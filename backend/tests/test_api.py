"""End-to-end API flows matching the plan's milestone exit criteria."""

import json

from app.storage import db


def add(client, path):
    r = client.post("/api/sources", json={"path": str(path)})
    assert r.status_code == 200, r.text
    return r.json()


def sheet_selection(client, source_id, sheet, header_row, label):
    r = client.post("/api/selections", json={"source_id": source_id, "label": label, "sheet": sheet,
                                             "header_row": header_row})
    assert r.status_code == 200, r.text
    return r.json()


def test_security_guards(client):
    assert client.post("/api/sources", json={"path": "/x"}, headers={"X-Workbench": ""}).status_code == 403
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 403
    assert client.get("/api/health", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/health").json()["ok"]


def test_milestone1_collection_survives_restart(client, files, data_dir):
    jan = add(client, files["jan"])
    assert jan["kind"] == "excel" and jan["metadata"]["sheets"] == ["Sales", "Notes"]
    prev = client.get(f"/api/sources/{jan['id']}/preview", params={"sheet": "Sales"}).json()
    assert prev["suggested_header_row"] == 5
    sel = sheet_selection(client, jan["id"], "Sales", 5, "January sales")
    assert sel["config"]["header_row"] == 5
    md = add(client, files["md"])
    txt = add(client, files["txt"])
    doc_sels = [s for s in client.get("/api/selections").json() if s["kind"] == "document"]
    assert len(doc_sels) == 2
    col = client.post("/api/collections", json={"name": "Q1 pack", "items": [
        {"selection_id": sel["id"]}, *({"selection_id": s["id"]} for s in doc_sels)]}).json()

    # "Restart": drop the DB connection and build a new app against the same data dir.
    db._conn = None
    from fastapi.testclient import TestClient

    from app.main import create_app
    with TestClient(create_app(), base_url="http://127.0.0.1:8765", headers={"X-Workbench": "1"}) as c2:
        again = c2.get(f"/api/collections/{col['id']}").json()
        assert [i["selection_id"] for i in again["items"]][0] == sel["id"]
        assert again["items"][0]["config"]["header_row"] == 5
        chk = c2.post(f"/api/collections/{col['id']}/check").json()
        assert chk["ok"], chk
    assert md and txt


def test_missing_and_drifted_sources_are_reported(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    col = client.post("/api/collections", json={"name": "c", "items": [{"selection_id": sel["id"]}]}).json()
    # Overwrite the workbook with different columns -> drift
    from openpyxl import Workbook
    wb = Workbook()
    wb.active.title = "Sales"
    for _ in range(4):
        wb.active.append([None])
    wb.active.append(["Txn ID", "Amount"])
    wb.active.append([1, 2])
    wb.save(files["jan"])
    chk = client.post(f"/api/collections/{col['id']}/check").json()
    assert chk["items"][0]["status"] == "drift"
    assert "Region" in chk["items"][0]["drift"]["missing"]
    files["jan"].unlink()
    chk = client.post(f"/api/collections/{col['id']}/check").json()
    assert chk["items"][0]["status"] == "missing" and not chk["ok"]


def test_milestone2_transform_save_and_rerun(client, files, tmp_path):
    jan = add(client, files["jan"])
    prod = add(client, files["products"])
    s_jan = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    s_prod = sheet_selection(client, prod["id"], "Products", 1, "Products")
    definition = {
        "inputs": [{"role": "sales", "expected_columns": [{"name": "Qty", "type": "integer"}]}, {"role": "products"}],
        "base": "sales",
        "steps": [
            {"op": "join", "right": "products", "left_on": ["Product ID"], "right_on": ["ID"],
             "right_columns": ["Category"]},
            {"op": "derive_column", "name": "Revenue", "expression": "[Qty] * [Unit Price]"},
            {"op": "group_aggregate", "group_by": ["Category"],
             "aggregations": [{"column": "Revenue", "function": "sum", "as": "Revenue"}]},
        ],
        "output": {"name": "revenue by category", "formats": ["xlsx", "csv"]},
    }
    bindings = {"sales": s_jan["id"], "products": s_prod["id"]}
    pv = client.post("/api/transform/preview", json={"recipe": definition, "bindings": bindings}).json()
    assert pv["error"] is None and pv["data"]["row_count"] == 3
    rec = client.post("/api/recipes", json={"name": "Revenue", "definition": definition}).json()
    run = client.post("/api/transform/run", json={"recipe": definition, "bindings": bindings,
                                                  "recipe_id": rec["id"], "title": "Revenue Jan"}).json()
    assert run["status"] == "completed", run
    assert {a["kind"] for a in run["artifacts"]} == {"xlsx", "csv"}
    xlsx = next(a for a in run["artifacts"] if a["kind"] == "xlsx")
    view = client.get(f"/api/artifacts/{xlsx['id']}/view").json()
    assert view["row_count"] == 3
    assert client.get(f"/api/artifacts/{xlsx['id']}/download").status_code == 200

    # Rerun on next month's workbook by relocating the source.
    client.post(f"/api/sources/{jan['id']}/relocate", json={"path": str(files["feb"])})
    run2 = client.post("/api/transform/run", json={"recipe": definition, "bindings": bindings}).json()
    assert run2["status"] == "completed" and run2["id"] != run["id"]
    assert run2["summary"]["output_rows"] == 1  # Feb only has P1


def test_milestone3_knowledge_base_flow(client, files):
    md = add(client, files["md"])
    txt = add(client, files["txt"])
    sels = client.get("/api/selections").json()
    col = client.post("/api/collections", json={"name": "Policies", "items": [
        {"selection_id": s["id"]} for s in sorted(sels, key=lambda s: s["label"], reverse=True)]}).json()
    prev = client.post("/api/context/preview", json={"collection_id": col["id"]}).json()
    anchors = [s["anchor"] for it in prev["items"] for s in it["segments"]]
    assert anchors[0] == "S1.1"

    run = client.post("/api/runs", json={"service_id": "knowledge_base", "collection_id": col["id"],
                                         "options": {"audience": "Tellers"},
                                         "redactions": [{"find": "branch manager", "replace": "[ROLE]"}]}).json()
    assert run["status"] == "awaiting_response"
    prompt = run["state"]["prompt"]
    assert "[ROLE]" in prompt and "branch manager" not in prompt
    assert "<<<END S1.1>>>\n\nSale" not in prompt  # source text cannot forge delimiters
    assert "‹‹‹END S1.1›››" in prompt

    bad = client.post(f"/api/runs/{run['id']}/response", json={"text": "Sure! Here is your knowledge base."}).json()
    assert bad["status"] == "invalid_response" and bad["state"]["corrective_prompt"]

    reply = {
        "title": "Refunds", "summary": "How refunds work.",
        "sections": [{"heading": "Policy", "claims": [
            {"text": "Refunds are allowed within 30 days.", "basis": "fact", "citations": ["S1.1"]},
            {"text": "Sale items are final.", "basis": "fact", "citations": ["[S1.2]"]},
            {"text": "<script>alert(1)</script>", "basis": "fact", "citations": ["S9.9"]},
        ]}],
        "contradictions": [], "open_questions": ["Who handles disputes?"],
    }
    ok = client.post(f"/api/runs/{run['id']}/response",
                     json={"text": "```json\n" + json.dumps(reply) + "\n```"}).json()
    assert ok["status"] == "completed", ok
    assert ok["summary"]["invalid_citations"] == 1 and ok["summary"]["flagged_claims"] == 1
    html_art = next(a for a in ok["artifacts"] if a["kind"] == "html")
    page = client.get(f"/api/artifacts/{html_art['id']}/view")
    assert "<script>alert" not in page.text and "&lt;script&gt;" in page.text
    assert "sandbox" in page.headers["content-security-policy"]
    assert len(client.get(f"/api/runs/{run['id']}").json()["exchanges"]) >= 4


def test_ai_recipe_proposal_uses_same_validation(client, files):
    jan = add(client, files["jan"])
    s = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    run = client.post("/api/runs", json={"service_id": "transformation_ai", "bindings": {"sales": s["id"]},
                                         "options": {"goal": "Total qty by region"}}).json()
    assert "Txn ID" in run["state"]["prompt"] and "Mindanao" not in run["state"]["prompt"]  # no samples unless approved
    evil = client.post(f"/api/runs/{run['id']}/response",
                       json={"text": json.dumps({"inputs": [{"role": "sales"}], "base": "sales",
                                                 "steps": [{"op": "python", "code": "import os"}]})}).json()
    assert evil["status"] == "invalid_response"
    good = client.post(f"/api/runs/{run['id']}/response", json={"text": json.dumps({
        "inputs": [{"role": "sales"}], "base": "sales",
        "steps": [{"op": "group_aggregate", "group_by": ["Region"],
                   "aggregations": [{"column": "Qty", "function": "sum", "as": "Qty"}]}]})}).json()
    assert good["status"] == "completed" and good["state"]["recipe"]["steps"][0]["op"] == "group_aggregate"


def test_recipe_remembers_last_bindings(client, files):
    src = add(client, files["csv"])
    sel = client.get("/api/selections").json()[0]
    definition = {"inputs": [{"role": "targets"}], "base": "targets", "steps": []}
    rec = client.post("/api/recipes", json={"name": "Targets", "definition": definition}).json()
    assert rec["last_bindings"] == {}
    client.post("/api/transform/run", json={"recipe": definition, "bindings": {"targets": sel["id"]}, "recipe_id": rec["id"]})
    assert client.get(f"/api/recipes/{rec['id']}").json()["last_bindings"] == {"targets": sel["id"]}
    assert src["kind"] == "csv"


def test_preview_profiles_and_secondary_inputs(client, files):
    jan = add(client, files["jan"])
    prod = add(client, files["products"])
    s1 = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    s2 = sheet_selection(client, prod["id"], "Products", 1, "Products")
    recipe = {"inputs": [{"role": "sales"}, {"role": "products"}], "base": "sales", "steps": []}
    pv = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": {"sales": s1["id"], "products": s2["id"]}}).json()
    prof = {p["name"]: p for p in pv["data"]["profile"]}
    assert prof["Region"]["top"][0] == {"value": "Luzon", "count": 3}
    assert "top" in prof["Date"] or "bins" in prof["Date"]
    assert all(str(t["value"]).startswith("2026") for t in prof["Date"].get("top", [])) and \
        all(str(b["from"]).startswith("2026") for b in prof["Date"].get("bins", []))
    pv2 = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": {"sales": s1["id"], "products": s2["id"]},
                                                       "view_role": "products"}).json()
    assert pv2["data"]["columns"] == ["ID", "Category", "Name"]


