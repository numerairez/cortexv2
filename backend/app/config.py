"""Runtime configuration: per-user data locations and server settings."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "ContextWorkbench"
APP_VERSION = "0.1.0"
MIN_PYTHON = (3, 10)
DEFAULT_PORT = 8765
HOST = "127.0.0.1"  # never bind to 0.0.0.0


def default_data_dir() -> Path:
    """Per-user, writable location outside the code checkout."""
    override = os.environ.get("CW_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_NAME


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def db(self) -> Path:
        return self.root / "workbench.sqlite3"

    @property
    def artifacts(self) -> Path:
        return self.root / "artifacts"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def instance_file(self) -> Path:
        return self.root / "instance.json"

    def ensure(self) -> "Paths":
        for p in (self.root, self.artifacts, self.logs):
            p.mkdir(parents=True, exist_ok=True)
        return self


_paths: Paths | None = None


def get_paths() -> Paths:
    global _paths
    if _paths is None:
        _paths = Paths(default_data_dir()).ensure()
    return _paths


def set_data_dir(root: Path) -> Paths:
    """Used by tests and the launcher to redirect storage."""
    global _paths
    _paths = Paths(Path(root)).ensure()
    return _paths


FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
