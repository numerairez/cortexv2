"""Excel/CSV reading: sheet listing, physical-row previews, header detection, profiling.

Row numbers exposed to users are always 1-based physical worksheet rows, exactly as
Excel shows them. We read rows through openpyxl/csv directly instead of
``pandas.read_excel(header=...)`` because pandas may drop leading blank rows, which
would silently shift a user's "header is on row 5" choice.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

EXCEL_EXTS = {".xlsx", ".xlsm"}
CSV_EXTS = {".csv", ".tsv", ".txt"}
CSV_SHEET = "(csv)"
MAX_PREVIEW_ROWS = 200


class TabularError(Exception):
    pass


def is_tabular(path: Path) -> bool:
    return path.suffix.lower() in EXCEL_EXTS | {".csv", ".tsv"}


def _open_workbook(path: Path):
    import openpyxl

    try:
        # data_only: read cached formula results, never formulas themselves.
        return openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as e:  # password-protected / corrupt / locked files land here
        raise TabularError(f"Could not open workbook: {e.__class__.__name__}: {e}") from e


def list_sheets(path: Path) -> list[str]:
    ext = path.suffix.lower()
    if ext in EXCEL_EXTS:
        wb = _open_workbook(path)
        try:
            return [ws.title for ws in wb.worksheets]
        finally:
            wb.close()
    if ext in CSV_EXTS:
        return [CSV_SHEET]
    if ext == ".xls":
        raise TabularError("Legacy .xls workbooks are not supported; please save as .xlsx.")
    raise TabularError(f"Unsupported tabular file type: {ext}")


def _read_csv_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise TabularError("Could not decode CSV text")


def _clean_cell(v: Any) -> Any:
    if isinstance(v, str):
        v = v.strip()
        return v if v != "" else None
    if isinstance(v, dt.datetime) and v.time() == dt.time(0):
        return v
    return v


def iter_physical_rows(path: Path, sheet: str, start_row: int = 1, max_rows: int | None = None):
    """Yield (excel_row_number, [values]) starting at ``start_row`` (1-based)."""
    ext = path.suffix.lower()
    if ext in EXCEL_EXTS:
        wb = _open_workbook(path)
        try:
            if sheet not in wb.sheetnames:
                raise TabularError(f"Sheet '{sheet}' not found in workbook")
            ws = wb[sheet]
            max_row = start_row + max_rows - 1 if max_rows else None
            for i, row in enumerate(ws.iter_rows(min_row=start_row, max_row=max_row, values_only=True)):
                yield start_row + i, [_clean_cell(v) for v in row]
        finally:
            wb.close()
    elif ext in CSV_EXTS:
        text = _read_csv_text(path)
        delim = "\t" if ext == ".tsv" else None
        if delim is None:
            try:
                delim = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|").delimiter
            except csv.Error:
                delim = ","
        reader = csv.reader(io.StringIO(text), delimiter=delim)
        for n, row in enumerate(reader, start=1):
            if n < start_row:
                continue
            if max_rows and n >= start_row + max_rows:
                break
            yield n, [_clean_cell(v) for v in row]
    else:
        raise TabularError(f"Unsupported tabular file type: {ext}")


def _jsonable(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (int, float, str, bool)):
        return v
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    return str(v)


def preview_rows(path: Path, sheet: str, max_rows: int = 30) -> dict:
    max_rows = min(max_rows, MAX_PREVIEW_ROWS)
    rows = [(n, vals) for n, vals in iter_physical_rows(path, sheet, 1, max_rows)]
    width = max((len(_trim(v)) for _, v in rows), default=0)
    return {
        "sheet": sheet,
        "width": width,
        "columns": [column_letter(i + 1) for i in range(width)],
        "rows": [{"row": n, "cells": [_jsonable(c) for c in (vals + [None] * width)[:width]]} for n, vals in rows],
        "suggested_header_row": suggest_header_row(rows),
    }


def _trim(vals: list) -> list:
    end = len(vals)
    while end and vals[end - 1] is None:
        end -= 1
    return vals[:end]


def column_letter(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def suggest_header_row(rows: list[tuple[int, list]]) -> int | None:
    """Heuristic: first row that is mostly text, reasonably wide, and followed by data."""
    filled = [(n, [v for v in vals if v is not None], vals) for n, vals in rows]
    if not filled:
        return None
    widest = max(len(f) for _, f, _ in filled) or 1
    for idx, (n, nonempty, _) in enumerate(filled):
        if len(nonempty) < max(2, int(widest * 0.6)):
            continue
        text_share = sum(isinstance(v, str) for v in nonempty) / len(nonempty)
        if text_share < 0.8:
            continue
        if len(set(map(str, nonempty))) != len(nonempty):
            continue
        following = filled[idx + 1 : idx + 4]
        if following and any(len(f) >= len(nonempty) * 0.5 for _, f, _ in following):
            return n
    return filled[0][0]


@dataclass
class LoadedTable:
    df: pd.DataFrame
    warnings: list[str] = field(default_factory=list)
    header_row: int = 1
    first_data_row: int = 2
    original_headers: list[Any] = field(default_factory=list)
    letters: dict[str, str] = field(default_factory=dict)   # column name -> Excel column letter


def load_table(path: Path, sheet: str, header_row: int = 1, columns: list[str] | None = None,
               max_rows: int | None = None) -> LoadedTable:
    """Load a rectangular table whose header sits on 1-based ``header_row``."""
    if header_row < 1:
        raise TabularError("Header row must be 1 or greater (Excel row numbers start at 1)")
    warnings: list[str] = []
    it = iter_physical_rows(path, sheet, start_row=header_row, max_rows=(max_rows + 1) if max_rows else None)
    try:
        _, header = next(it)
    except StopIteration:
        raise TabularError(f"Row {header_row} is beyond the end of the sheet")

    body = [vals for _, vals in it]
    # Drop trailing fully-empty rows.
    while body and all(v is None for v in body[-1]):
        body.pop()
    width = max([len(_trim(header))] + [len(_trim(r)) for r in body] or [0])
    header = (header + [None] * width)[:width]

    names: list[str] = []
    seen: dict[str, int] = {}
    keep: list[int] = []
    for i, h in enumerate(header):
        col_has_data = any(i < len(r) and r[i] is not None for r in body)
        if h is None and not col_has_data:
            continue
        name = str(h).strip() if h is not None else ""
        if isinstance(h, (dt.datetime, dt.date)):
            name = h.date().isoformat() if isinstance(h, dt.datetime) else h.isoformat()
        if not name:
            name = f"Column {column_letter(i + 1)}"
            warnings.append(f"Blank header in column {column_letter(i + 1)} renamed to '{name}'")
        if name in seen:
            seen[name] += 1
            new = f"{name} ({seen[name]})"
            warnings.append(f"Duplicate header '{name}' in column {column_letter(i + 1)} renamed to '{new}'")
            name = new
        else:
            seen[name] = 1
        names.append(name)
        keep.append(i)

    data = [[(r[i] if i < len(r) else None) for i in keep] for r in body]
    blank_rows = sum(1 for r in data if all(v is None for v in r))
    if blank_rows:
        warnings.append(f"{blank_rows} blank row(s) inside the table were removed")
        data = [r for r in data if not all(v is None for v in r)]
    df = pd.DataFrame(data, columns=names, dtype=object)
    df = normalise_types(df)

    letters = {n: column_letter(i + 1) for n, i in zip(names, keep)}
    t = LoadedTable(df=df, warnings=warnings, header_row=header_row, first_data_row=header_row + 1,
                    original_headers=[_jsonable(h) for h in header], letters=letters)
    return select_columns(t, columns)


def select_columns(t: LoadedTable, columns: list[str] | None) -> LoadedTable:
    """Narrow a loaded table to the selection's column subset (all columns when there is none)."""
    if columns:
        missing = [c for c in columns if c not in t.df.columns]
        if missing:
            raise TabularError(f"Selected column(s) no longer present: {', '.join(missing)}")
        t = replace(t, df=t.df[columns])
    return replace(t, warnings=list(t.warnings), letters={c: t.letters[c] for c in t.df.columns if c in t.letters})


