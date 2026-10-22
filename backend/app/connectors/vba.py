"""Excel macro (VBA) extraction and static analysis.

Extraction follows [MS-OVBA]: the VBA project lives in an OLE compound file
(``xl/vbaProject.bin`` inside .xlsm/.xlsb/.xltm/.xlam, or the ``_VBA_PROJECT_CUR``
storage of a legacy .xls). The ``dir`` stream lists modules; each module stream
holds compressed source text starting at ``MODULEOFFSET``.

Analysis is a conservative, regex-based scan that flags what a macro touches
(other workbooks, sheets, databases, files picked at run time) and actions a
data workflow cannot reproduce (emails, deleting files, shell commands). It never
executes anything.
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

MACRO_EXTS = {".xlsm", ".xlsb", ".xltm", ".xlam", ".xls"}
TEXT_EXTS = {".bas", ".cls", ".txt", ".vba", ".vb"}


class VBAError(Exception):
    pass


# ---------------------------------------------------------------- decompression

def decompress(data: bytes) -> bytes:
    """MS-OVBA 2.4.1 decompression of a CompressedContainer."""
    if not data or data[0] != 0x01:
        raise VBAError("Not a VBA compressed container")
    out = bytearray()
    pos = 1
    while pos < len(data):
        if pos + 2 > len(data):
            break
        header = struct.unpack_from("<H", data, pos)[0]
        size = (header & 0x0FFF) + 3
        compressed = header & 0x8000
        chunk_end = min(pos + size, len(data))
        pos += 2
        chunk_start = len(out)
        if not compressed:
            out += data[pos : pos + 4096]
            pos += 4096
            continue
        while pos < chunk_end:
            flags = data[pos]
            pos += 1
            for bit in range(8):
                if pos >= chunk_end:
                    break
                if not (flags >> bit) & 1:
                    out.append(data[pos])
                    pos += 1
                    continue
                token = struct.unpack_from("<H", data, pos)[0]
                pos += 2
                difference = len(out) - chunk_start
                bit_count = max((difference - 1).bit_length(), 4)
                length_mask = 0xFFFF >> bit_count
                length = (token & length_mask) + 3
                offset = (token >> (16 - bit_count)) + 1
                if offset > len(out) - chunk_start:
                    raise VBAError("Corrupt VBA compressed data")
                src = len(out) - offset
                for k in range(length):
                    out.append(out[src + k])
    return bytes(out)


# ---------------------------------------------------------------- dir stream

@dataclass
class ModuleInfo:
    name: str
    stream: str
    offset: int = 0
    kind: str = "standard"   # standard | document (sheet/workbook/class modules)


def parse_dir(dir_stream: bytes) -> tuple[list[ModuleInfo], str]:
    data = decompress(dir_stream)
    pos = 0
    codepage = "cp1252"
    modules: list[ModuleInfo] = []
    cur: ModuleInfo | None = None
    while pos + 6 <= len(data):
        rid, size = struct.unpack_from("<HI", data, pos)
        pos += 6
        if rid == 0x0009:          # PROJECTVERSION: size field is reserved; 6 bytes follow
            pos += 6
            continue
        body = data[pos : pos + size]
        pos += size
        if rid == 0x0003 and len(body) >= 2:
            cp = struct.unpack_from("<H", body)[0]
            codepage = f"cp{cp}" if cp not in (65001,) else "utf-8"
        elif rid == 0x0019:
            cur = ModuleInfo(name=_dec(body, codepage), stream="")
        elif rid == 0x0047 and cur is not None:
            cur.name = body.decode("utf-16-le", "replace") or cur.name
        elif rid == 0x001A and cur is not None:
            cur.stream = _dec(body, codepage)
        elif rid == 0x0032 and cur is not None:
            cur.stream = body.decode("utf-16-le", "replace") or cur.stream
        elif rid == 0x0031 and cur is not None and len(body) >= 4:
            cur.offset = struct.unpack_from("<I", body)[0]
        elif rid == 0x0022 and cur is not None:
            cur.kind = "document"
        elif rid == 0x002B and cur is not None:
            modules.append(cur)
            cur = None
        elif rid == 0x0010:
            break
    return modules, codepage


def _dec(b: bytes, codepage: str) -> str:
    try:
        return b.decode(codepage)
    except (LookupError, UnicodeDecodeError):
        return b.decode("latin-1")


# ---------------------------------------------------------------- extraction

@dataclass
class Module:
    name: str
    kind: str
    code: str
    procedures: list[dict] = field(default_factory=list)


def _vba_bin(path: Path) -> bytes:
    ext = path.suffix.lower()
    if ext == ".xls":
        return path.read_bytes()
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith("vbaproject.bin")]
            if not names:
                raise VBAError("This workbook contains no macros (no VBA project found)")
            return z.read(names[0])
    except zipfile.BadZipFile:
        raise VBAError("The file is not a valid Excel workbook (it may be password-protected)")


def extract_modules(path: Path) -> list[Module]:
    import olefile

    raw = _vba_bin(path)
    try:
        ole = olefile.OleFileIO(io.BytesIO(raw))
    except OSError as e:
        raise VBAError(f"Could not read the VBA project: {e}")
    try:
        dirs = [p for p in ole.listdir() if p[-1].lower() == "dir" and len(p) >= 2 and p[-2].upper() == "VBA"]
        if not dirs:
            raise VBAError("This workbook contains no macros (no VBA project found)")
        vba_root = dirs[0][:-1]
        infos, codepage = parse_dir(ole.openstream(dirs[0]).read())
        modules = []
        for info in infos:
            stream_path = vba_root + [info.stream or info.name]
            if not ole.exists("/".join(stream_path)):
                continue
            blob = ole.openstream(stream_path).read()
            try:
                text = _dec(decompress(blob[info.offset:]), codepage)
            except VBAError:
                continue
            code = _strip_attributes(text)
            kind = info.kind
            modules.append(Module(name=info.name, kind=kind, code=code, procedures=list_procedures(code)))
        return modules
    finally:
        ole.close()


def modules_from_text(code: str, name: str = "Pasted code") -> list[Module]:
    code = _strip_attributes(code.replace("\r\n", "\n"))
    return [Module(name=name, kind="standard", code=code, procedures=list_procedures(code))]


def _strip_attributes(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln for ln in text.split("\n") if not ln.startswith("Attribute VB_")]
    return "\n".join(lines).strip("\n")


PROC_RE = re.compile(r"^\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(Sub|Function|Property\s+(?:Get|Let|Set))\s+(\w+)",
                     re.IGNORECASE)
END_RE = re.compile(r"^\s*End\s+(Sub|Function|Property)\b", re.IGNORECASE)


def list_procedures(code: str) -> list[dict]:
    procs: list[dict] = []
    open_proc: dict | None = None
    for n, line in enumerate(code.split("\n"), start=1):
        m = PROC_RE.match(line)
        if m and open_proc is None:
            open_proc = {"name": m.group(2), "kind": m.group(1).split()[0].lower(), "start": n, "end": n}
        elif open_proc is not None and END_RE.match(line):
            open_proc["end"] = n
            procs.append(open_proc)
            open_proc = None
    return procs


# ---------------------------------------------------------------- analysis

DATA_EXT = r"xlsx|xlsm|xlsb|xls|csv|tsv|txt|mdb|accdb|xml|json"
FILE_LITERAL = re.compile(r'"([^"\n]*\.(?:' + DATA_EXT + r'))"', re.IGNORECASE)
SHEET_REF = re.compile(r'(?:\b(\w+)\s*\.\s*)?\b(?:Sheets|Worksheets)\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)
SHEET_VAR = re.compile(r'\bSet\s+(\w+)\s*=\s*(?:\w+\s*\.\s*)?(?:Sheets|Worksheets)\s*\(\s*"([^"]+)"', re.IGNORECASE)
WB_VAR = re.compile(r'\bSet\s+(\w+)\s*=\s*Workbooks(?:\.Open\s*\(?\s*(?:Filename\s*:=\s*)?|\s*\(\s*)"([^"]+)"', re.IGNORECASE)
WORKBOOK_REF = re.compile(r'\bWorkbooks\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)
OPEN_VAR = re.compile(r'\bWorkbooks\.Open\s*\(?\s*(?:Filename\s*:=\s*)?([A-Za-z_][\w.]*)\s*[,)\n]?', re.IGNORECASE)
USER_PICK = re.compile(r'\b(GetOpenFilename|FileDialog|msoFileDialog\w*)\b', re.IGNORECASE)
DB = re.compile(r'(ADODB\.\w+|Provider\s*=[^";]+|DSN\s*=[^";]+|ODBC;[^"]*|QueryTables\.Add|OLEDB;[^"]*)', re.IGNORECASE)
WEB = re.compile(r'"(https?://[^"\s]+)"', re.IGNORECASE)
FOLDER_LOOP = re.compile(r'\bDir\s*\(\s*"([^"]+)"', re.IGNORECASE)
SHEET_CREATED = re.compile(r'\.Name\s*=\s*"([^"]+)"', re.IGNORECASE)

ACTIONS = [
    (re.compile(r'Outlook\.Application|\.Send\b|SendMail', re.I), "Sends email"),
    (re.compile(r'\bKill\s|DeleteFile|\.Delete\b', re.I), "Deletes files, sheets or ranges"),
    (re.compile(r'\bShell\s*\(|WScript\.Shell|CreateObject\s*\(\s*"WScript', re.I), "Runs external programs"),
    (re.compile(r'\.PrintOut\b', re.I), "Prints"),
    (re.compile(r'\bMsgBox\b|\bInputBox\b', re.I), "Shows pop-up messages or asks the user for input"),
    (re.compile(r'\.SaveAs\b|\.SaveCopyAs\b', re.I), "Saves workbooks to specific locations"),
    (re.compile(r'\.Interior\.|\.Font\.|\.NumberFormat|\.ColumnWidth|\.AutoFit|Conditional', re.I), "Applies formatting"),
    (re.compile(r'PivotCaches|PivotTables|\.Chart|ChartObjects', re.I), "Builds Excel pivot tables or charts"),
    (re.compile(r'SendKeys|Application\.Run\b|\.OnTime\b', re.I), "Automates the Excel interface"),
]


def _strip_comments(line: str) -> str:
    out, in_str = [], False
    for ch in line:
        if ch == '"':
            in_str = not in_str
        if ch == "'" and not in_str:
            break
        out.append(ch)
    return "".join(out)


def analyse(modules: list[Module], workbook_sheets: list[str] | None = None, workbook_name: str | None = None) -> dict:
    """Return the datasets and actions referenced by the macro code."""
    deps: dict[tuple[str, str], dict] = {}
    actions: dict[str, dict] = {}
    created_sheets: set[str] = set()
    sheets_lower = {s.lower(): s for s in (workbook_sheets or [])}

    def add(kind: str, ref: str, where: str, **extra):
        key = (kind, ref.lower())
        d = deps.setdefault(key, {"kind": kind, "reference": ref, "lines": [], **extra})
        if where not in d["lines"] and len(d["lines"]) < 20:
            d["lines"].append(where)

    # Workbook variables (Set wb = Workbooks.Open("x.xlsx")) so wb.Sheets("S") is attributed to x.xlsx.
    wb_vars: dict[str, str] = {}
    sheet_vars: dict[str, str] = {}
    all_code = "\n".join(_strip_comments(raw) for mod in modules for raw in mod.code.split("\n"))
    for m in WB_VAR.finditer(all_code):
        wb_vars[m.group(1).lower()] = m.group(2)
    for m in SHEET_VAR.finditer(all_code):
        sheet_vars[m.group(1).lower()] = m.group(2)
    # A sheet the macro clears is where it writes results, not an input.
    cleared = {name.lower() for var, name in sheet_vars.items()
               if re.search(rf"\b{re.escape(var)}\s*\.\s*(?:Cells\s*\.\s*)?(?:Clear|ClearContents)\b", all_code, re.I)}
    cleared |= {m.group(1).lower() for m in re.finditer(
        r'(?:Sheets|Worksheets)\s*\(\s*"([^"]+)"\s*\)\s*\.\s*(?:Cells\s*\.\s*)?(?:Clear|ClearContents)\b', all_code, re.I)}

    for mod in modules:
        for n, raw in enumerate(mod.code.split("\n"), start=1):
            line = _strip_comments(raw)
            if not line.strip():
                continue
            where = f"{mod.name}:{n}"
            for m in SHEET_CREATED.finditer(line):
                created_sheets.add(m.group(1).lower())
            for m in FILE_LITERAL.finditer(line):
                ref = m.group(1)
                fname = PureWindowsPath(ref).name if ("\\" in ref or ":" in ref) else Path(ref).name
                if workbook_name and fname.lower() == workbook_name.lower():
                    continue
                add("external_file", ref, where, filename=fname)
            for m in WORKBOOK_REF.finditer(line):
                name = m.group(1)
                if workbook_name and name.lower() == workbook_name.lower():
                    continue
                if re.search(r"\.(" + DATA_EXT + r")$", name, re.I):
                    add("external_file", name, where, filename=name)
            for m in SHEET_REF.finditer(line):
                owner = (m.group(1) or "").lower()
                if owner in wb_vars:
                    ref = wb_vars[owner]
                    fname = PureWindowsPath(ref).name
                    if not (workbook_name and fname.lower() == workbook_name.lower()):
                        add("external_file", ref, where, filename=fname)
                        sheets = deps[("external_file", ref.lower())].setdefault("sheets", [])
                        if m.group(2) not in sheets:
                            sheets.append(m.group(2))
                        continue
                add("sheet", m.group(2), where)
            om = OPEN_VAR.search(line)
            if om and not FILE_LITERAL.search(line):
                add("dynamic_file", om.group(1), where)
            for m in USER_PICK.finditer(line):
                add("user_picks_file", "File chosen by the user when the macro runs", where)
            for m in DB.finditer(line):
                add("database", m.group(1).strip()[:120], where)
            for m in WEB.finditer(line):
                add("web", m.group(1), where)
            for m in FOLDER_LOOP.finditer(line):
                if not FILE_LITERAL.search(f'"{m.group(1)}"'):
                    add("folder", m.group(1), where)
            for rx, label in ACTIONS:
                if rx.search(line):
                    a = actions.setdefault(label, {"action": label, "lines": []})
                    if len(a["lines"]) < 10:
                        a["lines"].append(where)

    out = []
    for d in deps.values():
        if d["kind"] == "sheet":
            name = d["reference"]
            if name.lower() in sheets_lower:
                d["reference"] = sheets_lower[name.lower()]
                d["in_workbook"] = True
                d["written_by_macro"] = name.lower() in cleared
            else:
                d["in_workbook"] = False
                d["created_by_macro"] = name.lower() in created_sheets
        out.append(d)
    order = {"sheet": 0, "external_file": 1, "dynamic_file": 2, "user_picks_file": 3, "folder": 4, "database": 5, "web": 6}
    out.sort(key=lambda d: (order.get(d["kind"], 9), d["reference"].lower()))
    return {"dependencies": out, "actions": list(actions.values())}


def load(path: Path | None = None, code: str | None = None, name: str | None = None) -> dict:
    """Extract (or accept pasted) macro code and analyse it."""
    sheets: list[str] = []
    wb_name = None
    if path is not None:
        ext = path.suffix.lower()
        if ext in TEXT_EXTS:
            modules = modules_from_text(path.read_text(encoding="utf-8", errors="replace"), path.stem)
        elif ext in MACRO_EXTS:
            modules = extract_modules(path)
            wb_name = path.name
            if ext in (".xlsm", ".xltm"):
                from . import tabular
                try:
                    sheets = tabular.list_sheets(path)
                except tabular.TabularError:
                    sheets = []
        else:
            raise VBAError(f"Unsupported file type '{ext}'. Use .xlsm, .xlsb, .xls, or an exported .bas file.")
    elif code:
        modules = modules_from_text(code, name or "Pasted code")
    else:
        raise VBAError("Provide a macro workbook or paste the macro code")
    modules = [m for m in modules if m.procedures]
    if not modules:
        raise VBAError("No macro code was found")
    analysis = analyse(modules, sheets, wb_name)
    return {
        "workbook": {"path": str(path) if path else None, "name": wb_name, "sheets": sheets,
                     "readable_sheets": bool(sheets)},
        "modules": [m.__dict__ for m in modules],
        **analysis,
    }
