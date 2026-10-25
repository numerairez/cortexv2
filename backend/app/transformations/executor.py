"""Allowlisted pandas interpreter for declarative recipes.

Every operation validates its inputs and records diagnostics (row counts, dropped
or unmatched rows, join multiplication) so problems are reported, not hidden.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import pandas as pd

from ..connectors import tabular
from . import expressions
from .recipe import (AppendRows, ConvertTypes, Deduplicate, DeriveColumn, FilterRows, GroupAggregate, Join, Pivot,
                     Recipe, RenameColumns, SelectColumns, SortRows, Unpivot)

MAX_OUTPUT_ROWS = 2_000_000


class StepError(Exception):
    def __init__(self, step_index: int | None, message: str, branch: str | None = None):
        super().__init__(message)
        self.step_index = step_index
        self.message = message
        self.branch = branch   # input role whose own steps failed; None = main flow


@dataclass
class StepReport:
    index: int
    op: str
    rows_in: int
    rows_out: int
    columns: list[dict]
    warnings: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return self.__dict__


Tap = tuple[str | None, int]   # (input role or None for the main flow, after step index; -1 = before any step)


@dataclass
class ExecutionResult:
    df: pd.DataFrame
    steps: list[StepReport]
    warnings: list[str]
    branches: dict[str, list[StepReport]] = field(default_factory=dict)
    taps: dict[Tap, pd.DataFrame] = field(default_factory=dict)   # tables captured part-way, for extra outputs


def _require(df: pd.DataFrame, cols: list[str], what: str = "Column") -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        avail = ", ".join(map(str, df.columns[:30]))
        raise ValueError(f"{what}(s) not found: {', '.join(missing)}. Available: {avail}")


def _coerce_value(series: pd.Series, value: Any) -> Any:
    if value is None:
        return None
    if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
        try:
            return float(value)
        except (TypeError, ValueError):
            raise ValueError(f"'{value}' is not a number, but column '{series.name}' is numeric")
    if pd.api.types.is_datetime64_any_dtype(series):
        try:
            return pd.Timestamp(value)
        except (TypeError, ValueError):
            raise ValueError(f"'{value}' is not a date, but column '{series.name}' holds dates")
    if pd.api.types.is_bool_dtype(series):
        return str(value).strip().lower() in ("true", "yes", "1")
    return str(value)


def _condition_mask(df: pd.DataFrame, c) -> pd.Series:
    s = df[c.column]
    op = c.operator
    blank = s.isna() | (s.astype(str).str.strip() == "")
    if op == "is_blank":
        return blank
    if op == "not_blank":
        return ~blank
    if op in ("in", "not_in"):
        vals = c.value if isinstance(c.value, list) else [c.value]
        picked = [_coerce_value(s, v) for v in vals if v is not None]
        if pd.api.types.is_object_dtype(s):
            # Mixed text/number columns: match on the text form, as the values were picked from it.
            m = s.map(lambda x: None if x is None else str(x)).isin([str(v) for v in picked])
        else:
            m = s.isin(picked)
        if len(picked) < len(vals):
            m = m | blank
        return m if op == "in" else ~m
    if op == "between":
        lo, hi = ([*c.value, None, None][:2] if isinstance(c.value, list) else (None, None))
        m = pd.Series(True, index=s.index)
        try:
            if lo not in (None, ""):
                m &= s >= _coerce_value(s, lo)
            if hi not in (None, ""):
                m &= s <= _coerce_value(s, hi)
        except TypeError:
            raise ValueError(f"Cannot compare column '{c.column}' with '{c.value}'; convert the column type first")
        m = m.fillna(False).astype(bool)
        return m | blank if c.keep_blanks else m
    if op in ("contains", "not_contains", "starts_with"):
        txt = s.astype(object).map(lambda v: "" if v is None or (isinstance(v, float) and np.isnan(v)) else str(v))
        needle = str(c.value or "")
        if op == "starts_with":
            return txt.str.lower().str.startswith(needle.lower())
        m = txt.str.contains(needle, case=False, regex=False)
        return m if op == "contains" else ~m
    v = _coerce_value(s, c.value)
    if isinstance(v, str) and pd.api.types.is_object_dtype(s):
        # Case-insensitive text equality matches how colleagues read spreadsheets.
        lhs = s.map(lambda x: None if x is None else str(x).strip().lower())
        v = v.strip().lower()
    else:
        lhs = s
    try:
        m = {"eq": lhs == v, "ne": lhs != v, "gt": lhs > v, "ge": lhs >= v, "lt": lhs < v, "le": lhs <= v}[op]
    except TypeError:
        raise ValueError(f"Cannot compare column '{c.column}' with '{c.value}'; convert the column type first")
    return m.fillna(False).astype(bool)


NOT_SET_UP = "Not set up yet ({}) — the data passes through unchanged"


def _filter(df, step: FilterRows, tables, rep):
    _require(df, [c.column for c in step.conditions])
    if not step.conditions:
        rep.details["removed_rows"] = 0
        return df
    masks = [_condition_mask(df, c) for c in step.conditions]
    mask = masks[0]
    for m in masks[1:]:
        mask = (mask & m) if step.match == "all" else (mask | m)
    out = df[mask]
    rep.details["removed_rows"] = int(len(df) - len(out))
    if len(out) == 0:
        rep.warnings.append("No rows matched the filter")
    return out


def _select(df, step: SelectColumns, tables, rep):
    _require(df, step.columns)
    if len(set(step.columns)) != len(step.columns):
        raise ValueError("A column is listed twice")
    return df[step.columns]


def _rename(df, step: RenameColumns, tables, rep):
    _require(df, list(step.mapping))
    new_names = [step.mapping.get(c, c) for c in df.columns]
    dupes = sorted({n for n in new_names if new_names.count(n) > 1})
    if dupes:
        raise ValueError(f"Renaming would create duplicate column names: {', '.join(map(str, dupes))}")
    return df.rename(columns=step.mapping)


def _sort(df, step: SortRows, tables, rep):
    _require(df, [k.column for k in step.keys])
    try:
        return df.sort_values([k.column for k in step.keys], ascending=[not k.descending for k in step.keys],
                             kind="stable", na_position="last")
    except TypeError:
        raise ValueError("A sort column mixes numbers and text; convert its type first")


def _append(df, step: AppendRows, tables, rep):
    if not step.inputs:
        rep.warnings.append(NOT_SET_UP.format("choose a table to append"))
        return df
    frames = [df]
    for role in step.inputs:
        if role not in tables:
            raise ValueError(f"Unknown input '{role}'")
        other = tables[role]
        missing = [c for c in df.columns if c not in other.columns]
        extra = [c for c in other.columns if c not in df.columns]
        if (missing or extra) and not step.allow_missing_columns:
            parts = []
            if missing:
                parts.append(f"'{role}' lacks: {', '.join(map(str, missing))}")
            if extra:
                parts.append(f"'{role}' has extra: {', '.join(map(str, extra))}")
            raise ValueError("Tables have different columns — " + "; ".join(parts) +
                             ". Rename/select columns first, or allow missing columns.")
        if missing or extra:
            rep.warnings.append(f"'{role}' columns differ; gaps filled with blanks")
        for c in df.columns:
            if c in other.columns:
                a, b = tabular.column_type(df[c]), tabular.column_type(other[c])
                if "empty" not in (a, b) and a != b and {a, b} != {"integer", "number"}:
                    rep.warnings.append(f"Column '{c}' is {a} in the current table but {b} in '{role}'")
        frames.append(other)
    rep.details["appended_rows"] = {r: int(len(tables[r])) for r in step.inputs}
    return pd.concat(frames, ignore_index=True, sort=False)


def _key_kind(s: pd.Series) -> str:
    t = tabular.column_type(s)
    return "number" if t in ("integer", "number") else t


def _join(df, step: Join, tables, rep):
    if not step.right or not step.left_on:
        rep.warnings.append(NOT_SET_UP.format("choose the table and the columns to match on"))
        return df
    if step.right not in tables:
        raise ValueError(f"Unknown input '{step.right}'")
    right = tables[step.right]
    _require(df, step.left_on, "Left key column")
    _require(right, step.right_on, "Right key column")
    for lk, rk in zip(step.left_on, step.right_on):
        a, b = _key_kind(df[lk]), _key_kind(right[rk])
        if "empty" not in (a, b) and a != b:
            raise ValueError(f"Key types differ: '{lk}' is {a} but '{rk}' is {b}. Use 'Convert types' first.")
    if step.right_columns:
        _require(right, step.right_columns)
        keep = list(dict.fromkeys(list(step.right_on) + list(step.right_columns)))
        right = right[keep]

    right_dupes = int(right.duplicated(subset=step.right_on, keep=False).sum())
    left_dupes = int(df.duplicated(subset=step.left_on, keep=False).sum())
    rep.details.update(right_duplicate_key_rows=right_dupes, left_duplicate_key_rows=left_dupes)
    if step.expected in ("many_to_one", "one_to_one") and right_dupes:
        raise ValueError(
            f"'{step.right}' has {right_dupes} rows with repeated keys ({', '.join(step.right_on)}), so the join "
            "would multiply rows. Remove duplicates first, or set the expected match to many-to-many.")
    if step.expected in ("one_to_many", "one_to_one") and left_dupes:
        raise ValueError(f"The current table has {left_dupes} rows with repeated keys, but a one-to-… match was expected")

    left_null = int(df[step.left_on].isna().any(axis=1).sum())
    if left_null:
        rep.warnings.append(f"{left_null} row(s) have a blank key and cannot match")

    merged = df.merge(right, how=step.how, left_on=step.left_on, right_on=step.right_on,
                      suffixes=("", step.suffix), indicator="__match__")
    counts = merged["__match__"].value_counts()
    left_only = int(counts.get("left_only", 0))
    right_only = int(counts.get("right_only", 0))
    rep.details.update(matched=int(counts.get("both", 0)), unmatched_left=left_only, unmatched_right=right_only)
    if left_only and step.how in ("left", "outer"):
        rep.warnings.append(f"{left_only} row(s) found no match in '{step.right}' (their new columns are blank)")
    if step.how == "inner":
        dropped = len(df) - int((merged["__match__"] == "both").sum())
        if dropped > 0:
            rep.warnings.append(f"Inner join dropped {dropped} unmatched row(s)")
    merged = merged.drop(columns="__match__")
    # Drop duplicated right key columns when they carry the same name as the left keys.
    for lk, rk in zip(step.left_on, step.right_on):
        if lk != rk and rk in merged.columns and step.how in ("left", "inner"):
            merged = merged.drop(columns=rk)
    if len(merged) > MAX_OUTPUT_ROWS:
        raise ValueError(f"Join would produce {len(merged):,} rows, above the safety limit")
    return merged


def _dedupe(df, step: Deduplicate, tables, rep):
    if step.columns:
        _require(df, step.columns)
    out = df.drop_duplicates(subset=step.columns or None, keep=step.keep)
    rep.details["removed_rows"] = int(len(df) - len(out))
    return out


_BOOL_MAP = {"true": True, "yes": True, "y": True, "1": True, "false": False, "no": False, "n": False, "0": False}


def _convert(df, step: ConvertTypes, tables, rep):
    if not step.conversions:
        return df
    _require(df, [c.column for c in step.conversions])
    df = df.copy()
    failures: dict[str, int] = {}
    for conv in step.conversions:
        s = df[conv.column]
        was_null = s.isna()
        if conv.to == "text":
            new = s.map(lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else
                        (v.isoformat() if hasattr(v, "isoformat") else (str(int(v)) if isinstance(v, float) and v.is_integer() else str(v))))
            new = new.astype(object)
        elif conv.to in ("integer", "number"):
            src = s
            if pd.api.types.is_object_dtype(s):
                src = s.map(lambda v: v.replace(",", "").replace("$", "").strip() if isinstance(v, str) else v)
                src = src.map(lambda v: "-" + v[1:-1] if isinstance(v, str) and v.startswith("(") and v.endswith(")") else v)
            new = pd.to_numeric(src, errors="coerce")
            if conv.to == "integer":
                frac = new.dropna() % 1 != 0
                if frac.any():
                    failures[conv.column] = failures.get(conv.column, 0) + int(frac.sum())
                    new = new.where(new % 1 == 0)
                new = new.astype("Int64")
        elif conv.to == "date":
            if conv.date_format:
                new = pd.to_datetime(s, format=conv.date_format, errors="coerce")
            else:
                new = pd.to_datetime(s, errors="coerce", dayfirst=conv.dayfirst, format="mixed") \
                    if pd.api.types.is_object_dtype(s) else pd.to_datetime(s, errors="coerce")
        else:  # boolean
            new = s.map(lambda v: v if isinstance(v, bool) else _BOOL_MAP.get(str(v).strip().lower()) if v is not None else None)
            new = new.astype("boolean")
        failed = int((new.isna() & ~was_null).sum())
        if failed:
            failures[conv.column] = failures.get(conv.column, 0) + failed
        df[conv.column] = new
    if failures:
        msg = "; ".join(f"'{c}': {n} value(s) could not be converted" for c, n in failures.items())
        if step.on_error == "fail":
            raise ValueError(msg)
        rep.warnings.append(msg + " and were left blank")
    rep.details["failed_conversions"] = failures
    return df


def _derive(df, step: DeriveColumn, tables, rep):
    if not step.expression.strip():
        rep.warnings.append(NOT_SET_UP.format("enter a formula"))
        return df
    try:
        values = expressions.evaluate(step.expression, df)
    except expressions.ExpressionError as e:
        raise ValueError(str(e))
    df = df.copy()
    if step.name in df.columns:
        rep.warnings.append(f"Column '{step.name}' was overwritten")
    df[step.name] = values.values
    nulls = int(pd.isna(df[step.name]).sum())
    if nulls:
        rep.details["blank_results"] = nulls
    return df


_AGG = {"sum": "sum", "mean": "mean", "median": "median", "min": "min", "max": "max", "count": "count",
        "count_distinct": "nunique", "first": "first", "last": "last"}
_NUMERIC_AGGS = {"sum", "mean", "median"}


def _check_agg_type(df, column, fn):
    if fn in _NUMERIC_AGGS and not pd.api.types.is_numeric_dtype(df[column]):
        raise ValueError(f"'{fn}' needs a numeric column, but '{column}' is {tabular.column_type(df[column])}. "
                         "Use 'Convert types' first.")


def _group(df, step: GroupAggregate, tables, rep):
    _require(df, step.group_by + [a.column for a in step.aggregations])
    if not step.aggregations:
        if not step.group_by:
            rep.warnings.append(NOT_SET_UP.format("choose columns to group by or a calculation"))
            return df
        return df[step.group_by].drop_duplicates()
    named = {}
    for a in step.aggregations:
        _check_agg_type(df, a.column, a.function)
        out = a.as_ or f"{a.function} of {a.column}"
        if out in named or out in step.group_by:
            raise ValueError(f"Output column '{out}' would appear twice; give it a different name")
        named[out] = pd.NamedAgg(column=a.column, aggfunc=_AGG[a.function])
    if step.group_by:
        blank = int(df[step.group_by].isna().any(axis=1).sum())
        if blank:
            rep.warnings.append(f"{blank} row(s) with a blank group value are grouped under '(blank)'")
        out = df.groupby(step.group_by, dropna=False, sort=True).agg(**named).reset_index()
    else:
        out = pd.DataFrame({k: [df[v.column].agg(v.aggfunc)] for k, v in named.items()})
    return out


def _pivot(df, step: Pivot, tables, rep):
    if not (step.index and step.columns and step.values):
        rep.warnings.append(NOT_SET_UP.format("choose the rows, columns and values"))
        return df
    _require(df, step.index + [step.columns, step.values])
    if step.columns in step.index or step.values in step.index or step.columns == step.values:
        raise ValueError("Pivot row, column, and value fields must all be different columns")
    _check_agg_type(df, step.values, step.function)
    n_cats = int(df[step.columns].nunique())
    if n_cats > 500:
        raise ValueError(f"'{step.columns}' has {n_cats} distinct values — too many to become columns")
    dupes = int(df.duplicated(subset=step.index + [step.columns]).sum())
    if dupes:
        rep.warnings.append(f"{dupes} row(s) share the same index/category and were combined with '{step.function}'")
    out = pd.pivot_table(df, index=step.index, columns=step.columns, values=step.values,
                         aggfunc=_AGG[step.function], dropna=False, observed=True).reset_index()
    out.columns = [str(c) for c in out.columns]
    return out


def _unpivot(df, step: Unpivot, tables, rep):
    _require(df, step.id_columns + (step.value_columns or []))
    clash = {step.variable_name, step.value_name} & set(step.id_columns)
    if clash:
        raise ValueError(f"New column name(s) clash with id columns: {', '.join(clash)}")
    return df.melt(id_vars=step.id_columns, value_vars=step.value_columns, var_name=step.variable_name,
                   value_name=step.value_name)


_DISPATCH: dict[type, Callable] = {
    SelectColumns: _select, RenameColumns: _rename, FilterRows: _filter, SortRows: _sort, AppendRows: _append,
    Join: _join, Deduplicate: _dedupe, ConvertTypes: _convert, DeriveColumn: _derive, GroupAggregate: _group,
    Pivot: _pivot, Unpivot: _unpivot,
}


def check_inputs(recipe: Recipe, tables: dict[str, pd.DataFrame]) -> list[str]:
    """Compare bound tables with the recipe's expected columns; return human-readable problems."""
    problems = []
    for inp in recipe.inputs:
        if inp.role not in tables:
            problems.append(f"Input '{inp.role}' is not bound to a dataset")
            continue
        df = tables[inp.role]
        for col in inp.expected_columns:
            if col.name not in df.columns:
                problems.append(f"Input '{inp.role}' is missing expected column '{col.name}'")
            elif col.type and col.type != "empty":
                actual = tabular.column_type(df[col.name])
                if actual != "empty" and actual != col.type and {actual, col.type} != {"integer", "number"}:
                    problems.append(f"Input '{inp.role}': column '{col.name}' is {actual}, expected {col.type}")
    return problems


