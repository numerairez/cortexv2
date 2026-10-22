# Adding a service

Services are developer-maintained. Each one is a Python class registered at import time. The shared runtime in `backend/app/api/runs.py` already handles snapshots, the export preview, copy/paste, validation retries, run history, and artifacts. A new service only implements its own hooks.

## 1. Choose a mode

| Mode | Implement | Example |
| --- | --- | --- |
| `deterministic` | your own endpoint or builder (see `services/transformation.py`) | Data Transformation Studio |
| `ai_assisted` | `build_prompt`, `accept_response` (AI proposes; local code validates/executes) | AI-drafted recipes |
| `ai_dependent` | `build_prompt`, `accept_response`, `finalize` (AI synthesises; local code validates/packages) | Knowledge Base |

## 2. Write the class

```python
# backend/app/services/glossary.py
from ..core import runs
from ..core.context import ResolvedItem
from . import prompting
from .base import OptionField, ResponseOutcome, Service, register

CONTRACT = '{"terms": [{"term": "string", "definition": "string", "citations": ["S1.2"]}]}'


class GlossaryService(Service):
    id = "glossary"
    name = "Glossary builder"
    description = "Extract defined terms from selected documents, with citations."
    mode = "ai_dependent"
    input_kind = "collection"           # or "datasets" for sheet bindings
    accepts = ["document", "page"]
    outputs = ["Markdown"]
    options = [OptionField("max_terms", "Maximum terms", "number", 50)]

    def build_prompt(self, run: dict, items: list[ResolvedItem]) -> tuple[str, dict]:
        redactions = run["config"].get("redactions") or []
        body = "\n\n".join(prompting.source_block(i, redactions) for i in items if i.segments and not i.error)
        prompt = f"{prompting.UNTRUSTED_NOTICE}\n\nList defined terms. Reply with JSON only:\n{CONTRACT}\n\n{body}"
        anchors = {s.anchor: s.locator for i in items for s in i.segments}
        return prompt, {"anchors": anchors}          # state is saved on the run

    def accept_response(self, run: dict, text: str) -> ResponseOutcome:
        out = ResponseOutcome()
        try:
            doc = prompting.extract_json(text)
        except ValueError as e:
            out.errors.append(str(e))
        # ... validate structure → out.errors (blocking) / out.warnings (flagged)
        if out.errors:
            out.corrective_prompt = prompting.corrective_prompt(out.errors, CONTRACT)
        else:
            out.state = {"glossary": doc}
            out.summary = {"terms": len(doc.get("terms", []))}
        return out

    def finalize(self, run: dict, outcome: ResponseOutcome) -> list[dict]:
        path = runs.artifact_path(run["id"], "glossary.md")
        path.write_text("...", encoding="utf-8")
        return [runs.register_artifact(run["id"], "markdown", path)]


register(GlossaryService())
```

Then import the module in `backend/app/main.py` next to the existing service imports so that it registers.

## 3. Rules

- **Treat source text as untrusted.** Always use `prompting.source_block` (it delimits and neutralises), and include `UNTRUSTED_NOTICE`.
- **Never execute pasted output.** Parse it with `prompting.extract_json` and validate it against a schema. If it describes operations, map them to an allowlist, as `transformations/` does.
- **Numbers come from local code.** If a service shows figures, compute them locally; the AI may only reference fields.
- **Escape everything** you render into HTML (`html.escape`). Artifact HTML is also served under a sandboxing CSP.
- **Errors vs. warnings:** `errors` reject the reply and offer a corrective prompt. `warnings` accept it but flag items for review.
- Add a test in `backend/tests/` with a valid reply, an invalid one, and a malicious one.

The UI renders `options` automatically on the service launch page. Collection-based AI services need no frontend changes. A service that needs a richer UI can set `builder_route` and add a page under `frontend/src/pages/`.
