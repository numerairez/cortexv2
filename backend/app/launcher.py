"""Entry point used by launch.bat / launch.sh.

Checks the environment, avoids duplicate instances, starts the server on
127.0.0.1, waits for a health check, then opens the browser.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler

MIN_PYTHON = (3, 10)
REQUIRED_MODULES = {"fastapi": "fastapi", "uvicorn": "uvicorn", "pandas": "pandas", "openpyxl": "openpyxl",
                    "pypdf": "pypdf", "docx": "python-docx", "httpx": "httpx",
                    "olefile": "olefile"}


def fail(message: str) -> None:
    print("\n" + "=" * 70)
    print("  Context Workbench could not start")
    print("=" * 70)
    print(message)
    print("=" * 70 + "\n")
    sys.exit(1)


def check_environment() -> None:
    if sys.version_info[:2] < MIN_PYTHON:
        fail(f"Python {'.'.join(map(str, MIN_PYTHON))} or newer is required; this is Python "
             f"{sys.version.split()[0]} at {sys.executable}.\nAsk IT for a supported Python, then run setup.bat.")
    missing = []
    for module, package in REQUIRED_MODULES.items():
        try:
            importlib.import_module(module)
        except Exception:
            missing.append(package)
    if missing:
        fail("Some required packages are not installed: " + ", ".join(missing) +
             "\n\nRun setup.bat once (it installs them into a private .venv folder),\n"
             "then start the app again with launch.bat.")


def setup_logging(log_dir) -> None:
    handler = RotatingFileHandler(log_dir / "workbench.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    # Access logs include URLs with query strings (e.g. file paths); keep them out of the log file.
    logging.getLogger("uvicorn.access").disabled = True


def healthy(port: int, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            return json.load(r).get("app") == "context-workbench"
    except Exception:
        return False


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Start Context Workbench")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    check_environment()

    from .config import DEFAULT_PORT, HOST, get_paths

    paths = get_paths()
    setup_logging(paths.logs)
    log = logging.getLogger("launcher")

    # Reuse an already-running instance instead of starting a second one.
    if paths.instance_file.exists():
        try:
            info = json.loads(paths.instance_file.read_text())
            if healthy(int(info["port"])):
                url = f"http://127.0.0.1:{info['port']}/"
                print(f"Context Workbench is already running at {url} — opening it.")
                if not args.no_browser:
                    webbrowser.open(url)
                return
        except Exception:
            pass
        paths.instance_file.unlink(missing_ok=True)

    candidates = [args.port] if args.port else list(range(DEFAULT_PORT, DEFAULT_PORT + 20))
    port = next((p for p in candidates if port_free(p)), None)
    if port is None:
        fail(f"No free local port found in {candidates[0]}–{candidates[-1]}. Close other programs and retry.")

    os.environ["CW_ALLOWED_PORTS"] = str(port)
    import uvicorn

    from .main import create_app

    app = create_app(allowed_ports={port})
    config = uvicorn.Config(app, host=HOST, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    url = f"http://127.0.0.1:{port}/"
    for _ in range(100):
        if healthy(port, 0.5):
            break
        if not thread.is_alive():
            fail("The server stopped during start-up. See the log in:\n" + str(paths.logs))
        time.sleep(0.1)
    else:
        fail("The server did not respond in time. See the log in:\n" + str(paths.logs))

    paths.instance_file.write_text(json.dumps({"port": port, "pid": os.getpid()}))
    log.info("Started on port %s (data dir %s)", port, paths.root)
    print("\n  Context Workbench is running at " + url)
    print("  Your data is stored in: " + str(paths.root))
    print("\n  Keep this window open while you use the app.")
    print("  To stop: close this window or press Ctrl+C.\n")
    if not args.no_browser:
        webbrowser.open(url)

    def _terminate(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _terminate)
    try:
        while thread.is_alive():
            thread.join(0.5)
    except KeyboardInterrupt:
        print("Stopping…")
        server.should_exit = True
        thread.join(5)
    finally:
        paths.instance_file.unlink(missing_ok=True)
        log.info("Stopped")


if __name__ == "__main__":
    main()
