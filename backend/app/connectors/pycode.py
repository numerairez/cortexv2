"""Python script / notebook extraction and static analysis.

The counterpart of ``vba`` for data scripts (pandas, openpyxl, csv…). Code is
parsed with ``ast`` and never executed. The scan flags what the script reads
(files, folders, databases, web addresses, files chosen at run time) and actions
a data workflow cannot reproduce (emails, deleting files, shell commands). The
result has the same shape as ``vba.load`` so the macro import flow can reuse it.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import re
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

from .vba import DATA_EXT, Module, VBAError

SCRIPT_EXTS = {".py", ".ipynb"}
DATA_FILE = re.compile(r"\.(?:" + DATA_EXT + r"|parquet|feather|pkl|pickle)$", re.IGNORECASE)
URL = re.compile(r"^https?://\S+$", re.IGNORECASE)

# Function names (last attribute) that read a file given as the first argument / a keyword.
READERS = {
    "read_csv", "read_excel", "read_table", "read_json", "read_parquet", "read_feather", "read_pickle", "read_xml",
    "read_fwf", "ExcelFile", "load_workbook", "open_workbook", "open", "loadtxt", "genfromtxt", "read_text", "read_bytes",
}
PATH_KWARGS = ("filepath_or_buffer", "io", "path", "filename", "file", "path_or_buf", "fname")
WRITERS = {"to_csv", "to_excel", "to_parquet", "to_json", "to_feather", "to_pickle", "ExcelWriter", "save", "write_text"}
FOLDER_CALLS = {"glob", "iglob", "rglob", "listdir", "scandir", "iterdir", "walk"}
DB_CALLS = {"read_sql", "read_sql_query", "read_sql_table", "create_engine", "connect"}
DB_MODULES = {"sqlite3", "pyodbc", "psycopg2", "psycopg", "pymysql", "mysql", "cx_Oracle", "oracledb", "sqlalchemy",
              "pymssql", "snowflake", "duckdb"}
WEB_CALLS = {"get", "post", "urlopen", "urlretrieve", "request"}
WEB_MODULES = {"requests", "urllib", "httpx", "aiohttp"}
USER_PICK_CALLS = {"askopenfilename", "askopenfilenames", "askdirectory", "input"}

# Libraries common in data scripts that Flowbook itself may not have installed: importing these is
# not a sign of code living in another of the user's files.
KNOWN_LIBRARIES = {
    "pandas", "numpy", "openpyxl", "xlrd", "xlwt", "xlsxwriter", "xlwings", "pyxlsb", "calamine", "polars", "pyarrow",
    "scipy", "sklearn", "statsmodels", "matplotlib", "seaborn", "plotly", "tabulate", "tqdm", "dateutil", "pytz",
    "yaml", "dotenv", "win32com", "pywintypes", "pythoncom", "tkinter", "IPython", "docx", "pypdf", "PyPDF2",
    "smtplib", "yagmail", "exchangelib", "schedule", "pydantic", "attr", "attrs", "rich", "click", "typer",
} | DB_MODULES | WEB_MODULES
NOTEBOOK_RUN = re.compile(r"^#\s*%run\s+(?:-\S+\s+)*['\"]?([^\s'\"]+)", re.MULTILINE)

# (modules, call names, label): a call matches when its dotted name starts with one of
# the modules, or — for an empty module set — when its last part is one of the names.
ACTIONS = [
    ({"smtplib", "yagmail", "exchangelib", "win32com"}, set(), "Sends email"),
    ({"shutil"}, set(), "Deletes, copies or moves files"),
    ({"subprocess"}, set(), "Runs external programs"),
    ({"matplotlib", "plt", "seaborn", "sns", "plotly", "px"}, set(), "Builds charts"),
    (set(), {"Font", "PatternFill", "Border", "Alignment", "set_column", "add_format", "conditional_formatting"},
     "Applies formatting"),
    (set(), set(WRITERS), "Saves results to files"),
    ({"time", "schedule"}, set(), "Waits or runs on a schedule"),
]
OS_ACTIONS = {
    "remove": "Deletes, copies or moves files", "unlink": "Deletes, copies or moves files", "rmdir": "Deletes, copies or moves files",
    "rename": "Deletes, copies or moves files", "replace": "Deletes, copies or moves files",
    "system": "Runs external programs", "popen": "Runs external programs", "startfile": "Runs external programs",
}


def _dotted(node: ast.AST) -> str:
    """'pd.read_csv' for pd.read_csv(...); '' when the callee is not a plain dotted name."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    if isinstance(node, ast.Call):   # Path("x").glob(...) → "Path().glob"
        inner = _dotted(node.func)
        return ".".join([f"{inner}()", *reversed(parts)]) if inner else ".".join(reversed(parts))
    return ".".join(reversed(parts))


