"""Data templates: recurring files that differ by a date in the filename."""

import datetime as dt

import pytest

from app.core import templates

from .conftest import _write_xlsx

HEADER = [["Monthly report"], [None], [None], [None], ["Txn ID", "Region", "Qty"]]


@pytest.fixture()
def monthly(tmp_path):
    d = tmp_path / "share" / "sales"
    d.mkdir(parents=True)
    _write_xlsx(d / "sales_2026_01.xlsx", HEADER + [[1, "Luzon", 2], [2, "Visayas", 3]], sheet="Sales")
    _write_xlsx(d / "sales_2026_02.xlsx", HEADER + [[3, "Luzon", 5]], sheet="Sales")
    _write_xlsx(d / "sales_2026_03.xlsx", HEADER[:4] + [["Txn ID", "Region", "Quantity"], [4, "Luzon", 1]], sheet="Sales")
    _write_xlsx(d / "sales_summary.xlsx", [["x"]], sheet="Sales")          # does not match
    (d / "~$sales_2026_04.xlsx").write_bytes(b"lock")                       # Excel lock file, ignored
    return d


def test_suggest_and_match(monthly):
    s = templates.suggest(str(monthly / "sales_2026_02.xlsx"))
    best = s["suggestions"][0]
    assert best["pattern"] == "sales_{date}.xlsx" and best["format"] == "YYYY_MM"
    assert [m["value"] for m in best["matches"]] == ["2026_03", "2026_02", "2026_01"]   # newest first
    assert best["matches"][0]["label"] == "Mar 2026"
    # the bare year inside 2026_02 is not offered as a separate, worse suggestion
    assert not any(x["format"] == "YYYY" for x in s["suggestions"])


@pytest.mark.parametrize("name,fmt,value", [
    ("GL extract 2026-10-22.csv", "YYYY-MM-DD", "2026-10-22"),
    ("Branch_Report_Oct 2026.xlsx", "MMM YYYY", "Oct 2026"),
    ("recon20261022.xlsx", "YYYYMMDD", "20261022"),
    ("payroll_202610.xlsx", "YYYYMM", "202610"),
])
def test_suggest_formats(tmp_path, name, fmt, value):
    (tmp_path / name).write_bytes(b"")
    s = templates.suggest(str(tmp_path / name))
    assert (s["suggestions"][0]["format"], s["suggestions"][0]["example_value"]) == (fmt, value)


def test_pattern_validation(tmp_path):
    with pytest.raises(templates.SourceError, match="exactly one"):
        templates.list_matches(str(tmp_path), "sales.xlsx", "YYYY_MM")
    with pytest.raises(templates.SourceError, match="not reachable"):
        templates.list_matches(str(tmp_path / "nope"), "s_{date}.xlsx", "YYYY_MM")


def test_template_in_workflow(client, monthly):
    src = client.post("/api/sources", json={"path": str(monthly / "sales_2026_01.xlsx")}).json()
    sel = client.post("/api/selections", json={"source_id": src["id"], "label": "Sales", "sheet": "Sales", "header_row": 5}).json()
    bad = client.post("/api/templates", json={"name": "x", "selection_id": sel["id"], "pattern": "other_{date}.xlsx", "format": "YYYY_MM"})
    assert bad.status_code == 400 and "example" in bad.json()["detail"]
    tpl = client.post("/api/templates", json={"name": "Monthly sales", "selection_id": sel["id"],
                                              "pattern": "sales_{date}.xlsx", "format": "YYYY_MM"}).json()
    assert tpl["id"].startswith("tpl_") and len(tpl["matches"]) == 3 and tpl["header_row"] == 5

    recipe = {"inputs": [{"role": "sales"}], "base": "sales", "steps": [
        {"op": "group_aggregate", "group_by": ["Region"], "aggregations": [{"column": "Txn ID", "function": "count", "as": "n"}]}]}
    # Specific period
    pv = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": {"sales": f"{tpl['id']}@2026_01"}}).json()
    assert pv["inputs"][0]["template_value"] == "2026_01" and pv["data"]["row_count"] == 2
    # Default = newest (March), whose columns changed -> warning, not silent
    pv = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": {"sales": tpl["id"]}}).json()
    assert pv["inputs"][0]["template_value"] == "2026_03" and pv["inputs"][0]["template_latest"]
    assert any("differ from the template" in w for w in pv["inputs"][0]["warnings"])
    # Unknown period
    r = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": {"sales": f"{tpl['id']}@2025_12"}})
    assert r.status_code == 400 and "no file for '2025_12'" in r.json()["detail"]
    # A run records exactly which file it used
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": f"{tpl['id']}@2026_02"}}).json()
    assert run["status"] == "completed"
    assert run["state"]["inputs"][0]["path"].endswith("sales_2026_02.xlsx")

    # New file dropped into the folder later -> appears automatically, becomes the newest
    _write_xlsx(monthly / "sales_2026_04.xlsx", HEADER + [[9, "Visayas", 1]], sheet="Sales")
    again = client.get(f"/api/templates/{tpl['id']}").json()
    assert again["matches"][0]["value"] == "2026_04"
    assert client.delete(f"/api/templates/{tpl['id']}").json()["ok"]
