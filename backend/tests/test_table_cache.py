"""The parsed-table cache: hits skip the reader, edits miss, damaged entries are re-read."""

from app import config
from app.connectors import documents, tabular
from app.core import table_cache


def _load(path, columns=None):
    return table_cache.load_table(path, "Sales", 5, columns, documents.fingerprint_file(path)["sha256"])


def test_second_load_comes_from_cache(data_dir, files, monkeypatch):
    first = _load(files["jan"])
    assert len(list(config.get_paths().table_cache.glob("*.pkl"))) == 1

    def boom(*a, **k):
        raise AssertionError("the file should not be read again")
    monkeypatch.setattr(tabular, "load_table", boom)
    again = _load(files["jan"])
    assert again.df.equals(first.df) and again.letters == first.letters and again.warnings == first.warnings

    # A column subset is applied to the cached full table, not cached separately.
    sub = _load(files["jan"], ["Region"])
    assert list(sub.df.columns) == ["Region"] and set(sub.letters) == {"Region"}


def test_changed_file_is_read_again(data_dir, files):
    from openpyxl import load_workbook

    before = _load(files["jan"])
    wb = load_workbook(files["jan"])
    ws = wb["Sales"]
    ws.append([5, None, "Mindanao", "P1", 7, 10.0, None])
    wb.save(files["jan"])
    after = _load(files["jan"])
    assert len(after.df) == len(before.df) + 1


def test_damaged_entry_is_replaced(data_dir, files):
    expected = _load(files["jan"])
    (entry,) = config.get_paths().table_cache.glob("*.pkl")
    entry.write_bytes(b"not a pickle")
    assert _load(files["jan"]).df.equals(expected.df)
    assert entry.read_bytes() != b"not a pickle"


def test_missing_selected_column_still_errors(data_dir, files):
    import pytest

    with pytest.raises(tabular.TabularError, match="no longer present"):
        _load(files["jan"], ["Nope"])