def _literal(node: ast.AST | None, consts: dict[str, str]) -> str | None:
    """A string the argument certainly evaluates to (literals, constants, joined literals)."""
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and node.id in consts:
        return consts[node.id]
    if isinstance(node, ast.Call) and _dotted(node.func).split(".")[-1] in ("Path", "PurePath", "PureWindowsPath") \
            and len(node.args) == 1:
        return _literal(node.args[0], consts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
        left, right = _literal(node.left, consts), _literal(node.right, consts)
        if left is not None and right is not None:
            return f"{left}/{right}" if isinstance(node.op, ast.Div) else left + right
    return None


def _filename(ref: str) -> str:
    return PureWindowsPath(ref).name if ("\\" in ref or re.match(r"^[A-Za-z]:", ref)) else PurePosixPath(ref).name


def _path_arg(call: ast.Call) -> ast.AST | None:
    if call.args:
        return call.args[0]
    for kw in call.keywords:
        if kw.arg in PATH_KWARGS:
            return kw.value
    return None


def _sheets(call: ast.Call, consts: dict[str, str]) -> list[str]:
    for kw in call.keywords:
        if kw.arg in ("sheet_name", "sheetname"):
            if isinstance(kw.value, (ast.List, ast.Tuple)):
                return [s for s in (_literal(e, consts) for e in kw.value.elts) if s]
            s = _literal(kw.value, consts)
            return [s] if s else []
    return []


def _mode(call: ast.Call) -> str:
    node = call.args[1] if len(call.args) > 1 else next((k.value for k in call.keywords if k.arg == "mode"), None)
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else "r"


def list_procedures(tree: ast.Module) -> list[dict]:
    procs = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            procs.append({"name": node.name, "kind": "function", "start": node.lineno, "end": node.end_lineno or node.lineno})
        elif isinstance(node, ast.ClassDef):
            procs.append({"name": node.name, "kind": "class", "start": node.lineno, "end": node.end_lineno or node.lineno})
    procs.sort(key=lambda p: p["start"])
    return procs


def _parse(code: str, name: str) -> ast.Module:
    try:
        return ast.parse(code)
    except SyntaxError as e:
        raise VBAError(f"{name} is not valid Python (line {e.lineno}: {e.msg})")


def notebook_code(raw: str) -> str:
    """Join a notebook's code cells; IPython magics and shell lines are kept as comments."""
    try:
        nb = json.loads(raw)
    except json.JSONDecodeError:
        raise VBAError("The notebook file is not valid JSON")
    cells = []
    for i, cell in enumerate(nb.get("cells") or [], start=1):
        if cell.get("cell_type") != "code":
            continue
        src = cell.get("source") or ""
        src = "".join(src) if isinstance(src, list) else str(src)
        lines = [f"# {ln}" if ln.lstrip().startswith(("%", "!")) else ln for ln in src.split("\n")]
        cells.append(f"# --- cell {i}\n" + "\n".join(lines).rstrip())
    return "\n\n".join(cells)


def modules_from_text(code: str, name: str = "Pasted code") -> list[Module]:
    code = code.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    return [Module(name=name, kind="standard", code=code, procedures=list_procedures(_parse(code, name)))]


def _is_library(name: str) -> bool:
    if name in sys.stdlib_module_names or name in KNOWN_LIBRARIES:
        return True
    try:
        return importlib.util.find_spec(name) is not None   # finds the module without importing it
    except (ImportError, ValueError):
        return False


def local_imports(modules: list[Module], script_dir: Path | None = None) -> list[dict]:
    """Code the script pulls in from other files, which Flowbook does not read: relative imports,
    imports that aren't a known library, and notebooks loaded with %run. ``certainly_local`` for
    relative imports, %run, and modules whose .py file or package sits beside the script; otherwise
    the name may also be a library Flowbook doesn't have installed."""
    found: dict[str, dict] = {}

    def add(name: str, where: str, certain: bool):
        d = found.setdefault(name, {"module": name, "lines": [], "certainly_local": False})
        d["certainly_local"] |= certain
        if where not in d["lines"] and len(d["lines"]) < 10:
            d["lines"].append(where)

    def beside(top: str) -> bool:
        return bool(script_dir) and ((script_dir / f"{top}.py").is_file() or (script_dir / top / "__init__.py").is_file())

    for mod in modules:
        for node in ast.walk(_parse(mod.code, mod.name)):
            where = f"{mod.name}:{getattr(node, 'lineno', 0)}"
            if isinstance(node, ast.ImportFrom) and node.level:
                add("." * node.level + (node.module or ""), where, True)
                continue
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else \
                [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
            for name in names:
                top = name.split(".")[0]
                if beside(top):
                    add(name, where, True)
                elif not _is_library(top):
                    add(name, where, False)
        for m in NOTEBOOK_RUN.finditer(mod.code):
            add(m.group(1), f"{mod.name}:{mod.code.count(chr(10), 0, m.start()) + 1}", True)
    return sorted(found.values(), key=lambda d: (not d["certainly_local"], d["module"].lower()))


def analyse(modules: list[Module]) -> dict:
    """Return the datasets and actions referenced by the script code."""
    deps: dict[tuple[str, str], dict] = {}
    actions: dict[str, dict] = {}
    written: set[str] = set()

    def add(kind: str, ref: str, where: str, **extra):
        key = (kind, ref.lower())
        d = deps.setdefault(key, {"kind": kind, "reference": ref, "lines": [], **extra})
        if where not in d["lines"] and len(d["lines"]) < 20:
            d["lines"].append(where)
        return d

    def act(label: str, where: str):
        a = actions.setdefault(label, {"action": label, "lines": []})
        if where not in a["lines"] and len(a["lines"]) < 10:
            a["lines"].append(where)

    for mod in modules:
        tree = _parse(mod.code, mod.name)
        imports: set[str] = set()
        consts: dict[str, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports |= {a.name.split(".")[0] for a in node.names} | {a.asname for a in node.names if a.asname}
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module.split(".")[0])
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                value = _literal(node.value, consts)
                if value is not None:
                    consts[node.targets[0].id] = value

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            where = f"{mod.name}:{node.lineno}"
            name = _dotted(node.func)
            last = name.split(".")[-1]
            root = name.split(".")[0]

            if last in READERS and not (last == "open" and _mode(node)[:1] in ("w", "a", "x")):
                arg = _path_arg(node)
                ref = _literal(arg, consts)
                if ref is not None and (DATA_FILE.search(ref) or last != "open"):
                    if URL.match(ref):
                        add("web", ref, where)
                        continue
                    d = add("external_file", ref, where, filename=_filename(ref))
                    for s in _sheets(node, consts):
                        if s not in d.setdefault("sheets", []):
                            d["sheets"].append(s)
                elif arg is not None and ref is None and last != "open" and not isinstance(arg, ast.Constant):
                    add("dynamic_file", ast.unparse(arg)[:120], where)
            elif last in WRITERS:
                ref = _literal(_path_arg(node), consts)
                if ref:
                    written.add(ref.lower())
            elif last == "open" and _mode(node)[:1] in ("w", "a", "x"):
                ref = _literal(_path_arg(node), consts)
                if ref:
                    written.add(ref.lower())

            if last in FOLDER_CALLS and (root in ("glob", "os", "pathlib") or "Path" in name or last in ("rglob", "iterdir")):
                pattern = _literal(node.args[0] if node.args else None, consts)
                owner = node.func.value if isinstance(node.func, ast.Attribute) else None
                base = _literal(owner.args[0] if isinstance(owner, ast.Call) and owner.args else None, consts)
                ref = "/".join(p for p in (base, pattern) if p) or ast.unparse(node)[:120]
                add("folder", ref, where)
            if last in DB_CALLS and (root in DB_MODULES or last.startswith("read_sql") or root in imports & DB_MODULES):
                target = _literal(node.args[0] if node.args else None, consts)
                add("database", (target or name)[:120], where)
            if last in WEB_CALLS and root in WEB_MODULES:
                url = _literal(node.args[0] if node.args else None, consts)
                add("web", url or name, where)
            if last in USER_PICK_CALLS and (last != "input" or name == "input"):
                add("user_picks_file", "File or value chosen by the user when the script runs", where)

            for modules_, names, label in ACTIONS:
                if root in modules_ or (not modules_ and last in names):
                    act(label, where)
            if (root == "os" or (last == "unlink" and "Path" in name)) and last in OS_ACTIONS:
                act(OS_ACTIONS[last], where)

        # sys.argv means values come from the command line.
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and _dotted(node) == "sys.argv":
                add("user_picks_file", "File or value chosen by the user when the script runs", f"{mod.name}:{node.lineno}")

    out = []
    for d in deps.values():
        if d["kind"] == "external_file" and d["reference"].lower() in written:
            d["written_by_macro"] = True   # read back after writing: the script's own output
        out.append(d)
    order = {"external_file": 1, "dynamic_file": 2, "user_picks_file": 3, "folder": 4, "database": 5, "web": 6}
    out.sort(key=lambda d: (order.get(d["kind"], 9), d["reference"].lower()))
    return {"dependencies": out, "actions": list(actions.values())}


def load(path: Path | None = None, code: str | None = None, name: str | None = None) -> dict:
    """Read (or accept pasted) Python code and analyse it."""
    if path is not None:
        ext = path.suffix.lower()
        raw = path.read_text(encoding="utf-8", errors="replace")
        if ext == ".ipynb":
            raw = notebook_code(raw)
        elif ext != ".py":
            raise VBAError(f"Unsupported file type '{ext}'. Use a .py script or a .ipynb notebook.")
        modules = modules_from_text(raw, path.name)
    elif code:
        modules = modules_from_text(code, name or "Pasted code")
    else:
        raise VBAError("Provide a Python script or paste the code")
    modules = [m for m in modules if m.code.strip()]
    if not modules:
        raise VBAError("No Python code was found")
    return {
        "workbook": {"path": str(path) if path else None, "name": path.name if path else None, "sheets": [],
                     "readable_sheets": False},
        "modules": [m.__dict__ for m in modules],
        **analyse(modules),
        "local_imports": local_imports(modules, path.parent if path else None),
    }
