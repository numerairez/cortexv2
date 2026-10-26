"""Resolving selections into concrete content, and recording Context Snapshots.

A snapshot is the reproducibility record of one run: which sources, which
locations, which versions/hashes, retrieved when. By default it stores
metadata only (no document text), per the metadata-first retention default.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from ..connectors import confluence, documents, tabular
from ..storage import db
from . import sources, table_cache
from .sources import SourceError

SHEET_ROWS_PER_SEGMENT = 40
CHARS_PER_TOKEN = 4  # rough estimate used only for size warnings


@dataclass
class ResolvedSegment:
    anchor: str          # e.g. "S2.4" — what the AI cites
    locator: str         # e.g. "p. 4", "§ Scope", "Sheet1 rows 6–45"
    text: str


@dataclass
class ResolvedItem:
    ref: str                       # e.g. "S2"
    selection_id: str
    source_id: str
    kind: str                      # document | sheet | page
    label: str
    source_name: str
    location: str
    link: str | None
    version: str | None
    segments: list[ResolvedSegment] = field(default_factory=list)
    table: pd.DataFrame | None = None
    header_row: int | None = None
    warnings: list[str] = field(default_factory=list)
    error: str | None = None

    def manifest(self) -> dict[str, Any]:
        m: dict[str, Any] = {
            "ref": self.ref, "selection_id": self.selection_id, "source_id": self.source_id, "kind": self.kind,
            "label": self.label, "source_name": self.source_name, "location": self.location, "link": self.link,
            "version": self.version, "warnings": self.warnings, "error": self.error,
            "anchors": [{"anchor": s.anchor, "locator": s.locator, "chars": len(s.text)} for s in self.segments],
        }
        if self.table is not None:
            m["rows"] = int(self.table.shape[0])
            m["columns"] = tabular.schema_of(self.table)
            m["header_row"] = self.header_row
        return m


def _file_link(path: str) -> str:
    return Path(path).as_uri()


def resolve_selection(selection_id: str, ref: str, as_text: bool = True) -> ResolvedItem:
    sel = sources.get_selection(selection_id)
    src = sources.get_source(sel["source_id"])
    item = ResolvedItem(ref=ref, selection_id=selection_id, source_id=src["id"], kind=sel["kind"], label=sel["label"],
                        source_name=src["name"], location=src["location"], link=None, version=None)
    try:
        if src["kind"] == "confluence":
            meta = src["metadata"]
            page = confluence.fetch_page(meta.get("base_url", ""), src["location"])
            item.version = f"v{page['version']}"
            item.link = page["url"]
            segs = confluence.page_segments(page)
        else:
            path = Path(src["location"])
            fp = documents.fingerprint_file(path)
            item.version = f"sha256:{fp['sha256'][:16]}"
            item.link = _file_link(src["location"])
            if sel["kind"] == "sheet":
                cfg = sel["config"]
                t = table_cache.load_table(path, cfg["sheet"], int(cfg.get("header_row") or 1), cfg.get("columns") or None, fp["sha256"])
                item.table = t.df
                item.header_row = t.header_row
                item.warnings.extend(t.warnings)
                drift = tabular.schema_drift(sel["schema"], tabular.schema_of(t.df))
                if drift:
                    item.warnings.append("Schema drift since selection was saved: " + _describe_drift(drift))
                segs = _sheet_segments(t, cfg["sheet"]) if as_text else []
            else:
                segs = documents.extract_segments(path)
        item.segments = [ResolvedSegment(f"{ref}.{i}", s.locator, s.text) for i, s in enumerate(segs, start=1)]
    except (documents.DocumentError, tabular.TabularError, confluence.ConfluenceError, SourceError) as e:
        item.error = str(e)
    except PermissionError:
        item.error = "Permission denied (the file may be open in another program)"
    return item


def _describe_drift(d: dict) -> str:
    parts = []
    if d["missing"]:
        parts.append("missing " + ", ".join(d["missing"]))
    if d["added"]:
        parts.append("new " + ", ".join(d["added"]))
    if d["type_changes"]:
        parts.append("type changed for " + ", ".join(c["name"] for c in d["type_changes"]))
    return "; ".join(parts)


def _sheet_segments(t: tabular.LoadedTable, sheet: str) -> list[documents.Segment]:
    df = t.df
    cols = [str(c) for c in df.columns]
    rows = tabular.records(df)
    segs = []
    for start in range(0, len(rows), SHEET_ROWS_PER_SEGMENT):
        chunk = rows[start : start + SHEET_ROWS_PER_SEGMENT]
        first = t.first_data_row + start
        last = first + len(chunk) - 1
        lines = ["Row | " + " | ".join(cols)]
        for i, r in enumerate(chunk):
            lines.append(f"{first + i} | " + " | ".join("" if v is None else str(v) for v in r))
        name = "" if sheet == tabular.CSV_SHEET else f"{sheet} "
        segs.append(documents.Segment(f"{name}rows {first}–{last}", "\n".join(lines)))
    if not segs:
        segs.append(documents.Segment(f"{sheet} header", "Columns: " + ", ".join(cols) + " (no data rows)"))
    return segs


def resolve_collection(collection_id: str, as_text: bool = True,
                       exclude_anchors: set[str] | None = None) -> list[ResolvedItem]:
    from .collections import get_collection

    col = get_collection(collection_id)
    items: list[ResolvedItem] = []
    n = 0
    for it in col["items"]:
        if not it["included"] or it["removed"]:
            continue
        n += 1
        r = resolve_selection(it["selection_id"], f"S{n}", as_text=as_text)
        if exclude_anchors:
            r.segments = [s for s in r.segments if s.anchor not in exclude_anchors]
        items.append(r)
    return items


def estimate_tokens(chars: int) -> int:
    return max(1, chars // CHARS_PER_TOKEN)


def create_snapshot(collection_id: str | None, items: list[ResolvedItem], extra: dict | None = None) -> str:
    sid = db.new_id("snap")
    manifest = {"retrieved_at": db.now(), "items": [i.manifest() for i in items], **(extra or {})}
    db.execute("INSERT INTO snapshots (id, collection_id, manifest, created_at) VALUES (?, ?, ?, ?)",
               (sid, collection_id, db.dumps(manifest), db.now()))
    return sid


def get_snapshot(snapshot_id: str) -> dict:
    row = db.decode(db.query_one("SELECT * FROM snapshots WHERE id = ?", (snapshot_id,)), "manifest")
    if not row:
        raise SourceError("Snapshot not found", 404)
    return row
