"""Data Transformation Studio: deterministic recipe execution, plus optional AI-proposed recipes.

Both manual and AI-proposed recipes go through the same pydantic schema and the
same allowlisted executor. Pasted AI output is only ever parsed as recipe JSON.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from pydantic import ValidationError

from ..connectors import documents, tabular
from ..core import context, runs, sources
from ..storage import db
from ..core.sources import SourceError
from ..transformations import executor, export
from ..transformations.recipe import OPERATION_CATALOG, Recipe
from . import prompting
from .base import OptionField, ResponseOutcome, Service, register


def load_bindings(bindings: dict[str, str]) -> tuple[dict[str, pd.DataFrame], list[dict]]:
    """Load each bound dataset. A binding is a sheet selection id, or a data template
    (``tpl_x`` for the newest file, ``tpl_x@value`` for a specific one). Returns tables and provenance."""
    from ..core import templates

    tables: dict[str, pd.DataFrame] = {}
    info: list[dict] = []
    for role, ref in bindings.items():
        tpl_info: dict[str, Any] = {}
        if ref.startswith("tpl_"):
            r = templates.resolve(ref)
            path, cfg = r["path"], r["config"]
            label = f"{r['template']['name']} — {r['match']['label']}"
            source_id = None
            tpl_info = {"template_id": r["template"]["id"], "template_value": r["match"]["value"],
                        "template_latest": r["latest"]}
        else:
            sel = sources.get_selection(ref)
            if sel["kind"] != "sheet":
                raise SourceError(f"Input '{role}' must be a sheet/CSV selection")
            src = sources.get_source(sel["source_id"])
            path, cfg, label, source_id = Path(src["location"]), sel["config"], sel["label"], src["id"]
        try:
            fp = documents.fingerprint_file(path)
            t = tabular.load_table(path, cfg["sheet"], int(cfg.get("header_row") or 1), cfg.get("columns") or None)
        except (tabular.TabularError, documents.DocumentError) as e:
            raise SourceError(f"Input '{role}' ({label}): {e}")
        warnings = list(t.warnings)
        if tpl_info:
            drift = templates.check_schema(r["template"], t.df)
            if drift:
                warnings.append(drift)
        tables[role] = t.df
        info.append({"role": role, "selection_id": ref, "label": label, "source_id": source_id,
                     "path": str(path), "sheet": cfg["sheet"], "header_row": t.header_row, "rows": int(len(t.df)),
                     "sha256": fp["sha256"], "warnings": warnings, "letters": t.letters, **tpl_info})
    return tables, info


def parse_recipe(data: Any) -> Recipe:
    try:
        return Recipe.model_validate(data)
    except ValidationError as e:
        raise SourceError("Recipe is not valid: " + "; ".join(_fmt_validation(e)), 422)


def _fmt_validation(e: ValidationError) -> list[str]:
    out = []
    for err in e.errors()[:30]:
        loc = ".".join(str(p) for p in err["loc"] if not (isinstance(p, str) and p in {
            "select_columns", "rename_columns", "filter_rows", "sort_rows", "append_rows", "join", "deduplicate",
            "convert_types", "derive_column", "group_aggregate", "pivot", "unpivot"}))
        loc = loc.replace("steps.", "step ")
        out.append(f"{loc}: {err['msg']}" if loc else err["msg"])
    return out


def column_profiles(df: pd.DataFrame, max_columns: int = 80, top: int = 8, bins: int = 8) -> list[dict]:
    """Per-column distribution summaries for the profile pane: top values, or histogram bins."""
    out = []
    for col in list(df.columns)[:max_columns]:
        s = df[col]
        kind = tabular.column_type(s)
        nonnull = s.dropna()
        entry: dict[str, Any] = {"name": str(col), "type": kind, "nulls": int(s.isna().sum()),
                                 "distinct": int(nonnull.nunique()), "count": int(len(s))}
        if kind in ("integer", "number", "date") and nonnull.nunique() > top:
            # Normalise to ns so the integer form matches pd.Timestamp(int) regardless of pandas resolution.
            vals = nonnull.astype("datetime64[ns]").astype("int64") if kind == "date" else pd.to_numeric(nonnull)
            counts, edges = np.histogram(vals.to_numpy(dtype="float64"), bins=bins)
            fmt = (lambda v: pd.Timestamp(int(v)).date().isoformat()) if kind == "date" else (lambda v: float(v))
            entry["bins"] = [{"from": fmt(edges[i]), "to": fmt(edges[i + 1]), "count": int(c)}
                             for i, c in enumerate(counts)]
        else:
            vc = nonnull.value_counts()
            entry["top"] = [{"value": tabular.to_json_value(k), "count": int(v)} for k, v in vc.head(top).items()]
            entry["other"] = int(vc.iloc[top:].sum()) if len(vc) > top else 0
        out.append(entry)
    return out


def column_values(recipe: Recipe, bindings: dict[str, str], column: str, before: int = 0,
                  branch: str | None = None, limit: int = 1000, bins: int = 24) -> dict:
    """What a filter can pick from: the distinct values (with counts) and, for numbers and dates,
    the range and a histogram of ``column`` as it enters step ``before`` of the main flow, or of
    input ``branch``'s own steps."""
    tables, _ = load_bindings(bindings)
    try:
        if branch:
            df = executor.execute(recipe, tables, branch_stop=(branch, before - 1)).df
        else:
            df = executor.execute(recipe, tables, stop_after=before - 1).df
    except executor.StepError as e:
        return {"type": "unknown", "values": [], "error": e.message}
    if column not in df.columns:
        return {"type": "unknown", "values": [], "error": f"Column '{column}' is not available at this step"}
    s = df[column]
    kind = tabular.column_type(s)
    nonnull = s.dropna()
    vc = nonnull.value_counts()
    out: dict[str, Any] = {"type": kind, "count": int(len(s)), "nulls": int(s.isna().sum()),
                           "distinct": int(len(vc)), "truncated": len(vc) > limit,
                           "values": [{"value": tabular.to_json_value(k), "count": int(v)} for k, v in vc.head(limit).items()]}
    if kind in ("integer", "number", "date") and len(nonnull):
        vals = nonnull.astype("datetime64[ns]").astype("int64") if kind == "date" else pd.to_numeric(nonnull)
        arr = vals.to_numpy(dtype="float64")
        fmt = (lambda v: pd.Timestamp(int(v)).date().isoformat()) if kind == "date" else \
            (lambda v: int(v) if kind == "integer" and float(v).is_integer() else float(v))
        counts, edges = np.histogram(arr, bins=bins)
        out["min"], out["max"] = fmt(arr.min()), fmt(arr.max())
        out["bins"] = [{"from": fmt(edges[i]), "to": fmt(edges[i + 1]), "count": int(n)} for i, n in enumerate(counts)]
    return out


