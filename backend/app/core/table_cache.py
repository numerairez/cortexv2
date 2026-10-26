"""A disk cache of parsed tables, so a large workbook is read once rather than on every open.

Reading a 500k-row .xlsx through openpyxl takes about 30 seconds; loading the parsed table
back takes a fraction of a second. Entries are keyed by the file's content hash plus the sheet
and header row, so editing or replacing the file is a miss and never a stale read. The full
table is cached and the selection's column subset applied afterwards, so selections over the
same sheet share one entry.

Entries are pickles written only by this app into the user's own data folder. One that can't
be read back (a pandas upgrade, a half-written file) is deleted and the file read again.
"""

from __future__ import annotations

import hashlib
import json
import os
import pickle
from pathlib import Path

import pandas as pd

from .. import config
from ..connectors import tabular

# Bump when the reader's output changes, so tables parsed by older code are read again.
CACHE_VERSION = 1
MAX_ENTRIES = 24
MAX_BYTES = 2 * 1024**3


def _entry(sha256: str, sheet: str, header_row: int) -> Path:
    key = json.dumps([CACHE_VERSION, pd.__version__, sha256, sheet, header_row])
    return config.get_paths().table_cache / f"{hashlib.sha256(key.encode()).hexdigest()[:32]}.pkl"


def load_table(path: Path, sheet: str, header_row: int, columns: list[str] | None, sha256: str) -> tabular.LoadedTable:
    """``tabular.load_table`` for a file whose content hash is already known, through the cache."""
    entry = _entry(sha256, sheet, header_row)
    t = _read(entry)
    if t is None:
        t = tabular.load_table(path, sheet, header_row)
        _write(entry, t)
    return tabular.select_columns(t, columns)


def _read(entry: Path) -> tabular.LoadedTable | None:
    try:
        with entry.open("rb") as f:
            t = pickle.load(f)
        if not isinstance(t, tabular.LoadedTable):
            raise TypeError("not a cached table")
    except FileNotFoundError:
        return None
    except Exception:
        entry.unlink(missing_ok=True)
        return None
    try:
        os.utime(entry)   # recently used: kept longest when pruning
    except OSError:
        pass
    return t


def _write(entry: Path, t: tabular.LoadedTable) -> None:
    """Best effort: a full disk or locked folder only costs the next open its speed."""
    tmp = entry.with_suffix(f".{os.getpid()}.tmp")
    try:
        entry.parent.mkdir(parents=True, exist_ok=True)
        with tmp.open("wb") as f:
            pickle.dump(t, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, entry)
    except OSError:
        tmp.unlink(missing_ok=True)
        return
    _prune(entry.parent)


def _prune(folder: Path) -> None:
    """Drop the least recently used entries beyond the count and size limits."""
    try:
        files = sorted(((p.stat().st_mtime, p.stat().st_size, p) for p in folder.glob("*.pkl")), reverse=True)
    except OSError:
        return
    total = 0
    for i, (_, size, p) in enumerate(files):
        total += size
        if i >= MAX_ENTRIES or (i > 0 and total > MAX_BYTES):
            p.unlink(missing_ok=True)