def normalise_types(df: pd.DataFrame) -> pd.DataFrame:
    """Convert object columns to numeric/datetime only when every non-null value agrees."""
    out = {}
    for col in df.columns:
        s = df[col]
        nonnull = s.dropna()
        if nonnull.empty:
            out[col] = s
        elif all(isinstance(v, bool) for v in nonnull):
            out[col] = s.astype("boolean")
        elif all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in nonnull):
            num = pd.to_numeric(s)
            if all(float(v).is_integer() for v in nonnull):
                num = num.astype("Int64")
            out[col] = num
        elif all(isinstance(v, (dt.datetime, dt.date)) for v in nonnull):
            out[col] = pd.to_datetime(s)
        else:
            out[col] = s.map(lambda v: None if v is None else (v if isinstance(v, str) else _jsonable(v))).astype(object)
    return pd.DataFrame(out, index=df.index)


def column_type(s: pd.Series) -> str:
    if s.dropna().empty:
        return "empty"
    if pd.api.types.is_bool_dtype(s):
        return "boolean"
    if pd.api.types.is_integer_dtype(s):
        return "integer"
    if pd.api.types.is_numeric_dtype(s):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "date"
    return "text"


def profile(df: pd.DataFrame, sample_count: int = 3) -> list[dict]:
    cols = []
    for col in df.columns:
        s = df[col]
        nonnull = s.dropna()
        samples = []
        for v in nonnull.unique()[:sample_count]:
            jv = _jsonable(v.item() if hasattr(v, "item") else v)
            if isinstance(jv, str) and len(jv) > 60:
                jv = jv[:57] + "..."
            samples.append(jv)
        cols.append({
            "name": str(col),
            "type": column_type(s),
            "non_null": int(nonnull.shape[0]),
            "nulls": int(s.isna().sum()),
            "distinct": int(nonnull.nunique()),
            "samples": samples,
        })
    return cols