def test_preview_branch_data_and_errors(client, files):
    jan = add(client, files["jan"])
    s = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    recipe = {"inputs": [{"role": "all"}, {"role": "luzon", "steps": [
        {"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Luzon"}]}]}],
        "base": "all", "steps": [{"op": "append_rows", "inputs": ["luzon"]}]}
    b = {"all": s["id"], "luzon": s["id"]}                     # same selection bound twice
    pv = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": b}).json()
    assert pv["error"] is None and pv["data"]["row_count"] == 5 + 3
    assert pv["branches"]["luzon"][0]["rows_out"] == 3
    one = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": b, "view_role": "luzon", "upto": 0}).json()
    assert one["data"]["row_count"] == 3
    raw = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": b, "view_role": "luzon"}).json()
    assert raw["data"]["row_count"] == 5
    recipe["inputs"][1]["steps"][0]["conditions"][0]["column"] = "Nope"
    bad = client.post("/api/transform/preview", json={"recipe": recipe, "bindings": b}).json()
    assert bad["error"]["branch"] == "luzon" and bad["error"]["step"] == 0
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": b}).json()
    assert run["status"] == "failed" and run["errors"][-1].startswith("Input 'luzon' step 1:")


def test_background_run_reports_progress_and_paths(client, files, monkeypatch):
    import time as _t

    from app.core import runs as runs_core
    opened = []
    monkeypatch.setattr(runs_core, "open_on_desktop", lambda path, reveal: opened.append((path.name, reveal)))
    jan = add(client, files["jan"])
    s = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    recipe = {"inputs": [{"role": "sales"}], "base": "sales", "steps": [
        {"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Luzon"}]},
        {"op": "sort_rows", "keys": [{"column": "Qty"}]}], "output": {"name": "out", "formats": ["xlsx", "csv"]}}
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}, "background": True}).json()
    assert run["status"] == "running" and run["state"]["progress"]["total"] == 2
    for _ in range(100):
        run = client.get(f"/api/runs/{run['id']}").json()
        if run["status"] != "running":
            break
        _t.sleep(0.05)
    assert run["status"] == "completed", run
    assert run["state"]["progress"]["stage"] == "done" and run["summary"]["duration_ms"] >= 0
    xlsx = next(a for a in run["artifacts"] if a["kind"] == "xlsx")
    assert xlsx["file_path"].endswith("out.xlsx")
    assert client.post(f"/api/artifacts/{xlsx['id']}/reveal").json()["ok"]
    assert client.post(f"/api/artifacts/{xlsx['id']}/open").json()["ok"]
    assert opened == [("out.xlsx", True), ("out.xlsx", False)]

    # A failing step ends the background run visibly, naming the step.
    recipe["steps"][1]["keys"][0]["column"] = "Nope"
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}, "background": True}).json()
    for _ in range(100):
        run = client.get(f"/api/runs/{run['id']}").json()
        if run["status"] != "running":
            break
        _t.sleep(0.05)
    assert run["status"] == "failed" and run["summary"]["failed_step"] == 1 and run["errors"][-1].startswith("Step 2:")


