"""Process document (Word / PDF) extraction for document → workflow.

The counterpart of ``vba`` and ``pycode`` for written procedures. The document becomes
numbered text lines in reading order, so step notes can cite lines exactly as they do for
code. Every picture becomes a figure: a ``[Figure n …]`` marker at its place in the text
and, when it can be shown, an image file saved under the data folder that the user
attaches to the chatbot message next to the prompt. Nothing is OCR'd or interpreted here;
the chatbot reads the pictures.

- Word: images (inline, floating, old VML), with their alt text; drawings made of Word
  shapes and SmartArt have no picture, so the text inside them is kept instead.
- PDF: flowcharts are often vector drawings rather than embedded images, so a page with
  a sizeable picture, a drawing, or hardly any text (a scan) is rendered whole to a PNG.

The result has the same shape as ``vba.load`` so the macro import flow can reuse it.
"""

from __future__ import annotations

import hashlib
import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

from ..config import get_paths
from .vba import DATA_EXT, Module, VBAError

DOC_EXTS = {".docx", ".pdf", ".txt", ".md"}
VIEWABLE = {"png", "jpeg", "gif"}          # formats a browser shows and chatbots accept
MIN_SIDE = 48                              # smaller pictures are bullets and icons
MAX_RENDER_SIDE = 2000                     # PDF pages are rendered at most this many pixels on the long side
PDF_PATHS_FOR_DRAWING = 20                 # vector path objects that make a page count as a drawing
PDF_MIN_IMAGE_AREA = 0.03                  # share of the page an embedded image must cover
PDF_SCAN_TEXT = 80                         # a page with less text than this and a picture is a scan
# A file the procedure names: quoted (may contain spaces) or a single word like S:\Finance\sales.xlsx.
FILE_REF = re.compile(r"[\"“'‘]([^\"”'’\n]{1,160}\.(?:" + DATA_EXT + r"))[\"”'’]|([\w\\/:.\-]+\.(?:" + DATA_EXT + r"))\b", re.I)
FIGURE_KEY = re.compile(r"^[0-9a-f]{16}$")
FIGURE_FILE = re.compile(r"^fig-\d{2,3}\.(?:png|jpg|gif)$")

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "v": "urn:schemas-microsoft-com:vml",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
}
W = "{%s}" % NS["w"]
R_EMBED = "{%s}embed" % NS["r"]
R_ID = "{%s}id" % NS["r"]
R_DM = "{%s}dm" % NS["r"]

# Wording in a procedure that a data workflow cannot do: (label, pattern).
ACTIONS = [
    ("Sends email", re.compile(r"\b(e-?mail|outlook|send (it|this|the \w+) to)\b", re.I)),
    ("Needs approval or sign-off", re.compile(r"\b(approv\w*|sign[- ]?off|authori[sz]\w*|review(ed)? by)\b", re.I)),
    ("Prints or saves as PDF", re.compile(r"\b(print\w*|save as pdf|export to pdf)\b", re.I)),
    ("Uploads or posts to a system", re.compile(r"\b(upload\w*|post (it|the \w+) (to|in)|journal entry|submit\w* (to|in))\b", re.I)),
    ("Applies formatting", re.compile(r"\b(highlight\w*|bold|colou?r (the|it)|conditional formatting|format (the|it))\b", re.I)),
]


@dataclass
class Figure:
    id: str
    kind: str                    # image | page | drawing | chart
    line: int = 0                # line of its marker in the document text
    locator: str = ""            # section heading or page
    alt: str = ""
    text: str = ""               # text found inside a drawing or SmartArt
    format: str = ""
    width: int = 0
    height: int = 0
    data: bytes = b""
    sha: str = ""
    reason: str = ""             # why it is skipped or cannot be attached
    file: str = ""
    mode: str = "attach"         # attach | describe | skip (the default the user starts from)
    lines: list[str] = field(default_factory=list)