def preview(recipe: Recipe, bindings: dict[str, str], upto: int | None = None, limit: int = 200,
            view_role: str | None = None) -> dict:
    """Report on every step (input branches and main flow) and return a data preview:
    main flow after step ``upto`` (None = final, -1 = the base input), or, with ``view_role``,
    that input raw (``upto`` None/-1) or after its own step ``upto``."""
    tables, info = load_bindings(bindings)
    problems = executor.check_inputs(recipe, tables)
    result: dict[str, Any] = {"inputs": info, "input_problems": problems, "steps": [], "branches": {}, "error": None}
    branch_steps = {i.role: i.steps for i in recipe.inputs}
    try:
        res = executor.execute(recipe, tables)
    except executor.StepError as e:
        result["error"] = {"step": e.step_index, "branch": e.branch, "message": e.message}
        # Re-run up to the failing step so the reports before it are still shown.
        try:
            if e.branch:
                res = executor.execute(recipe, tables, branch_stop=(e.branch, (e.step_index or 0) - 1)) \
                    if e.step_index else None
            else:
                res = executor.execute(recipe, tables, stop_after=e.step_index - 1) if e.step_index else None
        except executor.StepError:
            res = None
        if res is None:
            return result
    result["steps"] = [s.as_dict() for s in res.steps]
    result["branches"] = {r: [x.as_dict() for x in reps] for r, reps in res.branches.items()}
    result["warnings"] = res.warnings
    if view_role is not None:
        if view_role not in tables:
            raise SourceError(f"Unknown input '{view_role}'")
        if upto is not None and upto >= 0 and branch_steps.get(view_role):
            df = executor.execute(recipe, tables, branch_stop=(view_role, upto)).df
        else:
            df = tables[view_role]
    elif upto is not None and upto < len(res.steps) - 1:
        df = tables[recipe.base] if upto < 0 else executor.execute(recipe, tables, stop_after=upto).df
    else:
        df = res.df
    result["data"] = {"columns": [str(c) for c in df.columns], "rows": tabular.records(df, limit),
                      "row_count": int(len(df)), "schema": tabular.schema_of(df),
                      "profile": column_profiles(df)}
    return result