def test_download_either_format(client, files):
    jan = add(client, files["jan"])
    s = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    recipe = {"inputs": [{"role": "sales"}], "base": "sales", "steps": [], "output": {"name": "only excel", "formats": ["xlsx"]}}
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}}).json()
    assert [a["kind"] for a in run["artifacts"]] == ["xlsx"]
    csv = client.get(f"/api/runs/{run['id']}/download/csv")
    assert csv.status_code == 200 and "only%20excel.csv" in csv.headers["content-disposition"]
    text = csv.content.decode("utf-8-sig")
    assert text.splitlines()[0].startswith("Txn ID,Date,Region") and "'=HYPERLINK" in text   # still formula-safe
    again = client.get(f"/api/runs/{run['id']}").json()
    assert sorted(a["kind"] for a in again["artifacts"]) == ["csv", "xlsx"]                # saved next to the xlsx
    assert client.get(f"/api/runs/{run['id']}/download/xlsx").status_code == 200
    assert client.get(f"/api/runs/{run['id']}/download/pdf").status_code == 400


def test_output_folder_name_tokens_and_conflicts(client, files, tmp_path):
    import datetime as _dt

    jan = add(client, files["jan"])
    s = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    out = tmp_path / "Team share" / "Reports"
    out.mkdir(parents=True)
    recipe = {"inputs": [{"role": "sales"}], "base": "sales", "steps": [],
              "output": {"name": "Sales {date}", "formats": ["xlsx", "csv"], "folder": str(out)}}
    today = _dt.date.today().isoformat()
    run = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}}).json()
    assert run["status"] == "completed", run
    assert sorted(p.name for p in out.iterdir()) == [f"Sales {today}.csv", f"Sales {today}.xlsx"]
    assert run["summary"]["saved_to"][0] == str(out / f"Sales {today}.xlsx")
    # Second run: keep both -> numbered copies
    client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}})
    assert (out / f"Sales {today} (2).xlsx").exists()
    # Replace -> overwrites, no new file
    recipe["output"]["if_exists"] = "replace"
    before = len(list(out.iterdir()))
    client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}})
    assert len(list(out.iterdir())) == before
    # Missing folder fails before doing any work, with a clear message
    recipe["output"]["folder"] = str(tmp_path / "missing")
    bad = client.post("/api/transform/run", json={"recipe": recipe, "bindings": {"sales": s["id"]}}).json()
    assert bad["status"] == "failed" and "output folder was not found" in bad["errors"][0]
    assert client.get("/api/fs/check-folder", params={"path": str(out)}).json()["ok"]
    assert not client.get("/api/fs/check-folder", params={"path": str(tmp_path / "missing")}).json()["ok"]
