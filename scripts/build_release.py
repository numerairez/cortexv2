"""Assemble a distributable folder (and .zip) for colleagues.

    python scripts/build_release.py              # build UI + package
    python scripts/build_release.py --wheels     # also bundle Windows wheels for offline setup

The release contains the backend code, the compiled UI, the launch/setup scripts and,
optionally, a ``wheels`` folder so ``setup.bat`` can install without internet access.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import APP_VERSION  # noqa: E402

INCLUDE = ["launch.bat", "setup.bat", "launch.sh", "README.md", "PLAN.md"]


def run(cmd: list[str], cwd: Path) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True, shell=sys.platform == "win32")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheels", action="store_true", help="download win_amd64 wheels for offline installs")
    ap.add_argument("--python-version", default="3.11", help="target Python for bundled wheels")
    ap.add_argument("--skip-ui", action="store_true", help="reuse an existing frontend/dist")
    args = ap.parse_args()

    if not args.skip_ui:
        run(["npm", "ci"] if (ROOT / "frontend" / "package-lock.json").exists() else ["npm", "install"], ROOT / "frontend")
        run(["npm", "run", "build"], ROOT / "frontend")
    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        sys.exit("frontend/dist is missing; build the UI first")

    out = ROOT / "release" / f"context-workbench-{APP_VERSION}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(ROOT / "backend", out / "backend",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "tests"))
    shutil.copytree(ROOT / "frontend" / "dist", out / "frontend" / "dist")
    if (ROOT / "samples").is_dir():   # demo files: sales workbooks, product list, policy docs, a macro workbook
        shutil.copytree(ROOT / "samples", out / "samples")
    for name in INCLUDE:
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, out / name)
    if args.wheels:
        lock = (ROOT / "backend" / "requirements.lock").read_text().splitlines()
        # pip evaluates environment markers against *this* machine, so Windows-only
        # requirements (e.g. colorama) must be listed explicitly without their marker.
        reqs = [ln.split(";")[0].strip() for ln in lock if ln.strip() and not ln.startswith("#")]
        run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--platform", "win_amd64",
             "--python-version", args.python_version, "--no-deps", *reqs, "-d", str(out / "wheels")], ROOT)
    archive = shutil.make_archive(str(out), "zip", out.parent, out.name)
    print(f"\nRelease folder: {out}\nArchive:        {archive}")


if __name__ == "__main__":
    main()