def execute_to_artifacts(recipe: Recipe, bindings: dict[str, str], title: str,
                         recipe_version_id: str | None = None, background: bool = False) -> dict:
    """Create a run and execute it. With ``background`` the run returns immediately (status
    "running") and reports progress in ``state.progress`` while a worker thread does the work."""
    run = runs.create_run("transformation", title, {"bindings": bindings, "recipe": recipe.model_dump(
        mode="json", by_alias=True, exclude_none=True)}, status="running")
    if recipe_version_id:
        runs.update_run(run["id"], recipe_version_id=recipe_version_id)
    runs.update_run(run["id"], state={"progress": {"stage": "queued", "message": "Starting…", "done": 0,
                                                   "total": _total_steps(recipe), "started": time.time()}})
    if background:
        threading.Thread(target=_perform_run, args=(run["id"], recipe, bindings, title), daemon=True).start()
        return runs.get_run(run["id"])
    _perform_run(run["id"], recipe, bindings, title)
    return runs.get_run(run["id"])


def _total_steps(recipe: Recipe) -> int:
    return len(recipe.steps) + sum(len(i.steps) for i in recipe.inputs)


def output_basename(name: str, when: datetime | None = None) -> str:
    """Fill {date}/{time} in an output file name and make it safe for the file system."""
    when = when or datetime.now()
    return runs.safe_filename(name.replace("{date}", when.strftime("%Y-%m-%d")).replace("{time}", when.strftime("%H%M")))


def check_output_folder(folder: str) -> Path:
    p = Path(folder.strip().strip('"')).expanduser()
    if not p.is_absolute():
        raise SourceError(f"The output folder must be a full path, e.g. S:\\Finance\\Reports (got “{folder}”)")
    if not p.is_dir():
        raise SourceError(f"The output folder was not found: {p}. Check the network drive or choose another folder.")
    if not os.access(p, os.W_OK):
        raise SourceError(f"You don't have permission to save in {p}")
    return p


def _free_name(dest: Path) -> Path:
    n = 2
    candidate = dest
    while candidate.exists():
        candidate = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
        n += 1
    return candidate


