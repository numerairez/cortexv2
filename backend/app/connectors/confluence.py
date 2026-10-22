"""Confluence Data Center/Server read-only connector (early technical spike).

Authentication uses a personal access token supplied by the user for the current
session only. The token is held in process memory and never written to SQLite,
logs, or config files.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

import httpx

from .documents import Segment, html_segments


class ConfluenceError(Exception):
    pass


_session_token: str | None = None


def set_session_token(token: str | None) -> None:
    global _session_token
    _session_token = token or None


def has_session_token() -> bool:
    return _session_token is not None


def parse_page_id(value: str) -> str:
    value = value.strip()
    if value.isdigit():
        return value
    url = urlparse(value)
    qs = parse_qs(url.query)
    if "pageId" in qs:
        return qs["pageId"][0]
    m = re.search(r"/pages/(\d+)", url.path)
    if m:
        return m.group(1)
    raise ConfluenceError(
        "Could not find a page ID. Paste a numeric page ID or a URL containing 'pageId=' or '/pages/<id>/'. "
        "Pretty '/display/SPACE/Title' URLs need the page ID from Page Information."
    )


def _client(base_url: str) -> httpx.Client:
    headers = {"Accept": "application/json"}
    if _session_token:
        headers["Authorization"] = f"Bearer {_session_token}"
    return httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=20.0, follow_redirects=False)


def fetch_page(base_url: str, page_id: str) -> dict:
    if not base_url:
        raise ConfluenceError("Set the Confluence base URL in Settings first")
    try:
        with _client(base_url) as c:
            r = c.get(f"/rest/api/content/{page_id}", params={"expand": "body.storage,version,space"})
    except httpx.HTTPError as e:
        raise ConfluenceError(f"Could not reach Confluence: {e.__class__.__name__}") from e
    if r.status_code in (301, 302, 303, 307, 308):
        raise ConfluenceError("Confluence redirected to a sign-in page; a personal access token is required")
    if r.status_code in (401, 403):
        raise ConfluenceError("Access denied by Confluence (check your token and page permissions)")
    if r.status_code == 404:
        raise ConfluenceError("Page not found, or you do not have permission to view it")
    if r.status_code >= 400:
        raise ConfluenceError(f"Confluence returned HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise ConfluenceError("Confluence returned a non-JSON response (possibly an SSO page)")
    return {
        "id": str(data.get("id", page_id)),
        "title": data.get("title", f"Page {page_id}"),
        "version": (data.get("version") or {}).get("number"),
        "space": (data.get("space") or {}).get("key"),
        "html": ((data.get("body") or {}).get("storage") or {}).get("value", ""),
        "url": base_url.rstrip("/") + ((data.get("_links") or {}).get("webui") or f"/pages/viewpage.action?pageId={page_id}"),
    }


def page_segments(page: dict) -> list[Segment]:
    return html_segments(page["html"])
