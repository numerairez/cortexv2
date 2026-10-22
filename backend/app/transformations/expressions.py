"""Safe, vectorised formula language for calculated columns.

Syntax: column references in square brackets, e.g. ``[Quantity] * [Unit Price]``.
Supported: numbers, 'text', + - * /, comparisons, and/or/not, parentheses, and an
allowlist of functions. Expressions are parsed with ``ast`` and interpreted node by
node; nothing is ever passed to ``eval``/``exec``.
"""

from __future__ import annotations

import ast
import operator
import re
from typing import Any, Callable

import numpy as np
import pandas as pd

MAX_DEPTH = 30


class ExpressionError(Exception):
    pass


_COLUMN_RE = re.compile(r"\[([^\[\]]+)\]")

_BINOPS: dict[type, Callable] = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
}
_CMPOPS: dict[type, Callable] = {
    ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Gt: operator.gt, ast.GtE: operator.ge,
    ast.Lt: operator.lt, ast.LtE: operator.le,
}


def _series(x: Any, index) -> pd.Series:
    return x if isinstance(x, pd.Series) else pd.Series([x] * len(index), index=index, dtype=object)


def _text(x, index):
    s = _series(x, index)
    return s.map(lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else str(v))


def _if(cond, a, b, index):
    c = _series(cond, index).fillna(False).astype(bool)
    return pd.Series(np.where(c, _series(a, index), _series(b, index)), index=index)


def _coalesce(*args, index):
    out = _series(args[0], index)
    for a in args[1:]:
        out = out.where(out.notna(), _series(a, index))
    return out


def _dt(x, index):
    return pd.to_datetime(_series(x, index), errors="coerce")


FUNCTIONS: dict[str, tuple[int, int, Callable]] = {
    # name: (min_args, max_args, fn(*args, index=...))
    "round": (1, 2, lambda x, n=0, index=None: pd.to_numeric(_series(x, index), errors="coerce").round(int(n))),
    "abs": (1, 1, lambda x, index=None: pd.to_numeric(_series(x, index), errors="coerce").abs()),
    "upper": (1, 1, lambda x, index=None: _text(x, index).str.upper()),
    "lower": (1, 1, lambda x, index=None: _text(x, index).str.lower()),
    "trim": (1, 1, lambda x, index=None: _text(x, index).str.strip()),
    "len": (1, 1, lambda x, index=None: _text(x, index).str.len()),
    "concat": (1, 20, lambda *a, index=None: _concat(a, index)),
    "if_": (3, 3, lambda c, a, b, index=None: _if(c, a, b, index)),
    "coalesce": (2, 10, lambda *a, index=None: _coalesce(*a, index=index)),
    "year": (1, 1, lambda x, index=None: _dt(x, index).dt.year.astype("Int64")),
    "month": (1, 1, lambda x, index=None: _dt(x, index).dt.month.astype("Int64")),
    "day": (1, 1, lambda x, index=None: _dt(x, index).dt.day.astype("Int64")),
    "isblank": (1, 1, lambda x, index=None: _series(x, index).isna() | (_text(x, index).str.strip() == "")),
}


def _concat(args, index):
    out = pd.Series([""] * len(index), index=index, dtype=object)
    for a in args:
        out = out + _text(a, index).fillna("")
    return out


_STRING_RE = re.compile(r"('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")")


def _normalise_code(code: str) -> str:
    """Accept spreadsheet habits outside string literals: = <> AND OR NOT, and the keyword ``if(``."""
    code = re.sub(r"<>", "!=", code)
    code = re.sub(r"(?<![=!<>])=(?!=)", "==", code)
    code = re.sub(r"\b(AND|OR|NOT)\b", lambda m: m.group(1).lower(), code)
    code = re.sub(r"\b(?:if|IF)\s*\(", "if_(", code)
    return code


def compile_expression(expr: str) -> tuple[ast.Expression, dict[str, str]]:
    """Return a validated AST and the mapping of placeholder names to column names."""
    columns: dict[str, str] = {}

    def repl(m: re.Match) -> str:
        name = m.group(1).strip()
        key = f"__c{len(columns)}"
        for k, v in columns.items():
            if v == name:
                return k
        columns[key] = name
        return key

    parts = _STRING_RE.split(expr)
    # Even indices are code, odd indices are quoted strings left untouched.
    src = "".join(p if i % 2 else _normalise_code(_COLUMN_RE.sub(repl, p)) for i, p in enumerate(parts))
    code_only = "".join(p for i, p in enumerate(parts) if not i % 2)
    if "[" in _COLUMN_RE.sub("", code_only) or "]" in _COLUMN_RE.sub("", code_only):
        raise ExpressionError("Unbalanced [ ] in column reference")
    try:
        tree = ast.parse(src, mode="eval")
    except SyntaxError as e:
        raise ExpressionError(f"Could not read the formula: {e.msg}") from e
    _check(tree.body, columns, 0)
    return tree, columns


