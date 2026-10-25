"""Describe-a-chart: the user says what one dashboard object should show, the app builds a prompt for the
approved chatbot, and the pasted reply is validated into that object.

Like AI-drafted workflows, the chatbot only ever proposes a declarative object (fields, aggregations, chart
type, or a Vega-Lite spec); every number is still computed locally from the dataset. Nothing is stored here:
the prompt and reply live only in the user's browser until they apply the result.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..connectors import tabular
from ..core.dashboards import Widget
from ..core.sources import SourceError
from . import prompting

NUMERIC_AGGS = {"sum", "mean", "median", "min", "max"}
MAX_SAMPLE_VALUES = 8
VEGA_LITE_MARKS = {"arc", "area", "bar", "boxplot", "circle", "errorband", "errorbar", "geoshape", "image", "line",
                   "point", "rect", "rule", "square", "text", "tick", "trail"}

CONTRACT = """Reply with exactly ONE JSON object, in one of these shapes:

A chart (preferred whenever it can express the request):
{"type": "chart", "title": "<short title>", "chart": "bar|hbar|line|area|scatter|donut|heatmap",
 "x": "<column along the axis; slices for donut; columns for heatmap>",
 "y": {"agg": "count|sum|mean|median|min|max|distinct", "field": "<column; omit for count>"},
 "color": "<optional column: split/stack series, line per value, point colour, or heatmap rows>",
 "timeUnit": "<optional, only when x is a date: year|yearquarter|yearmonth|yearweek|yearmonthdate>",
 "sort": "value|label", "top": <optional number: keep only the top N categories>}
For "scatter", x and y.field are both number columns plotted as-is (y.agg is ignored).

A headline (one big number):
{"type": "headline", "title": "...", "measure": {"agg": "...", "field": "..."}, "format": "auto|number|currency|percent", "suffix": "<optional unit>"}

A table:
{"type": "table", "title": "...", "mode": "rows", "columns": ["<column>", ...], "limit": 200}
{"type": "table", "title": "...", "mode": "summary", "groupBy": ["<column>", ...], "measures": [{"agg": "...", "field": "..."}]}
{"type": "table", "title": "...", "mode": "pivot", "groupBy": ["<row column>", ...], "pivotColumn": "<column across>",
 "pivotValue": {"agg": "...", "field": "..."}, "totals": true, "heat": true}

Any of the above may add a filter to show only part of the data (same operators as a spreadsheet filter):
 "filter": {"match": "all|any", "conditions": [{"column": "<column>", "operator": "<operator>", "value": <value>}]}
 operators: eq, ne, gt, ge, lt, le, contains, not_contains, starts_with, in, not_in (value is a list),
 between (value [low, high]; dates as "YYYY-MM-DD"; either may be null), is_blank, not_blank (no value).

Only when none of the above can express the request (e.g. reference lines, labels on marks, unusual mark
types), a custom Vega-Lite v6 chart:
{"type": "chart", "title": "...", "vegaLite": { <Vega-Lite spec WITHOUT "data", "datasets" or any URL> }}"""

RULES = """# Rules
- Use column names exactly as listed (case-sensitive). Never invent columns or values.
- sum, mean, median, min and max need a number column; count needs no field; distinct works on any column.
- Do not include numbers from the data in your reply: the tool computes every value itself.
- For "vegaLite": the rows arrive as a named dataset called "table" (do not add "data"); you may use
  "transform" (filter, calculate, aggregate, window, timeUnit…), "layer", "encoding" and "mark". Do not load
  files, images or URLs. To let viewers click it to filter other objects, add a parameter named "sel"
  (a point selection with "fields", or an interval selection).