class _Doc:
    """Numbered lines plus the figures placed between them."""

    def __init__(self, name: str):
        self.name = name
        self.lines: list[str] = []
        self.headings: list[dict] = []
        self.figures: list[Figure] = []
        self._by_sha: dict[str, Figure] = {}
        self.section = ""

    def add(self, text: str):
        for ln in text.replace("\r", "").split("\n"):
            self.lines.append(ln.rstrip())

    def heading(self, text: str):
        if self.lines and self.lines[-1]:
            self.lines.append("")
        self.lines.append(f"## {text}")
        self.section = text
        self.headings.append({"name": text[:120], "kind": "heading", "start": len(self.lines), "end": len(self.lines)})

    def figure(self, fig: Figure):
        if fig.data:
            fig.sha = hashlib.sha256(fig.data).hexdigest()
            seen = self._by_sha.get(fig.sha)
            if seen is not None:     # the same picture again (a repeated logo or diagram)
                self.lines.append(f"[{seen.id} again]")
                seen.lines.append(self._where())
                return
            self._by_sha[fig.sha] = fig
        fig.id = f"Figure {len(self.figures) + 1}"
        fig.locator = fig.locator or (f"§ {self.section}" if self.section else "")
        self.figures.append(fig)
        fig.line = len(self.lines) + 1
        fig.lines.append(self._where())
        self.lines.append(_marker(fig))

    def _where(self) -> str:
        return f"{self.name}:{len(self.lines) + 1}"

    def finish(self) -> str:
        for i, h in enumerate(self.headings):
            h["end"] = (self.headings[i + 1]["start"] - 1) if i + 1 < len(self.headings) else len(self.lines)
        while self.lines and not self.lines[-1]:
            self.lines.pop()
        return "\n".join(self.lines)


def _marker(fig: Figure) -> str:
    kind = {"image": "picture", "page": "page as a picture", "drawing": "drawing made of shapes", "chart": "chart"}[fig.kind]
    parts = [f"{fig.id}: {kind}"]
    if fig.alt:
        parts.append(f'alt text "{fig.alt}"')
    if fig.text:
        parts.append(f"text inside: {fig.text}")
    return "[" + " · ".join(parts) + "]"


# ---------- image helpers

