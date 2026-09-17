"""HTTP routes. Deliberately thin -- no heavy work happens in a handler."""
from __future__ import annotations

import json
import os
import platform
import shutil

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.app.agents import designer
from backend.app.agents.commands import CommandType, apply_command
from backend.app.agents.providers import ProviderError, provider_report
from backend.app.core.config import MAX_CONCURRENT_JOBS, ROOT, find_blender
from backend.app.core.security import UnsafePath, safe_asset_path, safe_name
from backend.app.database.db import get_conn, new_id, now, tx
from backend.app.events.bus import bus
from backend.app.jobs import manager
from backend.app.versions import store
from design_engine.configurations.schema import DesignConfig, ui_schema

router = APIRouter(prefix="/api")

PREVIEW_SHOTS = [{"name": "preview", "camera": "three_quarter"}]
CONCEPT_SHOTS = [
    {"name": "01_complete_flower", "camera": "three_quarter", "separated": False},
    {"name": "02_separated_components", "camera": "three_quarter", "separated": True},
    {"name": "03_top_view", "camera": "top", "separated": False},
    {"name": "04_three_quarter_view", "camera": "hero", "separated": False},
    {"name": "05_split_closeup", "camera": "closeup", "separated": True},
    {"name": "06_side_view", "camera": "side", "separated": False},
]


# ------------------------------------------------------------------ system
@router.get("/system")
def system_info():
    b = find_blender()
    du = shutil.disk_usage(ROOT)
    try:
        with open("/proc/meminfo") as fh:
            mem = {l.split(":")[0]: l.split()[1] for l in fh if ":" in l}
        ram_gb = round(int(mem.get("MemTotal", "0")) / 1048576, 1)
        ram_free = round(int(mem.get("MemAvailable", "0")) / 1048576, 1)
    except Exception:
        ram_gb = ram_free = None
    return {
        "app": "AFRi Studio", "version": "1.0.0", "stage": "Stage One",
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "machine": platform.machine(),
        "ram_total_gb": ram_gb, "ram_available_gb": ram_free,
        "disk_free_gb": round(du.free / 1e9, 1),
        "blender": {"available": b.available, "path": b.path,
                    "version": b.version, "error": b.error,
                    "engines": b.engines,
                    "note": "EEVEE Next requires a GPU/EGL context and is "
                            "unavailable on this machine; Cycles CPU with "
                            "OpenImageDenoise is used for every render preset."},
        "ai_providers": provider_report(),
        "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
        # Stage two was authorised on 2026-09-17. The hat and the assembly
        # stage are built; attachment geometry and surface conforming are not.
        # See deliverables/STAGE_TWO_ASSEMBLY.md.
        "hat_stage_two_started": True,
        "hat_stage_two": {
            "hat_geometry": True,
            "placement_rigid": True,
            "surface_conform": False,
            "attachment_geometry": False,
            "manufacturing_review": False,
        },
    }


@router.get("/schema")
def get_schema():
    return ui_schema()


# ---------------------------------------------------------------- projects
@router.get("/projects")
def projects():
    return {"projects": store.list_projects()}


@router.get("/projects/{pid}")
def project_detail(pid: str):
    ps = [p for p in store.list_projects() if p["id"] == pid]
    if not ps:
        raise HTTPException(404, "project not found")
    concepts = store.list_concepts(pid, include_archived=True)
    jobs = manager.list_jobs(40)
    return {"project": ps[0], "concepts": concepts,
            "milestones": _milestones(concepts, jobs), "jobs": jobs}


def _has_deliverables() -> bool:
    d = ROOT / "deliverables"
    return d.is_dir() and any(p.is_file() for p in d.iterdir())


