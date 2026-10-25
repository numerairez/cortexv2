"""Dashboards: saved specs over a library dataset, validated links, and the rows they compute from."""

import json

from .test_api import add, sheet_selection


def _spec(**extra):
    return {
        "widgets": [
            {"id": "h1", "type": "headline", "title": "Units", "box": {"x": 0, "y": 0, "w": 3, "h": 3},
             "measure": {"agg": "sum", "field": "Qty"}},
            {"id": "c1", "type": "chart", "chart": "bar", "title": "By region", "box": {"x": 0, "y": 3, "w": 6, "h": 8},
             "x": "Region", "y": {"agg": "sum", "field": "Qty"}},
            {"id": "t1", "type": "table", "title": "Rows", "box": {"x": 6, "y": 3, "w": 6, "h": 8},
             "columns": ["Region", "Qty"]},
        ],
        **extra,
    }


def test_dashboard_crud_and_data(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "January sales")

    r = client.post("/api/dashboards", json={"name": "Sales board", "dataset": sel["id"],
                                            "spec": _spec(links=[{"id": "l1", "source": "c1", "target": "t1"}])})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["dataset_label"] == "January sales" and d["dataset_kind"] == "excel"
    assert d["spec"]["links"][0]["effect"] == "filter"  # default: filter

    data = client.get("/api/dashboards/data", params={"dataset": sel["id"]}).json()
    assert data["row_count"] == 5 and not data["truncated"]
    assert data["file"] == "sales_jan.xlsx" and data["sheet"] == "Sales" and data["read_at"]
    names = [c["name"] for c in data["columns"]]
    assert {"name": "Qty", "type": "integer"} in data["columns"] and "Region" in names
    assert data["rows"][0][names.index("Region")] == "Luzon"

    upd = client.put(f"/api/dashboards/{d['id']}", json={"name": "Renamed", "dataset": sel["id"], "spec": _spec()}).json()
    assert upd["name"] == "Renamed" and upd["spec"]["links"] == []
    assert [x["id"] for x in client.get("/api/dashboards").json()] == [d["id"]]

    assert client.delete(f"/api/dashboards/{d['id']}").status_code == 200
    assert client.get(f"/api/dashboards/{d['id']}").status_code == 404
    assert client.get("/api/dashboards").json() == []


def test_dashboard_spec_is_validated(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "Jan")

    def post(spec, dataset=sel["id"]):
        return client.post("/api/dashboards", json={"name": "x", "dataset": dataset, "spec": spec})

    assert post(_spec(links=[{"id": "l", "source": "c1", "target": "nope"}])).status_code == 422
    assert post(_spec(links=[{"id": "l", "source": "c1", "target": "c1"}])).status_code == 422
    assert post(_spec(links=[{"id": "l", "source": "h1", "target": "c1"}])).status_code == 422  # headlines don't drive
    bad_box = _spec()
    bad_box["widgets"][1]["box"] = {"x": 8, "y": 0, "w": 6, "h": 4}  # spills past column 12
    assert post(bad_box).status_code == 422
    no_field = _spec()
    no_field["widgets"][0]["measure"] = {"agg": "sum"}
    assert post(no_field).status_code == 422
    assert post(_spec(), dataset="sel_missing").status_code == 404
    flt = _spec()
    flt["widgets"][0]["filter"] = {"match": "any", "conditions": [{"column": "Region", "operator": "nope"}]}
    assert post(flt).status_code == 422  # same operators as a workflow filter
    flt["widgets"][0]["filter"]["conditions"][0] = {"column": "Qty", "operator": "between", "value": [2, None]}
    assert post(flt).json()["spec"]["widgets"][0]["filter"]["match"] == "any"
    assert post({**_spec(), "showTitle": False}).json()["spec"]["showTitle"] is False  # dashboard display options too
    # Unknown display options survive a round trip.
    extra = _spec()
    extra["widgets"][1]["timeUnit"] = "yearmonth"
    assert post(extra).json()["spec"]["widgets"][1]["timeUnit"] == "yearmonth"


