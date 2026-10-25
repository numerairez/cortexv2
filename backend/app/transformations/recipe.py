"""Versioned, declarative recipe schema shared by the manual builder and AI-proposed recipes."""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

RECIPE_SCHEMA_VERSION = 1

ColumnName = Annotated[str, Field(min_length=1, max_length=200)]


class _Step(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=500)


class SelectColumns(_Step):
    op: Literal["select_columns"]
    columns: list[ColumnName] = Field(min_length=1)


class RenameColumns(_Step):
    op: Literal["rename_columns"]
    mapping: dict[ColumnName, ColumnName] = Field(min_length=1)


FilterOperator = Literal["eq", "ne", "gt", "ge", "lt", "le", "contains", "not_contains", "starts_with",
                         "in", "not_in", "between", "is_blank", "not_blank"]


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: ColumnName
    operator: FilterOperator
    # in/not_in: a list (None in it stands for blanks); between: [low, high], either may be None.
    value: str | int | float | bool | list[str | int | float | bool | None] | None = None
    keep_blanks: bool = False   # between: also keep blank cells once a bound is set


class FilterRows(_Step):
    op: Literal["filter_rows"]
    match: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default_factory=list)   # empty keeps every row


class SortKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: ColumnName
    descending: bool = False


class SortRows(_Step):
    op: Literal["sort_rows"]
    keys: list[SortKey] = Field(min_length=1)


class AppendRows(_Step):
    op: Literal["append_rows"]
    inputs: list[str] = Field(default_factory=list)   # empty: not set up yet, passes through
    allow_missing_columns: bool = False


class Join(_Step):
    op: Literal["join"]
    right: str = ""
    left_on: list[ColumnName] = Field(default_factory=list)   # no right/keys yet: not set up, passes through
    right_on: list[ColumnName] = Field(default_factory=list)
    how: Literal["left", "inner", "right", "outer"] = "left"
    expected: Literal["many_to_one", "one_to_one", "one_to_many", "many_to_many"] = "many_to_one"
    right_columns: list[ColumnName] | None = None
    suffix: str = " (right)"

    @model_validator(mode="before")
    @classmethod
    def _drop_unfinished_keys(cls, data):
        # Key pairs where either side is still "Choose column…" are not set up yet.
        if isinstance(data, dict) and isinstance(data.get("left_on"), list) and isinstance(data.get("right_on"), list):
            pairs = [(lk, rk) for lk, rk in zip(data["left_on"], data["right_on"]) if lk and rk]
            data = {**data, "left_on": [p[0] for p in pairs], "right_on": [p[1] for p in pairs]}
        return data

    @field_validator("right_on")
    @classmethod
    def _same_len(cls, v, info):
        left = info.data.get("left_on")
        if left is not None and len(left) != len(v):
            raise ValueError("left_on and right_on must list the same number of key columns")
        return v


class Deduplicate(_Step):
    op: Literal["deduplicate"]
    columns: list[ColumnName] | None = None
    keep: Literal["first", "last"] = "first"


class Conversion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: ColumnName
    to: Literal["text", "integer", "number", "date", "boolean"]
    date_format: str | None = Field(default=None, max_length=50)
    dayfirst: bool = False


class ConvertTypes(_Step):
    op: Literal["convert_types"]
    conversions: list[Conversion] = Field(default_factory=list)
    on_error: Literal["blank", "fail"] = "blank"


class DeriveColumn(_Step):
    op: Literal["derive_column"]
    name: ColumnName
    expression: str = Field(default="", max_length=1000)   # blank: not set up yet, passes through


Aggregate = Literal["sum", "mean", "median", "min", "max", "count", "count_distinct", "first", "last"]


class Aggregation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: ColumnName
    function: Aggregate
    as_: ColumnName | None = Field(default=None, alias="as")


class GroupAggregate(_Step):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    op: Literal["group_aggregate"]
    group_by: list[ColumnName] = Field(default_factory=list)
    aggregations: list[Aggregation] = Field(default_factory=list)