def _milestones(concepts, jobs):
    """Milestone state derived from what actually exists, never hardcoded."""
    b = find_blender()
    any_geo = any(c.get("head", {}) and (c["head"].get("stats") or {}).get("faces")
                  for c in concepts if c.get("head"))
    any_valid = any((c["head"].get("validation") or {}).get("ok")
                    for c in concepts if c.get("head"))
    any_render = any(any(k.endswith(".png") or "render" in k or k.startswith("0")
                         for k in (c["head"].get("assets") or {}))
                     for c in concepts if c.get("head"))
    approved = any(v["approved"] for c in concepts
                   for v in store.list_versions(c["id"]))
    full = [c for c in concepts
            if c.get("head") and len(c["head"].get("assets") or {}) >= 6]
    return [
        {"key": "ENVIRONMENT_READY", "label": "Environment ready",
         "done": b.available, "detail": b.version or (b.error or "")},
        {"key": "ARCHITECTURE", "label": "Architecture complete",
         "done": (ROOT / "ARCHITECTURE.md").exists(), "detail": "ARCHITECTURE.md"},
        {"key": "FLOWER_ENGINE", "label": "Flower engine ready",
         "done": any_geo, "detail": f"{len(concepts)} concepts"},
        {"key": "SPLIT_ENGINE", "label": "Split engine ready",
         "done": any_geo, "detail": "two-piece geometry generated"},
        {"key": "GEOMETRY_VALIDATED", "label": "Geometry validated",
         "done": any_valid, "detail": "validation suite passing"},
        {"key": "CONCEPTS", "label": "Concepts generated",
         "done": len([c for c in concepts if not c["archived"]]) >= 3,
         "detail": f"{len([c for c in concepts if not c['archived']])} of 3"},
        {"key": "RENDERING", "label": "Rendering",
         "done": any_render, "detail": f"{len(full)} concepts fully shot"},
        {"key": "REFINEMENT", "label": "Refinement",
         "done": any(v["author"] == "refiner" for c in concepts
                     for v in store.list_versions(c["id"])),
         "detail": "iteration history"},
        {"key": "EXPORT", "label": "Export",
         "done": _has_deliverables(), "detail": "deliverables folder"},
        {"key": "USER_REVIEW", "label": "User review",
         "done": approved, "detail": "a version has been approved"},
    ]


# ---------------------------------------------------------------- concepts
class ConceptIn(BaseModel):
    name: str
    description: str = ""
    config: dict | None = None


@router.get("/concepts")
def concepts(include_archived: bool = Query(False)):
    p = store.ensure_default_project()
    return {"concepts": store.list_concepts(p["id"], include_archived)}


@router.post("/concepts")
def create_concept(body: ConceptIn):
    p = store.ensure_default_project()
    try:
        cfg = DesignConfig(**body.config) if body.config else DesignConfig()
        return store.create_concept(p["id"], body.name, body.description, cfg)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/concepts/{cid}")
def concept_detail(cid: str):
    c = store.get_concept(cid)
    if not c:
        raise HTTPException(404, "concept not found")
    versions = store.list_versions(cid)
    return {"concept": c, "versions": versions,
            "head": store.get_version(c["head_version"])}


@router.patch("/concepts/{cid}")
def patch_concept(cid: str, body: dict = Body(...)):
    if "name" in body:
        try:
            body["name"] = safe_name(body["name"], "concept name")
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    c = store.update_concept(cid, **body)
    if not c:
        raise HTTPException(404, "concept not found")
    return c


@router.post("/concepts/{cid}/duplicate")
def duplicate(cid: str, body: dict = Body(default={})):
    try:
        return store.duplicate_concept(cid, body.get("name") or "Copy")
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.get("/concepts/{cid}/versions")
def versions(cid: str):
    return {"versions": store.list_versions(cid)}


class VersionIn(BaseModel):
    config: dict
    description: str = ""
    parent_id: str | None = None
    author: str = "user"


@router.post("/concepts/{cid}/versions")
def new_version(cid: str, body: VersionIn):
    c = store.get_concept(cid)
    if not c:
        raise HTTPException(404, "concept not found")
    try:
        cfg = DesignConfig(**body.config)
    except Exception as exc:
        raise HTTPException(422, f"invalid configuration: {exc}")
    return store.create_version(cid, body.parent_id or c["head_version"], cfg,
                                body.description or "parameter change", body.author)


# ---------------------------------------------------------------- versions
@router.get("/versions/{vid}")
def version_detail(vid: str):
    v = store.get_version(vid)
    if not v:
        raise HTTPException(404, "version not found")
    return v


@router.get("/versions/{a}/diff/{b}")
def diff(a: str, b: str):
    try:
        return store.diff_versions(a, b)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.post("/versions/{vid}/restore")
def restore(vid: str):
    try:
        return store.restore_version(vid)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.post("/versions/{vid}/approve")
def approve(vid: str, body: dict = Body(default={})):
    v = store.update_version(vid, approved=1 if body.get("approved", True) else 0)
    return v


