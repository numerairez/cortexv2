<img src="docs/brand/flowbook-logo.svg" width="72" alt="Flowbook logo">

# Flowbook

*Repeatable spreadsheet workflows — no macros needed.*

A local, browser-based **workflow studio** for spreadsheets. Colleagues drop in Excel/CSV files, build a visual, rerunnable workflow (filter, join, calculate, summarise…), and export the result. Existing **Excel macros can be imported**: the VBA is read (never run), every dataset it touches is flagged and connected, and an approved AI chatbot translates it into workflow steps through a manual copy-prompt / paste-reply loop.

Secondary tools build cited knowledge bases from documents and Confluence pages using reusable **Context Collections**.

Everything runs on the user's own PC, bound to `127.0.0.1`. See [PLAN.md](PLAN.md) for the product plan.

## For colleagues (Windows)

1. Unzip the release folder somewhere in your user area (e.g. `Documents\flowbook`).
2. If the folder contains a `python` folder, skip this step: Python and everything it needs are included. Otherwise double-click **`setup.bat`** once. It creates a private Python environment in `.venv` and installs the dependencies. If the release includes a `wheels` folder, setup runs fully offline.
3. Double-click **`launch.bat`**. Your browser opens the app. Keep the black window open while you work; close it to stop the app.

Your data (database, outputs, logs) lives in `%LOCALAPPDATA%\Flowbook`, not in the app folder, so updating the app never touches it. (Data from the app's earlier name, `ContextWorkbench`, is moved there automatically on first start.)

Requirements: none for a release with a `python` folder. Otherwise Python 3.10+ (3.11+ uses the pinned lock file). No administrator rights or Node.js needed.

**Updating to a new version:** close the black Flowbook window, delete the old app folder (or use a new one; don't unzip on top of it, or files removed from the app stay behind), unzip the new release, run `setup.bat` once if it has no `python` folder, then `launch.bat`. If the old version is still running, `launch.bat` says so and asks you to close it first, rather than opening the old screens. Your data is kept.

## What's implemented (MVP, milestones 1–3)

| Area | Status |
| --- | --- |
| Launcher: environment check, port selection, duplicate-instance detection, browser open, sanitised logs | ✅ |
| Sources: local files (xlsx/xlsm/csv/tsv/pdf/docx/txt/md), folder browser, fingerprints, change/missing detection, relocate to a new file | ✅ |
| Excel sheets: physical-row preview with Excel row numbers, suggested header row, manual override (e.g. row 5), column profiling, column subset | ✅ |
| Schema drift detection on reopen/refresh, with "accept new layout" | ✅ |
| Context Collections: create, order, include/exclude, save, reopen, check sources | ✅ |
| Export preview: per-passage exclusion, redactions, token estimate with budget warning | ✅ |
| **Workflows home**: drop a file to start, saved workflows with flow previews and last-run status | ✅ |
| **Workflow Studio** (Tableau Prep-style): flow canvas, settings + column profile pane, data grid; drag-and-drop files, inline sheet/header setup, undo/redo, Ctrl+S, unsaved-change warning | ✅ |
| **Excel macro → workflow**: VBA extraction from .xlsm/.xlsb/.xls/.bas (or pasted code); flags sheets, other workbooks (incl. sheets read from them), files picked at run time, folders, databases, web; flags actions a workflow can't do (email, delete, formatting…); connect each dataset, then AI translation validated by the same schema/executor with per-step macro line notes | ✅ |
| **Data templates**: recurring Excel/CSV files that differ by a date in the file name (e.g. `sales_{date}.xlsx`, `YYYY_MM`); offered automatically when a file has dated siblings; workflows choose which file (default: always the newest), runs record the exact file used, column changes are flagged | ✅ |
| **Input branches**: add the same data more than once; each extra input row can have its own steps (filter, calculate, group…) before a Join/Append combines it with the main flow | ✅ |
| **Step groups**: collapse consecutive steps into one node (Shift+click a range → Group); translated macros arrive as one 📜 group; expand/collapse, rename, ungroup; errors and warnings surface on the collapsed node. Groups are organisational only and never change results | ✅ |
| Data Transformation engine: 12 allowlisted operations, live per-step preview and row counts, join cardinality/unmatched diagnostics, safe formula language, xlsx/csv export with run summary, versioned recipes, rerun on new files | ✅ |
| AI-drafted recipes: schema-only (or approved samples) prompt → pasted JSON validated by the same schema and executor | ✅ |
| Knowledge Base service: anchored source prompts, untrusted-content delimiting, JSON contract, citation validation, corrective follow-up prompt, Markdown/HTML/JSON outputs | ✅ |
| Runs: append-only history, snapshots/provenance, prompt/reply history (retention toggle), artifacts | ✅ |
| Confluence (Data Center/Server REST, session-only personal access token) | ⚠️ Implemented, untested against the real intranet (Milestone 0 spike). Hidden in the UI with context collections; set `CONFLUENCE_ENABLED` in `frontend/src/features.ts` to show it |
| **Dashboards** (Vega-Lite): headlines, charts and tables (rows, summary or **pivot** with totals) on one library dataset, started from a gallery of **layout templates** filled from the dataset's own columns (some with interactions pre-wired), each with its own filter (same conditions as a workflow Filter step) and a caption naming its data source, row count and active filters, suggested starting layout, drag/resize grid editor, field drag-and-drop; static by default, with an **Interactions** wireframe mode to link objects so a click filters or highlights others; **describe interactions in words** (chatbot proposes filter/highlight links, previewed on the wireframe as a diff before applying); **describe an object in words** inside its wireframe → copy a prompt for the approved chatbot → paste the reply, validated against the dataset's columns (builder settings or Vega-Lite); optional hand-written Vega-Lite per chart (no external data or links) | ✅ |

## Development

```bash
# backend
python3.11 -m venv .venv
.venv/bin/pip install -r backend/requirements.lock -r backend/requirements-dev.txt
cd backend && ../.venv/bin/python -m pytest -q

# frontend (dev server with hot reload, proxies /api to :8765)
cd frontend && npm install && npm run dev

# run the full app (serves frontend/dist); use a throwaway data folder while developing
CW_DATA_DIR=$PWD/.cw-dev-data ./launch.sh

# demo files are committed in samples/; regenerate them with:
.venv/bin/python scripts/make_samples.py
```

The full app serves the compiled UI in `frontend/dist`, not `frontend/src`. When you start it from a checkout, the launcher rebuilds `frontend/dist` (`npm run build`) if anything in `frontend/src` changed since the last build, and stops with the errors if the build fails. Releases don't include `frontend/src`, so this check never runs on colleagues' PCs.

The server sends `Cache-Control: no-cache` for `index.html` and the other un-hashed files, so browsers pick up a new build on a normal reload. Files in `/assets` have content-hashed names and can be cached.

### Building a release for colleagues

1. Bump `APP_VERSION` in `backend/app/config.py` (e.g. `0.1.0` → `0.1.1`). The launcher compares versions: if an older version is still running when a colleague starts the new one, it asks them to close it instead of opening the old screens. Without a bump, it can't tell the two apart.
2. Run `python scripts/build_release.py --bundle-python` (recommended) or `python scripts/build_release.py --wheels`. Either needs Node.js/npm and internet access on your machine. It:
   - runs `npm ci` and `npm run build` in `frontend/`, so the release always has a fresh UI (`--skip-ui` reuses the existing `frontend/dist`);
   - recreates `release/flowbook-<version>/`, deleting any earlier folder for the same version;
   - copies in `backend/` (without tests and caches), `frontend/dist`, `samples/`, `launch.bat`, `setup.bat`, `launch.sh`, `README.md` and `PLAN.md`;
   - with `--bundle-python`, downloads python.org's Windows embeddable Python (3.11.9 by default; `--bundle-python 3.14.3` picks another) into `python/` and installs every package in `backend/requirements.lock` into it as Windows 64-bit builds. Colleagues need no Python, no `setup.bat` and no internet. The zip is about 50 MB;
   - with `--wheels` instead, downloads those packages as Windows 64-bit wheels for Python 3.11 into `wheels/`, so `setup.bat` installs offline into the colleague's own Python (`--python-version` targets another Python, e.g. `3.12`);
   - writes `launch.bat` and `setup.bat` with Windows line endings;
   - zips the folder to `release/flowbook-<version>.zip`.
3. Send the zip. Colleagues follow [Updating to a new version](#for-colleagues-windows).

How the bundled Python works: `launch.bat` uses `python\python.exe` when it exists (else `.venv`, else the system Python), and `setup.bat` exits straight away. The embeddable Python ignores `PYTHONPATH`; its search path is `python\python311._pth`, which the release script writes to include `Lib\site-packages` and `..\backend`. Nothing runs the Windows Python during the build, so a release can be built on macOS. Python 3.11.9 is the last 3.11 with an embeddable build. Moving to a newer Python means testing the app on it first.

With `--wheels`, the wheels match one Python version. A colleague whose Python differs (check with `py --version`) needs a release built with `--python-version` set to theirs. On Python 3.10, `setup.bat` installs `backend/requirements.txt` instead of the lock file, which the 3.11 wheels don't cover.

### Layout

```text
backend/app/
  main.py              FastAPI app, loopback/origin/CSRF guard, serves the UI
  launcher.py          entry point used by launch.bat / launch.sh
  api/                 HTTP endpoints
  core/                sources, selections, collections, context resolution & snapshots, runs, recipes
  connectors/          tabular (Excel/CSV), documents (pdf/docx/txt/md), confluence, vba (macro extraction + analysis)
  services/            Service contract + knowledge_base, transformation, macro (macro → workflow)
  transformations/     recipe schema, safe expressions, executor, export (formula-injection safe)
  storage/db.py        SQLite + migrations
frontend/src/          React + TypeScript UI (no component library)
docs/                  developer documentation
scripts/               sample data, release packaging, vbafixture (builds real .xlsm files with VBA for tests/demos)
```

See [docs/adding-a-service.md](docs/adding-a-service.md) to add a new service.

## Security notes

- The server binds only to `127.0.0.1`. Requests with a non-loopback `Host`, a foreign `Origin`, or a state-changing call without the `X-Workbench` header are rejected.
- Pasted AI output is only ever parsed as JSON against a schema. Recipes run through an allowlisted interpreter; formulas are parsed with `ast` and interpreted node by node. Nothing is passed to `eval`/`exec`.
- Source text is wrapped in delimiters and labelled as untrusted evidence. Text that imitates those delimiters is neutralised.
- Generated HTML is fully escaped and served with a sandboxing CSP.
- Exports never write formulas: formula-like text is stored as text in `.xlsx` and prefixed with `'` in `.csv`.
- Confluence tokens are held in memory only. Logs contain no document content, prompts, or request bodies.

## Known limitations

- Macro analysis is static and pattern-based: references built entirely at run time are flagged as "file chosen in code" for the user to resolve, not guessed. Translation quality depends on the chatbot; every proposed step is checked against the real data and shown for review before anything runs.
- Workbook formulas are read from their cached values. A file saved by a tool that doesn't store cached values (rare for Excel-saved files) reads those cells as blank.
- Legacy `.xls`, password-protected files, merged/multi-level headers, and scanned PDFs are not supported. They fail with a visible message rather than misreading.
- The `.bat` launchers have not yet been run on a corporate Windows PC (Milestone 0).
