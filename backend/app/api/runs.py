"""Endpoints: services, the shared prompt/response runtime, transformations, recipes, artifacts."""

from __future__ import annotations

import io
import mimetypes
import zipfile
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ..connectors import procdoc, tabular
from ..connectors.vba import VBAError
from ..core import context, recipes, runs
from ..core.sources import SourceError
from ..services import base, transformation
from ..storage import db
from ..transformations import export
from ..transformations.recipe import OPERATION_CATALOG, Recipe

router = APIRouter(prefix="/api")


class StartRun(BaseModel):
    service_id: str
    title: str = ""
    collection_id: str | None = None
    bindings: dict[str, str] | None = None
    options: dict = {}
    exclude_anchors: list[str] = []
    redactions: list[dict] = []


class ResponseBody(BaseModel):
    text: str = Field(min_length=1, max_length=5_000_000)


class TransformBody(BaseModel):
    recipe: dict
    bindings: dict[str, str]
    background: bool = False
    upto: int | None = None
    view_role: str | None = None
    title: str = ""
    recipe_id: str | None = None


class ColumnValuesBody(BaseModel):
    recipe: dict
    bindings: dict[str, str]
    column: str
    before: int = 0
    branch: str | None = None


class RecipeBody(BaseModel):
    name: str
    description: str = ""
    definition: dict
    origin: str = "manual"


class AIPreviewBody(BaseModel):
    bindings: dict[str, str]
    options: dict = {}


@router.get("/services")
def list_services():
    return [s.describe() for s in base.all_services() if s.id not in ("transformation_ai", "macro_to_workflow", "python_to_workflow", "doc_to_workflow")]


@router.get("/services/{service_id}")
def get_service(service_id: str):
    return base.get_service(service_id).describe()


# ---- shared AI runtime

def _public_run(run: dict) -> dict:
    st = dict(run.get("state") or {})
    st.pop("excerpts", None)
    run["state"] = st
    return run


@router.post("/runs")
def start_run(body: StartRun):
    svc = base.get_service(body.service_id)
    if svc.mode == "deterministic":
        raise SourceError("This service runs locally; use its builder instead")
    cfg = {"options": body.options, "redactions": body.redactions, "exclude_anchors": body.exclude_anchors,
           "bindings": body.bindings}
    if svc.input_kind == "collection":
        if not body.collection_id:
            raise SourceError("Choose a context collection")
        items = context.resolve_collection(body.collection_id, exclude_anchors=set(body.exclude_anchors))
        if not any(i.segments and not i.error for i in items):
            raise SourceError("Nothing to send: every item is excluded, empty, or unreadable")
        snap = context.create_snapshot(body.collection_id, items, {"excluded_anchors": body.exclude_anchors,
                                                                  "redaction_count": len(body.redactions)})
        run = runs.create_run(svc.id, body.title or svc.name, cfg, body.collection_id, snap)
        prompt, state = svc.build_prompt(run, items)
    else:
        if not body.bindings:
            raise SourceError("Choose at least one dataset")
        ctx = svc.context_preview(body.bindings, body.options)
        snap = context.create_snapshot(None, [], {"inputs": ctx["inputs"] and [
            {"role": i["role"], "label": i["label"], "rows": i["rows"]} for i in ctx["inputs"]]})
        run = runs.create_run(svc.id, body.title or svc.name, cfg, None, snap)
        prompt, state = svc.build_prompt(run, ctx)
    state["prompt"] = prompt
    state["estimated_tokens"] = context.estimate_tokens(len(prompt))
    run = runs.update_run(run["id"], status="awaiting_response", state=state,
                          exchanges=runs.record_exchange(run, "prompt", prompt))
    return _public_run(run)


