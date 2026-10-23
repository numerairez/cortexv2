"""Endpoints: sources, selections, collections, context preview."""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..config import get_paths
from ..connectors import feeds, pycode, vba
from ..core import collections, context, runs, sources, templates
from ..services import prompting
from ..storage import db

router = APIRouter(prefix="/api")


class AddFile(BaseModel):
    path: str
    name: str | None = None


class AddConfluence(BaseModel):
    page: str


class AddFeed(BaseModel):
    feed: str
    name: str | None = None
    params: dict = {}


class PathBody(BaseModel):
    path: str


class ProfileBody(BaseModel):
    sheet: str
    header_row: int = Field(ge=1, le=1_048_576)
    columns: list[str] | None = None


class SelectionBody(BaseModel):
    source_id: str
    label: str
    sheet: str
    header_row: int = Field(ge=1, le=1_048_576)
    columns: list[str] | None = None


class SelectionUpdate(BaseModel):
    label: str | None = None
    sheet: str | None = None
    header_row: int | None = Field(default=None, ge=1, le=1_048_576)
    columns: list[str] | None = None
    accept_schema: bool = False


class CollectionItem(BaseModel):
    selection_id: str
    included: bool = True


class CollectionBody(BaseModel):
    name: str
    description: str = ""
    items: list[CollectionItem] = []


class ContextPreviewBody(BaseModel):
    collection_id: str
    exclude_anchors: list[str] = []
    redactions: list[dict] = []
    full_text: bool = False


# ---- sources

@router.get("/sources")
def list_sources():
    return sources.list_sources()


@router.post("/sources")
def add_source(body: AddFile):
    return sources.add_file_source(body.path, body.name)


@router.post("/sources/confluence")
def add_confluence(body: AddConfluence):
    return sources.add_confluence_source(body.page, db.get_setting("confluence_base_url", ""))


@router.get("/feeds")
def list_feeds():
    return [f.info() for f in feeds.available()]


@router.post("/sources/feed")
def add_feed(body: AddFeed):
    return sources.add_feed_source(body.feed, body.name, body.params)


@router.get("/sources/{source_id}")
def get_source(source_id: str):
    src = sources.get_source(source_id)
    src["selections"] = sources.list_selections(source_id)
    return src


@router.post("/sources/{source_id}/refresh")
def refresh_source(source_id: str):
    return sources.refresh_source(source_id)


@router.post("/sources/{source_id}/relocate")
def relocate_source(source_id: str, body: PathBody):
    return sources.relocate_source(source_id, body.path)


@router.delete("/sources/{source_id}")
def delete_source(source_id: str):
    sources.delete_source(source_id)
    return {"ok": True}


@router.get("/sources/{source_id}/preview")
def preview_sheet(source_id: str, sheet: str, rows: int = 30):
    return sources.preview_sheet(source_id, sheet, rows)


@router.post("/sources/{source_id}/profile")
def profile_sheet(source_id: str, body: ProfileBody):
    return sources.profile_sheet(source_id, body.sheet, body.header_row, body.columns)


# ---- selections

@router.get("/selections")
def list_selections(source_id: str | None = None):
    return sources.list_selections(source_id)


@router.post("/selections")
def create_selection(body: SelectionBody):
    cfg = {"sheet": body.sheet, "header_row": body.header_row}
    if body.columns:
        cfg["columns"] = body.columns
    return sources.create_selection(body.source_id, "sheet", body.label.strip() or body.sheet, cfg)


@router.put("/selections/{selection_id}")
def update_selection(selection_id: str, body: SelectionUpdate):
    cfg = {k: v for k, v in {"sheet": body.sheet, "header_row": body.header_row}.items() if v is not None}
    if body.columns is not None:
        cfg["columns"] = body.columns or None
    return sources.update_selection(selection_id, body.label, cfg or None, body.accept_schema)


@router.delete("/selections/{selection_id}")
def delete_selection(selection_id: str):
    sources.delete_selection(selection_id)
    return {"ok": True}


@router.get("/selections/{selection_id}/check")
def check_selection(selection_id: str):
    return sources.check_selection(selection_id)


# ---- collections

@router.get("/collections")
def list_collections():
    return collections.list_collections()


@router.post("/collections")
def create_collection(body: CollectionBody):
    return collections.save_collection(None, body.name, body.description, [i.model_dump() for i in body.items])


@router.get("/collections/{collection_id}")
def get_collection(collection_id: str):
    return collections.get_collection(collection_id)


@router.put("/collections/{collection_id}")
def update_collection(collection_id: str, body: CollectionBody):
    return collections.save_collection(collection_id, body.name, body.description, [i.model_dump() for i in body.items])


@router.delete("/collections/{collection_id}")
def delete_collection(collection_id: str):
    collections.delete_collection(collection_id)
    return {"ok": True}


@router.post("/collections/{collection_id}/check")
def check_collection(collection_id: str):
    return collections.check_collection(collection_id)


PREVIEW_CHARS = 600


