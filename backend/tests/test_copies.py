"""Readable copies of workflows and dashboards in the save folder: written on save, moved on rename,
removed on delete, and never touching files Flowbook didn't write."""

import json

from app.core import copies

from .test_api import add, sheet_selection
from .test_dashboards import _spec

RECIPE = {"inputs": [{"role": "sales"}], "base": "sales", "steps": [{"op": "filter_rows", "conditions": [
    {"column": "Region", "operator": "eq", "value": "Luzon"}]}], "output": {"name": "Luzon sales"}}


def _workflow(client, name, recipe_id=None):
    body = {"name": name, "definition": RECIPE}
    r = client.put(f"/api/recipes/{recipe_id}", json=body) if recipe_id else client.post("/api/recipes", json=body)
    assert r.status_code == 200, r.text
    copies.flush()
    return r.json()


def _files(folder):
    return sorted(p.name for p in folder.glob("*")) if folder.is_dir() else []


def test_workflow_copy_follows_saves_renames_and_deletes(client, tmp_path):
    out = tmp_path / "Flowbook"
    client.put("/api/settings", json={"save_folder": str(out)})
    wf = out / "Workflows"
    (wf).mkdir()
    (wf / "Monthly sales.json").write_text('{"mine": true}', encoding="utf-8")   # the user's own file

    rec = _workflow(client, "Monthly sales")
    assert _files(wf) == ["Monthly sales (2).json", "Monthly sales.json"]
    doc = json.loads((wf / "Monthly sales (2).json").read_text(encoding="utf-8"))
    assert doc["flowbook_copy"] == "workflow" and doc["id"] == rec["id"] and doc["version"] == 1
    assert "not read back" in doc["note"]
    assert doc["definition"]["steps"][0]["conditions"][0]["value"] == "Luzon"

    _workflow(client, "Quarterly sales", rec["id"])
    assert _files(wf) == ["Monthly sales.json", "Quarterly sales.json"]
    assert json.loads((wf / "Quarterly sales.json").read_text(encoding="utf-8"))["version"] == 2

    client.delete(f"/api/recipes/{rec['id']}")
    copies.flush()
    assert _files(wf) == ["Monthly sales.json"]
    assert (wf / "Monthly sales.json").read_text(encoding="utf-8") == '{"mine": true}'


def test_dashboard_copy_names_its_dataset(client, files, tmp_path):
    out = tmp_path / "Flowbook"
    client.put("/api/settings", json={"save_folder": str(out)})
    sel = sheet_selection(client, add(client, files["jan"])["id"], "Sales", 5, "January sales")
    d = client.post("/api/dashboards", json={"name": "Sales: board/1", "dataset": sel["id"], "spec": _spec()}).json()
    copies.flush()
    (path,) = (out / "Dashboards").glob("*.json")
    assert path.name == "Sales_ board_1.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["id"] == d["id"] and doc["dataset"] == {"id": sel["id"], "name": "January sales"}
    assert [w["id"] for w in doc["spec"]["widgets"]] == ["h1", "c1", "t1"]


def test_choosing_a_save_folder_writes_existing_items_and_clears_stale_copies(client, tmp_path):
    rec = _workflow(client, "Before a folder was chosen")
    out = tmp_path / "Flowbook"
    out.mkdir()
    (out / "Workflows").mkdir()
    stale = {"flowbook_copy": "workflow", "id": "rcp_gone", "name": "Old"}
    (out / "Workflows" / "Old.json").write_text(json.dumps(stale), encoding="utf-8")

    client.put("/api/settings", json={"save_folder": str(out)})
    copies.flush()
    assert _files(out / "Workflows") == ["Before a folder was chosen.json"]
    assert json.loads((out / "Workflows" / "Before a folder was chosen.json").read_text(encoding="utf-8"))["id"] == rec["id"]


def test_no_save_folder_writes_nothing(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _workflow(client, "Nowhere to go")
    assert not [p for p in tmp_path.rglob("*.json") if "appdata" not in p.parts]