@router.post("/versions/{vid}/prefer")
def prefer(vid: str, body: dict = Body(default={})):
    return store.update_version(vid, preferred=1 if body.get("preferred", True) else 0)


# -------------------------------------------------------------------- jobs
class JobIn(BaseModel):
    type: str = "GENERATE"
    version_id: str
    quality: str | None = None
    shots: list | None = None
    export_meshes: list[str] = []
    save_blend: bool = True
    export_glb: bool = True
    show_master: bool = False
    force_unlock: bool = False


@router.post("/jobs")
def create_job(body: JobIn):
    v = store.get_version(body.version_id)
    if not v:
        raise HTTPException(404, "version not found")
    b = find_blender()
    if not b.available:
        raise HTTPException(503, b.error or "Blender is unavailable")

    shots = body.shots
    if shots is None:
        shots = CONCEPT_SHOTS if body.type in ("RENDER_FINAL", "CONCEPT") else PREVIEW_SHOTS
    spec = {"shots": shots, "export_meshes": body.export_meshes,
            "save_blend": body.save_blend, "export_glb": body.export_glb,
            "show_master": body.show_master, "force_unlock": body.force_unlock}
    cfg = DesignConfig(**v["config"])
    dedupe = f"{body.version_id}:{cfg.hash_render()}:{body.type}:{len(shots)}"
    return manager.enqueue(body.type, spec, v["concept_id"], body.version_id, dedupe)


@router.get("/jobs")
def jobs(limit: int = 60, status: str | None = None):
    return {"jobs": manager.list_jobs(limit, status)}