def test_pivot_tables_are_validated(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    spec = _spec()
    spec["widgets"][2].update(mode="pivot", groupBy=["Region"], pivotColumn="Date", pivotValue={"agg": "sum", "field": "Qty"},
                              totals=True, heat=True)
    r = client.post("/api/dashboards", json={"name": "p", "dataset": sel["id"], "spec": spec})
    assert r.status_code == 200, r.text
    t = r.json()["spec"]["widgets"][2]
    assert t["mode"] == "pivot" and t["pivotTop"] == 12 and t["pivotValue"] == {"agg": "sum", "field": "Qty"}
    assert t["heat"] is True  # display options are kept as-is

    spec["widgets"][2]["pivotColumn"] = "Region"  # same field down and across
    assert client.post("/api/dashboards", json={"name": "p", "dataset": sel["id"], "spec": spec}).status_code == 422
    spec["widgets"][2].update(pivotColumn="Date", pivotValue={"agg": "mean"})  # a mean needs a column
    assert client.post("/api/dashboards", json={"name": "p", "dataset": sel["id"], "spec": spec}).status_code == 422


def test_describe_a_chart_prompt_and_reply(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    current = {"id": "c1", "type": "chart", "chart": "bar", "title": "New chart", "box": {"x": 0, "y": 3, "w": 6, "h": 8},
               "y": {"agg": "count"}}

    r = client.post("/api/dashboards/ai/prompt", json={"dataset": sel["id"], "request": "Qty per region, stacked by product",
                                                       "widget": current})
    prompt = r.json()["prompt"]
    assert "Qty per region, stacked by product" in prompt and "- Region | text |" in prompt
    assert "Luzon" not in prompt  # no data values unless the user allows examples
    with_samples = client.post("/api/dashboards/ai/prompt", json={"dataset": sel["id"], "request": "x", "include_samples": True}).json()
    assert "Luzon" in with_samples["prompt"] and "<<<SOURCE examples" in with_samples["prompt"]
    assert client.post("/api/dashboards/ai/prompt", json={"dataset": sel["id"], "request": "  "}).status_code == 400

    def reply(obj, text=None):
        return client.post("/api/dashboards/ai/reply", json={"dataset": sel["id"], "widget": current,
                                                             "text": text or f"Sure!\n```json\n{json.dumps(obj)}\n```"}).json()

    ok = reply({"type": "chart", "title": "Qty by region", "chart": "bar", "x": "Region",
                "y": {"agg": "sum", "field": "Qty"}, "color": "Product ID"})
    assert ok["errors"] == [] and ok["corrective_prompt"] is None
    assert ok["widget"]["id"] == "c1" and ok["widget"]["box"] == current["box"] and ok["widget"]["color"] == "Product ID"

    bad = reply({"type": "chart", "chart": "bar", "x": "Area", "y": {"agg": "sum", "field": "Region"}})
    assert bad["widget"] is None and any("Unknown column" in e for e in bad["errors"])
    assert "Area" in bad["corrective_prompt"] and "ONE JSON object" in bad["corrective_prompt"]
    assert any("needs a number column" in e for e in reply({"type": "headline", "measure": {"agg": "mean", "field": "Region"}})["errors"])

    pivot = reply({"type": "table", "mode": "pivot", "groupBy": ["Region"], "pivotColumn": "Product ID",
                   "pivotValue": {"agg": "sum", "field": "Qty"}})
    assert pivot["widget"]["type"] == "table" and pivot["widget"]["mode"] == "pivot"

    vl = reply({"type": "chart", "vegaLite": {"transform": [{"filter": "datum.Region == 'Luzon'"}], "mark": "bar",
                                              "encoding": {"x": {"field": "Product ID"}, "y": {"aggregate": "sum", "field": "Qty"}}}})
    assert vl["errors"] == [] and vl["widget"]["vegaLite"]["mark"] == "bar"
    remote = reply({"type": "chart", "vegaLite": {"layer": [{"data": {"url": "http://evil/x.csv"}, "mark": "bar"}]}})
    assert remote["widget"] is None and any("web addresses" in e for e in remote["errors"])
    assert any("leave data out" in e for e in remote["errors"])
    assert reply(None, text="no json here")["errors"]
    luzon = reply({"type": "headline", "measure": {"agg": "sum", "field": "Qty"},
                   "filter": {"match": "all", "conditions": [{"column": "Region", "operator": "in", "value": ["Luzon"]}]}})
    assert luzon["errors"] == [] and luzon["widget"]["filter"]["conditions"][0]["value"] == ["Luzon"]
    assert any("Unknown column" in e for e in reply({"type": "headline", "measure": {"agg": "count"},
               "filter": {"conditions": [{"column": "Zone", "operator": "eq", "value": "N"}]}})["errors"])
    assert reply({"type": "headline", "measure": {"agg": "count"},
                  "filter": {"conditions": [{"column": "Qty", "operator": "roughly", "value": 3}]}})["errors"]
    assert any("unknown mark type 'barz'" in e for e in reply({"type": "chart", "vegaLite": {"mark": "barz"}})["errors"])
    refine = client.post("/api/dashboards/ai/prompt", json={"dataset": sel["id"], "request": "as a pivot", "widget": {**current, "x": "Region"}}).json()["prompt"]
    assert "# The object as it is now" in refine and '"x": "Region"' in refine and '"box"' not in refine

    fix = client.post("/api/dashboards/ai/correction", json={"problems": ["Unrecognized mark 'barz'"]}).json()["prompt"]
    assert "barz" in fix


def test_describe_interactions_prompt_and_reply(client, files):
    jan = add(client, files["jan"])
    sel = sheet_selection(client, jan["id"], "Sales", 5, "Jan")
    spec = _spec(links=[{"id": "l1", "source": "t1", "target": "c1", "effect": "filter"}])
    spec["widgets"].append({"id": "d1", "type": "chart", "chart": "donut", "title": "Share", "box": {"x": 0, "y": 11, "w": 6, "h": 8},
                            "x": "Region", "y": {"agg": "sum", "field": "Qty"}})

    def prompt(request, focus=None):
        return client.post("/api/dashboards/ai/links/prompt", json={"dataset": sel["id"], "spec": spec, "request": request, "focus": focus})

    p = prompt("clicking a region filters everything").json()["prompt"]
    assert "clicking a region filters everything" in p and "id c1 | chart" in p and "- t1 → c1: filter" in p
    assert "can be a source: no" in p  # the headline
    assert "as a target: filter only" in p  # the donut
    assert "Luzon" not in p  # no data values
    assert "Focus: only the links that START at object c1" in prompt("x", focus="c1").json()["prompt"]
    assert prompt("  ").status_code == 400

    def reply(obj, focus=None):
        return client.post("/api/dashboards/ai/links/reply", json={"dataset": sel["id"], "spec": spec, "focus": focus,
                                                                   "text": f"```json\n{json.dumps(obj)}\n```"}).json()

    r = reply({"mode": "replace", "links": [{"source": "c1", "target": "h1", "effect": "filter"},
                                            {"source": "c1", "target": "t1", "effect": "highlight"}],
               "selectBy": {"t1": "Region"}, "notes": ["Drill-down from region to product isn't possible"]})
    assert r["errors"] == [] and r["mode"] == "replace"
    assert [(l["source"], l["target"], l["effect"]) for l in r["links"]] == [("c1", "h1", "filter"), ("c1", "t1", "highlight")]
    assert r["selectBy"] == {"t1": "Region"} and r["notes"] == ["Drill-down from region to product isn't possible"]

    added = reply({"mode": "add", "links": [{"source": "t1", "target": "c1", "effect": "highlight"}, {"source": "c1", "target": "d1"}]})
    assert added["errors"] == []
    assert {(l["source"], l["target"], l["effect"]) for l in added["links"]} == {("t1", "c1", "highlight"), ("c1", "d1", "filter")}
    assert next(l for l in added["links"] if l["source"] == "t1")["id"] == "l1"  # an updated link keeps its id

    focused = reply({"mode": "replace", "links": [{"source": "c1", "target": "t1"}]}, focus="c1")
    assert {(l["source"], l["target"]) for l in focused["links"]} == {("t1", "c1"), ("c1", "t1")}  # others kept

    def errs(obj, focus=None):
        out = reply(obj, focus)
        assert out["links"] is None and out["corrective_prompt"]
        return " ".join(out["errors"])
    assert "unknown object id zz" in errs({"links": [{"source": "c1", "target": "zz"}]})
    assert "cannot be clicked" in errs({"links": [{"source": "h1", "target": "c1"}]})
    assert "only be filtered" in errs({"links": [{"source": "c1", "target": "d1", "effect": "highlight"}]})
    assert "linked to itself" in errs({"links": [{"source": "c1", "target": "c1"}]})
    assert "aren't available" in errs({"links": [{"source": "c1", "target": "t1", "effect": "drill"}]})
    assert "only links starting at c1" in errs({"links": [{"source": "t1", "target": "h1"}]}, focus="c1")
    assert "can pick by Region, Qty" in errs({"links": [], "selectBy": {"t1": "Date"}})
