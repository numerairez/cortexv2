import pandas as pd
import pytest

from app.connectors import tabular
from app.transformations import executor, expressions
from app.transformations.recipe import Recipe


def tables(files):
    return {
        "sales": tabular.load_table(files["jan"], "Sales", 5).df,
        "feb": tabular.load_table(files["feb"], "Sales", 5).df,
        "products": tabular.load_table(files["products"], "Products", 1).df,
        "dup_products": tabular.load_table(files["dup_products"], "Products", 1).df,
    }


def recipe(steps, base="sales", roles=("sales", "feb", "products", "dup_products")):
    return Recipe.model_validate({"inputs": [{"role": r} for r in roles], "base": base, "steps": steps})


def test_join_filter_aggregate_golden(files):
    r = recipe([
        {"op": "append_rows", "inputs": ["feb"]},
        {"op": "deduplicate", "columns": ["Txn ID"]},
        {"op": "join", "right": "products", "left_on": ["Product ID"], "right_on": ["ID"], "how": "left",
         "expected": "many_to_one", "right_columns": ["Category"]},
        {"op": "derive_column", "name": "Revenue", "expression": "[Qty] * [Unit Price]"},
        {"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "luzon"}]},
        {"op": "group_aggregate", "group_by": ["Category"],
         "aggregations": [{"column": "Revenue", "function": "sum", "as": "Revenue"},
                          {"column": "Txn ID", "function": "count", "as": "Transactions"}]},
    ])
    res = executor.execute(r, tables(files))
    got = dict(zip(res.df["Category"], res.df["Revenue"]))
    # Luzon: P1 2*10 + P2 3*25.5 (deduplicated) + Feb P1 10*10
    assert got == {"Hardware": 120.0, "Tools": 76.5}
    join = res.steps[2]
    assert join.details["unmatched_left"] == 1  # P9 has no product
    assert any("no match" in w for w in join.warnings)
    assert res.steps[1].details["removed_rows"] == 1


def test_join_detects_row_multiplication(files):
    r = recipe([{"op": "join", "right": "dup_products", "left_on": ["Product ID"], "right_on": ["ID"]}])
    with pytest.raises(executor.StepError) as e:
        executor.execute(r, tables(files))
    assert e.value.step_index == 0 and "multiply" in e.value.message


def test_join_key_type_mismatch(files):
    r = recipe([{"op": "join", "right": "products", "left_on": ["Txn ID"], "right_on": ["ID"]}])
    with pytest.raises(executor.StepError, match="Key types differ"):
        executor.execute(r, tables(files))


def test_append_schema_mismatch_is_reported(files):
    r = recipe([{"op": "append_rows", "inputs": ["products"]}])
    with pytest.raises(executor.StepError, match="different columns"):
        executor.execute(r, tables(files))


def test_unknown_column_message(files):
    r = recipe([{"op": "select_columns", "columns": ["Nope"]}])
    with pytest.raises(executor.StepError, match="not found: Nope"):
        executor.execute(r, tables(files))


def test_convert_types_reports_failures():
    df = pd.DataFrame({"Amount": ["1,000", "(50)", "abc", None]}, dtype=object)
    r = Recipe.model_validate({"inputs": [{"role": "t"}], "base": "t", "steps": [
        {"op": "convert_types", "conversions": [{"column": "Amount", "to": "number"}]}]})
    res = executor.execute(r, {"t": df})
    assert list(res.df["Amount"].iloc[:2]) == [1000.0, -50.0]
    assert res.steps[0].details["failed_conversions"] == {"Amount": 1}


def test_pivot_and_unpivot(files):
    t = tables(files)
    r = recipe([
        {"op": "derive_column", "name": "Month", "expression": "month([Date])"},
        {"op": "pivot", "index": ["Region"], "columns": "Month", "values": "Qty", "function": "sum"},
    ])
    res = executor.execute(r, t)
    assert list(res.df.columns) == ["Region", "1"]
    bad = recipe([{"op": "pivot", "index": ["Region"], "columns": "Region", "values": "Qty"}])
    with pytest.raises(executor.StepError, match="must all be different"):
        executor.execute(bad, t)
    r2 = recipe([{"op": "select_columns", "columns": ["Txn ID", "Qty", "Unit Price"]},
                 {"op": "unpivot", "id_columns": ["Txn ID"]}])
    assert len(executor.execute(r2, t).df) == 10


@pytest.mark.parametrize("bad", [
    "__import__('os').system('x')",
    "[Qty].__class__",
    "open('x')",
    "(lambda: 1)()",
    "[Qty] ** 2",
    "[a][0]",
])
def test_expressions_reject_unsafe_code(bad):
    with pytest.raises(expressions.ExpressionError):
        expressions.compile_expression(bad)


def test_expression_functions():
    df = pd.DataFrame({"A": [1, 2, None], "B": ["x", "y", "z"]})
    assert list(expressions.evaluate("if([A] > 1, 'big', 'small')", df)) == ["small", "big", "small"]
    assert list(expressions.evaluate("concat(upper([B]), '-', [A])", df))[0] == "X-1.0"
    assert expressions.evaluate("[A] / 0", df).isna().all()


def test_recipe_rejects_unknown_operations():
    with pytest.raises(Exception):
        Recipe.model_validate({"inputs": [{"role": "a"}], "base": "a", "steps": [{"op": "python", "code": "x"}]})


def test_expressions_accept_spreadsheet_habits():
    df = pd.DataFrame({"Region": ["Luzon", "Visayas"], "Qty": [1, 5]})
    assert list(expressions.evaluate("IF([Region] = 'Luzon' AND [Qty] <> 2, 'yes', 'no')", df)) == ["yes", "no"]
    # Operators inside quoted text are left alone.
    assert list(expressions.evaluate("concat([Region], ' = x')", df))[0] == "Luzon = x"


def test_same_data_twice_with_branches(files):
    """The same file bound to two inputs, prepared differently, then combined."""
    t = tables(files)
    t["luzon"] = t["sales"]
    t["visayas"] = t["sales"]
    by_product = {"op": "group_aggregate", "group_by": ["Product ID"], "aggregations": [{"column": "Qty", "function": "sum", "as": "Qty"}]}
    r = Recipe.model_validate({
        "inputs": [{"role": "luzon"},
                   {"role": "visayas", "steps": [
                       {"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Visayas"}]},
                       by_product,
                       {"op": "rename_columns", "mapping": {"Qty": "Visayas Qty"}}]}],
        "base": "luzon",
        "steps": [
            {"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Luzon"}]},
            by_product,
            {"op": "join", "right": "visayas", "left_on": ["Product ID"], "right_on": ["Product ID"], "how": "outer",
             "expected": "one_to_one"}],
    })
    res = executor.execute(r, t)
    got = {row["Product ID"]: (row["Qty"], row["Visayas Qty"]) for row in res.df.to_dict("records")}
    assert got["P1"][0] == 2 and pd.isna(got["P1"][1])
    assert got["P2"][0] == 6 and got["P2"][1] == 1          # Luzon P2: 3+3 (duplicate rows), Visayas P2: 1
    assert [s.op for s in res.branches["visayas"]] == ["filter_rows", "group_aggregate", "rename_columns"]
    # Peek at the branch after its first step
    mid = executor.execute(r, t, branch_stop=("visayas", 0)).df
    assert set(mid["Region"]) == {"Visayas"}


