"""Data templates: recurring Excel/CSV files that share a schema and differ by a date in the filename.

A template is a folder + a filename pattern with one ``{date}`` placeholder and a date
format (e.g. ``sales_{date}.xlsx`` with ``YYYY_MM``), plus the sheet and header row
that apply to every file. Workflows can bind an input to a template and choose which
file (period) to use; by default the newest one.
"""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Any

from ..connectors import tabular
from ..storage import db
from . import sources
from .sources import SourceError

PLACEHOLDER = "{date}"

# Supported date formats, most specific first: key -> (strptime format, granularity)
FORMATS: dict[str, tuple[str, str]] = {
    "YYYY-MM-DD": ("%Y-%m-%d", "day"),
    "YYYY_MM_DD": ("%Y_%m_%d", "day"),
    "YYYY.MM.DD": ("%Y.%m.%d", "day"),
    "YYYYMMDD": ("%Y%m%d", "day"),
    "DD-MM-YYYY": ("%d-%m-%Y", "day"),
    "DD_MM_YYYY": ("%d_%m_%Y", "day"),
    "DD.MM.YYYY": ("%d.%m.%Y", "day"),
    "YYYY-MM": ("%Y-%m", "month"),
    "YYYY_MM": ("%Y_%m", "month"),
    "YYYY.MM": ("%Y.%m", "month"),
    "YYYYMM": ("%Y%m", "month"),
    "MM-YYYY": ("%m-%Y", "month"),
    "MM_YYYY": ("%m_%Y", "month"),
    "MMMM YYYY": ("%B %Y", "month"),
    "MMM YYYY": ("%b %Y", "month"),
    "MMM-YYYY": ("%b-%Y", "month"),
    "MMM_YYYY": ("%b_%Y", "month"),
    "MMMYYYY": ("%b%Y", "month"),
    "YYYY": ("%Y", "year"),
}
TEXT_FORMAT = "text"   # any text; files are ordered by modified time

_TOKEN_RE = {"%Y": r"\d{4}", "%m": r"\d{2}", "%d": r"\d{2}", "%b": r"[A-Za-z]{3}", "%B": r"[A-Za-z]{3,9}"}


def _format_regex(fmt_key: str) -> str:
    if fmt_key == TEXT_FORMAT:
        return r".+?"
    fmt = FORMATS[fmt_key][0]
    out, i = [], 0
    while i < len(fmt):
        tok = fmt[i : i + 2]
        if tok in _TOKEN_RE:
            out.append(_TOKEN_RE[tok])
            i += 2
        else:
            out.append(re.escape(fmt[i]))
            i += 1
    return "".join(out)


def _parse(value: str, fmt_key: str) -> dt.date | None:
    if fmt_key == TEXT_FORMAT:
        return None
    try:
        return dt.datetime.strptime(value, FORMATS[fmt_key][0]).date()
    except ValueError:
        return None


def _label(d: dt.date | None, fmt_key: str, raw: str) -> str:
    if d is None:
        return raw
    gran = FORMATS[fmt_key][1]
    return d.strftime("%d %b %Y") if gran == "day" else d.strftime("%b %Y") if gran == "month" else d.strftime("%Y")


def pattern_regex(pattern: str, fmt_key: str) -> re.Pattern:
    if pattern.count(PLACEHOLDER) != 1:
        raise SourceError(f"The filename pattern needs exactly one {PLACEHOLDER} placeholder")
    if fmt_key != TEXT_FORMAT and fmt_key not in FORMATS:
        raise SourceError(f"Unknown date format '{fmt_key}'")
    before, after = pattern.split(PLACEHOLDER)
    return re.compile(f"^{re.escape(before)}(?P<v>{_format_regex(fmt_key)}){re.escape(after)}$", re.IGNORECASE)


def list_matches(folder: str, pattern: str, fmt_key: str) -> list[dict]:
    """All files in ``folder`` matching the pattern, newest first."""
    rx = pattern_regex(pattern, fmt_key)
    root = Path(folder)
    if not root.is_dir():
        raise SourceError("The template's folder is not reachable (check the network drive or folder path)", 404)
    out = []
    try:
        entries = list(root.iterdir())
    except PermissionError:
        raise SourceError("Permission denied for the template's folder", 403)
    for f in entries:
        if not f.is_file() or f.name.startswith("~$"):
            continue
        m = rx.match(f.name)
        if not m:
            continue
        raw = m.group("v")
        d = _parse(raw, fmt_key)
        if fmt_key != TEXT_FORMAT and d is None:
            continue
        st = f.stat()
        out.append({"value": raw, "label": _label(d, fmt_key, raw), "filename": f.name, "path": str(f),
                    "date": d.isoformat() if d else None, "modified": st.st_mtime, "size": st.st_size})
    out.sort(key=lambda x: (x["date"] or "", x["modified"]), reverse=True)
    return out


