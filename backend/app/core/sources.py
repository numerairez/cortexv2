"""Sources (where information lives) and Source Selections (which part of it to use)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import get_paths
from ..connectors import confluence, documents, feeds, tabular
from ..storage import db

MAX_FILE_BYTES = 250 * 1024 * 1024
DOCUMENT_EXTS = documents.DOC_EXTS


class SourceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _kind_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in tabular.EXCEL_EXTS:
        return "excel"
    if ext in {".csv", ".tsv"}:
        return "csv"
    if ext in DOCUMENT_EXTS:
        return "document"
    if ext == ".xls":
        raise SourceError("Legacy .xls workbooks are not supported; please re-save as .xlsx")
    raise SourceError(f"Unsupported file type '{ext}'. Supported: .xlsx, .xlsm, .csv, .tsv, .pdf, .docx, .txt, .md")


def validate_path(raw: str) -> Path:
    if not raw or not raw.strip():
        raise SourceError("Enter a file path")
    p = Path(raw.strip().strip('"')).expanduser()
    if not p.is_absolute():
        raise SourceError("Use a full path, e.g. C:\\Users\\you\\Documents\\report.xlsx")
    try:
        p = p.resolve(strict=True)
    except (FileNotFoundError, OSError):
        raise SourceError("File not found", 404)
    if not p.is_file():
        raise SourceError("That path is a folder, not a file")
    if p.stat().st_size > MAX_FILE_BYTES:
        raise SourceError("File is larger than the 250 MB limit")
    return p


def _in_uploads(location: str) -> bool:
    try:
        return Path(location).resolve().is_relative_to((get_paths().root / "uploads").resolve())
    except (OSError, ValueError):
        return False


def _decode(row):
    row = db.decode(row, "metadata")
    if row:
        # Dropped files are copied into the app folder; flag them as not linked to the original path.
        row["is_copy"] = row["kind"] != "confluence" and _in_uploads(row["location"])
    return row


def get_source(source_id: str) -> dict:
    row = _decode(db.query_one("SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL", (source_id,)))
    if not row:
        raise SourceError("Source not found", 404)
    return row


def list_sources() -> list[dict]:
    rows = [_decode(r) for r in db.query("SELECT * FROM sources WHERE deleted_at IS NULL ORDER BY created_at DESC")]
    counts = {r["source_id"]: r for r in db.query(
        "SELECT source_id, COUNT(*) n, COUNT(DISTINCT CASE WHEN kind = 'sheet' THEN json_extract(config, '$.sheet') END) sheets "
        "FROM selections WHERE deleted_at IS NULL GROUP BY source_id")}
    for r in rows:
        c = counts.get(r["id"])
        r["selection_count"] = c["n"] if c else 0
        r["sheets_used"] = c["sheets"] if c else 0
    return rows


def _inspect_file(path: Path, kind: str) -> tuple[dict, dict]:
    fp = documents.fingerprint_file(path)
    meta: dict[str, Any] = {"extension": path.suffix.lower(), "size": fp["size"], "mtime": fp["mtime"]}
    if kind in ("excel", "csv", "feed"):
        meta["sheets"] = tabular.list_sheets(path)
    else:
        segs = documents.extract_segments(path)
        meta["segments"] = len(segs)
        meta["characters"] = sum(len(s.text) for s in segs)
    return meta, fp


def add_file_source(raw_path: str, name: str | None = None) -> dict:
    path = validate_path(raw_path)
    kind = _kind_for(path)
    existing = db.query_one("SELECT id FROM sources WHERE location = ? AND deleted_at IS NULL", (str(path),))
    if existing:
        raise SourceError("This file is already registered as a source", 409)
    try:
        meta, fp = _inspect_file(path, kind)
    except (tabular.TabularError, documents.DocumentError) as e:
        raise SourceError(str(e))
    sid = db.new_id("src")
    ts = db.now()
    db.execute(
        "INSERT INTO sources (id, kind, name, location, metadata, fingerprint, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)",
        (sid, kind, name or path.name, str(path), db.dumps(meta), fp["sha256"], ts, ts),
    )
    if kind == "document":
        create_selection(sid, kind="document", label=name or path.name, config={})
    elif kind == "csv":
        # A CSV has exactly one "sheet"; offer it pre-configured with a suggested header.
        prev = tabular.preview_rows(path, tabular.CSV_SHEET, 30)
        create_selection(sid, kind="sheet", label=name or path.name,
                         config={"sheet": tabular.CSV_SHEET, "header_row": prev["suggested_header_row"] or 1})
    return get_source(sid)


def add_confluence_source(page_ref: str, base_url: str) -> dict:
    try:
        page_id = confluence.parse_page_id(page_ref)
        page = confluence.fetch_page(base_url, page_id)
    except confluence.ConfluenceError as e:
        raise SourceError(str(e))
    existing = db.query_one("SELECT id FROM sources WHERE kind = 'confluence' AND location = ? AND deleted_at IS NULL",
                            (page["id"],))
    if existing:
        raise SourceError("This Confluence page is already registered", 409)
    sid = db.new_id("src")
    ts = db.now()
    meta = {"title": page["title"], "space": page["space"], "version": page["version"], "url": page["url"],
            "base_url": base_url, "modified": page.get("modified")}
    db.execute(
        "INSERT INTO sources (id, kind, name, location, metadata, fingerprint, status, created_at, updated_at) "
        "VALUES (?, 'confluence', ?, ?, ?, ?, 'ok', ?, ?)",
        (sid, page["title"], page["id"], db.dumps(meta), f"v{page['version']}", ts, ts),
    )
    create_selection(sid, kind="page", label=page["title"], config={})
    return get_source(sid)


def _fetch_feed(path: Path, feed_id: str, params: dict) -> tuple[dict, dict]:
    """Run the feed's fetch code and save its table as a CSV snapshot at ``path``.

    The snapshot is what the rest of the app reads, so a feed behaves like a CSV source.
    On failure the previous snapshot (if any) is left untouched.
    """
    try:
        feed = feeds.get(feed_id)
        df = feed.module.fetch(params)
    except feeds.FeedError as e:
        raise SourceError(str(e))
    except Exception as e:  # external code: report it, never crash the request
        raise SourceError(f"{feed.name} failed: {e.__class__.__name__}: {e}")
    if not hasattr(df, "to_csv"):
        raise SourceError(f"{feed.name} did not return a table")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    df.to_csv(tmp, index=False)
    tmp.replace(path)
    meta, fp = _inspect_file(path, "feed")
    meta.update(feed=feed_id, feed_name=feed.name, params=params, rows=int(df.shape[0]), fetched_at=db.now())
    return meta, fp


def add_feed_source(feed_id: str, name: str | None, params: dict) -> dict:
    sid = db.new_id("src")
    path = get_paths().root / "feeds" / f"{sid}.csv"
    meta, fp = _fetch_feed(path, feed_id, params)
    label = (name or "").strip() or meta["feed_name"]
    ts = db.now()
    db.execute(
        "INSERT INTO sources (id, kind, name, location, metadata, fingerprint, status, created_at, updated_at) "
        "VALUES (?, 'feed', ?, ?, ?, ?, 'ok', ?, ?)",
        (sid, label, str(path), db.dumps(meta), fp["sha256"], ts, ts),
    )
    create_selection(sid, kind="sheet", label=label, config={"sheet": tabular.CSV_SHEET, "header_row": 1})
    return get_source(sid)


def refresh_source(source_id: str) -> dict:
    """Re-inspect a source and record whether it is ok, changed, missing, or unreadable."""
    src = get_source(source_id)
    status, detail, fp_value, meta = "ok", None, src["fingerprint"], dict(src["metadata"])
    if src["kind"] == "confluence":
        try:
            page = confluence.fetch_page(meta.get("base_url", ""), src["location"])
            new_fp = f"v{page['version']}"
            if new_fp != src["fingerprint"]:
                status, detail = "changed", f"Page updated to version {page['version']}"
            fp_value = new_fp
            meta.update(title=page["title"], version=page["version"], modified=page.get("modified"))
        except confluence.ConfluenceError as e:
            status, detail = "error", str(e)
    elif src["kind"] == "feed":
        # Refreshing a feed re-runs its fetch code; the new snapshot replaces the old one.
        try:
            new_meta, fp = _fetch_feed(Path(src["location"]), meta.get("feed", ""), meta.get("params") or {})
            if fp["sha256"] != src["fingerprint"]:
                status, detail = "changed", "New data fetched"
            fp_value = fp["sha256"]
            meta.update(new_meta)
        except SourceError as e:
            status, detail = "error", str(e)
    else:
        path = Path(src["location"])
        if not path.exists():
            status, detail = "missing", "File no longer exists at this path"
        else:
            try:
                new_meta, fp = _inspect_file(path, src["kind"])
                if fp["sha256"] != src["fingerprint"]:
                    status, detail = "changed", "File content changed since it was last checked"
                fp_value = fp["sha256"]
                meta.update(new_meta)
            except (tabular.TabularError, documents.DocumentError) as e:
                status, detail = "error", str(e)
    db.execute(
        "UPDATE sources SET status = ?, status_detail = ?, fingerprint = ?, metadata = ?, updated_at = ? WHERE id = ?",
        (status, detail, fp_value, db.dumps(meta), db.now(), source_id),
    )
    return get_source(source_id)


def relocate_source(source_id: str, raw_path: str) -> dict:
    """Point an existing source at a new file (e.g. next month's workbook)."""
    src = get_source(source_id)
    if src["kind"] in ("confluence", "feed"):
        raise SourceError(f"{'Confluence' if src['kind'] == 'confluence' else 'Data feed'} sources cannot be relocated")
    path = validate_path(raw_path)
    if _kind_for(path) != src["kind"]:
        raise SourceError(f"New file must be the same type ({src['kind']})")
    if _in_uploads(str(path)):
        raise SourceError("Choose the original file, not a copy inside Flowbook's folder")
    other = db.query_one("SELECT name FROM sources WHERE location = ? AND id != ? AND deleted_at IS NULL", (str(path), source_id))
    if other:
        raise SourceError(f"That file is already in My data as “{other['name']}”")
    try:
        meta, fp = _inspect_file(path, src["kind"])
    except (tabular.TabularError, documents.DocumentError) as e:
        raise SourceError(str(e))
    detail = "Re-linked to the original file" if src["is_copy"] else "Relocated to a new file"
    db.execute(
        "UPDATE sources SET location = ?, metadata = ?, fingerprint = ?, status = 'ok', status_detail = ?, updated_at = ? "
        "WHERE id = ?",
        (str(path), db.dumps(meta), fp["sha256"], detail, db.now(), source_id),
    )
    return get_source(source_id)


def delete_source(source_id: str) -> None:
    get_source(source_id)
    ts = db.now()
    with db.tx() as c:
        c.execute("UPDATE sources SET deleted_at = ? WHERE id = ?", (ts, source_id))
        c.execute("UPDATE selections SET deleted_at = ? WHERE source_id = ? AND deleted_at IS NULL", (ts, source_id))


def preview_sheet(source_id: str, sheet: str, rows: int = 30) -> dict:
    src = get_source(source_id)
    if src["kind"] not in ("excel", "csv", "feed"):
        raise SourceError("Only spreadsheet sources have sheets")
    try:
        return tabular.preview_rows(Path(src["location"]), sheet, rows)
    except tabular.TabularError as e:
        raise SourceError(str(e))
    except FileNotFoundError:
        raise SourceError("File no longer exists at this path", 404)


def profile_sheet(source_id: str, sheet: str, header_row: int, columns: list[str] | None = None) -> dict:
    src = get_source(source_id)
    try:
        t = tabular.load_table(Path(src["location"]), sheet, header_row, columns)
    except tabular.TabularError as e:
        raise SourceError(str(e))
    except FileNotFoundError:
        raise SourceError("File no longer exists at this path", 404)
    return {
        "header_row": header_row,
        "row_count": int(t.df.shape[0]),
        "columns": tabular.profile(t.df),
        "warnings": t.warnings,
        "sample": {"columns": list(map(str, t.df.columns)), "rows": tabular.records(t.df, 10)},
    }


# ---------------------------------------------------------------- selections

def _decode_sel(row):
    return db.decode(row, "config", "schema")


def get_selection(selection_id: str) -> dict:
    row = _decode_sel(db.query_one("SELECT * FROM selections WHERE id = ? AND deleted_at IS NULL", (selection_id,)))
    if not row:
        raise SourceError("Selection not found", 404)
    return row


def list_selections(source_id: str | None = None) -> list[dict]:
    sql = ("SELECT s.*, src.name AS source_name, src.kind AS source_kind, src.status AS source_status "
           "FROM selections s JOIN sources src ON src.id = s.source_id "
           "WHERE s.deleted_at IS NULL AND src.deleted_at IS NULL")
    params: list = []
    if source_id:
        sql += " AND s.source_id = ?"
        params.append(source_id)
    return [_decode_sel(r) for r in db.query(sql + " ORDER BY s.created_at DESC", params)]


def _sheet_schema(src: dict, config: dict) -> list[dict]:
    header_row = int(config.get("header_row") or 1)
    try:
        t = tabular.load_table(Path(src["location"]), config["sheet"], header_row, config.get("columns") or None)
    except tabular.TabularError as e:
        raise SourceError(str(e))
    return tabular.schema_of(t.df)


def create_selection(source_id: str, kind: str, label: str, config: dict) -> dict:
    src = get_source(source_id)
    schema = None
    if kind == "sheet":
        if src["kind"] not in ("excel", "csv", "feed"):
            raise SourceError("Sheet selections need a spreadsheet source")
        if not config.get("sheet"):
            raise SourceError("Choose a sheet")
        config["header_row"] = int(config.get("header_row") or 1)
        schema = _sheet_schema(src, config)
    sid = db.new_id("sel")
    ts = db.now()
    db.execute(
        "INSERT INTO selections (id, source_id, kind, label, config, schema, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, source_id, kind, label, db.dumps(config), db.dumps(schema) if schema else None, ts, ts),
    )
    return get_selection(sid)


def update_selection(selection_id: str, label: str | None, config: dict | None, accept_schema: bool = False) -> dict:
    sel = get_selection(selection_id)
    src = get_source(sel["source_id"])
    new_config = {**sel["config"], **(config or {})}
    schema = sel["schema"]
    if sel["kind"] == "sheet" and (config or accept_schema):
        new_config["header_row"] = int(new_config.get("header_row") or 1)
        schema = _sheet_schema(src, new_config)
    db.execute(
        "UPDATE selections SET label = ?, config = ?, schema = ?, updated_at = ? WHERE id = ?",
        (label or sel["label"], db.dumps(new_config), db.dumps(schema) if schema else None, db.now(), selection_id),
    )
    return get_selection(selection_id)


def delete_selection(selection_id: str) -> None:
    get_selection(selection_id)
    db.execute("UPDATE selections SET deleted_at = ? WHERE id = ?", (db.now(), selection_id))


def check_selection(selection_id: str) -> dict:
    """Report whether a selection can still be read and whether its schema drifted."""
    sel = get_selection(selection_id)
    src = get_source(sel["source_id"])
    result: dict[str, Any] = {"selection_id": selection_id, "status": "ok", "detail": None, "drift": None}
    if src["kind"] == "confluence":
        result["status"] = src["status"]
        result["detail"] = src.get("status_detail")
        return result
    path = Path(src["location"])
    if not path.exists():
        return {**result, "status": "missing", "detail": "File no longer exists at this path"}
    if sel["kind"] == "sheet":
        try:
            t = tabular.load_table(path, sel["config"]["sheet"], sel["config"]["header_row"])
        except tabular.TabularError as e:
            return {**result, "status": "error", "detail": str(e)}
        except PermissionError:
            return {**result, "status": "error", "detail": "Permission denied (file may be open/locked)"}
        cols = sel["config"].get("columns")
        current = tabular.schema_of(t.df[cols] if cols and all(c in t.df.columns for c in cols) else t.df)
        drift = tabular.schema_drift(sel["schema"], current)
        if cols and any(c not in t.df.columns for c in cols):
            drift = drift or {"missing": [], "added": [], "type_changes": []}
            drift["missing"] = sorted(set(drift["missing"]) | {c for c in cols if c not in t.df.columns})
        if drift:
            result.update(status="drift", detail="Columns differ from when this selection was saved", drift=drift)
    return result

