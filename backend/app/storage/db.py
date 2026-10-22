"""SQLite access and schema migrations.

Kept deliberately thin (stdlib sqlite3, JSON columns) so the app has no ORM
dependency to install on locked-down PCs.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from ..config import get_paths

_lock = threading.RLock()

MIGRATIONS: list[str] = [
    # 1 — initial schema
    """
    CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,              -- file | excel | csv | confluence
        name TEXT NOT NULL,
        location TEXT NOT NULL,          -- absolute path or Confluence page id/url
        metadata TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        status_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE TABLE selections (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        kind TEXT NOT NULL,              -- document | sheet | page
        label TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',   -- sheet, header_row (1-based), columns, ...
        schema TEXT,                      -- detected columns/types at save time
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE TABLE collection_items (
        collection_id TEXT NOT NULL REFERENCES collections(id),
        selection_id TEXT NOT NULL REFERENCES selections(id),
        position INTEGER NOT NULL,
        included INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (collection_id, selection_id)
    );
    CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        collection_id TEXT,
        manifest TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE TABLE recipe_versions (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL REFERENCES recipes(id),
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'manual',  -- manual | ai
        created_at TEXT NOT NULL,
        UNIQUE (recipe_id, version)
    );
    CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,            -- draft | awaiting_response | invalid_response | completed | failed
        config TEXT NOT NULL DEFAULT '{}',
        collection_id TEXT,
        snapshot_id TEXT REFERENCES snapshots(id),
        recipe_version_id TEXT REFERENCES recipe_versions(id),
        state TEXT NOT NULL DEFAULT '{}',    -- service-private working state
        exchanges TEXT NOT NULL DEFAULT '[]', -- prompt/response history
        errors TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,              -- xlsx | csv | markdown | html | json
        name TEXT NOT NULL,
        path TEXT NOT NULL,              -- relative to artifact store
        size INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
    # 2 — data templates (recurring files that differ by a date in the filename)
    """
    CREATE TABLE data_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        pattern TEXT NOT NULL,           -- e.g. sales_{date}.xlsx
        format TEXT NOT NULL,            -- e.g. YYYY_MM, or "text"
        sheet TEXT NOT NULL,
        header_row INTEGER NOT NULL,
        columns TEXT,
        schema TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    """,
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(get_paths().db, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


_conn: sqlite3.Connection | None = None
_conn_path = None


def conn() -> sqlite3.Connection:
    global _conn, _conn_path
    path = get_paths().db
    if _conn is None or _conn_path != path:
        _conn = _connect()
        _conn_path = path
        migrate(_conn)
    return _conn


def migrate(c: sqlite3.Connection) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    applied = {r[0] for r in c.execute("SELECT version FROM schema_migrations")}
    for i, sql in enumerate(MIGRATIONS, start=1):
        if i in applied:
            continue
        # executescript runs outside the connection's transaction handling, so the
        # migration and its bookkeeping row are wrapped in one explicit transaction.
        c.executescript(
            f"BEGIN;\n{sql}\nINSERT INTO schema_migrations (version, applied_at) VALUES ({i}, '{now()}');\nCOMMIT;"
        )


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    with _lock:
        c = conn()
        c.execute("BEGIN")
        try:
            yield c
        except Exception:
            c.execute("ROLLBACK")
            raise
        c.execute("COMMIT")


def query(sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params)]


def query_one(sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple | list = ()) -> None:
    with tx() as c:
        c.execute(sql, params)


def dumps(value: Any) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


def decode(row: dict[str, Any] | None, *json_fields: str) -> dict[str, Any] | None:
    if row is None:
        return None
    for f in json_fields:
        if f in row:
            row[f] = loads(row[f], None)
    return row


def get_setting(key: str, default: Any = None) -> Any:
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return loads(row["value"]) if row else default


def set_setting(key: str, value: Any) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, dumps(value)),
    )
