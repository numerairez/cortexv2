"""Dashboards: headlines, charts and tables over one library dataset, optionally linked so that
clicking one object filters or highlights others.

The spec stores *what* to show (fields, aggregations, chart types, layout, links), never numbers:
every displayed value is computed from the dataset's rows when the dashboard opens.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from ..connectors import tabular
from ..storage import db
from ..transformations.recipe import Condition
from .sources import SourceError

GRID_COLUMNS = 12
MAX_WIDGETS = 60
MAX_ROWS = 500_000

Agg = Literal["count", "sum", "mean", "median", "min", "max", "distinct"]


class _Spec(BaseModel):
    # Unknown keys are kept so newer UIs can add display options without a migration.
    model_config = ConfigDict(extra="allow")


class Box(_Spec):
    x: int = Field(ge=0, lt=GRID_COLUMNS)
    y: int = Field(ge=0, le=10_000)
    w: int = Field(ge=1, le=GRID_COLUMNS)
    h: int = Field(ge=1, le=60)

    @model_validator(mode="after")
    def _fits(self):
        if self.x + self.w > GRID_COLUMNS:
            raise ValueError(f"box overflows the {GRID_COLUMNS}-column grid")
        return self


class Measure(_Spec):
    agg: Agg
    field: str | None = None

    @model_validator(mode="after")
    def _field_needed(self):
        if self.agg != "count" and not self.field:
            raise ValueError(f"'{self.agg}' needs a column")
        return self


class WidgetFilter(_Spec):
    """Rows an object is limited to; conditions are the same as a workflow Filter step's."""
    match: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default=[], max_length=30)


class _Widget(_Spec):
    id: str = Field(min_length=1, max_length=40)
    title: str = Field(default="", max_length=200)
    box: Box
    filter: WidgetFilter | None = None


class Headline(_Widget):
    type: Literal["headline"]
    measure: Measure


class Chart(_Widget):
    type: Literal["chart"]
    chart: Literal["bar", "hbar", "line", "area", "scatter", "donut", "heatmap"]
    x: str | None = None
    y: Measure
    color: str | None = None
    # A hand-edited Vega-Lite spec replacing the generated one (advanced users).
    vegaLite: dict[str, Any] | None = None


class Table(_Widget):
    type: Literal["table"]
    mode: Literal["rows", "summary", "pivot"] = "rows"
    columns: list[str] = []
    groupBy: list[str] = []
    measures: list[Measure] = []
    limit: int = Field(default=200, ge=1, le=5000)
    # Pivot: the field spread across columns and the value in each cell.
    pivotColumn: str | None = None
    pivotValue: Measure | None = None
    pivotTop: int = Field(default=12, ge=1, le=200)

    @model_validator(mode="after")
    def _pivot_fields(self):
        if self.mode == "pivot" and self.pivotColumn and self.pivotColumn in self.groupBy:
            raise ValueError("a pivot can't use the same field for rows and columns")
        return self


Widget = Annotated[Union[Headline, Chart, Table], Field(discriminator="type")]


class Link(_Spec):
    id: str = Field(min_length=1, max_length=40)
    source: str
    target: str
    effect: Literal["filter", "highlight"] = "filter"


class DashboardSpec(_Spec):
    widgets: list[Widget] = Field(default=[], max_length=MAX_WIDGETS)
    links: list[Link] = []

    @model_validator(mode="after")
    def _consistent(self):
        ids = [w.id for w in self.widgets]
        if len(ids) != len(set(ids)):
            raise ValueError("two objects share the same id")
        by_id = {w.id: w for w in self.widgets}
        seen = set()
        for link in self.links:
            if link.source not in by_id or link.target not in by_id:
                raise ValueError("an interaction refers to an object that no longer exists")
            if link.source == link.target:
                raise ValueError("an object cannot be linked to itself")
            if by_id[link.source].type == "headline":
                raise ValueError("headlines cannot drive interactions")
            if (link.source, link.target) in seen:
                raise ValueError("the same two objects are linked twice")
            seen.add((link.source, link.target))
        return self


