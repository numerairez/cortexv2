"""Endpoints: dashboards and the dataset rows they are computed from."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import dashboards
from ..core.sources import SourceError
from ..services import dashboard_ai
from ..services.transformation import load_bindings

router = APIRouter(prefix="/api")


class DashboardBody(BaseModel):
    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=2000)
    dataset: str = Field(min_length=1, max_length=200)
    spec: dict = {}


@router.get("/dashboards")
def list_dashboards():
    return dashboards.list_dashboards()


@router.post("/dashboards")
def create_dashboard(body: DashboardBody):
    return dashboards.save_dashboard(None, body.name, body.description, body.dataset, body.spec)


@router.get("/dashboards/data")
def dashboard_data(dataset: str):
    return dashboards.dataset_rows(dataset)


@router.get("/dashboards/{dashboard_id}")
def get_dashboard(dashboard_id: str):
    return dashboards.get_dashboard(dashboard_id)


@router.put("/dashboards/{dashboard_id}")
def update_dashboard(dashboard_id: str, body: DashboardBody):
    return dashboards.save_dashboard(dashboard_id, body.name, body.description, body.dataset, body.spec)


@router.delete("/dashboards/{dashboard_id}")
def delete_dashboard(dashboard_id: str):
    dashboards.delete_dashboard(dashboard_id)
    return {"ok": True}


# ---- describe an object: build a prompt for the approved chatbot, then validate its pasted reply

class AIPromptBody(BaseModel):
    dataset: str = Field(min_length=1, max_length=200)
    request: str = Field(max_length=5000)
    widget: dict | None = None
    include_samples: bool = False


class AIReplyBody(BaseModel):
    dataset: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=500_000)
    widget: dict = {}


class AICorrectionBody(BaseModel):
    problems: list[str] = Field(min_length=1, max_length=50)


def _table(dataset: str):
    tables, info = load_bindings({"data": dataset})
    return tables["data"], info[0]["label"]


@router.post("/dashboards/ai/prompt")
def ai_prompt(body: AIPromptBody):
    df, label = _table(body.dataset)
    return {"prompt": dashboard_ai.build_prompt(label, df, body.request, body.widget, body.include_samples)}


@router.post("/dashboards/ai/reply")
def ai_reply(body: AIReplyBody):
    df, _ = _table(body.dataset)
    return dashboard_ai.accept_reply(df, body.text, body.widget)


@router.post("/dashboards/ai/correction")
def ai_correction(body: AICorrectionBody):
    if not any(p.strip() for p in body.problems):
        raise SourceError("Nothing to correct")
    return {"prompt": dashboard_ai.correction_prompt(body.problems)}


class AILinksPromptBody(BaseModel):
    dataset: str = Field(min_length=1, max_length=200)
    spec: dict
    request: str = Field(max_length=5000)
    focus: str | None = None


class AILinksReplyBody(BaseModel):
    dataset: str = Field(min_length=1, max_length=200)
    spec: dict
    text: str = Field(min_length=1, max_length=500_000)
    focus: str | None = None


@router.post("/dashboards/ai/links/prompt")
def ai_links_prompt(body: AILinksPromptBody):
    df, label = _table(body.dataset)
    return {"prompt": dashboard_ai.build_links_prompt(label, df, body.spec, body.request, body.focus)}


@router.post("/dashboards/ai/links/reply")
def ai_links_reply(body: AILinksReplyBody):
    df, _ = _table(body.dataset)
    return dashboard_ai.accept_links_reply(df, body.spec, body.text, body.focus)