def _check(node: ast.AST, columns: dict[str, str], depth: int) -> None:
    if depth > MAX_DEPTH:
        raise ExpressionError("Formula is too deeply nested")
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float, str, bool)) and node.value is not None:
            raise ExpressionError("Unsupported literal")
        return
    if isinstance(node, ast.Name):
        if node.id in columns or node.id in ("True", "False", "None"):
            return
        raise ExpressionError(f"Unknown name '{node.id}'. Put column names in square brackets, e.g. [{node.id}]")
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        _check(node.left, columns, depth + 1)
        _check(node.right, columns, depth + 1)
        return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd, ast.Not)):
        _check(node.operand, columns, depth + 1)
        return
    if isinstance(node, ast.BoolOp):
        for v in node.values:
            _check(v, columns, depth + 1)
        return
    if isinstance(node, ast.Compare) and all(type(o) in _CMPOPS for o in node.ops):
        _check(node.left, columns, depth + 1)
        for c in node.comparators:
            _check(c, columns, depth + 1)
        return
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
            name = getattr(node.func, "id", "?")
            allowed = ", ".join(sorted(f.rstrip("_") for f in FUNCTIONS))
            raise ExpressionError(f"Function '{name}' is not allowed. Allowed: {allowed}")
        if node.keywords:
            raise ExpressionError("Named arguments are not supported")
        lo, hi, _ = FUNCTIONS[node.func.id]
        if not lo <= len(node.args) <= hi:
            raise ExpressionError(f"{node.func.id.rstrip('_')}() takes {lo}–{hi} arguments")
        for a in node.args:
            _check(a, columns, depth + 1)
        return
    raise ExpressionError(f"'{ast.unparse(node)}' is not supported in formulas")


def referenced_columns(expr: str) -> list[str]:
    return list(compile_expression(expr)[1].values())


def evaluate(expr: str, df: pd.DataFrame) -> pd.Series:
    tree, columns = compile_expression(expr)
    missing = [c for c in columns.values() if c not in df.columns]
    if missing:
        raise ExpressionError(f"Unknown column(s): {', '.join(missing)}")
    env = {k: df[v] for k, v in columns.items()}
    index = df.index

    def ev(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env.get(node.id, {"True": True, "False": False, "None": None}.get(node.id))
        if isinstance(node, ast.BinOp):
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Div):
                right = _series(right, index).replace(0, np.nan) if isinstance(right, pd.Series) else (
                    np.nan if right == 0 else right)
            try:
                return _BINOPS[type(node.op)](left, right)
            except TypeError as e:
                raise ExpressionError(
                    f"Cannot apply '{ast.unparse(node)}' to these column types; convert types first") from e
        if isinstance(node, ast.UnaryOp):
            v = ev(node.operand)
            if isinstance(node.op, ast.USub):
                return -v
            if isinstance(node.op, ast.UAdd):
                return v
            return ~_series(v, index).fillna(False).astype(bool)
        if isinstance(node, ast.BoolOp):
            vals = [_series(ev(v), index).fillna(False).astype(bool) for v in node.values]
            out = vals[0]
            for v in vals[1:]:
                out = (out & v) if isinstance(node.op, ast.And) else (out | v)
            return out
        if isinstance(node, ast.Compare):
            left = ev(node.left)
            result = None
            for op, comp in zip(node.ops, node.comparators):
                right = ev(comp)
                try:
                    r = _CMPOPS[type(op)](left, right)
                except TypeError as e:
                    raise ExpressionError(f"Cannot compare in '{ast.unparse(node)}'; check column types") from e
                result = r if result is None else (result & r)
                left = right
            return result
        if isinstance(node, ast.Call):
            fn = FUNCTIONS[node.func.id][2]
            return fn(*[ev(a) for a in node.args], index=index)
        raise ExpressionError("Unsupported expression")  # unreachable after _check

    return _series(ev(tree.body), index)