@router.post("/context/preview")
def context_preview(body: ContextPreviewBody):
    """Exactly what would be exported for a collection, with size estimates."""
    items = context.resolve_collection(body.collection_id)
    excluded = set(body.exclude_anchors)
    out, total = [], 0
    for it in items:
        segs = []
        for s in it.segments:
            text = prompting.apply_redactions(s.text, body.redactions)
            inc = s.anchor not in excluded
            if inc:
                total += len(text)
            segs.append({"anchor": s.anchor, "locator": s.locator, "chars": len(text), "included": inc,
                         "text": text if body.full_text else text[:PREVIEW_CHARS],
                         "truncated": not body.full_text and len(text) > PREVIEW_CHARS})
        out.append({"ref": it.ref, "label": it.label, "kind": it.kind, "source_name": it.source_name,
                    "location": it.location, "version": it.version, "warnings": it.warnings, "error": it.error,
                    "segments": segs})
    budget = int(db.get_setting("prompt_token_budget", 100_000))
    tokens = context.estimate_tokens(total + 3000)
    return {"items": out, "characters": total, "estimated_tokens": tokens, "token_budget": budget,
            "over_budget": tokens > budget}


# ---- uploads (drag & drop) and macro analysis

UPLOAD_EXTS = {".xlsx", ".xlsm", ".csv", ".tsv", ".pdf", ".docx", ".txt", ".md", ".xlsb", ".xls", ".bas", ".cls", ".py", ".ipynb"}
SOURCE_EXTS = {".xlsx", ".xlsm", ".csv", ".tsv", ".pdf", ".docx", ".txt", ".md"}


@router.post("/uploads")
async def upload(request: Request):
    """Store a dropped file in the per-user data folder and register it as a source when possible."""
    name = runs.safe_filename(unquote(request.headers.get("x-filename", "")))
    ext = Path(name).suffix.lower()
    if ext not in UPLOAD_EXTS:
        raise sources.SourceError(f"Unsupported file type '{ext or '?'}'")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > sources.MAX_FILE_BYTES:
            raise sources.SourceError("File is larger than the 250 MB limit", 413)
    if not data:
        raise sources.SourceError("The file is empty")
    digest = hashlib.sha256(data).hexdigest()
    existing = db.query_one("SELECT id FROM sources WHERE fingerprint = ? AND name = ? AND deleted_at IS NULL",
                            (digest, name))
    if existing:
        src = sources.get_source(existing["id"])
        return {"path": src["location"], "source": src, "existing": True}
    folder = get_paths().root / "uploads" / uuid.uuid4().hex[:12]
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_bytes(bytes(data))
    src = sources.add_file_source(str(path), name) if ext in SOURCE_EXTS else None
    return {"path": str(path), "source": src, "existing": False}


class MacroBody(BaseModel):
    path: str | None = None
    code: str | None = Field(default=None, max_length=500_000)
    name: str | None = None
    language: Literal["vba", "python"] = "vba"


@router.post("/macros/analyse")
def analyse_macro(body: MacroBody):
    path = None
    if body.path:
        path = Path(body.path.strip().strip('"')).expanduser()
        if not path.is_absolute() or not path.is_file():
            raise sources.SourceError("File not found", 404)
    try:
        python = body.language == "python" or (path is not None and path.suffix.lower() in pycode.SCRIPT_EXTS)
        result = (pycode if python else vba).load(path=path, code=body.code, name=body.name)
    except vba.VBAError as e:
        raise sources.SourceError(str(e))
    if path is not None:
        src = db.query_one("SELECT id FROM sources WHERE location = ? AND deleted_at IS NULL", (str(path.resolve()),))
        result["workbook"]["source_id"] = src["id"] if src else None
    return result


# ---- data templates

class SuggestBody(BaseModel):
    path: str


class TemplatePreviewBody(BaseModel):
    folder: str
    pattern: str
    format: str


class TemplateBody(BaseModel):
    name: str
    selection_id: str
    pattern: str
    format: str


class TemplateUpdate(BaseModel):
    name: str | None = None
    pattern: str | None = None
    format: str | None = None


@router.post("/templates/suggest")
def suggest_template(body: SuggestBody):
    return templates.suggest(body.path)


@router.post("/templates/preview")
def preview_template(body: TemplatePreviewBody):
    return {"matches": templates.list_matches(body.folder, body.pattern, body.format)}


@router.get("/templates")
def list_templates():
    return templates.list_templates()


@router.post("/templates")
def create_template(body: TemplateBody):
    return templates.create_template(body.name, body.selection_id, body.pattern, body.format)


@router.get("/templates/{template_id}")
def get_template(template_id: str):
    return templates.get_template(template_id)


@router.put("/templates/{template_id}")
def update_template(template_id: str, body: TemplateUpdate):
    return templates.update_template(template_id, body.name, body.pattern, body.format)


@router.delete("/templates/{template_id}")
def delete_template(template_id: str):
    templates.delete_template(template_id)
    return {"ok": True}
