"""Readable copies of workflows and dashboards in the save folder, for people to open and check.

The database stays the source of truth: these files are written for reading and never read back,
so editing one changes nothing in Flowbook. Each workflow or dashboard has one file,
``<save folder>/Workflows/<name>.json`` or ``Dashboards/<name>.json``, rewritten on every save,
moved when it is renamed and removed when it is deleted. Files are matched to their workflow or
dashboard by the id inside them, so only files Flowbook wrote are ever replaced or removed.

Writing is best effort and happens on one background thread, in order: a slow or missing network
folder never delays or fails a save.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from ..storage import db

log = logging.getLogger("workbench")

FOLDERS = {"workflow": "Workflows", "dashboard": "Dashboards"}
MARKER = "flowbook_copy"   # the kind of copy; also what marks a file as written by Flowbook
NOTE = ("A copy for reading. Flowbook keeps the real {kind} in its own database and rewrites this file "
        "whenever the {kind} is saved; changes made here are not read back.")
MAX_COPY_BYTES = 5 * 1024**2

_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="copies")
_last: Future | None = None


def _submit(fn, *args) -> None:
    global _last
    _last = _worker.submit(_safely, fn, *args)


def _safely(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:   # a copy must never break the app
        log.warning("Could not write readable copies to the save folder", exc_info=True)


def flush() -> None:
    """Wait for queued writes (tests)."""
    if _last is not None:
        _last.result()


def write(kind: str, item_id: str) -> None:
    """Refresh one copy after a save, rename or delete."""
    _submit(_write, kind, item_id)


def sync_all() -> None:
    """Write every copy and remove copies of deleted items: at startup and when the save folder changes."""
    _submit(_sync_all)


# ---------------------------------------------------------------- work (on the worker thread)

def _root() -> Path | None:
    folder = db.get_setting("save_folder")
    if not folder:
        return None
    p = Path(folder)
    return p if p.is_dir() and os.access(p, os.W_OK) else None


def _document(kind: str, item_id: str) -> dict[str, Any] | None:
    """What the copy holds, or None when the item no longer exists."""
    if kind == "workflow":
        r = db.query_one("SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL", (item_id,))
        v = r and db.query_one("SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC LIMIT 1", (item_id,))
        if not v:
            return None
        return {MARKER: kind, "note": NOTE.format(kind=kind), "id": r["id"], "name": r["name"],
                "description": r["description"] or "", "version": v["version"], "saved_at": v["created_at"],
                "definition": db.loads(v["definition"], {})}
    from .dashboards import dataset_label

    d = db.query_one("SELECT * FROM dashboards WHERE id = ? AND deleted_at IS NULL", (item_id,))
    if not d:
        return None
    return {MARKER: kind, "note": NOTE.format(kind=kind), "id": d["id"], "name": d["name"],
            "description": d["description"] or "", "saved_at": d["updated_at"],
            "dataset": {"id": d["dataset"], "name": dataset_label(d["dataset"])[0]},
            "spec": db.loads(d["spec"], {})}


def _copies(folder: Path, kind: str) -> dict[str, Path]:
    """Copies Flowbook wrote in ``folder``, by the id inside them."""
    out: dict[str, Path] = {}
    for p in folder.glob("*.json") if folder.is_dir() else []:
        try:
            if p.stat().st_size > MAX_COPY_BYTES:
                continue
            doc = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and doc.get(MARKER) == kind and isinstance(doc.get("id"), str):
            out[doc["id"]] = p
    return out


def _write(kind: str, item_id: str, copies: dict[str, Path] | None = None) -> None:
    from .runs import safe_filename

    root = _root()
    if root is None:
        return
    folder = root / FOLDERS[kind]
    copies = _copies(folder, kind) if copies is None else copies
    current = copies.get(item_id)
    doc = _document(kind, item_id)
    if doc is None:
        if current:
            current.unlink(missing_ok=True)
        return

    # Named after the item; a name another file already has gets " (2)", " (3)" … (case-insensitively,
    # as on Windows).
    taken = {p.name.lower() for i, p in copies.items() if i != item_id}
    taken |= {p.name.lower() for p in folder.glob("*") if p != current} if folder.is_dir() else set()
    base = safe_filename(doc["name"])
    name, n = f"{base}.json", 2
    while name.lower() in taken:
        name, n = f"{base} ({n}).json", n + 1
    target = folder / name

    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if current == target and target.read_text(encoding="utf-8") == text:
        return
    folder.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
    if current and current != target:
        current.unlink(missing_ok=True)
    copies[item_id] = target


def _sync_all() -> None:
    root = _root()
    if root is None:
        return
    for kind, table in (("workflow", "recipes"), ("dashboard", "dashboards")):
        copies = _copies(root / FOLDERS[kind], kind)
        live = [r["id"] for r in db.query(f"SELECT id FROM {table} WHERE deleted_at IS NULL ORDER BY created_at")]
        for item_id in live:
            _write(kind, item_id, copies)
        for item_id in set(copies) - set(live):
            copies[item_id].unlink(missing_ok=True)
