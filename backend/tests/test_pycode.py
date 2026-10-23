"""Python script analysis and script → workflow translation."""

import json

import pytest

from app.connectors import pycode, vba

SCRIPT = '''import os
import smtplib
import pandas as pd

BASE = r"C:\\Shared\\Finance"
# old version used "archive_2019.xlsx"


def load():
    sales = pd.read_excel("monthly report.xlsx", sheet_name="Sales", header=4)
    products = pd.read_csv(BASE + "\\\\products.csv")
    return sales, products


def main(month):
    sales, products = load()
    extra = pd.read_csv(f"extra_{month}.csv")
    out = sales.merge(products, on="Product ID").groupby("Category")["Qty"].sum()
    out.to_excel("summary.xlsx")
    for f in os.listdir("inbox"):
        os.remove(f)
    smtplib.SMTP("mail").sendmail("a", "b", "done")
    items = [1, 2]
    items.remove(1)


if __name__ == "__main__":
    main(input("Month? "))
'''


def test_analyse_script():
    r = pycode.load(code=SCRIPT, name="report.py")
    mod = r["modules"][0]
    assert [p["name"] for p in mod["procedures"]] == ["load", "main"]
    deps = {(d["kind"], d["reference"]) for d in r["dependencies"]}
    assert ("external_file", "monthly report.xlsx") in deps
    assert ("external_file", "C:\\Shared\\Finance\\products.csv") in deps     # constants are followed
    assert ("dynamic_file", "f'extra_{month}.csv'") in deps
    assert ("folder", "inbox") in deps
    assert ("user_picks_file", "File or value chosen by the user when the script runs") in deps
    assert not any("archive_2019" in d["reference"] for d in r["dependencies"])   # comments ignored
    assert not any(d["reference"] == "summary.xlsx" for d in r["dependencies"])   # output, not input
    sales = next(d for d in r["dependencies"] if d["reference"] == "monthly report.xlsx")
    assert sales["sheets"] == ["Sales"] and sales["lines"] == ["report.py:10"]
    actions = {a["action"]: a["lines"] for a in r["actions"]}
    assert "Sends email" in actions and "Saves results to files" in actions
    assert actions["Deletes, copies or moves files"] == ["report.py:21"]          # list.remove() is not flagged


def test_notebook_and_errors(tmp_path):
    nb = {"cells": [{"cell_type": "markdown", "source": ["# Title"]},
                    {"cell_type": "code", "source": ["%matplotlib inline\n", "import pandas as pd\n", "df = pd.read_csv('a.csv')"]}]}
    path = tmp_path / "analysis.ipynb"
    path.write_text(json.dumps(nb))
    r = pycode.load(path)
    assert r["modules"][0]["name"] == "analysis.ipynb"
    assert "# %matplotlib inline" in r["modules"][0]["code"]
    assert r["dependencies"][0]["reference"] == "a.csv"
    with pytest.raises(vba.VBAError, match="not valid Python"):
        pycode.load(code="def broken(:\n  pass")


def test_python_to_workflow_end_to_end(client, files):
    a = client.post("/api/macros/analyse", json={"code": SCRIPT, "name": "report.py", "language": "python"}).json()
    assert a["modules"][0]["name"] == "report.py"
    prod = client.post("/api/sources", json={"path": str(files["products"])}).json()
    s_prod = client.post("/api/selections", json={"source_id": prod["id"], "label": "Products", "sheet": "Products", "header_row": 1}).json()
    deps = [{**d, "role": "products" if d["reference"].endswith("products.csv") else None,
             "ignored": not d["reference"].endswith("products.csv")} for d in a["dependencies"]]
    run = client.post("/api/runs", json={
        "service_id": "python_to_workflow", "bindings": {"products": s_prod["id"]},
        "options": {"macro_name": "main", "entry": "main", "modules": a["modules"], "dependencies": deps,
                    "actions": a["actions"]}}).json()
    prompt = run["state"]["prompt"]
    assert "Python data script" in prompt and "main function" in prompt
    assert "Python file report.py" in prompt and "VBA" not in prompt
    assert "  10:     sales = pd.read_excel" in prompt

    reply = {"recipe": {"inputs": [{"role": "products"}], "base": "products",
                        "steps": [{"op": "group_aggregate", "group_by": ["Category"], "aggregations": [{"column": "ID", "function": "count", "as": "n"}]}]},
             "step_notes": [{"step": 1, "macro_lines": "report.py:18", "explanation": "Sums per category"}]}
    done = client.post(f"/api/runs/{run['id']}/response", json={"text": json.dumps(reply)}).json()
    assert done["status"] == "completed", done
    assert done["state"]["recipe"]["steps"][0]["note"].startswith("From code report.py:18")
    assert done["state"]["recipe"]["groups"][0]["source"]["language"] == "python"