def image_info(data: bytes) -> tuple[str, int, int]:
    """(format, width, height) from the file header; ('', 0, 0) when unknown."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return "png", w, h
    if data[:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", data[6:10])
        return "gif", w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            size = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return "jpeg", w, h
            i += 2 + size
        return "jpeg", 0, 0
    if data[:2] == b"BM":
        return "bmp", 0, 0
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff", 0, 0
    if data[:4] == b"\x01\x00\x00\x00" and data[40:44] == b" EMF":
        return "emf", 0, 0
    if data[:4] == b"\xd7\xcd\xc6\x9a" or data[:3] == b"\x01\x00\x09":
        return "wmf", 0, 0
    if data.lstrip()[:5] in (b"<?xml", b"<svg "):
        return "svg", 0, 0
    return "", 0, 0


def _png(width: int, height: int, rgb: bytes, stride: int) -> bytes:
    """Encode 8-bit RGB rows as a PNG (no Pillow needed)."""
    raw = b"".join(b"\x00" + rgb[y * stride:y * stride + width * 3] for y in range(height))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _image_figure(data: bytes, alt: str) -> Figure:
    fmt, w, h = image_info(data)
    fig = Figure(id="", kind="image", alt=alt, format=fmt, width=w, height=h, data=data)
    if fmt not in VIEWABLE:
        fig.mode = "describe"
        fig.reason = (f"This picture is stored as {fmt.upper() or 'an unknown format'}, which can’t be shown here or "
                      "attached. Describe it, or copy it out of the document and paste it into the chatbot yourself.")
    elif w and h and min(w, h) < MIN_SIDE:
        fig.mode = "skip"
        fig.reason = "Small icon or bullet"
    return fig


# ---------- Word

def _text_of(el: ET.Element) -> str:
    out = []
    for node in el.iter():
        if node.tag == W + "t" and node.text:
            out.append(node.text)
        elif node.tag == W + "tab":
            out.append("\t")
        elif node.tag in (W + "br", W + "cr"):
            out.append("\n")
    return "".join(out)


def _paragraph_text(p: ET.Element) -> str:
    """Text of a paragraph, leaving out drawings: text boxes belong to the figure they sit in."""
    out = []

    def walk(node: ET.Element):
        for child in node:
            if child.tag in (W + "drawing", W + "pict", "{%s}AlternateContent" % NS["mc"]):
                continue
            if child.tag == W + "t" and child.text:
                out.append(child.text)
            elif child.tag == W + "tab":
                out.append("\t")
            elif child.tag in (W + "br", W + "cr"):
                out.append("\n")
            else:
                walk(child)
    walk(p)
    return "".join(out).strip()


def _drawings(el: ET.Element) -> list[ET.Element]:
    """w:drawing and w:pict elements in reading order, skipping the copies inside mc:Fallback."""
    found = []
    fallback = "{%s}Fallback" % NS["mc"]

    def walk(node: ET.Element):
        for child in node:
            if child.tag == fallback:
                continue
            if child.tag in (W + "drawing", W + "pict"):
                found.append(child)
                continue
            walk(child)
    walk(el)
    return found


def _drawing_figures(drawing: ET.Element, part) -> list[Figure]:
    doc_pr = drawing.find(".//wp:docPr", NS)
    alt = ""
    if doc_pr is not None:
        alt = (doc_pr.get("descr") or doc_pr.get("title") or "").strip()
        if re.fullmatch(r"(Picture|Image|Grafik|Imagen|Graphic|Chart|Diagram) ?\d*", alt, re.I):
            alt = ""
    figs: list[Figure] = []
    rids = [b.get(R_EMBED) for b in drawing.iterfind(".//a:blip", NS)]
    rids += [i.get(R_ID) for i in drawing.iterfind(".//v:imagedata", NS)]
    for rid in rids:
        target = part.related_parts.get(rid) if rid else None
        if target is not None:
            figs.append(_image_figure(target.blob, alt))
    if figs:
        return figs

    shape_text = [t for t in (" ".join(_text_of(p).split()) for p in drawing.iterfind(".//w:txbxContent//w:p", NS)) if t]
    for rel in drawing.iterfind(".//dgm:relIds", NS):    # SmartArt: its text lives in the diagram data part
        target = part.related_parts.get(rel.get(R_DM))
        if target is not None:
            tree = ET.fromstring(target.blob)
            shape_text += [t.text.strip() for t in tree.iter("{%s}t" % NS["a"]) if t.text and t.text.strip()]
    if drawing.find(".//c:chart", NS) is not None:
        return [Figure(id="", kind="chart", alt=alt, mode="describe",
                       reason="Word charts can’t be extracted as a picture. Describe it if it matters.")]
    if shape_text or alt:
        return [Figure(id="", kind="drawing", alt=alt, text=" / ".join(shape_text)[:1500], mode="describe",
                       reason="Drawn with Word shapes, so there is no picture to attach. The text inside the shapes "
                              "is sent; describe how they connect (the arrows) if that matters.")]
    return []


def _roman(n: int) -> str:
    out = ""
    for value, letters in ((1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"),
                           (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):
        while n >= value:
            out, n = out + letters, n - value
    return out


def _letters(n: int) -> str:
    return chr(ord("a") + (n - 1) % 26) * ((n - 1) // 26 + 1)


NUMBER_FORMATS = {
    "decimal": str, "decimalZero": lambda n: f"{n:02d}", "lowerLetter": _letters, "upperLetter": lambda n: _letters(n).upper(),
    "lowerRoman": _roman, "upperRoman": lambda n: _roman(n).upper(),
}


class _Numbering:
    """Word's automatic list numbers ("1.", "2.3", "b)"), which a written procedure refers back to
    ("repeat step 3"). They are not in the text itself, so they are counted here as Word would."""

    def __init__(self, document):
        self.levels: dict[str, dict[str, tuple[str, int, str]]] = {}   # numId → ilvl → (format, start, lvlText)
        self.counters: dict[str, dict[int, int]] = {}
        try:
            root = document.part.numbering_part.element
        except (KeyError, NotImplementedError):
            root = None
        if root is not None:
            abstract = {}
            for a in root.iterfind("w:abstractNum", NS):
                abstract[a.get(W + "abstractNumId")] = {lvl.get(W + "ilvl"): self._level(lvl) for lvl in a.iterfind("w:lvl", NS)}
            for num in root.iterfind("w:num", NS):
                ref = num.find("w:abstractNumId", NS)
                levels = dict(abstract.get(ref.get(W + "val") if ref is not None else "", {}))
                for override in num.iterfind("w:lvlOverride", NS):
                    start = override.find("w:startOverride", NS)
                    ilvl = override.get(W + "ilvl")
                    if start is not None and ilvl in levels:
                        fmt, _, text = levels[ilvl]
                        levels[ilvl] = (fmt, int(start.get(W + "val")), text)
                self.levels[num.get(W + "numId")] = levels
        self.style_numbers: dict[str, tuple[str, str]] = {}
        for style in document.styles:
            num_pr = style.element.find("w:pPr/w:numPr", NS)
            if num_pr is not None:
                self.style_numbers[style.style_id] = self._num_pr(num_pr)

    @staticmethod
    def _level(lvl) -> tuple[str, int, str]:
        def val(tag: str, default: str) -> str:
            el = lvl.find(tag, NS)
            return el.get(W + "val") if el is not None and el.get(W + "val") is not None else default
        return val("w:numFmt", "decimal"), int(val("w:start", "1")), val("w:lvlText", "")

    @staticmethod
    def _num_pr(num_pr) -> tuple[str, str]:
        num_id, ilvl = num_pr.find("w:numId", NS), num_pr.find("w:ilvl", NS)
        return (num_id.get(W + "val") if num_id is not None else "", ilvl.get(W + "val") if ilvl is not None else "0")

    def label(self, ppr, style_id: str) -> str | None:
        """The list label for a paragraph ("3.", "-"), or None when it is not in a list."""
        num_pr = ppr.find("w:numPr", NS) if ppr is not None else None
        num_id, ilvl = self._num_pr(num_pr) if num_pr is not None else self.style_numbers.get(style_id, ("", "0"))
        if num_pr is not None and num_pr.find("w:numId", NS) is None and style_id in self.style_numbers:
            num_id = self.style_numbers[style_id][0]       # level set on the paragraph, list from its style
        if not num_id or num_id == "0":
            return None
        levels = self.levels.get(num_id, {})
        fmt, _, text = levels.get(ilvl, ("bullet", 1, ""))
        if fmt not in NUMBER_FORMATS:
            return "-"
        counts = self.counters.setdefault(num_id, {})
        level = int(ilvl)
        counts[level] = counts.get(level, levels[ilvl][1] - 1) + 1
        for deeper in [k for k in counts if k > level]:
            del counts[deeper]                             # a new item restarts the sub-list under it

        def number(k: int) -> str:
            f, start, _ = levels.get(str(k), ("decimal", 1, ""))
            return NUMBER_FORMATS.get(f, str)(counts.get(k, start))
        return re.sub(r"%(\d)", lambda m: number(int(m.group(1)) - 1), text or f"%{level + 1}.")


def _read_docx(path: Path, doc: _Doc):
    import docx

    d = docx.Document(str(path))
    part = d.part
    styles = {s.style_id: (s.name or "").lower() for s in d.styles}
    numbering = _Numbering(d)

    def paragraph(p: ET.Element):
        ppr = p.find("w:pPr", NS)
        style_id = ppr.find("w:pStyle", NS).get(W + "val") if ppr is not None and ppr.find("w:pStyle", NS) is not None else ""
        style = styles.get(style_id, style_id.lower())
        text = _paragraph_text(p)
        if text and (style.startswith("heading") or style == "title"):
            doc.heading(" ".join(text.split()))
        elif text:
            label = numbering.label(ppr, style_id)
            if label is None and style.startswith("list"):
                label = "-"
            depth = int(ppr.find("w:numPr/w:ilvl", NS).get(W + "val")) if ppr is not None and ppr.find("w:numPr/w:ilvl", NS) is not None else 0
            doc.add(f"{'  ' * depth}{label} {text}" if label else text)
        for drawing in _drawings(p):
            for fig in _drawing_figures(drawing, part):
                doc.figure(fig)

    def table(tbl: ET.Element):
        for tr in tbl.iterfind("w:tr", NS):
            cells = [" ".join(_text_of(tc).split()) for tc in tr.iterfind("w:tc", NS)]
            if any(cells):
                doc.add("| " + " | ".join(cells) + " |")
            for drawing in _drawings(tr):
                for fig in _drawing_figures(drawing, part):
                    doc.figure(fig)
        doc.add("")

    def block(el: ET.Element):
        if el.tag == W + "p":
            paragraph(el)
        elif el.tag == W + "tbl":
            table(el)
        elif el.tag == W + "sdt":                # content controls wrap ordinary paragraphs and tables
            content = el.find("w:sdtContent", NS)
            for child in (content if content is not None else []):
                block(child)

    for el in d.element.body:     # python-docx elements are lxml, which share ElementTree's API
        block(el)


# ---------- PDF

def _read_pdf(path: Path, doc: _Doc, warnings: list[str]):
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        raise VBAError("The PDF is password-protected. Save an unprotected copy and try again.")
    texts = [(page.extract_text() or "").strip() for page in reader.pages]
    try:
        import pypdfium2 as pdfium
    except ImportError:
        pdfium = None
        warnings.append("Pictures in PDFs can’t be read because a component is missing (pypdfium2). "
                        "Run setup again to install it; the text is still read.")

    pdf = pdfium.PdfDocument(str(path)) if pdfium else None
    try:
        for i, text in enumerate(texts):
            doc.heading(f"Page {i + 1}")
            if text:
                doc.add(text)
            if pdf is None:
                continue
            page = pdf[i]
            reason = _page_needs_picture(page, len(text))
            if reason:
                doc.figure(_render_page(page, reason, f"p. {i + 1}"))
    finally:
        if pdf is not None:
            pdf.close()
    if not any(texts) and not doc.figures:
        raise VBAError("No text or pictures could be read from this PDF.")


def _page_needs_picture(page, text_chars: int) -> str:
    """Why the page should be sent as a picture, or '' when its text says it all."""
    import pypdfium2.raw as raw

    pw, ph = page.get_size()
    area = max(pw * ph, 1.0)
    paths = 0
    big_images = 0
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_PATH, raw.FPDF_PAGEOBJ_IMAGE], max_depth=3):
        if obj.type == raw.FPDF_PAGEOBJ_PATH:
            paths += 1
        else:
            left, bottom, right, top = obj.get_bounds()
            if (right - left) * (top - bottom) / area >= PDF_MIN_IMAGE_AREA:
                big_images += 1
    if big_images and text_chars < PDF_SCAN_TEXT:
        return "scanned page"
    if big_images:
        return "has a picture"
    if paths >= PDF_PATHS_FOR_DRAWING:
        return "has a drawing or bordered table"
    return ""


def _render_page(page, reason: str, locator: str) -> Figure:
    pw, ph = page.get_size()
    scale = min(2.0, MAX_RENDER_SIDE / max(pw, ph, 1.0))
    bitmap = page.render(scale=scale, rev_byteorder=True)   # RGB, not the default BGR
    try:
        data = _png(bitmap.width, bitmap.height, bytes(bitmap.buffer), bitmap.stride)
        return Figure(id="", kind="page", locator=locator, format="png", width=bitmap.width, height=bitmap.height,
                      data=data, reason=reason)
    finally:
        bitmap.close()


# ---------- shared

def _scan(doc: _Doc) -> dict:
    """Files the procedure names, and steps a workflow can't do, by line."""
    deps: dict[str, dict] = {}
    actions: dict[str, dict] = {}
    for n, line in enumerate(doc.lines, start=1):
        where = f"{doc.name}:{n}"
        for m in FILE_REF.finditer(line):
            ref = (m.group(1) or m.group(2)).strip()
            name = re.split(r"[\\/]", ref)[-1]
            d = deps.setdefault(name.lower(), {"kind": "external_file", "reference": ref, "filename": name, "lines": []})
            if where not in d["lines"] and len(d["lines"]) < 20:
                d["lines"].append(where)
        for label, pattern in ACTIONS:
            if pattern.search(line):
                a = actions.setdefault(label, {"action": label, "lines": []})
                if len(a["lines"]) < 10:
                    a["lines"].append(where)
    return {"dependencies": sorted(deps.values(), key=lambda d: d["reference"].lower()), "actions": list(actions.values())}