def test_branch_errors_and_rules(files):
    t = tables(files)
    r = Recipe.model_validate({"inputs": [{"role": "sales"}, {"role": "feb", "steps": [{"op": "select_columns", "columns": ["Nope"]}]}],
                               "base": "sales"})
    with pytest.raises(executor.StepError) as e:
        executor.execute(r, t)
    assert e.value.branch == "feb" and e.value.step_index == 0
    loop = {"inputs": [{"role": "a"}, {"role": "b", "steps": [{"op": "append_rows", "inputs": ["c"]}]},
                       {"role": "c", "steps": [{"op": "append_rows", "inputs": ["b"]}]}], "base": "a"}
    with pytest.raises(Exception, match="loop"):
        Recipe.model_validate(loop)
    with pytest.raises(Exception, match="itself"):
        Recipe.model_validate({"inputs": [{"role": "a"}, {"role": "b", "steps": [{"op": "append_rows", "inputs": ["b"]}]}], "base": "a"})
    with pytest.raises(Exception, match="starting input"):
        Recipe.model_validate({"inputs": [{"role": "a", "steps": [{"op": "sort_rows", "keys": [{"column": "x"}]}]}], "base": "a"})


def test_groups_are_validated_and_do_not_change_results(files):
    t = tables(files)
    steps = [{"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Luzon"}]},
             {"op": "select_columns", "columns": ["Txn ID", "Qty"]},
             {"op": "sort_rows", "keys": [{"column": "Qty"}]}]
    base = {"inputs": [{"role": "sales"}], "base": "sales", "steps": steps}
    plain = executor.execute(Recipe.model_validate(base), t).df
    grouped = Recipe.model_validate({**base, "groups": [{"id": "g1", "name": "Clean-up", "start": 0, "end": 1}]})
    assert executor.execute(grouped, t).df.equals(plain)
    for bad, msg in [([{"id": "g", "name": "x", "start": 1, "end": 5}], "don't exist"),
                     ([{"id": "a", "name": "A", "start": 0, "end": 1}, {"id": "b", "name": "B", "start": 1, "end": 2}], "overlap"),
                     ([{"id": "a", "name": "A", "start": 0, "end": 0, "inputs": ["nope"]}], "unknown input")]:
        with pytest.raises(Exception, match=msg):
            Recipe.model_validate({**base, "groups": bad})