def _perform_run(run_id: str, recipe: Recipe, bindings: dict[str, str], title: str) -> None:
    started = time.time()
    total = _total_steps(recipe)
    progress = {"stage": "read", "message": "", "done": 0, "total": total, "started": started,
                "inputs_done": 0, "inputs_total": len(bindings)}

    def report(**kw):
        progress.update(kw)
        runs.update_run(run_id, state={"progress": dict(progress)})

    try:
        # 0. Check the output folder first, so a missing share fails before any work is done.
        out_folder = check_output_folder(recipe.output.folder) if recipe.output.folder else None

        # 1. Read inputs one by one so the user sees which file is being opened.
        tables: dict[str, pd.DataFrame] = {}
        info: list[dict] = []
        for n, (role, ref) in enumerate(bindings.items()):
            report(stage="read", message=f"Reading {role}…", inputs_done=n)
            t, i = load_bindings({role: ref})
            tables.update(t)
            info.extend(i)
        report(inputs_done=len(bindings))
        problems = executor.check_inputs(recipe, tables)
        snap = context.create_snapshot(None, [], {"inputs": info})

        # 2. Run the steps.
        done = {"n": 0}

        def on_step(branch, i, op):
            label = op.replace("_", " ")
            report(stage="steps", done=done["n"], message=(f"{branch}: " if branch else "") + f"step {i + 1} — {label}")
            done["n"] += 1

        try:
            res = executor.execute(recipe, tables, on_step=on_step)
        except executor.StepError as e:
            where = f"Input '{e.branch}' step" if e.branch else "Step"
            step = f"{where} {e.step_index + 1}: " if e.step_index is not None else ""
            runs.update_run(run_id, status="failed", snapshot_id=snap,
                            state={"progress": {**progress, "stage": "failed", "message": e.message}, "inputs": info},
                            errors=problems + [step + e.message],
                            summary={"inputs": len(info), "duration_ms": int((time.time() - started) * 1000),
                                     "failed_step": e.step_index, "failed_branch": e.branch})
            return

        # 3. Write the output files.
        summary_rows: list[tuple[str, Any]] = [("Run", run_id), ("Created", db.now()), ("Recipe", title)]
        for i in info:
            summary_rows.append((f"Input: {i['role']}", f"{i['path']} | sheet {i['sheet']} | header row {i['header_row']} "
                                                        f"| {i['rows']} rows | sha256 {i['sha256'][:16]}"))
        for role, reps in res.branches.items():
            for s_ in reps:
                summary_rows.append((f"Input {role} step {s_.index + 1}: {s_.op}", f"{s_.rows_in} → {s_.rows_out} rows"
                                     + (f" | {json.dumps(s_.details, default=str)}" if s_.details else "")))
        for s_ in res.steps:
            summary_rows.append((f"Step {s_.index + 1}: {s_.op}", f"{s_.rows_in} → {s_.rows_out} rows"
                                 + (f" | {json.dumps(s_.details, default=str)}" if s_.details else "")))
        for w in problems + res.warnings:
            summary_rows.append(("Warning", w))
        summary_rows.append(("Output rows", len(res.df)))

        base = output_basename(recipe.output.name)
        saved_to: list[str] = []
        save_error = None
        for fmt in recipe.output.formats:
            report(stage="write", done=total, message=f"Writing {base}.{fmt}…")
            p = runs.artifact_path(run_id, f"{base}.{fmt}")
            if fmt == "xlsx":
                export.write_xlsx(res.df, p, summary_rows + ([("Saved to folder", str(out_folder))] if out_folder else []))
            else:
                export.write_csv(res.df, p)
            meta: dict[str, Any] = {"rows": int(len(res.df))}
            if out_folder and not save_error:
                dest = out_folder / p.name
                if recipe.output.if_exists == "keep_both":
                    dest = _free_name(dest)
                report(message=f"Saving {dest.name} to {out_folder}…")
                try:
                    shutil.copy2(p, dest)
                    meta["saved_to"] = str(dest)
                    saved_to.append(str(dest))
                except OSError as e:   # e.g. the file is open in Excel, or the share went away
                    save_error = f"Could not save to {dest}: {e.strerror or e}. The result is still available here to download."
            runs.register_artifact(run_id, fmt, p, meta)
        duration = int((time.time() - started) * 1000)
        runs.update_run(
            run_id, status="completed", snapshot_id=snap,
            state={"steps": [x.as_dict() for x in res.steps], "inputs": info,
                   "branches": {r: [x.as_dict() for x in reps] for r, reps in res.branches.items()},
                   "progress": {**progress, "stage": "done", "done": total, "message": "Done"}},
            errors=[], summary={"output_rows": int(len(res.df)), "output_columns": int(res.df.shape[1]),
                                "steps": len(res.steps), "warnings": problems + res.warnings + ([save_error] if save_error else []),
                                "inputs": len(info), "duration_ms": duration,
                                "saved_to": saved_to, "output_folder": str(out_folder) if out_folder else None,
                                "save_error": save_error},
        )
    except Exception as e:  # missing files, locked files, disk full… — always end the run visibly
        message = str(e) if isinstance(e, SourceError) else f"{e.__class__.__name__}: {e}"
        runs.update_run(run_id, status="failed",
                        state={"progress": {**progress, "stage": "failed", "message": message}},
                        errors=[message], summary={"duration_ms": int((time.time() - started) * 1000)})


class TransformationService(Service):
    id = "transformation"
    name = "Data Transformation Studio"
    description = ("Combine, clean, and summarise Excel/CSV tables with a step-by-step builder. Runs locally; "
                   "saved recipes can be rerun on next month's files. Optionally ask your AI chatbot to draft "
                   "the steps.")
    mode = "deterministic"
    input_kind = "datasets"
    accepts = ["sheet"]
    outputs = ["Excel (.xlsx)", "CSV"]
    builder_route = "/workflows/new"


