"""Saved transformation recipes. Each save creates a new immutable version."""

from __future__ import annotations

from ..storage import db
from ..transformations.recipe import Recipe
from .sources import SourceError


def list_recipes() -> list[dict]:
    rows = db.query(
        "SELECT r.*, v.version AS latest_version, v.definition, v.origin, "
        "(SELECT MAX(version) FROM recipe_versions x WHERE x.recipe_id = r.id) AS max_version "
        "FROM recipes r JOIN recipe_versions v ON v.recipe_id = r.id "
        "AND v.version = (SELECT MAX(version) FROM recipe_versions x WHERE x.recipe_id = r.id) "
        "WHERE r.deleted_at IS NULL ORDER BY r.updated_at DESC")
    last_runs = {r["recipe_id"]: r for r in db.query(
        "SELECT v.recipe_id, r.id, r.status, r.created_at, r.summary FROM runs r "
        "JOIN recipe_versions v ON v.id = r.recipe_version_id "
        "WHERE r.created_at = (SELECT MAX(r2.created_at) FROM runs r2 JOIN recipe_versions v2 "
        "ON v2.id = r2.recipe_version_id WHERE v2.recipe_id = v.recipe_id)")}
    for r in rows:
        d = db.loads(r.pop("definition"), {})
        r.pop("max_version", None)
        r["inputs"] = [i["role"] for i in d.get("inputs", [])]
        r["ops"] = [s["op"] for s in d.get("steps", [])]
        lr = last_runs.get(r["id"])
        r["last_run"] = {"id": lr["id"], "status": lr["status"], "at": lr["created_at"],
                         "rows": db.loads(lr["summary"], {}).get("output_rows")} if lr else None
    return rows


def get_recipe(recipe_id: str, version: int | None = None) -> dict:
    r = db.query_one("SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL", (recipe_id,))
    if not r:
        raise SourceError("Recipe not found", 404)
    if version is None:
        v = db.query_one("SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC LIMIT 1", (recipe_id,))
    else:
        v = db.query_one("SELECT * FROM recipe_versions WHERE recipe_id = ? AND version = ?", (recipe_id, version))
    if not v:
        raise SourceError("Recipe version not found", 404)
    r["version"] = db.decode(v, "definition")
    r["versions"] = db.query(
        "SELECT id, version, origin, created_at FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC",
        (recipe_id,))
    last = db.query_one(
        "SELECT r.config FROM runs r JOIN recipe_versions v ON v.id = r.recipe_version_id "
        "WHERE v.recipe_id = ? ORDER BY r.created_at DESC LIMIT 1", (recipe_id,))
    r["last_bindings"] = (db.loads(last["config"], {}) or {}).get("bindings", {}) if last else {}
    return r


def save_recipe(recipe_id: str | None, name: str, description: str, definition: Recipe, origin: str = "manual") -> dict:
    if not name.strip():
        raise SourceError("Give the recipe a name")
    ts = db.now()
    body = definition.model_dump(mode="json", by_alias=True, exclude_none=True)
    with db.tx() as c:
        if recipe_id:
            if not c.execute("SELECT 1 FROM recipes WHERE id = ? AND deleted_at IS NULL", (recipe_id,)).fetchone():
                raise SourceError("Recipe not found", 404)
            c.execute("UPDATE recipes SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                      (name.strip(), description, ts, recipe_id))
            version = c.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM recipe_versions WHERE recipe_id = ?",
                                (recipe_id,)).fetchone()[0]
        else:
            recipe_id = db.new_id("rcp")
            c.execute("INSERT INTO recipes (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                      (recipe_id, name.strip(), description, ts, ts))
            version = 1
        c.execute(
            "INSERT INTO recipe_versions (id, recipe_id, version, definition, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (db.new_id("rcv"), recipe_id, version, db.dumps(body), origin, ts))
    return get_recipe(recipe_id)


def delete_recipe(recipe_id: str) -> None:
    get_recipe(recipe_id)
    db.execute("UPDATE recipes SET deleted_at = ? WHERE id = ?", (db.now(), recipe_id))