- To show a subset (one region, a date range, values above a threshold), use "filter" rather than Vega-Lite.
- Keep titles short and in plain language."""

_widget = TypeAdapter(Widget)


def _profile(df) -> list[dict]:
    cols = tabular.profile(df, 0)
    for c in cols:
        c.pop("samples", None)
    return cols


def _sample_lines(df, columns: list[dict]) -> list[str]:
    """A few example values per column, inside untrusted-content markers (only when the user allows it)."""
    out = []
    for c in columns:
        s = df[c["name"]].dropna()
        if s.empty:
            continue
        if c["type"] in ("integer", "number", "date"):
            lo, hi = tabular.to_json_value(s.min()), tabular.to_json_value(s.max())
            out.append(f"{c['name']}: from {lo} to {hi}")
        else:
            vals = [str(tabular.to_json_value(v))[:40] for v in s.unique()[:MAX_SAMPLE_VALUES]]
            more = " …" if s.nunique() > MAX_SAMPLE_VALUES else ""
            out.append(f"{c['name']}: {', '.join(vals)}{more}")
    body = prompting.neutralise("\n".join(out))
    return [f"{prompting.OPEN} examples | example values (approved by the user)>>>", body, f"{prompting.CLOSE} examples>>>"]


def build_prompt(dataset_label: str, df, request: str, current: dict | None, include_samples: bool) -> str:
    request = (request or "").strip()
    if not request:
        raise SourceError("Describe what this object should show")
    columns = _profile(df)
    lines = [
        "You design ONE object (a chart, headline or table) for a dashboard in a local tool. The tool draws it "
        "with Vega-Lite and computes every value itself from the dataset described below.",
        prompting.UNTRUSTED_NOTICE,
        "",
        "# What the user wants",
        prompting.neutralise(request),
    ]
    if current:
        shown = {k: v for k, v in current.items() if k not in ("id", "box")}
        lines += ["", "# The object as it is now (change it as the user asks; keep what they don't mention)",
                  prompting.neutralise(json.dumps(shown, ensure_ascii=False))]
    lines += ["", f"# Dataset: {prompting.neutralise(dataset_label)} ({len(df)} rows)",
              "Columns (name | type | blanks | distinct values):"]
    lines += [f"- {prompting.neutralise(c['name'])} | {c['type']} | {c['nulls']} | {c['distinct']}" for c in columns]
    if include_samples:
        lines += ["", *_sample_lines(df, columns)]
    lines += ["", RULES, "", "# Reply format", CONTRACT, "", "Reply with the JSON object only, no commentary."]
    return "\n".join(lines)


def _fields_of(obj: dict) -> list[str]:
    """Every column a builder object refers to."""
    t = obj.get("type")
    out: list[Any] = []
    measures = []
    if t == "chart":
        out += [obj.get("x"), obj.get("color")]
        measures.append(obj.get("y"))
    elif t == "headline":
        measures.append(obj.get("measure"))
    elif t == "table":
        out += list(obj.get("columns") or []) + list(obj.get("groupBy") or []) + [obj.get("pivotColumn")]
        measures += list(obj.get("measures") or []) + [obj.get("pivotValue")]
    out += [m.get("field") for m in measures if isinstance(m, dict)]
    flt = obj.get("filter")
    if isinstance(flt, dict):
        out += [c.get("column") for c in flt.get("conditions") or [] if isinstance(c, dict)]
    return [f for f in out if isinstance(f, str) and f]


def _vega_lite_problems(spec: Any, names: set[str]) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    if not isinstance(spec, dict):
        return ["\"vegaLite\" must be a JSON object (a Vega-Lite spec)"], []
    derived: set[str] = set()
    used: set[str] = set()

    def walk(node: Any, path: str):
        if isinstance(node, dict):
            for k, v in node.items():
                here = f"{path}.{k}" if path else k
                if k in ("url", "href"):
                    errors.append(f"\"{here}\": charts cannot load files, images or web addresses")
                elif k in ("data", "datasets"):
                    errors.append(f"\"{here}\": leave data out; rows arrive as the named dataset \"table\"")
                elif k == "as":
                    for a in (v if isinstance(v, list) else [v]):
                        if isinstance(a, str):
                            derived.add(a)
                elif k == "field" and isinstance(v, str):
                    used.add(v)
                elif k == "mark":
                    kind = v.get("type") if isinstance(v, dict) else v
                    if isinstance(kind, str) and kind not in VEGA_LITE_MARKS:
                        errors.append(f"\"{here}\": unknown mark type '{kind}'; use one of {', '.join(sorted(VEGA_LITE_MARKS))}")
                walk(v, here)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")

    walk(spec, "")
    unknown = sorted(f for f in used if f not in names and f not in derived and not f.startswith(("sum_", "mean_", "count_")))
    if unknown:
        warnings.append(f"The Vega-Lite spec refers to field(s) not in the dataset: {', '.join(unknown)}")
    return errors, warnings


def accept_reply(df, text: str, current: dict) -> dict:
    """Validate a pasted reply into a dashboard object that keeps the current object's id and position."""
    errors: list[str] = []
    warnings: list[str] = []
    widget = None
    try:
        data = prompting.extract_json(text)
    except ValueError as e:
        data, errors = None, [str(e)]
    if isinstance(data, dict) and isinstance(data.get("object"), dict):
        data = data["object"]  # tolerate {"object": {...}}
    if data is not None and not isinstance(data, dict):
        errors.append("The reply must be one JSON object")
    elif isinstance(data, dict):
        types = {c["name"]: c["type"] for c in tabular.schema_of(df)}
        unknown = [f for f in _fields_of(data) if f not in types]
        if unknown:
            errors.append(f"Unknown column(s): {', '.join(sorted(set(unknown)))}. Use only: {', '.join(types)}")
        measures = [data.get("y"), data.get("measure"), data.get("pivotValue"), *(data.get("measures") or [])]
        for m in measures:
            if isinstance(m, dict) and m.get("agg") in NUMERIC_AGGS and m.get("field") in types \
                    and types[m["field"]] not in ("integer", "number") and not (data.get("chart") == "scatter"):
                errors.append(f"\"{m['agg']}\" needs a number column, but {m['field']} is {types[m['field']]}")
        if data.get("type") == "chart" and data.get("chart") == "scatter" and not data.get("vegaLite"):
            for f in (data.get("x"), (data.get("y") or {}).get("field")):
                if f in types and types[f] not in ("integer", "number"):
                    errors.append(f"A scatter plots numbers on both axes, but {f} is {types[f]}")
        if data.get("timeUnit") and types.get(data.get("x") or "") != "date":
            warnings.append("\"timeUnit\" only applies when x is a date column; it was ignored")
            data.pop("timeUnit")
        if data.get("type") == "chart" and "vegaLite" in data:
            # The builder fields aren't used by a hand-written spec, but every chart carries them.
            data.setdefault("chart", "bar")
            data.setdefault("y", {"agg": "count"})
            e, w = _vega_lite_problems(data["vegaLite"], set(types))
            errors += e
            warnings += w
        if not errors:
            try:
                parsed = _widget.validate_python({**data, "id": current.get("id") or "new",
                                                  "box": current.get("box") or {"x": 0, "y": 0, "w": 6, "h": 8}})
                widget = parsed.model_dump(mode="json", exclude_none=True)
            except ValidationError as e:
                errors += [f"{'.'.join(str(p) for p in x['loc'][1:]) or 'object'}: {x['msg']}" for x in e.errors()[:10]]
    problems = errors + warnings
    return {
        "widget": widget if not errors else None,
        "errors": errors,
        "warnings": warnings,
        "corrective_prompt": prompting.corrective_prompt(problems, CONTRACT) if problems else None,
    }


