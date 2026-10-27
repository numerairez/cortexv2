"""FastAPI application: API routers, local-only request guard, and the compiled UI."""

from __future__ import annotations

import logging
import os
from urllib.parse import urlparse
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import dashboards as dashboards_api
from .api import runs as runs_api
from .api import sources as sources_api
from .api import system as system_api
from .config import APP_VERSION, FRONTEND_DIST
from .core import copies
from .core.sources import SourceError
from .services import knowledge_base as _kb  # noqa: F401  (registers service)
from .services import macro as _macro  # noqa: F401  (registers service)
from .services import transformation as _tx  # noqa: F401  (registers services)
from .storage import db

log = logging.getLogger("workbench")

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
LOCAL_HOSTS = {"127.0.0.1", "localhost"}


def _env_ports() -> set[int] | None:
    raw = os.environ.get("CW_ALLOWED_PORTS", "")
    ports = {int(p) for p in raw.split(",") if p.strip().isdigit()}
    return ports or None


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.conn()  # run migrations before serving
    copies.sync_all()  # readable copies of workflows and dashboards in the save folder, in the background
    yield


def create_app(allowed_ports: set[int] | None = None) -> FastAPI:
    allowed_ports = allowed_ports or _env_ports()
    app = FastAPI(title="Flowbook", version=APP_VERSION, docs_url="/api/docs", redoc_url=None,
                  openapi_url="/api/openapi.json", lifespan=lifespan)

    @app.middleware("http")
    async def local_guard(request: Request, call_next):
        # 1) Host header must be loopback: blocks DNS-rebinding attacks from web pages.
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in LOCAL_HOSTS:
            return JSONResponse({"detail": "Forbidden host"}, status_code=403)
        # 2) Any browser Origin must be this app itself.
        origin = request.headers.get("origin")
        if origin:
            o = urlparse(origin)
            if o.hostname not in LOCAL_HOSTS or (allowed_ports and o.port not in allowed_ports):
                return JSONResponse({"detail": "Cross-origin requests are not allowed"}, status_code=403)
        # 3) State-changing API calls need a custom header, which other sites cannot send
        #    without a CORS preflight (and we never grant CORS).
        if request.method in MUTATING and request.url.path.startswith("/api/") \
                and request.headers.get("x-workbench") != "1":
            return JSONResponse({"detail": "Missing X-Workbench header"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    @app.exception_handler(SourceError)
    async def source_error(_: Request, exc: SourceError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        msgs = [f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors()[:10]]
        return JSONResponse({"detail": "; ".join(msgs) or "Invalid request"}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception):
        # Log type and message only — never request bodies, which may hold document content.
        log.error("Unhandled error: %s: %s", exc.__class__.__name__, str(exc)[:300])
        return JSONResponse({"detail": f"Unexpected error: {exc.__class__.__name__}"}, status_code=500)

    app.include_router(system_api.router)
    app.include_router(sources_api.router)
    app.include_router(runs_api.router)
    app.include_router(dashboards_api.router)

    if FRONTEND_DIST.is_dir():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not found"}, status_code=404)
            # Files under /assets have hashed names and may be cached; these (index.html, favicon…) do not, so
            # browsers must re-check them or they keep showing the previous build after an update.
            headers = {"Cache-Control": "no-cache"}
            candidate = (FRONTEND_DIST / full_path).resolve()
            if full_path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
                return FileResponse(candidate, headers=headers)
            return FileResponse(FRONTEND_DIST / "index.html", headers=headers)
    else:
        @app.get("/", include_in_schema=False)
        def no_ui():
            return JSONResponse({"detail": "UI not built. Run 'npm run build' in frontend/, or use the dev server."})

    return app


app = create_app()