RECIPE_EXAMPLES = [
    {"op": "select_columns", "columns": ["Date", "Region", "Amount"]},
    {"op": "rename_columns", "mapping": {"Amt": "Amount"}},
    {"op": "filter_rows", "match": "all", "conditions": [
        {"column": "Region", "operator": "eq", "value": "Luzon"},
        {"column": "Amount", "operator": "gt", "value": 0}]},
    {"op": "sort_rows", "keys": [{"column": "Amount", "descending": True}]},
    {"op": "append_rows", "inputs": ["february"], "allow_missing_columns": False},
    {"op": "join", "right": "products", "left_on": ["Product ID"], "right_on": ["ID"], "how": "left",
     "expected": "many_to_one", "right_columns": ["Category"]},
    {"op": "deduplicate", "columns": ["Transaction ID"], "keep": "first"},
    {"op": "convert_types", "conversions": [{"column": "Date", "to": "date", "dayfirst": False},
                                            {"column": "Amount", "to": "number"}], "on_error": "blank"},
    {"op": "derive_column", "name": "Revenue", "expression": "[Quantity] * [Unit Price]"},
    {"op": "group_aggregate", "group_by": ["Region"], "aggregations": [
        {"column": "Revenue", "function": "sum", "as": "Total revenue"}]},
    {"op": "pivot", "index": ["Region"], "columns": "Month", "values": "Revenue", "function": "sum"},
    {"op": "unpivot", "id_columns": ["Region"], "value_columns": ["Jan", "Feb"], "variable_name": "Month",
     "value_name": "Revenue"},
]

RECIPE_CONTRACT = """{
  "schema_version": 1,
  "inputs": [{"role": "<role name exactly as given>", "steps": [ <optional preparation steps for this input only> ]}],
  "base": "<role the pipeline starts from>",
  "steps": [ <steps, in order> ],
  "output": {"name": "<file name>", "formats": ["xlsx"]}
}"""


def inputs_section(ctx: dict) -> list[str]:
    """Prompt lines describing each bound input: columns (with Excel letters) and optional samples."""
    lines: list[str] = []
    for inp in ctx["inputs"]:
        lines.append(f"\n## Input role: {inp['role']} ({inp['rows']} rows; from {prompting.neutralise(inp['label'])})")
        if inp.get("header_row"):
            lines.append(f"Header is on Excel row {inp['header_row']}; data starts on row {inp['header_row'] + 1}.")
        lines.append("Columns (name | Excel column | type | blanks | distinct):")
        letters = inp.get("letters") or {}
        for c in inp["columns"]:
            lines.append(f"- {prompting.neutralise(c['name'])} | {letters.get(c['name'], '?')} | {c['type']} | "
                         f"{c['nulls']} | {c['distinct']}")
        if inp.get("sample"):
            body = "\n".join(" | ".join("" if v is None else str(v) for v in r) for r in inp["sample"]["rows"])
            head = " | ".join(inp["sample"]["columns"])
            lines.append(f"{prompting.OPEN} sample-{inp['role']} | approved sample rows>>>\n"
                         f"{prompting.neutralise(head)}\n{prompting.neutralise(body)}\n"
                         f"{prompting.CLOSE} sample-{inp['role']}>>>")
    return lines


def operations_section() -> list[str]:
    lines = ["# Operations (use only these; one JSON object per step)"]
    for cat, ex in zip(OPERATION_CATALOG, RECIPE_EXAMPLES):
        lines.append(f"- {cat['op']}: {cat['help']}\n  e.g. {json.dumps(ex)}")
    lines += [
        "",
        "Notes:",
        "- filter operators: eq, ne, gt, ge, lt, le, contains, not_contains, starts_with, in, not_in, between (value [low, high]), is_blank, not_blank",
        "- join.expected: many_to_one (lookup), one_to_one, one_to_many, many_to_many; join.how: left, inner, right, outer",
        "- derive_column expressions reference columns in [square brackets] and may use + - * /, comparisons, "
        "and/or/not, and functions round, abs, upper, lower, trim, len, concat, if, coalesce, year, month, day, isblank",
        "- aggregate functions: sum, mean, median, min, max, count, count_distinct, first, last",
        "- Column names must match exactly (case-sensitive). Convert text to number/date before arithmetic or sums.",
        "- \"inputs\" must use exactly the input role names given above; \"base\" is the role the main flow starts from.",
        "- A non-base input may have its own \"steps\" (any operation except join/append_rows). They run first, so the "
        "main flow can join/append the prepared result. Use this when the same data is needed twice with different "
        "preparation (e.g. two roles bound to the same file: this month vs. last month, or two filtered subsets).",
    ]
    return lines


