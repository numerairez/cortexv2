"""Endpoints: health, environment check, settings, Confluence session, file browser."""

from __future__ import annotations

import importlib.metadata as md
import os
import string
import sys
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from ..config import APP_VERSION, MIN_PYTHON, get_paths
from ..connectors import confluence
from ..core import copies
from ..core.sources import DOCUMENT_EXTS, SourceError
from ..storage import db

router = APIRouter(prefix="/api")

SETTINGS_DEFAULTS = {
    "confluence_base_url": "",
    "retain_prompts": True,
    "prompt_token_budget": 100_000,
    "chatbot_name": "the approved company AI chatbot",
    "save_folder": None,   # where run results are saved when a workflow has no folder of its own
    "welcomed": False,     # the first-launch welcome has been answered (folder chosen or skipped)
}
BROWSABLE_EXTS = {".xlsx", ".xlsm", ".csv", ".tsv", ".xlsb", ".xls", ".bas", ".cls"} | DOCUMENT_EXTS
REQUIRED_PACKAGES = ["fastapi", "uvicorn", "pydantic", "pandas", "numpy", "openpyxl", "pypdf", "pypdfium2", "python-docx", "httpx", "olefile"]


@router.get("/health")
def health():
    return {"ok": True, "app": "flowbook", "version": APP_VERSION}


@router.get("/env")
def environment():
    paths = get_paths()
    pkgs = {}
    for p in REQUIRED_PACKAGES:
        try:
            pkgs[p] = md.version(p)
        except md.PackageNotFoundError:
            pkgs[p] = None
    writable = os.access(paths.root, os.W_OK)
    return {
        "python": sys.version.split()[0],
        "python_ok": sys.version_info[:2] >= MIN_PYTHON,
        "min_python": ".".join(map(str, MIN_PYTHON)),
        "platform": sys.platform,
        "packages": pkgs,
        "data_dir": str(paths.root),
        "data_dir_writable": writable,
        "artifact_dir": str(paths.artifacts),
        "app_version": APP_VERSION,
    }


@router.get("/settings")
def get_settings():
    out = {k: db.get_setting(k, v) for k, v in SETTINGS_DEFAULTS.items()}
    out["confluence_token_set"] = confluence.has_session_token()
    out["suggested_save_folder"] = str(_suggested_save_folder())
    return out


def _suggested_save_folder() -> Path:
    docs = Path.home() / "Documents"
    return (docs if docs.is_dir() else Path.home()) / "Flowbook"


def _prepare_save_folder(value: str) -> str:
    """Create the chosen save folder if needed and make sure files can be written there."""
    p = Path(value.strip().strip('"')).expanduser()
    if not p.is_absolute():
        raise SourceError("Use a full folder path")
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise SourceError(f"Couldn't create {p}. Choose another folder.")
    if not os.access(p, os.W_OK):
        raise SourceError("You don't have permission to save here")
    return str(p)


@router.put("/settings")
def put_settings(body: dict):
    for k, v in body.items():
        if k not in SETTINGS_DEFAULTS:
            continue
        if k == "confluence_base_url" and v and not str(v).startswith(("https://", "http://")):
            raise SourceError("Confluence URL must start with https://")
        if k == "prompt_token_budget":
            v = max(1000, int(v))
        if k in ("retain_prompts", "welcomed"):
            v = bool(v)
        if k == "save_folder":
            v = _prepare_save_folder(str(v)) if v else None
        db.set_setting(k, v)
    if "save_folder" in body:
        copies.sync_all()
    return get_settings()


class TokenBody(BaseModel):
    token: str


@router.post("/confluence/token")
def set_token(body: TokenBody):
    confluence.set_session_token(body.token.strip())
    return {"ok": True}


@router.delete("/confluence/token")
def clear_token():
    confluence.set_session_token(None)
    return {"ok": True}


@router.post("/confluence/test")
def test_confluence(body: dict):
    base = db.get_setting("confluence_base_url", "")
    try:
        page = confluence.fetch_page(base, confluence.parse_page_id(str(body.get("page", ""))))
    except confluence.ConfluenceError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "title": page["title"], "version": page["version"], "space": page["space"]}


def _roots() -> list[dict]:
    roots = [{"name": "Home", "path": str(Path.home())}]
    for name in ("Documents", "Desktop", "Downloads", "OneDrive"):
        p = Path.home() / name
        if p.is_dir():
            roots.append({"name": name, "path": str(p)})
    if sys.platform == "win32":
        for letter in string.ascii_uppercase:
            d = Path(f"{letter}:\\")
            if d.exists():
                roots.append({"name": f"{letter}:", "path": str(d)})
    return roots


@router.get("/fs/browse")
def browse(path: str | None = None):
    """List folders and supported files so users can pick sources without typing paths."""
    if not path:
        return {"path": None, "parent": None, "roots": _roots(), "entries": []}
    p = Path(path).expanduser()
    if not p.is_absolute() or not p.is_dir():
        raise SourceError("Folder not found", 404)
    entries = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
            if child.name.startswith((".", "~$")):
                continue
            try:
                if child.is_dir():
                    entries.append({"name": child.name, "path": str(child), "type": "dir"})
                elif child.suffix.lower() in BROWSABLE_EXTS:
                    entries.append({"name": child.name, "path": str(child), "type": "file",
                                    "size": child.stat().st_size})
            except OSError:
                continue
    except PermissionError:
        raise SourceError("Permission denied for this folder", 403)
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "roots": _roots(), "entries": entries[:2000]}


@router.get("/fs/check-folder")
def check_folder(path: str):
    """Can the app save files here? Used by the workflow's output-folder setting."""
    p = Path(path.strip().strip('"')).expanduser()
    if not p.is_absolute():
        return {"ok": False, "message": "Use a full folder path"}
    if not p.is_dir():
        return {"ok": False, "message": "Folder not found (check the drive is connected)"}
    if not os.access(p, os.W_OK):
        return {"ok": False, "message": "You don't have permission to save here"}
    return {"ok": True, "message": "OK — files will be saved here", "path": str(p)}
