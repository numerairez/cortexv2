"""Create demo files in ./samples: monthly sales workbooks (header on row 5), a product list, and policy docs."""

import datetime as dt
import random
from pathlib import Path

from openpyxl import Workbook

OUT = Path(__file__).resolve().parents[1] / "samples"
REGIONS = ["Luzon", "Visayas", "Mindanao"]
PRODUCTS = [("P1", "Hardware", "Bolt", 10.0), ("P2", "Tools", "Wrench", 25.5), ("P3", "Tools", "Hammer", 18.0),
            ("P4", "Paint", "Primer", 32.0)]


def sales(month: int, n: int, seed: int) -> Path:
    rnd = random.Random(seed)
    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append([f"Branch Sales Report — 2026-{month:02d}"])
    ws.append(["Prepared by Finance Operations"])
    ws.append([])
    ws.append([])
    ws.append(["Txn ID", "Date", "Region", "Product ID", "Qty", "Unit Price"])
    for i in range(n):
        pid, _, _, price = rnd.choice(PRODUCTS)
        ws.append([month * 1000 + i, dt.datetime(2026, month, rnd.randint(1, 28)), rnd.choice(REGIONS), pid,
                   rnd.randint(1, 12), price])
    notes = wb.create_sheet("Notes")
    notes.append(["Figures are unaudited."])
    p = OUT / f"sales_2026_{month:02d}.xlsx"
    wb.save(p)
    return p


DEMO_MACRO = r'''Option Explicit

' Builds the monthly regional revenue summary.
Sub BuildMonthlySummary()
    Dim ws As Worksheet, prod As Workbook, lastRow As Long, r As Long
    Application.ScreenUpdating = False
    Set ws = ThisWorkbook.Sheets("Sales")
    Set prod = Workbooks.Open("S:\Finance\Master Data\products.xlsx")

    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row
    ws.Range("G5").Value = "Category"
    ws.Range("H5").Value = "Revenue"
    For r = 6 To lastRow
        ' look up the product category from the master list
        ws.Cells(r, "G").Value = Application.WorksheetFunction.VLookup(ws.Cells(r, "D").Value, _
            prod.Sheets("Products").Range("A:B"), 2, False)
        ws.Cells(r, "H").Value = ws.Cells(r, "E").Value * ws.Cells(r, "F").Value
    Next r
    prod.Close SaveChanges:=False

    ' drop Mindanao rows, they are reported separately
    For r = lastRow To 6 Step -1
        If ws.Cells(r, "C").Value = "Mindanao" Then ws.Rows(r).Delete
    Next r

    Call SummariseByRegion
    Call EmailSummary
    Application.ScreenUpdating = True
End Sub

Private Sub SummariseByRegion()
    Dim out As Worksheet
    Set out = ThisWorkbook.Sheets("Summary")
    out.Cells.Clear
    out.Range("A1:C1").Value = Array("Region", "Category", "Revenue")
    ' (pivot of Sales!C:H by Region and Category, summing Revenue)
    ThisWorkbook.Sheets("Sales").Range("A5").CurrentRegion.Copy
    out.Range("A1").Font.Bold = True
End Sub

Private Sub EmailSummary()
    Dim ol As Object
    Set ol = CreateObject("Outlook.Application")
    MsgBox "Summary emailed to the regional managers"
End Sub
'''


def macro_workbook() -> Path:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from vbafixture import make_xlsm

    rnd = random.Random(7)
    rows = [["Branch Sales Report — macro edition"], ["Run BuildMonthlySummary from the Developer tab"], [], [],
            ["Txn ID", "Date", "Region", "Product ID", "Qty", "Unit Price"]]
    for i in range(60):
        pid, _, _, price = rnd.choice(PRODUCTS)
        rows.append([5000 + i, dt.datetime(2026, 3, rnd.randint(1, 28)), rnd.choice(REGIONS), pid, rnd.randint(1, 9), price])
    return make_xlsm(OUT / "monthly_summary_macro.xlsm", {"Sales": rows, "Summary": [["Region", "Category", "Revenue"]]},
                     {"Reports": DEMO_MACRO})


def main() -> None:
    OUT.mkdir(exist_ok=True)
    sales(1, 120, 1)
    sales(2, 95, 2)
    wb = Workbook()
    ws = wb.active
    ws.title = "Products"
    ws.append(["ID", "Category", "Name", "List Price"])
    for p in PRODUCTS:
        ws.append(list(p))
    wb.save(OUT / "products.xlsx")
    (OUT / "refund_policy.md").write_text(
        "# Refund policy\n\nCustomers may request a refund within 30 days of purchase with a receipt.\n\n"
        "## Approvals\n\nRefunds above PHP 5,000 require branch manager approval.\n\n"
        "## Exceptions\n\nSale and clearance items are final and cannot be refunded.\n", encoding="utf-8")
    (OUT / "branch_faq.txt").write_text(
        "Q: How long do refunds take?\nA: Approved refunds are credited within 5 business days.\n\n"
        "Q: Who approves large refunds?\nA: The area manager approves refunds above PHP 10,000.\n", encoding="utf-8")
    macro_workbook()
    print(f"Sample files written to {OUT}")


if __name__ == "__main__":
    main()