def schema_of(df: pd.DataFrame) -> list[dict]:
    return [{"name": str(c), "type": column_type(df[c])} for c in df.columns]


def schema_drift(saved: list[dict] | None, current: list[dict]) -> dict | None:
    """Compare a saved schema with the current one; None means no drift."""
    if not saved:
        return None
    old = {c["name"]: c["type"] for c in saved}
    new = {c["name"]: c["type"] for c in current}
    missing = [c for c in old if c not in new]
    added = [c for c in new if c not in old]
    # "empty" columns carry no type information, so they never count as a type change.
    changed = [
        {"name": c, "was": old[c], "now": new[c]}
        for c in old
        if c in new and old[c] != new[c] and "empty" not in (old[c], new[c])
        and {old[c], new[c]} != {"integer", "number"}
    ]
    if not (missing or added or changed):
        return None
    return {"missing": missing, "added": added, "type_changes": changed}


def to_json_value(v: Any) -> Any:
    """Convert a pandas/numpy scalar into a JSON-friendly Python value."""
    if _isna(v):
        return None
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    return _jsonable(v.item() if hasattr(v, "item") and not isinstance(v, str) else v)


def column_values(s: pd.Series, limit: int | None = None) -> list[Any]:
    """One column as JSON-ready values, converted like ``to_json_value`` but a column at a time:
    fast enough for hundreds of thousands of rows. Infinite numbers become None."""
    if limit is not None:
        s = s.iloc[:limit]
    if pd.api.types.is_datetime64_any_dtype(s):
        if getattr(s.dt, "tz", None) is None and not (s.dt.microsecond.fillna(0) != 0).any():
            return s.dt.strftime("%Y-%m-%dT%H:%M:%S").astype(object).where(s.notna(), None).tolist()
        return [None if pd.isna(v) else v.isoformat() for v in s]
    if pd.api.types.is_float_dtype(s):
        s = s.where(np.isfinite(s))
    if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
        return s.astype(object).where(s.notna(), None).tolist()
    return [v if v is None or isinstance(v, str) else to_json_value(v) for v in s.tolist()]


def records(df: pd.DataFrame, limit: int | None = None) -> list[list[Any]]:
    sub = df if limit is None else df.head(limit)
    return [[to_json_value(v) for v in row] for row in sub.itertuples(index=False, name=None)]


def _isna(v: Any) -> bool:
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False
