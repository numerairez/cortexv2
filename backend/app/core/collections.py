"""Context Collections: named, ordered, reusable sets of Source Selections."""

from __future__ import annotations

from ..storage import db
from . import sources
from .sources import SourceError


def _items(collection_id: str) -> list[dict]:
    rows = db.query(
        "SELECT ci.position, ci.included, s.id AS selection_id, s.kind, s.label, s.config, s.schema, s.deleted_at, "
        "src.id AS source_id, src.name AS source_name, src.kind AS source_kind, src.location, src.status AS source_status "
        "FROM collection_items ci JOIN selections s ON s.id = ci.selection_id "
        "JOIN sources src ON src.id = s.source_id "
        "WHERE ci.collection_id = ? ORDER BY ci.position",
        (collection_id,),
    )
    for r in rows:
        r["included"] = bool(r["included"])
        r["config"] = db.loads(r["config"], {})
        r["schema"] = db.loads(r["schema"], None)
        r["removed"] = r.pop("deleted_at") is not None
    return rows


def get_collection(collection_id: str) -> dict:
    row = db.query_one("SELECT * FROM collections WHERE id = ? AND deleted_at IS NULL", (collection_id,))
    if not row:
        raise SourceError("Collection not found", 404)
    row["items"] = _items(collection_id)
    return row


def list_collections() -> list[dict]:
    rows = db.query("SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    counts = {r["collection_id"]: r["n"] for r in db.query(
        "SELECT collection_id, COUNT(*) n FROM collection_items GROUP BY collection_id")}
    for r in rows:
        r["item_count"] = counts.get(r["id"], 0)
    return rows


def save_collection(collection_id: str | None, name: str, description: str, items: list[dict]) -> dict:
    """Create or fully replace a collection. ``items`` = [{selection_id, included}] in order."""
    if not name.strip():
        raise SourceError("Give the collection a name")
    seen = set()
    for it in items:
        if it["selection_id"] in seen:
            raise SourceError("A selection can only appear once in a collection")
        seen.add(it["selection_id"])
        sources.get_selection(it["selection_id"])
    ts = db.now()
    with db.tx() as c:
        if collection_id:
            if not c.execute("SELECT 1 FROM collections WHERE id = ? AND deleted_at IS NULL", (collection_id,)).fetchone():
                raise SourceError("Collection not found", 404)
            c.execute("UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                      (name.strip(), description, ts, collection_id))
            c.execute("DELETE FROM collection_items WHERE collection_id = ?", (collection_id,))
        else:
            collection_id = db.new_id("col")
            c.execute("INSERT INTO collections (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                      (collection_id, name.strip(), description, ts, ts))
        for pos, it in enumerate(items):
            c.execute("INSERT INTO collection_items (collection_id, selection_id, position, included) VALUES (?, ?, ?, ?)",
                      (collection_id, it["selection_id"], pos, 1 if it.get("included", True) else 0))
    return get_collection(collection_id)


def delete_collection(collection_id: str) -> None:
    get_collection(collection_id)
    db.execute("UPDATE collections SET deleted_at = ? WHERE id = ?", (db.now(), collection_id))


def check_collection(collection_id: str) -> dict:
    """Refresh every source in the collection and report problems per item."""
    col = get_collection(collection_id)
    refreshed: set[str] = set()
    results = []
    for it in col["items"]:
        if it["removed"]:
            results.append({"selection_id": it["selection_id"], "status": "removed",
                            "detail": "This selection was deleted from its source"})
            continue
        if it["source_id"] not in refreshed:
            sources.refresh_source(it["source_id"])
            refreshed.add(it["source_id"])
        src = sources.get_source(it["source_id"])
        res = sources.check_selection(it["selection_id"])
        if res["status"] == "ok" and src["status"] == "changed":
            res.update(status="changed", detail=src["status_detail"])
        results.append(res)
    return {"collection_id": collection_id, "items": results,
            "ok": all(r["status"] in ("ok", "changed") for r in results)}
