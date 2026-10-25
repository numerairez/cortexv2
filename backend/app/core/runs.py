"""Runs (append-only execution records) and the artifacts they produce."""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Any

from ..config import get_paths
from ..storage import db
from .sources import SourceError

RUN_JSON = ("config", "state", "exchanges", "errors", "summary")


def _decode(row):
    return db.decode(row, *RUN_JSON)


def create_run(service_id: str, title: str, config: dict, collection_id: str | None = None,
               snapshot_id: str | None = None, status: str = "draft") -> dict:
    rid = db.new_id("run")
    ts = db.now()
    db.execute(
        "INSERT INTO runs (id, service_id, title, status, config, collection_id, snapshot_id, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (rid, service_id, title, status, db.dumps(config), collection_id, snapshot_id, ts, ts),
    )
    return get_run(rid)


def get_run(run_id: str) -> dict:
    row = _decode(db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,)))
    if not row:
        raise SourceError("Run not found", 404)
    row["artifacts"] = list_artifacts(run_id)
    # The saved workflow this run belongs to, if any, so it can be reopened as that workflow.
    v = db.query_one("SELECT recipe_id FROM recipe_versions WHERE id = ?", (row["recipe_version_id"],)) \
        if row.get("recipe_version_id") else None
    row["recipe_id"] = v["recipe_id"] if v else None
    return row


def list_runs(limit: int = 200) -> list[dict]:
    rows = db.query(
        "SELECT r.id, r.service_id, r.title, r.status, r.collection_id, r.created_at, r.updated_at, r.summary, "
        "c.name AS collection_name, (SELECT COUNT(*) FROM artifacts a WHERE a.run_id = r.id) AS artifact_count "
        "FROM runs r LEFT JOIN collections c ON c.id = r.collection_id ORDER BY r.created_at DESC LIMIT ?",
        (limit,),
    )
    for r in rows:
        r["summary"] = db.loads(r["summary"], {})
    return rows


def update_run(run_id: str, **fields: Any) -> dict:
    allowed = {"status", "title", "config", "state", "exchanges", "errors", "summary", "snapshot_id",
               "recipe_version_id"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            raise ValueError(k)
        sets.append(f"{k} = ?")
        params.append(db.dumps(v) if k in RUN_JSON else v)
    sets.append("updated_at = ?")
    params.extend([db.now(), run_id])
    db.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", params)
    return get_run(run_id)


def retain_prompts() -> bool:
    return bool(db.get_setting("retain_prompts", True))


def record_exchange(run: dict, kind: str, text: str, extra: dict | None = None) -> list[dict]:
    """Append a prompt or response to the run's history, honouring the retention setting."""
    entry: dict[str, Any] = {"kind": kind, "at": db.now(), "chars": len(text),
                             "sha256": hashlib.sha256(text.encode()).hexdigest(), **(extra or {})}
    if retain_prompts():
        entry["text"] = text
    exchanges = list(run.get("exchanges") or [])
    exchanges.append(entry)
    return exchanges


def delete_run(run_id: str) -> None:
    get_run(run_id)
    folder = get_paths().artifacts / run_id
    with db.tx() as c:
        c.execute("DELETE FROM artifacts WHERE run_id = ?", (run_id,))
        c.execute("DELETE FROM runs WHERE id = ?", (run_id,))
    if folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)


# ---------------------------------------------------------------- artifacts

def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\-. ()]+", "_", name).strip(" .")
    return (name or "output")[:120]


def artifact_path(run_id: str, filename: str) -> Path:
    folder = get_paths().artifacts / run_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / safe_filename(filename)


def register_artifact(run_id: str, kind: str, path: Path, metadata: dict | None = None) -> dict:
    aid = db.new_id("art")
    rel = path.relative_to(get_paths().artifacts).as_posix()
    db.execute(
        "INSERT INTO artifacts (id, run_id, kind, name, path, size, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (aid, run_id, kind, path.name, rel, path.stat().st_size, db.dumps(metadata or {}), db.now()),
    )
    return get_artifact(aid)


def get_artifact(artifact_id: str) -> dict:
    row = db.decode(db.query_one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)), "metadata")
    if not row:
        raise SourceError("Artifact not found", 404)
    return row


def artifact_file(artifact: dict) -> Path:
    root = get_paths().artifacts.resolve()
    p = (root / artifact["path"]).resolve()
    if root not in p.parents:
        raise SourceError("Invalid artifact path", 400)
    if not p.exists():
        raise SourceError("Artifact file is missing from the store", 404)
    return p


def list_artifacts(run_id: str | None = None) -> list[dict]:
    if run_id:
        rows = db.query("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at", (run_id,))
    else:
        rows = db.query(
            "SELECT a.*, r.title AS run_title, r.service_id FROM artifacts a LEFT JOIN runs r ON r.id = a.run_id "
            "ORDER BY a.created_at DESC")
    out = [db.decode(r, "metadata") for r in rows]
    for r in out:
        r["file_path"] = str(get_paths().artifacts / r["path"])
    return out


def open_on_desktop(path: Path, reveal: bool) -> None:
    """Open a file with its default app, or show it in Explorer/Finder. Local single-user app only."""
    import os
    import subprocess
    import sys

    if sys.platform == "win32":
        if reveal:
            subprocess.Popen(f'explorer /select,"{path}"')
        else:
            os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if reveal else ["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent if reveal else path)])
