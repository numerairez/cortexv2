from app.connectors import tabular
from app.transformations import export


def test_preview_uses_physical_excel_rows(files):
    p = tabular.preview_rows(files["jan"], "Sales", 10)
    assert [r["row"] for r in p["rows"]][:6] == [1, 2, 3, 4, 5, 6]
    assert p["rows"][4]["cells"][0] == "Txn ID"
    assert p["suggested_header_row"] == 5


def test_load_with_header_on_row_5(files):
    t = tabular.load_table(files["jan"], "Sales", header_row=5)
    assert list(t.df.columns) == ["Txn ID", "Date", "Region", "Product ID", "Qty", "Unit Price", "Note"]
    assert len(t.df) == 5
    assert t.first_data_row == 6
    types = {c["name"]: c["type"] for c in tabular.schema_of(t.df)}
    assert types["Txn ID"] == "integer" and types["Date"] == "date" and types["Unit Price"] == "number"


def test_wrong_header_row_produces_different_schema(files):
    t = tabular.load_table(files["jan"], "Sales", header_row=1)
    assert "Txn ID" not in t.df.columns
    drift = tabular.schema_drift(tabular.schema_of(tabular.load_table(files["jan"], "Sales", 5).df),
                                 tabular.schema_of(t.df))
    assert drift and "Txn ID" in drift["missing"]


def test_csv_single_sheet(files):
    assert tabular.list_sheets(files["csv"]) == [tabular.CSV_SHEET]
    t = tabular.load_table(files["csv"], tabular.CSV_SHEET, 1)
    assert list(t.df["Region"]) == ["Luzon", "Visayas"]


def test_xlsx_export_never_writes_formulas(files, tmp_path):
    from openpyxl import load_workbook

    t = tabular.load_table(files["jan"], "Sales", 5)
    out = tmp_path / "out.xlsx"
    export.write_xlsx(t.df, out, [("Note", "=1+1")])
    ws = load_workbook(out)["Result"]
    cells = [c for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith("=")]
    assert cells and all(c.data_type == "s" for c in cells)


def test_csv_export_escapes_formula_text(files, tmp_path):
    t = tabular.load_table(files["jan"], "Sales", 5)
    out = tmp_path / "out.csv"
    export.write_csv(t.df, out)
    text = out.read_text(encoding="utf-8-sig")
    assert "'=HYPERLINK" in text
    assert ",=HYPERLINK" not in text


def test_column_values_match_per_value_conversion():
    import datetime as dt
    import math

    import pandas as pd

    df = tabular.normalise_types(pd.DataFrame({
        "when": [dt.datetime(2024, 1, 5), None, dt.datetime(2024, 2, 1, 9, 30)],
        "precise": [dt.datetime(2024, 1, 5, 0, 0, 0, 1500), dt.datetime(2024, 1, 6), None],
        "n": [1, None, 3],
        "x": [1.5, float("inf"), None],
        "flag": [True, None, False],
        "name": ["a", None, "c"],
    }, dtype=object))
    for col in df.columns:
        expected = [tabular.to_json_value(v) for v in df[col]]
        expected = [None if isinstance(v, float) and math.isinf(v) else v for v in expected]
        assert tabular.column_values(df[col]) == expected, col
    assert tabular.column_values(df["n"], limit=1) == [1]