def validate_recipe_reply(data: Any, run: dict, out: ResponseOutcome) -> Recipe | None:
    """Shared validation for AI-proposed recipes: schema, known roles, and a dry run on the real data."""
    try:
        recipe = Recipe.model_validate(data)
    except ValidationError as e:
        out.errors.extend(_fmt_validation(e))
        return None
    roles = run["state"].get("roles") or []
    bad = [r for r in recipe.roles() if r not in roles]
    if bad:
        out.errors.append(f"Unknown input role(s) {', '.join(bad)}; use only: {', '.join(roles)}")
        return None
    pv = preview(recipe, run["state"]["bindings"])
    if pv["error"]:
        step, branch = pv["error"]["step"], pv["error"].get("branch")
        where = (f"Input '{branch}' step {step + 1}" if branch else f"Step {step + 1}") if step is not None else "Recipe"
        out.warnings.append(f"{where} fails on the actual data: {pv['error']['message']}")
    out.warnings.extend(pv["input_problems"])
    return recipe


class RecipeAIService(Service):
    id = "transformation_ai"
    name = "AI-drafted transformation recipe"
    description = "Describe the result you want; the chatbot drafts recipe steps you can inspect before running."
    mode = "ai_assisted"
    input_kind = "datasets"
    accepts = ["sheet"]
    outputs = ["Recipe draft"]
    options = [
        OptionField("goal", "What should the result look like?", "textarea", ""),
        OptionField("include_samples", "Include approved sample rows", "boolean", False,
                    help="Sends a few example rows per input. Only enable if policy allows this data in the chatbot."),
        OptionField("sample_rows", "Sample rows per input", "number", 5),
    ]

    def context_preview(self, bindings: dict[str, str], options: dict) -> dict:
        tables, info = load_bindings(bindings)
        include = bool(options.get("include_samples"))
        n = max(0, min(int(options.get("sample_rows") or 5), 20))
        inputs = []
        for i in info:
            df = tables[i["role"]]
            entry = {"role": i["role"], "label": i["label"], "rows": i["rows"], "columns": tabular.profile(df, 0),
                     "letters": i["letters"], "header_row": i["header_row"], "sheet": i["sheet"]}
            for c in entry["columns"]:
                c.pop("samples", None)
            if include and n:
                entry["sample"] = {"columns": [str(c) for c in df.columns], "rows": tabular.records(df, n)}
            inputs.append(entry)
        return {"inputs": inputs}

    def build_prompt(self, run: dict, ctx: dict) -> tuple[str, dict]:
        opts = {**self.default_options(), **(run["config"].get("options") or {})}
        goal = (opts.get("goal") or "").strip()
        if not goal:
            raise SourceError("Describe the result you want")
        lines = [
            "You design data transformation recipes for a local tool that executes ONLY a fixed set of JSON "
            "operations (no code, no formulas outside the documented syntax).",
            prompting.UNTRUSTED_NOTICE,
            "",
            "# Goal (from the user)",
            prompting.neutralise(goal),
            "",
            "# Available inputs",
            *inputs_section(ctx),
            "",
            *operations_section(),
            "",
            "# Reply format",
            "Reply with ONE JSON object only, no commentary:",
            RECIPE_CONTRACT,
        ]
        return "\n".join(lines), {"bindings": run["config"].get("bindings"), "roles": [i["role"] for i in ctx["inputs"]]}

    def accept_response(self, run: dict, text: str) -> ResponseOutcome:
        out = ResponseOutcome()
        try:
            data = prompting.extract_json(text)
        except ValueError as e:
            out.errors.append(str(e))
        else:
            recipe = validate_recipe_reply(data, run, out)
            if recipe is not None:
                out.state = {"recipe": recipe.model_dump(mode="json", by_alias=True, exclude_none=True)}
                out.summary = {"steps": len(recipe.steps), "needs_edit": bool(out.warnings)}
        if out.errors or out.warnings:
            out.corrective_prompt = prompting.corrective_prompt(out.errors + out.warnings, RECIPE_CONTRACT)
        return out


register(TransformationService())
register(RecipeAIService())
