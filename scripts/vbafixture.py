"""Build real macro-enabled workbooks (.xlsm) with embedded VBA, for tests and demos.

Implements just enough of [MS-CFB] (compound file writer) and [MS-OVBA] (dir stream +
literal-only compression) to produce a vbaProject.bin that Excel-format readers parse.
"""

from __future__ import annotations

import io
import math
import struct
import zipfile
from pathlib import Path

SECTOR = 512
FREESECT, ENDOFCHAIN, FATSECT, NOSTREAM = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF


def compress(data: bytes) -> bytes:
    """Valid MS-OVBA CompressedContainer: literal tokens, or raw chunks where literals would overflow."""
    out = bytearray(b"\x01")
    for start in range(0, max(len(data), 1), 4096):
        chunk = data[start : start + 4096]
        body = bytearray()
        for i in range(0, len(chunk), 8):
            body.append(0x00)
            body += chunk[i : i + 8]
        if len(body) + 2 <= 4098:
            out += struct.pack("<H", (len(body) + 2 - 3) | 0xB000) + body
        else:  # uncompressed chunk (flag bit clear)
            out += struct.pack("<H", 0x3FFF) + chunk
    return bytes(out)


def _rec(rid: int, body: bytes) -> bytes:
    return struct.pack("<HI", rid, len(body)) + body


def dir_stream(module_names: list[str]) -> bytes:
    d = bytearray()
    d += _rec(0x0001, struct.pack("<I", 1))               # PROJECTSYSKIND (win32)
    d += _rec(0x0003, struct.pack("<H", 1252))            # PROJECTCODEPAGE
    d += _rec(0x0004, b"VBAProject")                       # PROJECTNAME
    d += struct.pack("<HI", 0x0009, 4) + struct.pack("<IH", 1, 0)  # PROJECTVERSION quirk
    d += _rec(0x000F, struct.pack("<H", len(module_names)))
    d += _rec(0x0013, struct.pack("<H", 0xFFFF))
    for name in module_names:
        b = name.encode("cp1252")
        d += _rec(0x0019, b) + _rec(0x0047, name.encode("utf-16-le"))
        d += _rec(0x001A, b) + _rec(0x0032, name.encode("utf-16-le"))
        d += _rec(0x0031, struct.pack("<I", 0))
        d += _rec(0x0021, b"")
        d += _rec(0x002B, b"")
    d += _rec(0x0010, b"")
    return compress(bytes(d))


