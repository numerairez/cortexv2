"""Assemble a distributable folder (and .zip) for colleagues.

    python scripts/build_release.py                  # build UI + package
    python scripts/build_release.py --wheels         # also bundle Windows wheels for offline setup
    python scripts/build_release.py --bundle-python  # include a ready-to-run Python: no setup on the PC

The release contains the backend code, the compiled UI, the launch/setup scripts and,
optionally, a ``wheels`` folder so ``setup.bat`` can install without internet access, or
a ``python`` folder holding Python itself with every package already installed.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import APP_VERSION  # noqa: E402

INCLUDE = ["launch.bat", "setup.bat", "launch.sh", "README.md", "PLAN.md"]
# python.org's Windows "embeddable package": a portable Python that runs from a folder without installing.
# 3.11.9 is the last 3.11 with one, and matches the 3.11 the lock file and tests use.
EMBED_PYTHON = "3.11.9"


def run(cmd: list[str], cwd: Path) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True, shell=sys.platform == "win32")


def locked_requirements() -> list[str]:
    lock = (ROOT / "backend" / "requirements.lock").read_text().splitlines()
    # pip evaluates environment markers against *this* machine, so Windows-only
    # requirements (e.g. colorama) must be listed explicitly without their marker.
    return [ln.split(";")[0].strip() for ln in lock if ln.strip() and not ln.startswith("#")]


def bundle_python(out: Path, version: str) -> None:
    """Put a portable Windows Python with every locked package installed in ``out/python``.

    Nothing runs the Windows Python here: pip unpacks the win_amd64 wheels straight into
    its site-packages, so this works from macOS or Linux too.
    """
    dest = out / "python"
    url = f"https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip"
    print("$ download", url)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "embed.zip"
        urllib.request.urlretrieve(url, archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
    site = dest / "Lib" / "site-packages"
    major_minor = ".".join(version.split(".")[:2])
    run([sys.executable, "-m", "pip", "install", "--only-binary=:all:", "--platform", "win_amd64",
         "--implementation", "cp", "--python-version", major_minor, "--no-deps", "--no-compile",
         "--target", str(site), *locked_requirements()], ROOT)
    # Console-script launchers made for this machine; the app never uses them.
    shutil.rmtree(site / "bin", ignore_errors=True)
    # The ._pth file is the embeddable Python's only module search path (PYTHONPATH is ignored),
    # so it lists the packages and the app's backend, relative to the python folder.
    pth = next(dest.glob("python3*._pth"))
    pth.write_text("\n".join([f"{pth.stem}.zip", ".", r"Lib\site-packages", r"..\backend", "import site", ""]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheels", action="store_true", help="download win_amd64 wheels for offline installs")
    ap.add_argument("--python-version", default="3.11", help="target Python for bundled wheels")
    ap.add_argument("--bundle-python", nargs="?", const=EMBED_PYTHON, metavar="VERSION",
                    help=f"include a portable Windows Python with the packages installed (default {EMBED_PYTHON})")
    ap.add_argument("--skip-ui", action="store_true", help="reuse an existing frontend/dist")
    args = ap.parse_args()

    if not args.skip_ui:
        run(["npm", "ci"] if (ROOT / "frontend" / "package-lock.json").exists() else ["npm", "install"], ROOT / "frontend")
        run(["npm", "run", "build"], ROOT / "frontend")
    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        sys.exit("frontend/dist is missing; build the UI first")

    out = ROOT / "release" / f"flowbook-{APP_VERSION}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(ROOT / "backend", out / "backend",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "tests"))
    shutil.copytree(ROOT / "frontend" / "dist", out / "frontend" / "dist")
    if (ROOT / "samples").is_dir():   # demo files: sales workbooks, product list, policy docs, a macro workbook
        shutil.copytree(ROOT / "samples", out / "samples")
    for name in INCLUDE:
        if not (ROOT / name).exists():
            continue
        if name.endswith(".bat"):
            # cmd.exe misreads batch files with Unix line endings, which a macOS checkout can have.
            text = (ROOT / name).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            (out / name).write_bytes(text)
        else:
            shutil.copy2(ROOT / name, out / name)
    if args.bundle_python:
        bundle_python(out, args.bundle_python)
    elif args.wheels:   # a bundled Python already has the packages, so wheels would only add size
        run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--platform", "win_amd64",
             "--python-version", args.python_version, "--no-deps", *locked_requirements(), "-d", str(out / "wheels")], ROOT)
    archive = shutil.make_archive(str(out), "zip", out.parent, out.name)
    print(f"\nRelease folder: {out}\nArchive:        {archive}")


if __name__ == "__main__":
    main()
