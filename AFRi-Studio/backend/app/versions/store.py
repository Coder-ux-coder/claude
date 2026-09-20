"""Projects, concepts and the version DAG.

History is append-only. Restoring an old version creates a new one holding the
same configuration; nothing is ever overwritten or deleted, so a bad generation
can never destroy work the user already approved.
"""
from __future__ import annotations

import json

from backend.app.core.config import PROJECTS_DIR
from backend.app.core.security import safe_name
from backend.app.database.db import get_conn, new_id, now, row_to_dict, tx
from design_engine.configurations.schema import DesignConfig

VJSON = ("config", "validation", "stats", "assets")


class ApprovalLocked(Exception):
    pass


# ---------------------------------------------------------------- projects
def ensure_default_project() -> dict:
    row = get_conn().execute("SELECT * FROM projects ORDER BY created_at LIMIT 1").fetchone()
    if row:
        return dict(row)
    pid = new_id("proj")
    t = now()
    with tx() as c:
        c.execute("INSERT INTO projects (id,name,description,created_at,updated_at) "
                  "VALUES (?,?,?,?,?)",
                  (pid, "AFRi Marigold",
                   "Two-piece marigold flower accessory. Stage One: standalone "
                   "flower concepts. Hat integration is Stage Two and not started.",
                   t, t))
    (PROJECTS_DIR / "afri_marigold").mkdir(parents=True, exist_ok=True)
    return dict(get_conn().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone())


def list_projects() -> list[dict]:
    return [dict(r) for r in get_conn().execute(
        "SELECT * FROM projects ORDER BY created_at").fetchall()]


# ---------------------------------------------------------------- concepts
def create_concept(project_id: str, name: str, description: str,
                   config: DesignConfig, author: str = "user") -> dict:
    name = safe_name(name, "concept name")
    cid = new_id("cpt")
    t = now()
    with tx() as c:
        c.execute("INSERT INTO concepts (id,project_id,name,description,split_type,"
                  "archived,head_version,created_at,updated_at) VALUES (?,?,?,?,?,0,NULL,?,?)",
                  (cid, project_id, name, description, config.split.type.value, t, t))
    v = create_version(cid, None, config, "initial configuration", author=author)
    return get_concept(cid) | {"head": v}


def get_concept(cid: str) -> dict | None:
    r = get_conn().execute("SELECT * FROM concepts WHERE id=?", (cid,)).fetchone()
    return dict(r) if r else None


def list_concepts(project_id: str | None = None, include_archived=False) -> list[dict]:
    q = "SELECT * FROM concepts"
    args: list = []
    where = []
    if project_id:
        where.append("project_id=?")
        args.append(project_id)
    if not include_archived:
        where.append("archived=0")
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY created_at"
    out = []
    for r in get_conn().execute(q, args).fetchall():
        d = dict(r)
        head = get_version(d["head_version"]) if d["head_version"] else None
        d["head"] = head
        d["version_count"] = get_conn().execute(
            "SELECT COUNT(*) FROM versions WHERE concept_id=?", (d["id"],)).fetchone()[0]
        out.append(d)
    return out


def update_concept(cid: str, **fields) -> dict | None:
    allowed = {"name", "description", "archived", "head_version", "split_type"}
    sets, args = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            args.append(v)
    if not sets:
        return get_concept(cid)
    sets.append("updated_at=?")
    args.extend([now(), cid])
    with tx() as c:
        c.execute(f"UPDATE concepts SET {','.join(sets)} WHERE id=?", args)
    return get_concept(cid)


def duplicate_concept(cid: str, new_name: str) -> dict:
    src = get_concept(cid)
    if not src:
        raise ValueError("concept not found")
    head = get_version(src["head_version"])
    cfg = DesignConfig(**head["config"]) if head else DesignConfig()
    return create_concept(src["project_id"], new_name,
                          f"Duplicated from {src['name']}", cfg)


# ---------------------------------------------------------------- versions
def create_version(concept_id: str, parent_id: str | None, config: DesignConfig,
                   description: str, author: str = "user",
                   hypothesis: str = "") -> dict:
    n = get_conn().execute(
        "SELECT COALESCE(MAX(number),0)+1 FROM versions WHERE concept_id=?",
        (concept_id,)).fetchone()[0]
    vid = new_id("ver")
    with tx() as c:
        c.execute("INSERT INTO versions (id,concept_id,parent_id,number,config,"
                  "description,author,validation,stats,assets,preferred,approved,"
                  "hypothesis,created_at) VALUES (?,?,?,?,?,?,?,'{}','{}','{}',0,0,?,?)",
                  (vid, concept_id, parent_id, n,
                   json.dumps(config.model_dump(mode="json")), description, author,
                   hypothesis, now()))
        c.execute("UPDATE concepts SET head_version=?, split_type=?, updated_at=? WHERE id=?",
                  (vid, config.split.type.value, now(), concept_id))
    return get_version(vid)


def get_version(vid: str | None) -> dict | None:
    if not vid:
        return None
    r = get_conn().execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    return row_to_dict(r, VJSON)


def list_versions(concept_id: str) -> list[dict]:
    return [row_to_dict(r, VJSON) for r in get_conn().execute(
        "SELECT * FROM versions WHERE concept_id=? ORDER BY number", (concept_id,)).fetchall()]


def update_version(vid: str, *, force_unlock: bool = False, **fields):
    cur = get_version(vid)
    if not cur:
        raise ValueError("version not found")
    if cur["approved"] and not force_unlock and set(fields) - {"preferred", "approved"}:
        raise ApprovalLocked(
            f"version {cur['number']} is approved; pass force_unlock to modify it")
    allowed = {"validation", "stats", "assets", "preferred", "approved",
               "description", "hypothesis"}
    sets, args = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k}=?")
        args.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
    if not sets:
        return cur
    args.append(vid)
    with tx() as c:
        c.execute(f"UPDATE versions SET {','.join(sets)} WHERE id=?", args)
    return get_version(vid)


def restore_version(vid: str) -> dict:
    """Restore into a *new* version. History is never rewritten."""
    src = get_version(vid)
    if not src:
        raise ValueError("version not found")
    cfg = DesignConfig(**src["config"])
    return create_version(src["concept_id"], src["id"], cfg,
                          f"restored from version {src['number']}", author="user")


def diff_versions(a_id: str, b_id: str) -> dict:
    a, b = get_version(a_id), get_version(b_id)
    if not a or not b:
        raise ValueError("version not found")
    ca, cb = DesignConfig(**a["config"]), DesignConfig(**b["config"])
    return {
        "a": {"id": a["id"], "number": a["number"], "description": a["description"]},
        "b": {"id": b["id"], "number": b["number"], "description": b["description"]},
        "changes": ca.diff(cb),
        "validation_a": a.get("validation", {}),
        "validation_b": b.get("validation", {}),
        "assets_a": a.get("assets", {}),
        "assets_b": b.get("assets", {}),
    }


def version_dir(concept_id: str, version_id: str):
    d = PROJECTS_DIR / "afri_marigold" / "versions" / concept_id / version_id
    d.mkdir(parents=True, exist_ok=True)
    return d