def write_cfb(streams: dict[str, bytes]) -> bytes:
    """Minimal version-3 compound file. Streams under 4096 bytes go in the mini stream."""
    MINI, CUTOFF = 64, 4096
    entries = [{"name": "Root Entry", "type": 5, "children": [], "data": b""}]
    index = {(): 0}
    for path in sorted(streams):
        parts = tuple(path.split("/"))
        for depth in range(1, len(parts) + 1):
            key = parts[:depth]
            if key in index:
                continue
            is_stream = depth == len(parts)
            entries.append({"name": parts[depth - 1], "type": 2 if is_stream else 1, "children": [],
                            "data": streams[path] if is_stream else b""})
            index[key] = len(entries) - 1
            entries[index[parts[: depth - 1]]]["children"].append(index[key])

    # Mini stream allocation
    ministream = bytearray()
    minifat: list[int] = []
    starts: dict[int, int] = {}
    for i, e in enumerate(entries):
        if e["type"] == 2 and 0 < len(e["data"]) < CUTOFF:
            n = math.ceil(len(e["data"]) / MINI)
            s0 = len(minifat)
            starts[i] = s0
            minifat += [k + 1 for k in range(s0, s0 + n - 1)] + [ENDOFCHAIN]
            ministream += e["data"] + b"\x00" * (n * MINI - len(e["data"]))
    entries[0]["data"] = bytes(ministream)
    minifat_bytes = struct.pack(f"<{len(minifat)}I", *minifat) if minifat else b""
    minifat_secs = math.ceil(len(minifat_bytes) / SECTOR)

    # Regular sector allocation: [FAT][dir][minifat][root ministream][large streams]
    dir_secs = math.ceil(len(entries) * 128 / SECTOR)
    big = [i for i, e in enumerate(entries) if (i == 0 and e["data"]) or (e["type"] == 2 and len(e["data"]) >= CUTOFF)]
    data_secs = {i: math.ceil(len(entries[i]["data"]) / SECTOR) for i in big}
    total = dir_secs + minifat_secs + sum(data_secs.values())
    fat_secs = 1
    while fat_secs * (SECTOR // 4) < total + fat_secs:
        fat_secs += 1
    fat = [FATSECT] * fat_secs

    def chain(n: int) -> int:
        s0 = len(fat)
        fat.extend([k + 1 for k in range(s0, s0 + n - 1)] + [ENDOFCHAIN])
        return s0

    dir_start = chain(dir_secs)
    minifat_start = chain(minifat_secs) if minifat_secs else ENDOFCHAIN
    for i in big:
        starts[i] = chain(data_secs[i])
    fat += [FREESECT] * (fat_secs * (SECTOR // 4) - len(fat))

    def sort_key(i):
        n = entries[i]["name"]
        return (len(n), n.upper())

    right, child = {}, {}
    for i, e in enumerate(entries):
        kids = sorted(e["children"], key=sort_key)
        child[i] = kids[0] if kids else NOSTREAM
        for a, b in zip(kids, kids[1:]):
            right[a] = b

    dir_bytes = bytearray()
    for i, e in enumerate(entries):
        name = e["name"].encode("utf-16-le") + b"\x00\x00"
        dir_bytes += name.ljust(64, b"\x00")
        dir_bytes += struct.pack("<HBB", len(name), e["type"], 1)
        dir_bytes += struct.pack("<III", NOSTREAM, right.get(i, NOSTREAM), child[i] if e["type"] != 2 else NOSTREAM)
        dir_bytes += b"\x00" * 36
        dir_bytes += struct.pack("<IQ", starts.get(i, ENDOFCHAIN), len(e["data"]))
    dir_bytes += b"\x00" * (dir_secs * SECTOR - len(dir_bytes))

    header = bytearray(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 16)
    header += struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\x00" * 6
    header += struct.pack("<IIIIIIIII", 0, fat_secs, dir_start, 0, CUTOFF, minifat_start, minifat_secs, ENDOFCHAIN, 0)
    header += struct.pack("<109I", *(list(range(fat_secs)) + [FREESECT] * (109 - fat_secs)))

    pad = lambda b, n: b + b"\x00" * (n * SECTOR - len(b))  # noqa: E731
    body = bytearray(struct.pack(f"<{len(fat)}I", *fat)) + dir_bytes
    if minifat_secs:
        body += pad(minifat_bytes, minifat_secs)
    for i in big:
        body += pad(entries[i]["data"], data_secs[i])
    return bytes(header) + bytes(body)


def vba_project(modules: dict[str, str]) -> bytes:
    streams = {"VBA/dir": dir_stream(list(modules)), "PROJECT": b'ID="{00000000-0000-0000-0000-000000000000}"\r\n'}
    for name, code in modules.items():
        text = f'Attribute VB_Name = "{name}"\r\n' + code.replace("\n", "\r\n")
        streams[f"VBA/{name}"] = compress(text.encode("cp1252"))
    return write_cfb(streams)


def make_xlsm(path: Path, sheets: dict[str, list[list]], modules: dict[str, str]) -> Path:
    """Create an .xlsm with the given sheet data and VBA modules."""
    from openpyxl import Workbook

    wb = Workbook()
    first = True
    for name, rows in sheets.items():
        ws = wb.active if first else wb.create_sheet()
        ws.title = name
        first = False
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(
                    b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                    b"application/vnd.ms-excel.sheet.macroEnabled.main+xml",
                ).replace(b"</Types>", b'<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')
            if item.filename == "xl/_rels/workbook.xml.rels":
                data = data.replace(b"</Relationships>", b'<Relationship Id="rIdVBA" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>')
            z.writestr(item, data)
        z.writestr("xl/vbaProject.bin", vba_project(modules))
    return path