def correction_prompt(problems: list[str]) -> str:
    """A fix-up prompt for problems found in the browser (e.g. a Vega-Lite spec that doesn't compile)."""
    return prompting.corrective_prompt(problems, CONTRACT)


# ---------------------------------------------------------------- describe the interactions
# The chatbot proposes links in the dashboard's own form ({source, target, effect} plus which field a click
# picks by). Links are routed by the app, not by Vega, so they work between charts, tables, pivots and headlines.

LINKS_CONTRACT = """Reply with exactly ONE JSON object:
{"mode": "replace|add",
 "links": [{"source": "<object id>", "target": "<object id>", "effect": "filter|highlight"}],
 "selectBy": {"<object id>": "<field a click on it picks by>"},
 "notes": ["<anything the user asked for that filter/highlight links cannot do>"]}
- "replace": these links replace the current ones (only the focus object's outgoing links, when a focus is given).
- "add": these links are added to the current ones (a link between the same two objects is updated).
- "selectBy" is optional; only use fields listed as pickable for that object.
- "notes" is optional; leave it empty when everything was possible."""

LINKS_RULES = """# What links can do (nothing else is available)
- filter: when a viewer picks something in the source, the target shows only matching data.
- highlight: the target keeps all data and emphasises the matching part.
- Headlines cannot be a source. Objects marked "filter only" cannot be highlighted.
- A link never connects an object to itself. Each pair of objects has at most one link per direction.
- Drill-down, dropdown/slider controls, hover effects or changing what another chart shows are NOT possible:
  describe such requests in "notes" instead of approximating them."""

HIGHLIGHTABLE_CHARTS = {"bar", "hbar", "line", "area", "scatter"}


def can_drive(w: dict) -> bool:
    return w.get("type") != "headline"


def can_highlight(w: dict) -> bool:
    if w.get("type") in ("table", "headline"):
        return True
    return w.get("type") == "chart" and not w.get("vegaLite") and w.get("chart") in HIGHLIGHTABLE_CHARTS