ProgressFn = Callable[[str | None, int, str], None]   # (branch, step index, op) — called before each step


def _run_steps(df: pd.DataFrame, steps: list, tables: dict[str, pd.DataFrame], branch: str | None,
               stop_after: int | None, on_step: ProgressFn | None = None,
               taps: dict[Tap, pd.DataFrame | None] | None = None) -> tuple[pd.DataFrame, list[StepReport], list[str]]:
    reports: list[StepReport] = []
    warnings: list[str] = []
    where = f"Input '{branch}' step" if branch else "Step"
    last = len(steps) if stop_after is None else min(stop_after + 1, len(steps))
    if taps is not None and (branch, -1) in taps:
        taps[(branch, -1)] = df
    for i, step in enumerate(steps[:last]):
        if on_step:
            on_step(branch, i, step.op)
        rep = StepReport(index=i, op=step.op, rows_in=int(len(df)), rows_out=0, columns=[])
        try:
            df = _DISPATCH[type(step)](df, step, tables, rep)
        except StepError:
            raise
        except ValueError as e:
            raise StepError(i, str(e), branch) from e
        except Exception as e:  # pandas edge cases surface as clear step errors
            raise StepError(i, f"{e.__class__.__name__}: {e}", branch) from e
        df = df.reset_index(drop=True)
        rep.rows_out = int(len(df))
        rep.columns = tabular.schema_of(df)
        reports.append(rep)
        warnings.extend(f"{where} {i + 1} ({step.op}): {w}" for w in rep.warnings)
        if taps is not None and (branch, i) in taps:
            taps[(branch, i)] = df
    return df, reports, warnings