class Pivot(_Step):
    op: Literal["pivot"]
    index: list[ColumnName] = Field(default_factory=list)   # any field missing: not set up, passes through
    columns: str = ""
    values: str = ""
    function: Aggregate = "sum"


class Unpivot(_Step):
    op: Literal["unpivot"]
    id_columns: list[ColumnName] = Field(default_factory=list)
    value_columns: list[ColumnName] | None = None
    variable_name: ColumnName = "Attribute"
    value_name: ColumnName = "Value"


Step = Annotated[
    Union[SelectColumns, RenameColumns, FilterRows, SortRows, AppendRows, Join, Deduplicate, ConvertTypes,
          DeriveColumn, GroupAggregate, Pivot, Unpivot],
    Field(discriminator="op"),
]


class ExpectedColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str | None = None


class RecipeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = Field(min_length=1, max_length=60, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    description: str = ""
    expected_columns: list[ExpectedColumn] = Field(default_factory=list)
    # Branch: preparation steps applied to this input before the main flow joins/appends it.
    # Lets the same dataset be used twice with different manipulations. A branch may itself join or
    # append other inputs, so several starting points can merge before reaching the main flow.
    steps: list[Step] = Field(default_factory=list, max_length=100)


class StepGroup(BaseModel):
    """A named, collapsible run of consecutive main-flow steps (e.g. a translated macro).

    Purely organisational: the executor ignores groups, so grouping never changes results.
    """
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=120)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    kind: Literal["manual", "macro"] = "manual"
    # Inputs whose own steps belong to this group (folded away with it when collapsed).
    inputs: list[str] = Field(default_factory=list)
    source: dict[str, str] | None = None


class RecipeOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Default file name; may contain {date} (YYYY-MM-DD) and {time} (HHMM), filled in at run time.
    name: str = Field(default="result", min_length=1, max_length=100)
    formats: list[Literal["xlsx", "csv"]] = Field(default_factory=lambda: ["xlsx"])
    # Folder the run also saves its files to (e.g. a team share). None = only the app's run history.
    folder: str | None = Field(default=None, max_length=500)
    if_exists: Literal["keep_both", "replace"] = "keep_both"
    # Also keep the table in the Library as a dataset (one per workflow output, refreshed on every run).
    save_to_library: bool = True


class ExtraOutput(RecipeOutput):
    """A further result taken from part-way through the flow: the main flow (``branch`` None) or an
    input's own row, right after step ``after`` (-1 = the input as read, before its steps)."""
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    branch: str | None = None
    after: int = Field(default=-1, ge=-1)


