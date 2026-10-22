#!/usr/bin/env bash
# Developer/macOS/Linux launcher (colleagues on Windows use launch.bat).
set -euo pipefail
cd "$(dirname "$0")"
PY=".venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
PYTHONPATH="$PWD/backend" exec "$PY" -m app.launcher "$@"