def execute(recipe: Recipe, tables: dict[str, pd.DataFrame], stop_after: int | None = None,
            branch_stop: tuple[str, int] | None = None, on_step: ProgressFn | None = None,
            taps: list[Tap] | None = None) -> ExecutionResult:
    """Run input branches (each after the inputs it combines), then the main flow.

    ``stop_after`` stops the main flow after that step; ``branch_stop=(role, i)`` returns the
    data of input ``role`` right after its own step ``i`` (and skips the main flow). ``taps``
    lists points whose table is captured on the way, e.g. for extra outputs.
    """
    if recipe.base not in tables:
        raise StepError(None, f"Base input '{recipe.base}' is not bound to a dataset")
    tables = dict(tables)
    raw = dict(tables)
    branches: dict[str, list[StepReport]] = {}
    warnings: list[str] = []
    captured: dict[Tap, pd.DataFrame | None] = {t: None for t in taps or []}
    for role in recipe.branch_order():
        if role not in tables:
            continue
        inp = recipe.input(role)
        stop = branch_stop[1] if branch_stop and branch_stop[0] == role else None
        df_b, reps, warns = _run_steps(tables[role].copy(), inp.steps, tables, role, stop, on_step, captured)
        branches[role] = reps
        warnings.extend(warns)
        if branch_stop and branch_stop[0] == role:
            return ExecutionResult(df=df_b, steps=[], warnings=warnings, branches=branches)
        tables[role] = df_b
    # Inputs without their own steps can still be taken as-is.
    for (role, after) in captured:
        if role is not None and after == -1 and captured[(role, after)] is None and role in raw:
            captured[(role, after)] = raw[role]
    df, reports, warns = _run_steps(tables[recipe.base].copy(), recipe.steps, tables, None, stop_after, on_step, captured)
    return ExecutionResult(df=df, steps=reports, warnings=warnings + warns, branches=branches,
                           taps={k: v for k, v in captured.items() if v is not None})