@router.get("/jobs/{jid}")
def job_detail(jid: str):
    j = manager.get_job(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@router.post("/jobs/{jid}/cancel")
def cancel(jid: str):
    j = manager.cancel_job(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@router.post("/jobs/{jid}/retry")
def retry(jid: str):
    j = manager.retry_job(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j


# ------------------------------------------------------------------ events
@router.get("/events")
def events():
    return StreamingResponse(bus.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ assets
@router.get("/assets/{version_id}/{name}")
def asset(version_id: str, name: str):
    v = store.get_version(version_id)
    if not v:
        raise HTTPException(404, "version not found")
    try:
        path = safe_asset_path("projects", "afri_marigold", "versions",
                               v["concept_id"], version_id, name)
    except UnsafePath as exc:
        raise HTTPException(400, str(exc))
    if not path.is_file():
        raise HTTPException(404, f"asset not found: {name}")
    return FileResponse(path)


# --------------------------------------------------------------- assistant
class AssistantIn(BaseModel):
    concept_id: str
    instruction: str
    auto_run: bool = True


@router.get("/assistant/providers")
def assistant_providers():
    return {"providers": provider_report()}


@router.get("/assistant/history")
def assistant_history(concept_id: str | None = None, limit: int = 60):
    q = "SELECT * FROM assistant_messages"
    args: list = []
    if concept_id:
        q += " WHERE concept_id=?"
        args.append(concept_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    rows = [dict(r) for r in get_conn().execute(q, args).fetchall()]
    for r in rows:
        r["commands"] = json.loads(r["commands"] or "[]")
    return {"messages": list(reversed(rows))}


def _store_message(concept_id, role, content, commands=None, provider="", status="ok"):
    mid = new_id("msg")
    with tx() as c:
        c.execute("INSERT INTO assistant_messages (id,concept_id,role,content,"
                  "commands,provider,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
                  (mid, concept_id, role, content,
                   json.dumps(commands or []), provider, status, now()))
    return mid


@router.post("/assistant/prompt")
def assistant_prompt(body: AssistantIn):
    """The exact prompt for manual handoff, when no automatic provider exists."""
    c = store.get_concept(body.concept_id)
    if not c:
        raise HTTPException(404, "concept not found")
    v = store.get_version(c["head_version"])
    cfg = DesignConfig(**v["config"])
    system, user = designer.build_prompt(body.instruction, cfg,
                                         {"concept": c["name"]})
    return {"system": system, "user": user,
            "combined": system + "\n\n---\n\n" + user}


@router.post("/assistant/message")
def assistant_message(body: AssistantIn):
    c = store.get_concept(body.concept_id)
    if not c:
        raise HTTPException(404, "concept not found")
    v = store.get_version(c["head_version"])
    cfg = DesignConfig(**v["config"])
    _store_message(body.concept_id, "user", body.instruction)
    try:
        plan, rejected, provider, raw = designer.interpret(
            body.instruction, cfg, {"concept": c["name"],
                                    "version": v["number"]})
    except (ProviderError, ValueError) as exc:
        _store_message(body.concept_id, "assistant",
                       f"Could not interpret that instruction: {exc}",
                       status="error")
        raise HTTPException(503, str(exc))
    return _apply_plan(c, v, cfg, plan, rejected, provider, body.auto_run,
                       body.instruction)


class ManualIn(BaseModel):
    concept_id: str
    reply: str
    instruction: str = "(manual handoff)"
    auto_run: bool = True


@router.post("/assistant/manual")
def assistant_manual(body: ManualIn):
    c = store.get_concept(body.concept_id)
    if not c:
        raise HTTPException(404, "concept not found")
    v = store.get_version(c["head_version"])
    cfg = DesignConfig(**v["config"])
    try:
        plan, rejected = designer.parse_manual(body.reply, cfg)
    except Exception as exc:
        raise HTTPException(422, f"could not parse that reply: {exc}")
    return _apply_plan(c, v, cfg, plan, rejected, "manual_handoff",
                       body.auto_run, body.instruction)


def _apply_plan(concept, version, cfg, plan, rejected, provider, auto_run,
                instruction):
    """Turn a validated plan into real configuration changes and real jobs."""
    changed = cfg
    applied = []
    for cmd in plan.commands:
        if cmd.type.value.startswith("UPDATE_"):
            changed = apply_command(cmd, changed)
            applied.append(f"{cmd.type.value.split('_')[1].lower()}."
                           f"{cmd.parameter} = {cmd.value}")

    new_version = None
    jobs_created = []
    if applied:
        new_version = store.create_version(
            concept["id"], version["id"], changed,
            f"assistant: {instruction[:120]}", author="assistant")

    wants_render = any(c.type in (CommandType.RENDER_PREVIEW,
                                  CommandType.RENDER_FINAL)
                       for c in plan.commands)
    target = new_version or version
    if auto_run and (applied or wants_render):
        final = any(c.type == CommandType.RENDER_FINAL for c in plan.commands)
        job = manager.enqueue(
            "RENDER_FINAL" if final else "GENERATE",
            {"shots": CONCEPT_SHOTS if final else PREVIEW_SHOTS,
             "export_meshes": [], "save_blend": True, "export_glb": True},
            concept["id"], target["id"],
            f"{target['id']}:{DesignConfig(**target['config']).hash_render()}")
        jobs_created.append(job["id"])

    variations = [c for c in plan.commands
                  if c.type == CommandType.GENERATE_VARIATION]
    variation_versions = []
    if variations and auto_run:
        count = variations[0].count or 3
        for i in range(count):
            vc = DesignConfig(**target["config"])
            vc.flower.seed = (vc.flower.seed + 1000 * (i + 1)) % (2 ** 31 - 1)
            vv = store.create_version(concept["id"], target["id"], vc,
                                      f"variation {i + 1} of {count}",
                                      author="assistant")
            variation_versions.append(vv["id"])
            jobs_created.append(manager.enqueue(
                "GENERATE", {"shots": PREVIEW_SHOTS, "save_blend": False,
                             "export_glb": True},
                concept["id"], vv["id"],
                f"{vv['id']}:{vc.hash_render()}")["id"])

    summary = plan.explanation or "Applied the requested changes."
    if applied:
        summary += "\n\nChanged: " + "; ".join(applied)
    if rejected:
        summary += "\n\nRejected " + str(len(rejected)) + " command(s): " + \
            "; ".join(r["reason"] for r in rejected)
    if jobs_created:
        summary += f"\n\nQueued {len(jobs_created)} job(s)."
    _store_message(concept["id"], "assistant", summary,
                   [c.model_dump(mode="json") for c in plan.commands], provider,
                   "partial" if rejected else "ok")

    return {"explanation": plan.explanation,
            "commands": [c.model_dump(mode="json") for c in plan.commands],
            "rejected": rejected, "applied": applied, "provider": provider,
            "new_version": new_version, "jobs": jobs_created,
            "variation_versions": variation_versions,
            "summary": summary}