def suggest(path: str) -> dict:
    """Propose filename patterns for an example file by spotting dates in its name."""
    p = Path(path)
    name = p.name
    suggestions: list[dict] = []
    seen: set[tuple[str, str]] = set()
    taken: list[tuple[int, int]] = []
    for key in FORMATS:
        # Month names must not start mid-word ("Report" ≠ "ort"); numbers only need digit boundaries.
        lead = "(?<![0-9A-Za-z])" if FORMATS[key][0].startswith("%b") or FORMATS[key][0].startswith("%B") else "(?<![0-9])"
        rx = re.compile(f"{lead}{_format_regex(key)}(?![0-9])", re.IGNORECASE)
        for m in rx.finditer(p.stem):
            span = (m.start(), m.end())
            # A shorter format inside an already-found longer date (e.g. YYYY inside YYYY_MM) is not useful.
            if any(a <= span[0] and span[1] <= b and (a, b) != span for a, b in taken):
                continue
            if _parse(m.group(0), key) is None:
                continue
            pattern = p.stem[: span[0]] + PLACEHOLDER + p.stem[span[1] :] + p.suffix
            if (pattern, key) in seen:
                continue
            seen.add((pattern, key))
            taken.append(span)
            try:
                matches = list_matches(str(p.parent), pattern, key)
            except SourceError:
                matches = []
            suggestions.append({"pattern": pattern, "format": key, "example_value": m.group(0), "matches": matches})
    suggestions.sort(key=lambda s: -len(s["matches"]))
    return {"folder": str(p.parent), "filename": name, "suggestions": suggestions, "formats": list(FORMATS) + [TEXT_FORMAT]}


# ---------------------------------------------------------------- storage

def _decode(row):
    return db.decode(row, "schema", "columns")


def get_template(template_id: str, with_matches: bool = True) -> dict:
    row = _decode(db.query_one("SELECT * FROM data_templates WHERE id = ? AND deleted_at IS NULL", (template_id,)))
    if not row:
        raise SourceError("Data template not found", 404)
    if with_matches:
        try:
            row["matches"] = list_matches(row["folder"], row["pattern"], row["format"])
            row["error"] = None
        except SourceError as e:
            row["matches"], row["error"] = [], str(e)
    return row


def list_templates() -> list[dict]:
    ids = [r["id"] for r in db.query("SELECT id FROM data_templates WHERE deleted_at IS NULL ORDER BY updated_at DESC")]
    return [get_template(i) for i in ids]


def create_template(name: str, selection_id: str, pattern: str, fmt_key: str) -> dict:
    """Create a template from a configured example selection (its folder, sheet and header row)."""
    sel = sources.get_selection(selection_id)
    if sel["kind"] != "sheet":
        raise SourceError("Templates need a sheet or CSV selection")
    src = sources.get_source(sel["source_id"])
    folder = str(Path(src["location"]).parent)
    matches = list_matches(folder, pattern, fmt_key)
    if not any(m["path"] == src["location"] for m in matches):
        raise SourceError("The pattern does not match the example file; adjust it so the example is included")
    tid = db.new_id("tpl")
    ts = db.now()
    cfg = sel["config"]
    db.execute(
        "INSERT INTO data_templates (id, name, folder, pattern, format, sheet, header_row, columns, schema, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (tid, name.strip() or pattern, folder, pattern, fmt_key, cfg["sheet"], int(cfg.get("header_row") or 1),
         db.dumps(cfg.get("columns")), db.dumps(sel["schema"]), ts, ts),
    )
    return get_template(tid)


def update_template(template_id: str, name: str | None, pattern: str | None, fmt_key: str | None) -> dict:
    tpl = get_template(template_id, with_matches=False)
    pattern = pattern or tpl["pattern"]
    fmt_key = fmt_key or tpl["format"]
    pattern_regex(pattern, fmt_key)
    db.execute("UPDATE data_templates SET name = ?, pattern = ?, format = ?, updated_at = ? WHERE id = ?",
               ((name or tpl["name"]).strip(), pattern, fmt_key, db.now(), template_id))
    return get_template(template_id)


def delete_template(template_id: str) -> None:
    get_template(template_id, with_matches=False)
    db.execute("UPDATE data_templates SET deleted_at = ? WHERE id = ?", (db.now(), template_id))


def resolve(binding: str) -> dict[str, Any]:
    """Turn a template binding ``tpl_x`` (newest) or ``tpl_x@value`` into a concrete file + read settings."""
    tid, _, value = binding.partition("@")
    tpl = get_template(tid)
    if tpl["error"]:
        raise SourceError(f"{tpl['name']}: {tpl['error']}")
    if not tpl["matches"]:
        raise SourceError(f"{tpl['name']}: no files in {tpl['folder']} match {tpl['pattern']}")
    if value:
        match = next((m for m in tpl["matches"] if m["value"].lower() == value.lower()), None)
        if match is None:
            raise SourceError(f"{tpl['name']}: there is no file for '{value}' (expected {tpl['pattern'].replace(PLACEHOLDER, value)})")
    else:
        match = tpl["matches"][0]
    return {"template": tpl, "match": match, "path": Path(match["path"]), "latest": not value,
            "config": {"sheet": tpl["sheet"], "header_row": tpl["header_row"], "columns": tpl["columns"]}}


def check_schema(tpl: dict, df) -> str | None:
    drift = tabular.schema_drift(tpl.get("schema"), tabular.schema_of(df))
    if not drift:
        return None
    parts = []
    if drift["missing"]:
        parts.append("missing " + ", ".join(drift["missing"]))
    if drift["added"]:
        parts.append("new " + ", ".join(drift["added"]))
    if drift["type_changes"]:
        parts.append("type changed for " + ", ".join(c["name"] for c in drift["type_changes"]))
    return "This file's columns differ from the template: " + "; ".join(parts)