def _category(t: str | None) -> bool:
    return t in ("text", "boolean")


def pick_info(w: dict, types: dict[str, str]) -> tuple[str, list[str]]:
    """How a viewer picks in this object (in words), and the fields "selectBy" may choose from."""
    t = w.get("type")
    if t == "headline":
        return "cannot be clicked", []
    if t == "table":
        mode = w.get("mode", "rows")
        if mode == "pivot":
            fields = [*w.get("groupBy", []), *([w["pivotColumn"]] if w.get("pivotColumn") else [])]
            return f"a cell picks its row and column ({', '.join(fields)}); a heading picks just that", []
        cols = w.get("groupBy", []) if mode == "summary" else w.get("columns", [])
        fields = [c for c in cols if types.get(c) not in (None, "empty")]
        return "clicking a row picks its value of the 'picks by' field", fields
    if w.get("vegaLite"):
        sel = next((p for p in w["vegaLite"].get("params", []) if isinstance(p, dict) and p.get("name") == "sel"), None)
        return ("its own custom selection" if sel else "cannot be clicked (custom chart without a 'sel' parameter)"), []
    x, color, kind = w.get("x"), w.get("color"), w.get("chart")
    xt = types.get(x or "")
    if kind == "scatter":
        return f"dragging a box picks ranges of {x} and {(w.get('y') or {}).get('field')}", []
    if kind == "heatmap":
        return f"clicking a cell picks {' and '.join(f for f in (x, color) if f)}", []
    if kind in ("bar", "hbar", "line", "area") and (xt == "date" or xt in ("integer", "number")):
        return f"dragging across picks a range of {x}", []
    fields = [f for f in (x, color) if f and _category(types.get(f))]
    return "clicking a mark picks its value of the 'picks by' field", fields


def _objects_section(widgets: list[dict], types: dict[str, str]) -> list[str]:
    lines = []
    for w in widgets:
        how, fields = pick_info(w, types)
        shown = {"headline": lambda: f"shows {json.dumps(w.get('measure'))}",
                 "chart": lambda: f"{w.get('chart')} chart of {json.dumps(w.get('y'))} by {w.get('x')}" + (f", split by {w['color']}" if w.get("color") else ""),
                 "table": lambda: f"{w.get('mode', 'rows')} table" + (f" by {', '.join(w.get('groupBy') or [])}" if w.get("groupBy") else "")}
        desc = "custom Vega-Lite chart" if w.get("vegaLite") else shown.get(w.get("type"), lambda: "")()
        lines.append(f"- id {w['id']} | {w.get('type')} | \"{prompting.neutralise(w.get('title') or '')}\" | {prompting.neutralise(desc)}")
        lines.append(f"    picking: {prompting.neutralise(how)}" + (f"; pickable fields: {', '.join(fields)}" if fields else "")
                     + (f"; picks by now: {w['selectBy']}" if w.get("selectBy") in fields else ""))
        lines.append(f"    can be a source: {'yes' if can_drive(w) and not how.startswith('cannot') else 'no'}; "
                     f"as a target: {'filter or highlight' if can_highlight(w) else 'filter only'}")
    return lines


def build_links_prompt(dataset_label: str, df, spec: dict, request: str, focus: str | None) -> str:
    request = (request or "").strip()
    if not request:
        raise SourceError("Describe how the objects should respond to clicks")
    widgets = spec.get("widgets") or []
    if len(widgets) < 2:
        raise SourceError("Add at least two objects before describing interactions")
    types = {c["name"]: c["type"] for c in tabular.schema_of(df)}
    by_id = {w["id"]: w for w in widgets}
    lines = [
        "You wire up interactions between the objects of a dashboard in a local tool: what happens to other "
        "objects when a viewer clicks or drags in one of them.",
        prompting.UNTRUSTED_NOTICE,
        "",
        "# What the user wants",
        prompting.neutralise(request),
    ]
    if focus and focus in by_id:
        lines += ["", f"# Focus: only the links that START at object {focus} "
                      f"(\"{prompting.neutralise(by_id[focus].get('title') or '')}\") are being decided."]
    lines += ["", f"# Objects (all built on the dataset {prompting.neutralise(dataset_label)})", *_objects_section(widgets, types)]
    current = spec.get("links") or []
    lines += ["", "# Current links"]
    lines += [f"- {l['source']} → {l['target']}: {l.get('effect', 'filter')}" for l in current] or ["- none (the dashboard is static)"]
    lines += ["", LINKS_RULES, "", "# Reply format", LINKS_CONTRACT, "", "Reply with the JSON object only, no commentary."]
    return "\n".join(lines)


