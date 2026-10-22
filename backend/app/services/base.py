"""The developer-facing Service contract and registry.

A service declares its inputs and options (rendered as a form by the UI) and
implements the stages that apply to its mode:

* deterministic  — ``execute`` only
* ai_assisted    — ``build_prompt`` → ``accept_response`` (AI proposes, local code validates/executes)
* ai_dependent   — ``build_prompt`` → ``accept_response`` (AI synthesises, local code validates/packages)

The shared runtime (``app.api.runs``) owns snapshotting, copy/paste, retries,
history and artifacts, so a new service only implements these hooks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Mode = Literal["deterministic", "ai_assisted", "ai_dependent"]


@dataclass
class OptionField:
    key: str
    label: str
    type: Literal["text", "textarea", "select", "boolean", "number"]
    default: Any = None
    choices: list[str] | None = None
    help: str | None = None

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class ResponseOutcome:
    """Result of validating a pasted AI response."""
    errors: list[str] = field(default_factory=list)       # blocking: response rejected
    warnings: list[str] = field(default_factory=list)     # non-blocking: shown and flagged in output
    corrective_prompt: str | None = None
    state: dict[str, Any] = field(default_factory=dict)   # merged into run.state
    summary: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors


class Service:
    id: str = ""
    name: str = ""
    description: str = ""
    mode: Mode = "deterministic"
    input_kind: Literal["collection", "datasets"] = "collection"
    accepts: list[str] = []          # selection kinds this service can use
    outputs: list[str] = []
    options: list[OptionField] = []
    builder_route: str | None = None  # UI route for services with a dedicated builder

    def describe(self) -> dict:
        return {
            "id": self.id, "name": self.name, "description": self.description, "mode": self.mode,
            "input_kind": self.input_kind, "accepts": self.accepts, "outputs": self.outputs,
            "options": [o.as_dict() for o in self.options], "builder_route": self.builder_route,
        }

    def default_options(self) -> dict:
        return {o.key: o.default for o in self.options}

    # --- AI stages ---------------------------------------------------------
    def build_prompt(self, run: dict, context: Any) -> tuple[str, dict]:
        """Return (prompt_text, state_to_remember)."""
        raise NotImplementedError

    def accept_response(self, run: dict, text: str) -> ResponseOutcome:
        raise NotImplementedError

    def finalize(self, run: dict, outcome: ResponseOutcome) -> list[dict]:
        """Write artifacts for an accepted response; return artifact records."""
        return []


_REGISTRY: dict[str, Service] = {}


def register(service: Service) -> Service:
    _REGISTRY[service.id] = service
    return service


def get_service(service_id: str) -> Service:
    try:
        return _REGISTRY[service_id]
    except KeyError:
        from ..core.sources import SourceError
        raise SourceError(f"Unknown service '{service_id}'", 404)


def all_services() -> list[Service]:
    return list(_REGISTRY.values())
