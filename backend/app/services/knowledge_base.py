"""Synthesized Knowledge Base (AI-dependent).

The AI writes the knowledge base as structured JSON whose claims cite source
anchors (e.g. ``S2.4``). Locally we check structure and that every cited anchor
exists. Whether a source truly supports a claim is NOT verified automatically;
the output flags anything that needs human review.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any

from ..core import runs
from ..core.context import ResolvedItem
from . import prompting
from .base import OptionField, ResponseOutcome, Service, register

CONTRACT = """{
  "title": "string",
  "summary": "2-5 sentence overview",
  "sections": [
    {
      "heading": "string",
      "claims": [
        {"text": "one self-contained statement", "basis": "fact" | "inference" | "unsupported", "citations": ["S1.2", "S3.1"]}
      ]
    }
  ],
  "contradictions": [{"description": "string", "citations": ["S1.4", "S2.2"]}],
  "open_questions": [{"question": "string", "citations": []}]
}"""

DETAIL = {
    "brief": "Keep it short: the essentials only, at most ~5 sections.",
    "standard": "Cover the main topics with moderate detail.",
    "detailed": "Be thorough: capture all substantive points, definitions, figures, and procedures.",
}

ANCHOR_RE = re.compile(r"^\[?\s*(S\d+(?:\.\d+)?)\s*\]?$")


class KnowledgeBaseService(Service):
    id = "knowledge_base"
    name = "Synthesized Knowledge Base"
    description = ("Turn selected documents, Confluence pages and sheets into a structured, cited knowledge base "
                   "using your approved AI chatbot. Citations are checked locally.")
    mode = "ai_dependent"
    input_kind = "collection"
    accepts = ["document", "page", "sheet"]
    outputs = ["Markdown", "HTML", "JSON"]
    options = [
        OptionField("audience", "Target audience", "text", "New team members",
                    help="Who will read this knowledge base?"),
        OptionField("detail", "Level of detail", "select", "standard", choices=list(DETAIL)),
        OptionField("topics", "Focus topics (optional)", "textarea", "",
                    help="One per line. Leave blank to cover everything."),
        OptionField("structure", "Desired structure (optional)", "textarea", "",
                    help="e.g. 'Overview, Processes, Roles, Systems, Glossary'"),
        OptionField("require_citations", "Require a citation for every factual claim", "boolean", True),
        OptionField("contradictions", "Look for contradictions between sources", "boolean", True),
        OptionField("gaps", "List knowledge gaps / open questions", "boolean", True),
    ]

    # ------------------------------------------------------------------ prompt
    def build_prompt(self, run: dict, items: list[ResolvedItem]) -> tuple[str, dict]:
        opts = {**self.default_options(), **(run["config"].get("options") or {})}
        redactions = run["config"].get("redactions") or []
        usable = [i for i in items if not i.error and i.segments]
        topics = [t.strip() for t in (opts.get("topics") or "").splitlines() if t.strip()]

        lines = [
            "You are helping build an internal knowledge base from the source material below.",
            prompting.UNTRUSTED_NOTICE,
            "",
            "# Task",
            f"- Audience: {opts.get('audience') or 'general staff'}.",
            f"- {DETAIL.get(opts.get('detail'), DETAIL['standard'])}",
        ]
        if topics:
            lines.append("- Focus on these topics: " + "; ".join(topics) + ".")
        if (opts.get("structure") or "").strip():
            lines.append(f"- Use this structure where it fits: {opts['structure'].strip()}")
        lines += [
            "- Write each claim as one self-contained statement.",
            "- Mark each claim's basis: \"fact\" (directly stated in a source), \"inference\" (your reasoning across "
            "sources), or \"unsupported\" (useful but not found in the sources).",
            "- Cite sources using ONLY the anchor IDs shown in the markers, e.g. \"S2.4\". Never invent anchors.",
        ]
        if opts.get("require_citations"):
            lines.append("- Every \"fact\" claim MUST have at least one citation.")
        lines.append("- Report contradictions between sources in \"contradictions\"." if opts.get("contradictions")
                     else "- Leave \"contradictions\" as an empty list.")
        lines.append("- List unanswered questions / knowledge gaps in \"open_questions\"." if opts.get("gaps")
                     else "- Leave \"open_questions\" as an empty list.")
        lines += [
            "",
            "# Reply format",
            "Reply with ONE JSON object only, no other text, matching:",
            CONTRACT,
            "",
            "# Source manifest",
        ]
        for i in usable:
            lines.append(f"- {i.ref}: {prompting.neutralise(i.label)} — {i.kind}, {len(i.segments)} passage(s)")
        lines += ["", "# Sources", ""]
        lines += [prompting.source_block(i, redactions) for i in usable]
        lines += ["", "Remember: reply with the JSON object only."]
        prompt = "\n".join(lines)

        anchors = {}
        excerpts = {}
        for i in usable:
            anchors[i.ref] = {"ref": i.ref, "locator": "(whole source)", "label": i.label, "link": i.link,
                              "source_name": i.source_name, "version": i.version}
            for s in i.segments:
                anchors[s.anchor] = {"ref": i.ref, "locator": s.locator, "label": i.label, "link": i.link,
                                     "source_name": i.source_name, "version": i.version}
                if runs.retain_prompts():
                    excerpts[s.anchor] = prompting.apply_redactions(s.text[:400], redactions)
        state = {"anchors": anchors, "excerpts": excerpts, "options": opts,
                 "sources": [{"ref": i.ref, "label": i.label, "kind": i.kind, "link": i.link, "location": i.location,
                              "version": i.version} for i in usable]}
        return prompt, state

    # ---------------------------------------------------------------- validate
    def accept_response(self, run: dict, text: str) -> ResponseOutcome:
        state = run["state"]
        anchors: dict = state.get("anchors", {})
        opts = state.get("options", {})
        out = ResponseOutcome()
        try:
            doc = prompting.extract_json(text)
        except ValueError as e:
            out.errors.append(str(e))
            out.corrective_prompt = prompting.corrective_prompt(out.errors, CONTRACT)
            return out

        errors, warnings = out.errors, out.warnings
        if not isinstance(doc, dict):
            errors.append("The top level must be a JSON object")
            doc = {}
        if not isinstance(doc.get("title"), str) or not doc.get("title", "").strip():
            errors.append('"title" must be a non-empty string')
        sections = doc.get("sections")
        if not isinstance(sections, list) or not sections:
            errors.append('"sections" must be a non-empty list')
            sections = []

        unknown: set[str] = set()
        flagged = 0
        clean_sections = []
        for si, sec in enumerate(sections, start=1):
            if not isinstance(sec, dict):
                errors.append(f"Section {si} must be an object")
                continue
            heading = sec.get("heading")
            if not isinstance(heading, str) or not heading.strip():
                errors.append(f"Section {si} needs a \"heading\"")
            claims = sec.get("claims")
            if not isinstance(claims, list):
                errors.append(f"Section {si} (\"{heading}\") needs a \"claims\" list")
                continue
            clean_claims = []
            for ci, cl in enumerate(claims, start=1):
                where = f"Section {si} claim {ci}"
                if not isinstance(cl, dict) or not isinstance(cl.get("text"), str) or not cl["text"].strip():
                    errors.append(f"{where} needs non-empty \"text\"")
                    continue
                basis = cl.get("basis", "fact")
                if basis not in ("fact", "inference", "unsupported"):
                    errors.append(f"{where}: basis must be fact, inference or unsupported (got {basis!r})")
                    continue
                cits, issues = self._citations(cl.get("citations", []), anchors, where, unknown)
                if issues:
                    warnings.extend(issues)
                if basis == "fact" and not cits and opts.get("require_citations", True):
                    issues = issues + ["factual claim without a valid citation"]
                    warnings.append(f"{where}: factual claim has no valid citation")
                if issues:
                    flagged += 1
                clean_claims.append({"text": cl["text"].strip(), "basis": basis, "citations": cits,
                                     "flags": issues})
            clean_sections.append({"heading": (heading or f"Section {si}").strip(), "claims": clean_claims})

        def items(key, field):
            vals = doc.get(key) or []
            if not isinstance(vals, list):
                errors.append(f'"{key}" must be a list')
                return []
            res = []
            for n, v in enumerate(vals, start=1):
                if isinstance(v, str):
                    v = {field: v}
                if not isinstance(v, dict) or not isinstance(v.get(field), str):
                    errors.append(f'{key} item {n} needs "{field}" text')
                    continue
                cits, issues = self._citations(v.get("citations", []), anchors, f"{key} item {n}", unknown)
                warnings.extend(issues)
                res.append({field: v[field].strip(), "citations": cits, "flags": issues})
            return res

        contradictions = items("contradictions", "description")
        questions = items("open_questions", "question")

        if errors:
            out.corrective_prompt = prompting.corrective_prompt(errors + warnings, CONTRACT)
            return out
        if unknown:
            warnings.insert(0, f"{len(unknown)} cited anchor(s) do not exist in the sources: "
                               + ", ".join(sorted(unknown)[:20]))
        if warnings:
            out.corrective_prompt = prompting.corrective_prompt(
                warnings + ["Valid anchors are: " + ", ".join(list(anchors)[:400])], CONTRACT)
        n_claims = sum(len(s["claims"]) for s in clean_sections)
        out.state = {"document": {"title": doc["title"].strip(), "summary": str(doc.get("summary") or "").strip(),
                                  "sections": clean_sections, "contradictions": contradictions,
                                  "open_questions": questions}}
        out.summary = {"sections": len(clean_sections), "claims": n_claims, "flagged_claims": flagged,
                       "invalid_citations": len(unknown), "contradictions": len(contradictions),
                       "open_questions": len(questions)}
        return out

    @staticmethod
    def _citations(raw: Any, anchors: dict, where: str, unknown: set[str]) -> tuple[list[str], list[str]]:
        if raw is None:
            return [], []
        if isinstance(raw, str):
            raw = [p for p in re.split(r"[,\s;]+", raw) if p]
        if not isinstance(raw, list):
            return [], [f"{where}: citations must be a list"]
        valid, issues = [], []
        for c in raw:
            m = ANCHOR_RE.match(str(c).strip())
            a = m.group(1) if m else str(c).strip()
            if a in anchors:
                if a not in valid:
                    valid.append(a)
            else:
                unknown.add(a)
                issues.append(f"{where}: cites '{a}', which is not a known anchor")
        return valid, issues

    # ---------------------------------------------------------------- outputs
    def finalize(self, run: dict, outcome: ResponseOutcome) -> list[dict]:
        state = {**run["state"], **outcome.state}
        doc = state["document"]
        base = runs.safe_filename(doc["title"]) or "knowledge_base"
        arts = []
        md = runs.artifact_path(run["id"], f"{base}.md")
        md.write_text(render_markdown(doc, state), encoding="utf-8")
        arts.append(runs.register_artifact(run["id"], "markdown", md, {"title": doc["title"]}))
        h = runs.artifact_path(run["id"], f"{base}.html")
        h.write_text(render_html(doc, state, run), encoding="utf-8")
        arts.append(runs.register_artifact(run["id"], "html", h, {"title": doc["title"], "viewable": True}))
        j = runs.artifact_path(run["id"], f"{base}.json")
        j.write_text(json.dumps({"document": doc, "sources": state.get("sources", []),
                                 "anchors": state.get("anchors", {}), "run_id": run["id"]}, indent=2,
                                ensure_ascii=False), encoding="utf-8")
        arts.append(runs.register_artifact(run["id"], "json", j, {"title": doc["title"]}))
        return arts


def _cite_md(cits: list[str]) -> str:
    return "".join(f" [{c}]" for c in cits)


def render_markdown(doc: dict, state: dict) -> str:
    anchors = state.get("anchors", {})
    out = [f"# {doc['title']}", ""]
    if doc.get("summary"):
        out += [doc["summary"], ""]
    out += ["> Generated with an AI assistant from the sources listed below. Citations were checked to exist, "
            "but not that they prove each claim. Items marked ⚠ need review.", ""]
    for sec in doc["sections"]:
        out += [f"## {sec['heading']}", ""]
        for cl in sec["claims"]:
            tag = {"inference": " *(inference)*", "unsupported": " *(unsupported — not found in sources)*"}.get(cl["basis"], "")
            warn = " ⚠" if cl["flags"] else ""
            out.append(f"- {cl['text']}{tag}{_cite_md(cl['citations'])}{warn}")
        out.append("")
    if doc["contradictions"]:
        out += ["## Contradictions between sources", ""]
        out += [f"- {c['description']}{_cite_md(c['citations'])}" for c in doc["contradictions"]] + [""]
    if doc["open_questions"]:
        out += ["## Open questions and knowledge gaps", ""]
        out += [f"- {q['question']}{_cite_md(q['citations'])}" for q in doc["open_questions"]] + [""]
    out += ["## Sources", ""]
    for a, info in anchors.items():
        if "." not in a:
            continue
        link = f" — {info['link']}" if info.get("link") else ""
        out.append(f"- **[{a}]** {info['label']}, {info['locator']}{link}")
    return "\n".join(out) + "\n"


def render_html(doc: dict, state: dict, run: dict) -> str:
    e = html.escape
    anchors = state.get("anchors", {})
    excerpts = state.get("excerpts", {})
    cited: list[str] = []

    def chips(cits):
        for c in cits:
            if c not in cited:
                cited.append(c)
        return "".join(f'<a class="cite" href="#src-{e(c)}">{e(c)}</a>' for c in cits)

    toc, body = [], []
    for n, sec in enumerate(doc["sections"], start=1):
        sid = f"sec-{n}"
        toc.append(f'<li><a href="#{sid}">{e(sec["heading"])}</a></li>')
        claims = []
        for cl in sec["claims"]:
            cls = f'claim {cl["basis"]}' + (" flagged" if cl["flags"] else "")
            badge = {"inference": '<span class="badge inf">inference</span>',
                     "unsupported": '<span class="badge uns">unsupported</span>'}.get(cl["basis"], "")
            flag = (f'<span class="flag" title="{e("; ".join(cl["flags"]))}">⚠ review</span>' if cl["flags"] else "")
            claims.append(f'<li class="{cls}">{e(cl["text"])} {badge}{chips(cl["citations"])}{flag}</li>')
        body.append(f'<section id="{sid}"><h2>{e(sec["heading"])}</h2><ul>{"".join(claims)}</ul></section>')
    if doc["contradictions"]:
        toc.append('<li><a href="#contradictions">Contradictions</a></li>')
        body.append('<section id="contradictions"><h2>Contradictions between sources</h2><ul>' + "".join(
            f'<li>{e(c["description"])} {chips(c["citations"])}</li>' for c in doc["contradictions"]) + "</ul></section>")
    if doc["open_questions"]:
        toc.append('<li><a href="#questions">Open questions</a></li>')
        body.append('<section id="questions"><h2>Open questions &amp; knowledge gaps</h2><ul>' + "".join(
            f'<li>{e(q["question"])} {chips(q["citations"])}</li>' for q in doc["open_questions"]) + "</ul></section>")
    toc.append('<li><a href="#sources">Sources</a></li>')
    src_rows = []
    for a in sorted(cited, key=_anchor_key):
        info = anchors.get(a, {})
        link = info.get("link")
        label = e(info.get("label", a))
        title = f'<a href="{e(link)}" target="_blank" rel="noopener">{label}</a>' if link and link.startswith("http") else label
        loc = f' <span class="path">{e(link)}</span>' if link and not link.startswith("http") else ""
        ex = f'<blockquote>{e(excerpts[a])}{"…" if len(excerpts[a]) >= 400 else ""}</blockquote>' if a in excerpts else ""
        src_rows.append(f'<li id="src-{e(a)}"><b>{e(a)}</b> {title}, {e(info.get("locator", ""))}{loc}{ex}</li>')
    body.append(f'<section id="sources"><h2>Sources cited</h2><ol class="sources">{"".join(src_rows)}</ol></section>')
    summary = f'<p class="summary">{e(doc["summary"])}</p>' if doc.get("summary") else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(doc['title'])}</title>
<style>
:root {{ --fg:#1d2433; --muted:#5b6475; --bg:#fff; --line:#e3e6ec; --accent:#2457c5; --warn:#a15c00; --warnbg:#fff4e0; }}
@media (prefers-color-scheme: dark) {{ :root {{ --fg:#e6e9ef; --muted:#9aa3b2; --bg:#14171c; --line:#2a2f38; --accent:#7aa2ff; --warn:#ffb347; --warnbg:#2e2412; }} }}
body {{ margin:0; font:15px/1.6 system-ui, "Segoe UI", sans-serif; color:var(--fg); background:var(--bg); }}
.wrap {{ display:grid; grid-template-columns: 240px 1fr; max-width:1200px; margin:0 auto; }}
nav {{ position:sticky; top:0; height:100vh; overflow:auto; padding:24px 16px; border-right:1px solid var(--line); font-size:14px; }}
nav ul {{ list-style:none; padding:0; margin:0; }} nav li {{ margin:6px 0; }} nav a {{ color:var(--fg); text-decoration:none; }}
main {{ padding:24px 40px 80px; min-width:0; }}
h1 {{ margin-top:0; }} h2 {{ border-bottom:1px solid var(--line); padding-bottom:4px; margin-top:36px; }}
.note {{ color:var(--muted); font-size:13px; border-left:3px solid var(--line); padding-left:10px; }}
.summary {{ font-size:16px; }}
li.claim {{ margin:6px 0; }}
.cite {{ display:inline-block; font-size:11px; padding:0 5px; margin-left:3px; border:1px solid var(--line); border-radius:4px; color:var(--accent); text-decoration:none; vertical-align:1px; }}
.badge {{ font-size:11px; padding:0 5px; border-radius:4px; background:var(--line); color:var(--muted); }}
.flagged {{ background:var(--warnbg); border-radius:4px; padding:2px 4px; }}
.flag {{ color:var(--warn); font-size:12px; margin-left:6px; cursor:help; }}
.sources li {{ margin:10px 0; scroll-margin-top:16px; }} .sources li:target {{ background:var(--warnbg); }}
.path {{ display:block; color:var(--muted); font-size:12px; word-break:break-all; }}
blockquote {{ margin:6px 0 0; padding:6px 10px; border-left:3px solid var(--line); color:var(--muted); font-size:13px; white-space:pre-wrap; }}
@media (max-width: 760px) {{ .wrap {{ grid-template-columns:1fr; }} nav {{ position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); }} main {{ padding:16px; }} }}
</style></head>
<body><div class="wrap"><nav><b>Contents</b><ul>{''.join(toc)}</ul></nav>
<main><h1>{e(doc['title'])}</h1>{summary}
<p class="note">Generated with an AI assistant from selected sources (run {e(run['id'])}). Citation anchors were checked to exist; whether each source supports its claim was not verified automatically. Items marked ⚠ need review.</p>
{''.join(body)}</main></div></body></html>"""


def _anchor_key(a: str):
    nums = re.findall(r"\d+", a)
    return [int(n) for n in nums]


register(KnowledgeBaseService())