def accept_links_reply(df, spec: dict, text: str, focus: str | None) -> dict:
    """Validate proposed links against the dashboard and return the complete resulting set (not yet applied)."""
    errors: list[str] = []
    warnings: list[str] = []
    widgets = spec.get("widgets") or []
    by_id = {w["id"]: w for w in widgets}
    types = {c["name"]: c["type"] for c in tabular.schema_of(df)}
    current = [dict(l) for l in spec.get("links") or []]
    result = {"links": None, "selectBy": {}, "notes": [], "mode": None}
    try:
        data = prompting.extract_json(text)
    except ValueError as e:
        data, errors = None, [str(e)]
    if data is not None and not isinstance(data, dict):
        errors.append("The reply must be one JSON object with a \"links\" list")
    elif isinstance(data, dict):
        mode = data.get("mode", "replace")
        if mode not in ("replace", "add"):
            errors.append("\"mode\" must be \"replace\" or \"add\"")
        proposed = data.get("links")
        if not isinstance(proposed, list):
            errors.append("\"links\" must be a list")
            proposed = []
        seen: set[tuple[str, str]] = set()
        clean = []
        for i, l in enumerate(proposed):
            where = f"links[{i}]"
            if not isinstance(l, dict):
                errors.append(f"{where} must be an object"); continue
            s, t, eff = l.get("source"), l.get("target"), l.get("effect", "filter")
            if s not in by_id or t not in by_id:
                bad = [x for x in (s, t) if x not in by_id]
                errors.append(f"{where}: unknown object id {', '.join(map(str, bad))}; use only: {', '.join(by_id)}"); continue
            if s == t:
                errors.append(f"{where}: an object cannot be linked to itself"); continue
            if focus and s != focus:
                errors.append(f"{where}: only links starting at {focus} were asked for"); continue
            if eff not in ("filter", "highlight"):
                errors.append(f"{where}: effect must be \"filter\" or \"highlight\" (other interactions aren't available)"); continue
            if not can_drive(by_id[s]) or pick_info(by_id[s], types)[0].startswith("cannot"):
                errors.append(f"{where}: {s} (\"{by_id[s].get('title')}\") cannot be clicked, so it cannot be a source"); continue
            if eff == "highlight" and not can_highlight(by_id[t]):
                errors.append(f"{where}: {t} (\"{by_id[t].get('title')}\") can only be filtered, not highlighted"); continue
            if (s, t) in seen:
                warnings.append(f"{where}: duplicate link {s} → {t} ignored"); continue
            seen.add((s, t))
            clean.append({"source": s, "target": t, "effect": eff})
        picks = data.get("selectBy") or {}
        if not isinstance(picks, dict):
            errors.append("\"selectBy\" must map object ids to field names"); picks = {}
        for wid, field in picks.items():
            if wid not in by_id:
                errors.append(f"selectBy: unknown object id {wid}"); continue
            allowed = pick_info(by_id[wid], types)[1]
            if not allowed:
                warnings.append(f"selectBy: {wid} doesn't pick by a single field; ignored")
            elif field not in allowed:
                errors.append(f"selectBy: {wid} can pick by {', '.join(allowed)}, not {field}")
            else:
                result["selectBy"][wid] = field
        notes = data.get("notes") or []
        result["notes"] = [str(n)[:300] for n in notes if str(n).strip()][:10] if isinstance(notes, list) else []
        if not errors:
            ids = {l["id"] for l in current}

            def new_id():
                while True:
                    i = "l" + uuid.uuid4().hex[:6]
                    if i not in ids:
                        ids.add(i)
                        return i
            existing = {(l["source"], l["target"]): l for l in current}
            if mode == "replace":
                kept = [l for l in current if focus and l["source"] != focus]
            else:
                kept = [l for l in current if (l["source"], l["target"]) not in seen]
            final = kept + [{"id": existing.get((l["source"], l["target"]), {}).get("id") or new_id(), **l} for l in clean]
            result["links"] = final
            result["mode"] = mode
    problems = errors + warnings
    return {**result, "links": result["links"] if not errors else None, "errors": errors, "warnings": warnings,
            "corrective_prompt": prompting.corrective_prompt(problems, LINKS_CONTRACT) if problems else None}
