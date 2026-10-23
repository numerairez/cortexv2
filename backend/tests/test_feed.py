"""Data feed sources: fetched by code, snapshotted to CSV, usable like any table."""

import types

import pandas as pd
import pytest

from app.connectors import feeds


@pytest.fixture()
def sales_feed(monkeypatch):
    """Register a fake 'sales' feed module next to the real ones."""
    mod = types.ModuleType("sales")
    mod.NAME, mod.DESCRIPTION, mod.calls = "Sales DB", "Monthly sales", []

    def fetch(params):
        mod.calls.append(params)
        return pd.DataFrame({"Region": ["N", "S"], "Sales": [10, 20 * len(mod.calls)]})

    mod.fetch = fetch
    real = feeds.available
    monkeypatch.setattr(feeds, "available", lambda: [*real(), feeds.Feed("sales", mod.NAME, mod.DESCRIPTION, mod)])
    return mod


def test_feeds_are_discovered_with_their_names(client, sales_feed):
    listed = {f["id"]: f for f in client.get("/api/feeds").json()}
    assert listed["example"]["name"] == "Example feed" and not listed["example"]["error"]
    assert listed["sales"] == {"id": "sales", "name": "Sales DB", "description": "Monthly sales", "error": None}


def test_feed_source_adds_refreshes_and_reports_errors(client, sales_feed, monkeypatch):
    r = client.post("/api/sources/feed", json={"feed": "sales", "params": {"month": "2026-09"}})
    assert r.status_code == 200, r.text
    src = r.json()
    assert src["kind"] == "feed" and src["name"] == "Sales DB" and src["metadata"]["feed"] == "sales"
    assert src["metadata"]["rows"] == 2 and not src["is_copy"]
    assert sales_feed.calls == [{"month": "2026-09"}]

    sels = client.get("/api/selections", params={"source_id": src["id"]}).json()
    assert len(sels) == 1 and [c["name"] for c in sels[0]["schema"]] == ["Region", "Sales"]
    assert client.get(f"/api/selections/{sels[0]['id']}/check").json()["status"] == "ok"

    # Refresh re-runs the same feed with the saved params; new data -> "changed".
    again = client.post(f"/api/sources/{src['id']}/refresh").json()
    assert again["status"] == "changed" and sales_feed.calls[-1] == {"month": "2026-09"}

    def broken(params):
        raise feeds.FeedError("Service unavailable")

    monkeypatch.setattr(sales_feed, "fetch", broken)
    failed = client.post(f"/api/sources/{src['id']}/refresh").json()
    assert failed["status"] == "error" and failed["status_detail"] == "Service unavailable"
    # The last good snapshot is still readable.
    prof = client.post(f"/api/sources/{src['id']}/profile", json={"sheet": "(csv)", "header_row": 1}).json()
    assert prof["row_count"] == 2

    assert client.post(f"/api/sources/{src['id']}/relocate", json={"path": "/x.csv"}).status_code == 400
    # A fetch that fails while adding is reported and nothing is saved.
    assert client.post("/api/sources/feed", json={"feed": "sales"}).status_code == 400
    assert client.post("/api/sources/feed", json={"feed": "nope"}).status_code == 400


def test_custom_source_name(client, sales_feed):
    src = client.post("/api/sources/feed", json={"feed": "sales", "name": "Sales – North"}).json()
    assert src["name"] == "Sales – North"


def test_broken_feed_module_is_listed_not_fatal(tmp_path, monkeypatch):
    (tmp_path / "broken.py").write_text("import not_installed_here\n")
    monkeypatch.setattr(feeds, "__path__", [*feeds.__path__, str(tmp_path)])
    broken = next(f for f in feeds.available() if f.id == "broken")
    assert "ModuleNotFoundError" in broken.error
    with pytest.raises(feeds.FeedError):
        feeds.get("broken")