class Recipe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = RECIPE_SCHEMA_VERSION
    inputs: list[RecipeInput] = Field(min_length=1)
    base: str
    steps: list[Step] = Field(default_factory=list, max_length=100)
    output: RecipeOutput = Field(default_factory=RecipeOutput)
    extra_outputs: list[ExtraOutput] = Field(default_factory=list, max_length=20)
    groups: list[StepGroup] = Field(default_factory=list, max_length=50)

    @field_validator("base")
    @classmethod
    def _base_is_input(cls, v, info):
        roles = [i.role for i in info.data.get("inputs", [])]
        if roles and v not in roles:
            raise ValueError(f"base must be one of the input roles: {', '.join(roles)}")
        return v

    @model_validator(mode="after")
    def _groups_fit(self):
        ids = set()
        spans = sorted((g.start, g.end, g.name) for g in self.groups)
        for g in self.groups:
            if g.id in ids:
                raise ValueError(f"Duplicate group id '{g.id}'")
            ids.add(g.id)
            if g.start > g.end or g.end >= len(self.steps):
                raise ValueError(f"Group '{g.name}' covers steps that don't exist")
            unknown = [r for r in g.inputs if r not in self.roles()]
            if unknown:
                raise ValueError(f"Group '{g.name}' refers to unknown input(s): {', '.join(unknown)}")
        for (a0, a1, an), (b0, b1, bn) in zip(spans, spans[1:]):
            if b0 <= a1:
                raise ValueError(f"Groups '{an}' and '{bn}' overlap")
        return self

    @model_validator(mode="after")
    def _base_has_no_branch(self):
        for i in self.inputs:
            if i.role == self.base and i.steps:
                raise ValueError("The main flow's starting input cannot have its own steps; put them in the main flow")
        return self

    @model_validator(mode="after")
    def _branches_form_no_loop(self):
        self.branch_order()
        return self

    @model_validator(mode="after")
    def _extra_outputs_fit(self):
        ids = set()
        for o in self.extra_outputs:
            if o.id in ids or o.id == "main":
                raise ValueError(f"Duplicate output id '{o.id}'")
            ids.add(o.id)
            if o.branch is not None and o.branch not in self.roles():
                raise ValueError(f"Output '{o.name}' refers to unknown input '{o.branch}'")
            steps = self.steps if o.branch is None else self.input(o.branch).steps
            if o.after >= len(steps):
                raise ValueError(f"Output '{o.name}' is taken after a step that doesn't exist")
        return self

    def roles(self) -> list[str]:
        return [i.role for i in self.inputs]

    def input(self, role: str) -> RecipeInput:
        return next(i for i in self.inputs if i.role == role)

    def branch_order(self) -> list[str]:
        """Inputs with their own steps, ordered so every input runs after the inputs it joins or appends."""
        roles = set(self.roles())
        deps: dict[str, set[str]] = {}
        for i in self.inputs:
            refs: set[str] = set()
            for s in i.steps:
                refs |= set(step_refs(s))
            unknown = refs - roles
            if unknown:
                raise ValueError(f"Input '{i.role}' combines unknown input(s): {', '.join(sorted(unknown))}")
            if i.role in refs:
                raise ValueError(f"Input '{i.role}' cannot join or append itself")
            deps[i.role] = refs
        order: list[str] = []
        state: dict[str, int] = {}   # 1 = visiting, 2 = done

        def visit(role: str, path: list[str]) -> None:
            if state.get(role) == 2:
                return
            if state.get(role) == 1:
                loop = path[path.index(role):] + [role]
                raise ValueError("These inputs combine each other in a loop: " + " → ".join(loop))
            state[role] = 1
            for d in sorted(deps.get(role, ())):
                visit(d, path + [role])
            state[role] = 2
            order.append(role)

        for i in self.inputs:
            visit(i.role, [])
        return [r for r in order if self.input(r).steps]


def step_refs(step) -> list[str]:
    """Inputs a step reads besides the table flowing through it."""
    if step.op == "join":
        return [step.right] if step.right else []
    if step.op == "append_rows":
        return list(step.inputs)
    return []


OPERATION_CATALOG = [
    {"op": "select_columns", "label": "Select columns", "help": "Keep only the listed columns, in this order."},
    {"op": "rename_columns", "label": "Rename columns", "help": "Rename columns, e.g. 'Amt' → 'Amount'."},
    {"op": "filter_rows", "label": "Filter rows", "help": "Keep rows matching all/any conditions."},
    {"op": "sort_rows", "label": "Sort rows", "help": "Sort by one or more columns."},
    {"op": "append_rows", "label": "Append (stack) tables", "help": "Stack other inputs below the current table."},
    {"op": "join", "label": "Join / lookup", "help": "Bring in columns from another input by matching keys."},
    {"op": "deduplicate", "label": "Remove duplicates", "help": "Drop repeated rows by key columns."},
    {"op": "convert_types", "label": "Convert types", "help": "Turn text into numbers or dates, etc."},
    {"op": "derive_column", "label": "Calculated column", "help": "New column from a formula, e.g. [Qty] * [Price]."},
    {"op": "group_aggregate", "label": "Group & summarise", "help": "Totals, averages, counts by group."},
    {"op": "pivot", "label": "Pivot", "help": "Turn category values into columns."},
    {"op": "unpivot", "label": "Unpivot", "help": "Turn columns into rows."},
]