def test_filter_defaults_keep_everything_and_ranges():
    df = pd.DataFrame({"Region": ["Luzon", "Visayas", None, "Mindanao"], "Qty": [1, 5, 10, None]})
    t = {"t": df}

    def run(conditions, match="all"):
        r = Recipe.model_validate({"inputs": [{"role": "t"}], "base": "t",
                                   "steps": [{"op": "filter_rows", "match": match, "conditions": conditions}]})
        return executor.execute(r, t).df

    # A fresh filter (no conditions, empty exclusion list, open range) keeps every row, blanks included.
    assert len(run([])) == 4
    assert len(run([{"column": "Region", "operator": "not_in", "value": []}])) == 4
    assert len(run([{"column": "Qty", "operator": "between", "value": [None, None]}])) == 4
    assert run([{"column": "Qty", "operator": "between", "value": [2, None]}])["Qty"].tolist() == [5, 10]
    assert run([{"column": "Qty", "operator": "between", "value": [None, 5]}])["Qty"].tolist() == [1, 5]
    # None in a picked list stands for blanks.
    assert run([{"column": "Region", "operator": "not_in", "value": [None, "Visayas"]}])["Region"].tolist() == ["Luzon", "Mindanao"]
    assert len(run([{"column": "Region", "operator": "in", "value": [None]}])) == 1
    assert run([{"column": "Qty", "operator": "between", "value": [2, None], "keep_blanks": True}])["Qty"].tolist()[:2] == [5, 10]
    assert len(run([{"column": "Qty", "operator": "between", "value": [2, None], "keep_blanks": True}])) == 3


@pytest.mark.parametrize("step", [
    {"op": "join", "right": "", "left_on": [""], "right_on": [""]},
    {"op": "join", "right": "t", "left_on": [""], "right_on": [""]},
    {"op": "append_rows", "inputs": []},
    {"op": "derive_column", "name": "New column", "expression": ""},
    {"op": "pivot", "index": [], "columns": "", "values": ""},
    {"op": "convert_types", "conversions": []},
    {"op": "group_aggregate", "group_by": [], "aggregations": []},
])
def test_untouched_steps_pass_data_through(step):
    df = pd.DataFrame({"A": ["x", "y"], "B": [1, 2]})
    r = Recipe.model_validate({"inputs": [{"role": "t"}], "base": "t", "steps": [step]})
    res = executor.execute(r, {"t": df})
    assert res.df.equals(df)


def test_inputs_merge_before_the_main_flow_and_extra_outputs(files):
    """Two starting points merge on a side row (listed before the input it needs), then join the main flow;
    extra outputs are taken part-way through."""
    t = tables(files)
    r = Recipe.model_validate({
        "inputs": [{"role": "sales"},
                   {"role": "both_months", "steps": [{"op": "append_rows", "inputs": ["feb"]},
                                                     {"op": "group_aggregate", "group_by": ["Product ID"],
                                                      "aggregations": [{"column": "Qty", "function": "sum", "as": "Qty"}]}]},
                   {"role": "feb", "steps": [{"op": "filter_rows", "conditions": [{"column": "Region", "operator": "eq", "value": "Luzon"}]}]},
                   {"role": "products"}],
        "base": "products",
        "steps": [{"op": "join", "right": "both_months", "left_on": ["ID"], "right_on": ["Product ID"], "how": "left",
                   "expected": "one_to_one"},
                  {"op": "select_columns", "columns": ["ID", "Qty"]}],
        "extra_outputs": [{"id": "o1", "name": "monthly", "branch": "both_months", "after": 0},
                          {"id": "o2", "name": "joined", "after": 0},
                          {"id": "o3", "name": "raw feb", "branch": "feb", "after": -1}],
    })
    t["both_months"] = t["sales"]
    assert r.branch_order() == ["feb", "both_months"]
    res = executor.execute(r, t, taps=[(o.branch, o.after) for o in r.extra_outputs])
    # Jan (5 rows) + the Luzon rows of Feb (1)
    assert len(res.taps[("both_months", 0)]) == 6
    assert dict(zip(res.df["ID"], res.df["Qty"])) == {"P1": 12, "P2": 7}
    assert "Category" in res.taps[(None, 0)].columns and len(res.taps[("feb", -1)]) == 2
    with pytest.raises(Exception, match="doesn't exist"):
        Recipe.model_validate({"inputs": [{"role": "a"}], "base": "a",
                               "extra_outputs": [{"id": "x", "name": "x", "after": 3}]})