@router.get("/runs/{run_id}/figures.zip")
def run_figures(run_id: str):
    """The pictures a document → workflow prompt asks the user to attach, in one download."""
    run = runs.get_run(run_id)
    opts = run["config"].get("options") or {}
    key = opts.get("figures_key")
    files = [f["file"] for f in opts.get("figures") or [] if f.get("mode") == "attach" and f.get("file")]
    if not key or not files:
        raise SourceError("This run has no pictures to attach", 404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:   # PNG and JPEG are already compressed
        for f in files:
            try:
                z.write(procdoc.figure_path(key, f), f)
            except VBAError:
                pass
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="figures-{run_id[:8]}.zip"'})


@router.get("/runs")
def list_runs():
    return runs.list_runs()


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    run = runs.get_run(run_id)
    if run["snapshot_id"]:
        run["snapshot"] = context.get_snapshot(run["snapshot_id"])
    return _public_run(run)


@router.post("/runs/{run_id}/response")
def submit_response(run_id: str, body: ResponseBody):
    run = runs.get_run(run_id)
    svc = base.get_service(run["service_id"])
    if svc.mode == "deterministic":
        raise SourceError("This run does not take AI responses")
    if "prompt" not in run["state"] and not run["state"].get("anchors") and not run["state"].get("roles"):
        raise SourceError("This run has no active prompt")
    attempt = sum(1 for e in run["exchanges"] if e["kind"] == "response") + 1
    outcome = svc.accept_response(run, body.text)
    exchanges = runs.record_exchange(run, "response", body.text,
                                     {"attempt": attempt, "accepted": outcome.ok, "errors": len(outcome.errors),
                                      "warnings": len(outcome.warnings)})
    if outcome.corrective_prompt:
        exchanges.append({"kind": "corrective_prompt", "at": exchanges[-1]["at"], "chars": len(outcome.corrective_prompt),
                          **({"text": outcome.corrective_prompt} if runs.retain_prompts() else {})})
    state = {**run["state"], **outcome.state, "corrective_prompt": outcome.corrective_prompt,
             "warnings": outcome.warnings, "attempt": attempt}
    if not outcome.ok:
        run = runs.update_run(run_id, status="invalid_response", state=state, exchanges=exchanges,
                              errors=outcome.errors)
        return _public_run(run)
    run = runs.update_run(run_id, state=state, exchanges=exchanges, errors=[])
    arts = svc.finalize(run, outcome)
    for a in arts:
        a["metadata"]["attempt"] = attempt
        db.execute("UPDATE artifacts SET metadata = ? WHERE id = ?", (db.dumps(a["metadata"]), a["id"]))
    if not runs.retain_prompts():
        state.pop("prompt", None)
        state.pop("excerpts", None)
    run = runs.update_run(run_id, status="completed", state=state,
                          summary={**outcome.summary, "warnings": outcome.warnings[:50], "attempt": attempt})
    return _public_run(run)


@router.delete("/runs/{run_id}")
def delete_run(run_id: str):
    runs.delete_run(run_id)
    return {"ok": True}


# ---- transformations

@router.get("/transform/catalog")
def transform_catalog():
    return {"operations": OPERATION_CATALOG, "examples": transformation.RECIPE_EXAMPLES}


@router.post("/transform/validate")
def validate_recipe(body: dict):
    r = transformation.parse_recipe(body)
    return {"ok": True, "recipe": r.model_dump(mode="json", by_alias=True, exclude_none=True)}


@router.post("/transform/preview")
def transform_preview(body: TransformBody):
    recipe = transformation.parse_recipe(body.recipe)
    return transformation.preview(recipe, body.bindings, body.upto, view_role=body.view_role)


@router.post("/transform/column-values")
def transform_column_values(body: ColumnValuesBody):
    recipe = transformation.parse_recipe(body.recipe)
    return transformation.column_values(recipe, body.bindings, body.column, body.before, body.branch)


@router.post("/transform/run")
def transform_run(body: TransformBody):
    recipe = transformation.parse_recipe(body.recipe)
    version_id = None
    if body.recipe_id:
        version_id = recipes.get_recipe(body.recipe_id)["version"]["id"]
    return transformation.execute_to_artifacts(recipe, body.bindings, body.title or recipe.output.name, version_id,
                                               background=body.background)


@router.post("/transform/ai-preview")
def transform_ai_preview(body: AIPreviewBody):
    svc = base.get_service("transformation_ai")
    return svc.context_preview(body.bindings, body.options)


@router.get("/recipes")
def list_recipes():
    return recipes.list_recipes()


@router.post("/recipes")
def create_recipe(body: RecipeBody):
    return recipes.save_recipe(None, body.name, body.description, transformation.parse_recipe(body.definition),
                               body.origin)


@router.get("/recipes/{recipe_id}")
def get_recipe(recipe_id: str, version: int | None = None):
    return recipes.get_recipe(recipe_id, version)


@router.put("/recipes/{recipe_id}")
def update_recipe(recipe_id: str, body: RecipeBody):
    return recipes.save_recipe(recipe_id, body.name, body.description, transformation.parse_recipe(body.definition),
                               body.origin)


@router.delete("/recipes/{recipe_id}")
def delete_recipe(recipe_id: str):
    recipes.delete_recipe(recipe_id)
    return {"ok": True}


# ---- artifacts

@router.get("/artifacts")
def list_artifacts():
    return runs.list_artifacts()


@router.get("/runs/{run_id}/download/{fmt}")
def download_run_output(run_id: str, fmt: str):
    """The run's result as .xlsx or .csv. A format the run didn't write is converted from the one it did
    (preferring the .xlsx, which keeps exact values) and saved next to it."""
    if fmt not in ("xlsx", "csv"):
        raise SourceError("Format must be xlsx or csv")
    run = runs.get_run(run_id)
    # The main result only; extra outputs are downloaded one by one.
    outputs = [a for a in run["artifacts"] if a["kind"] in ("xlsx", "csv")
               and (a.get("metadata") or {}).get("output", "main") == "main"]
    if not outputs:
        raise SourceError("This run has no output files", 404)
    existing = next((a for a in reversed(outputs) if a["kind"] == fmt), None)
    if existing is None:
        src = next((a for a in outputs if a["kind"] == "xlsx"), outputs[0])
        src_path = runs.artifact_file(src)
        df = tabular.load_table(src_path, "Result" if src["kind"] == "xlsx" else tabular.CSV_SHEET, 1).df
        if src["kind"] == "csv":
            # Undo the CSV formula-injection apostrophe; the xlsx writer stores such text safely as text.
            df = df.map(lambda v: v[1:] if isinstance(v, str) and v.startswith("'") and v[1:2] in export.FORMULA_PREFIXES else v)
        out = runs.artifact_path(run_id, src_path.with_suffix(f".{fmt}").name)
        (export.write_xlsx if fmt == "xlsx" else export.write_csv)(df, out)
        existing = runs.register_artifact(run_id, fmt, out, {"rows": int(len(df)), "converted_from": src["kind"]})
    return FileResponse(runs.artifact_file(existing), filename=existing["name"],
                        media_type=mimetypes.guess_type(existing["name"])[0] or "application/octet-stream")


def _desktop_target(artifact_id: str, copy: bool) -> Path:
    """The app's copy of an artifact, or (copy=True) the copy saved to the workflow's output folder."""
    a = runs.get_artifact(artifact_id)
    if not copy:
        return runs.artifact_file(a)
    saved = (a.get("metadata") or {}).get("saved_to")
    if not saved or not Path(saved).exists():
        raise SourceError("The copy in the output folder is no longer there", 404)
    return Path(saved)


@router.post("/artifacts/{artifact_id}/open")
def open_artifact(artifact_id: str, copy: bool = False):
    runs.open_on_desktop(_desktop_target(artifact_id, copy), reveal=False)
    return {"ok": True}


@router.post("/artifacts/{artifact_id}/reveal")
def reveal_artifact(artifact_id: str, copy: bool = False):
    runs.open_on_desktop(_desktop_target(artifact_id, copy), reveal=True)
    return {"ok": True}


@router.get("/artifacts/{artifact_id}/download")
def download_artifact(artifact_id: str):
    a = runs.get_artifact(artifact_id)
    return FileResponse(runs.artifact_file(a), filename=a["name"],
                        media_type=mimetypes.guess_type(a["name"])[0] or "application/octet-stream")


# Artifact HTML is rendered from escaped content, but is still served under a strict
# CSP and sandbox so a generated page can never script against the local API.
ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-popups allow-popups-to-escape-sandbox"


@router.get("/artifacts/{artifact_id}/view")
def view_artifact(artifact_id: str):
    a = runs.get_artifact(artifact_id)
    p = runs.artifact_file(a)
    if a["kind"] == "html":
        return Response(p.read_bytes(), media_type="text/html; charset=utf-8",
                        headers={"Content-Security-Policy": ARTIFACT_CSP, "X-Content-Type-Options": "nosniff"})
    if a["kind"] in ("markdown", "json"):
        return Response(p.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8",
                        headers={"X-Content-Type-Options": "nosniff"})
    if a["kind"] in ("csv", "xlsx"):
        from ..connectors.tabular import CSV_SHEET
        sheet = CSV_SHEET if a["kind"] == "csv" else "Result"
        t = tabular.load_table(p, sheet, 1, max_rows=200)
        return {"columns": [str(c) for c in t.df.columns], "rows": tabular.records(t.df, 200),
                "truncated": int(a["metadata"].get("rows", 0)) > 200, "row_count": a["metadata"].get("rows")}
    raise SourceError("No preview available for this artifact")