def figure_dir(key: str) -> Path:
    if not FIGURE_KEY.match(key):
        raise VBAError("Unknown figure set")
    return get_paths().root / "figures" / key


def figure_path(key: str, file: str) -> Path:
    if not FIGURE_FILE.match(file):
        raise VBAError("Unknown figure")
    path = figure_dir(key) / file
    if not path.is_file():
        raise VBAError("Figure not found")
    return path


def _save_figures(figures: list[Figure], digest: str) -> str:
    key = digest[:16]
    folder = figure_dir(key)
    folder.mkdir(parents=True, exist_ok=True)
    for n, fig in enumerate(figures, start=1):
        if fig.data and fig.format in VIEWABLE:
            fig.file = f"fig-{n:02d}.{'jpg' if fig.format == 'jpeg' else fig.format}"
            target = folder / fig.file
            if not target.exists():
                target.write_bytes(fig.data)
    return key


def load(path: Path | None = None, code: str | None = None, name: str | None = None) -> dict:
    """Read a procedure document (or pasted text) into numbered lines and figures."""
    warnings: list[str] = []
    if path is not None:
        ext = path.suffix.lower()
        doc = _Doc(path.name)
        try:
            if ext == ".docx":
                _read_docx(path, doc)
            elif ext == ".pdf":
                _read_pdf(path, doc, warnings)
            elif ext in (".txt", ".md"):
                doc.add(path.read_text(encoding="utf-8", errors="replace"))
            elif ext == ".doc":
                raise VBAError("Old Word documents (.doc) can’t be read. Open it in Word and save it as .docx.")
            else:
                raise VBAError(f"Unsupported file type '{ext}'. Use a Word document (.docx) or a PDF.")
        except VBAError:
            raise
        except Exception as e:
            raise VBAError(f"Could not read {path.name}: {e.__class__.__name__}: {e}") from e
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    elif code:
        doc = _Doc(name or "Pasted text")
        doc.add(code)
        digest = hashlib.sha256(code.encode()).hexdigest()
    else:
        raise VBAError("Provide a document or paste its text")

    text = doc.finish()
    if not text.strip():
        raise VBAError("No text was found in the document")
    key = _save_figures(doc.figures, digest) if doc.figures else None
    return {
        "workbook": {"path": str(path) if path else None, "name": path.name if path else None, "sheets": [],
                     "readable_sheets": False},
        "modules": [Module(name=doc.name, kind="document", code=text, procedures=doc.headings).__dict__],
        **_scan(doc),
        "figures": [{"id": f.id, "kind": f.kind, "line": f.line, "lines": f.lines, "locator": f.locator, "alt": f.alt,
                     "text": f.text, "format": f.format, "width": f.width, "height": f.height, "file": f.file or None,
                     "mode": f.mode, "reason": f.reason} for f in doc.figures],
        "figures_key": key,
        "warnings": warnings,
    }