def parse_spec(data: Any) -> dict:
    try:
        spec = DashboardSpec.model_validate(data or {})
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise SourceError(f"Dashboard layout is invalid ({where}: {first['msg']})", 422)
    return spec.model_dump(mode="json", exclude_none=True)


# ---------------------------------------------------------------- storage

def dataset_label(binding: str) -> tuple[str | None, str | None]:
    """The dataset's display name and its source kind, or (None, None) when it was removed."""
    if binding.startswith("tpl_"):
        row = db.query_one("SELECT name, pattern FROM data_templates WHERE id = ? AND deleted_at IS NULL",
                           (binding.split("@")[0],))
        if not row:
            return None, None
        return row["name"], "csv" if row["pattern"].lower().endswith((".csv", ".tsv")) else "excel"
    row = db.query_one("SELECT s.label, src.kind FROM selections s JOIN sources src ON src.id = s.source_id "
                       "WHERE s.id = ? AND s.deleted_at IS NULL AND src.deleted_at IS NULL", (binding,))
    return (row["label"], row["kind"]) if row else (None, None)


def _decode(row: dict) -> dict:
    row = db.decode(row, "spec")
    row["dataset_label"], row["dataset_kind"] = dataset_label(row["dataset"])
    return row


def list_dashboards() -> list[dict]:
    return [_decode(r) for r in db.query("SELECT * FROM dashboards WHERE deleted_at IS NULL ORDER BY updated_at DESC")]


def get_dashboard(dashboard_id: str) -> dict:
    row = db.query_one("SELECT * FROM dashboards WHERE id = ? AND deleted_at IS NULL", (dashboard_id,))
    if not row:
        raise SourceError("Dashboard not found", 404)
    return _decode(row)


def save_dashboard(dashboard_id: str | None, name: str, description: str, dataset: str, spec: Any) -> dict:
    if not name.strip():
        raise SourceError("Give the dashboard a name")
    if dataset_label(dataset)[0] is None:
        raise SourceError("That dataset is no longer in your library", 404)
    body = db.dumps(parse_spec(spec))
    ts = db.now()
    if dashboard_id:
        get_dashboard(dashboard_id)
        db.execute("UPDATE dashboards SET name = ?, description = ?, dataset = ?, spec = ?, updated_at = ? WHERE id = ?",
                   (name.strip(), description, dataset, body, ts, dashboard_id))
    else:
        dashboard_id = db.new_id("dsh")
        db.execute("INSERT INTO dashboards (id, name, description, dataset, spec, created_at, updated_at) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?)", (dashboard_id, name.strip(), description, dataset, body, ts, ts))
    return get_dashboard(dashboard_id)


def delete_dashboard(dashboard_id: str) -> None:
    get_dashboard(dashboard_id)
    db.execute("UPDATE dashboards SET deleted_at = ? WHERE id = ?", (db.now(), dashboard_id))


# ---------------------------------------------------------------- data

def dataset_rows(binding: str, limit: int = MAX_ROWS) -> dict:
    """The dataset's rows for the browser to aggregate and chart, with its column types.
    Sent column by column (``values[i]`` is every value of ``columns[i]``): far smaller and
    faster to build than one list per row."""
    from ..services.transformation import load_bindings

    tables, info = load_bindings({"data": binding})
    df = tables["data"]
    return {
        "label": info[0]["label"],
        "file": Path(info[0]["path"]).name,
        "sheet": info[0]["sheet"],
        "read_at": db.now(),
        "columns": tabular.schema_of(df),
        "values": [tabular.column_values(df[c], limit) for c in df.columns],
        "row_count": int(len(df)),
        "truncated": len(df) > limit,
        "warnings": info[0]["warnings"],
    }
