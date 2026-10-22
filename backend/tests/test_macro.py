"""Macro extraction, dependency flagging, and macro → workflow translation."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from vbafixture import compress, make_xlsm  # noqa: E402

from app.connectors import vba  # noqa: E402

MACRO = '''Option Explicit
Sub BuildReport()
    Dim wb As Workbook
    Application.ScreenUpdating = False
    Set wb = Workbooks.Open("C:\\Shared\\Finance\\products.xlsx")
    x = wb.Sheets("Products").Range("A1").Value
    ' old version used "archive_2019.xlsx"
    ThisWorkbook.Sheets("Sales").Range("A5").CurrentRegion.Copy
    Sheets("Summary").Cells.Clear
    Sheets("Summary").Range("A1").PasteSpecial
    Call Notify
End Sub

Private Sub Notify()
    Dim o As Object
    Set o = CreateObject("Outlook.Application")
    MsgBox "Done"
End Sub
'''


@pytest.fixture()
def macro_book(tmp_path):
    rows = [["Sales report"], [None], [None], [None], ["Txn ID", "Region", "Product ID", "Qty"],
            [1, "Luzon", "P1", 2], [2, "Visayas", "P2", 5]]
    return make_xlsm(tmp_path / "monthly report.xlsm", {"Sales": rows, "Summary": [["x"]]},
                     {"Module1": MACRO, "Helpers": "Function Twice(x)\n  Twice = x * 2\nEnd Function"})


def test_decompress_spec_examples():
    assert vba.decompress(bytes.fromhex("0119B000616263646566676800696A6B6C6D6E6F700071727374757 62E".replace(" ", ""))) \
        == b"abcdefghijklmnopqrstuv."
    assert vba.decompress(bytes.fromhex("0103B002610500")) == b"a" * 9   # copy token
    big = ("Sub X()\n" + "  y = y + 1\n" * 900 + "End Sub\n").encode()
    assert vba.decompress(compress(big)) == big


def test_extract_and_analyse(macro_book):
    r = vba.load(macro_book)
    mods = {m["name"]: m for m in r["modules"]}
    assert set(mods) == {"Module1", "Helpers"}
    assert [p["name"] for p in mods["Module1"]["procedures"]] == ["BuildReport", "Notify"]
    assert "Attribute VB_Name" not in mods["Module1"]["code"]
    deps = {(d["kind"], d["reference"]) for d in r["dependencies"]}
    assert ("external_file", "C:\\Shared\\Finance\\products.xlsx") in deps
    assert ("sheet", "Sales") in deps and ("sheet", "Summary") in deps
    assert not any("archive_2019" in d["reference"] for d in r["dependencies"])   # comments ignored
    sales = next(d for d in r["dependencies"] if d["reference"] == "Sales")
    assert sales["in_workbook"] and sales["lines"] == ["Module1:8"]
    assert next(d for d in r["dependencies"] if d["reference"] == "Summary")["written_by_macro"]
    assert not sales["written_by_macro"]
    ext = next(d for d in r["dependencies"] if d["kind"] == "external_file")
    assert ext["sheets"] == ["Products"] and not any(d["reference"] == "Products" for d in r["dependencies"] if d["kind"] == "sheet")
    actions = {a["action"] for a in r["actions"]}
    assert "Sends email" in actions and "Shows pop-up messages or asks the user for input" in actions


def test_pasted_code_and_dynamic_files():
    r = vba.load(code='Sub A()\n  f = Application.GetOpenFilename()\n  Workbooks.Open f\n'
                      '  cn.Open "Provider=SQLOLEDB;Data Source=FINDB"\nEnd Sub')
    kinds = {d["kind"] for d in r["dependencies"]}
    assert {"user_picks_file", "dynamic_file", "database"} <= kinds


def test_no_macros(tmp_path, files):
    with pytest.raises(vba.VBAError, match="no macros"):
        vba.load(files["jan"].with_suffix(".xlsx").rename(tmp_path / "plain.xlsm"))


def test_macro_to_workflow_end_to_end(client, macro_book, files):
    a = client.post("/api/macros/analyse", json={"path": str(macro_book)}).json()
    assert a["workbook"]["sheets"] == ["Sales", "Summary"] and a["workbook"]["source_id"] is None

    # Upload (drag & drop) the macro workbook and the external products file as sources.
    up = client.post("/api/uploads", content=macro_book.read_bytes(), headers={"X-Filename": "monthly%20report.xlsm"}).json()
    assert up["source"]["kind"] == "excel"
    again = client.post("/api/uploads", content=macro_book.read_bytes(), headers={"X-Filename": "monthly%20report.xlsm"}).json()
    assert again["existing"] and again["source"]["id"] == up["source"]["id"]
    prod = client.post("/api/sources", json={"path": str(files["products"])}).json()
    s_sales = client.post("/api/selections", json={"source_id": up["source"]["id"], "label": "Sales", "sheet": "Sales", "header_row": 5}).json()
    s_prod = client.post("/api/selections", json={"source_id": prod["id"], "label": "Products", "sheet": "Products", "header_row": 1}).json()

    deps = [{**d, "role": {"Sales": "sales", "C:\\Shared\\Finance\\products.xlsx": "products"}.get(d["reference"]),
             "ignored": d["reference"] == "Summary"} for d in a["dependencies"]]
    run = client.post("/api/runs", json={
        "service_id": "macro_to_workflow", "bindings": {"sales": s_sales["id"], "products": s_prod["id"]},
        "options": {"macro_name": "BuildReport", "entry": "BuildReport", "modules": a["modules"],
                    "dependencies": deps, "actions": a["actions"]}}).json()
    prompt = run["state"]["prompt"]
    assert "Qty | D | integer" in prompt                       # Excel column letters for range mapping
    assert "Header is on Excel row 5" in prompt
    assert '→ input role "products"' in prompt
    assert "   8:     ThisWorkbook.Sheets" in prompt           # numbered macro lines
    assert "Sends email" in prompt

    reply = {
        "recipe": {"inputs": [{"role": "sales"}, {"role": "products"}], "base": "sales", "steps": [
            {"op": "join", "right": "products", "left_on": ["Product ID"], "right_on": ["ID"], "right_columns": ["Category"]},
            {"op": "group_aggregate", "group_by": ["Category"], "aggregations": [{"column": "Qty", "function": "sum", "as": "Qty"}]}]},
        "step_notes": [{"step": 1, "macro_lines": "Module1:5-7", "explanation": "Looks up product category"}],
        "not_translated": [{"macro_lines": "Module1:12-16", "what_it_does": "Emails the team", "why": "Not a data step"}],
        "missing_data": [],
    }
    done = client.post(f"/api/runs/{run['id']}/response", json={"text": json.dumps(reply)}).json()
    assert done["status"] == "completed", done
    assert done["state"]["recipe"]["steps"][0]["note"].startswith("From macro Module1:5-7")
    assert done["state"]["not_translated"][0]["what_it_does"] == "Emails the team"
    group = done["state"]["recipe"]["groups"][0]
    assert (group["kind"], group["name"], group["start"], group["end"]) == ("macro", "BuildReport", 0, 1)

    bad = client.post(f"/api/runs/{run['id']}/response", json={"text": json.dumps({"recipe": {
        "inputs": [{"role": "sales"}], "base": "sales", "steps": [{"op": "vba", "code": "Kill \"C:\\\\*\""}]}})}).json()
    assert bad["status"] == "invalid_response"


def test_upload_rejects_unknown_types(client):
    r = client.post("/api/uploads", content=b"MZ", headers={"X-Filename": "tool.exe"})
    assert r.status_code == 400
