"""Persistent job queue and worker.

Blender never runs inside an HTTP request handler. Jobs are rows in SQLite, so
they survive a restart; a background worker thread picks them up one at a time.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from pathlib import Path

from backend.app.core.config import MAX_CONCURRENT_JOBS, TMP_DIR
from backend.app.database.db import get_conn, new_id, now, row_to_dict, tx
from backend.app.events.bus import bus
from backend.app.jobs.pipeline import PipelineError, run_pipeline
from backend.app.versions import store
from design_engine.configurations.schema import DesignConfig

JJSON = ("spec", "outputs", "logs")

_cancel_flags: dict[str, bool] = {}
_workers: list[threading.Thread] = []
_stop = threading.Event()


# ------------------------------------------------------------------ queue
def enqueue(job_type: str, spec: dict, concept_id=None, version_id=None,
            dedupe_key: str = "") -> dict:
    if dedupe_key:
        row = get_conn().execute(
            "SELECT * FROM jobs WHERE dedupe_key=? AND status IN ('queued','running') "
            "ORDER BY created_at DESC LIMIT 1", (dedupe_key,)).fetchone()
        if row:
            # Coalesce rather than queue the same work twice.
            return row_to_dict(row, JJSON)
    jid = new_id("job")
    with tx() as c:
        c.execute("INSERT INTO jobs (id,concept_id,version_id,type,status,spec,"
                  "stage,message,created_at,dedupe_key) "
                  "VALUES (?,?,?,?,'queued',?,'QUEUED','waiting for a worker',?,?)",
                  (jid, concept_id, version_id, job_type, json.dumps(spec),
                   now(), dedupe_key))
    job = get_job(jid)
    bus.publish("job.queued", {"job": _summary(job)}, jid)
    return job


def get_job(jid: str) -> dict | None:
    return row_to_dict(get_conn().execute(
        "SELECT * FROM jobs WHERE id=?", (jid,)).fetchone(), JJSON)


def list_jobs(limit: int = 60, status: str | None = None) -> list[dict]:
    q = "SELECT * FROM jobs"
    args: list = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    return [row_to_dict(r, JJSON) for r in get_conn().execute(q, args).fetchall()]


def cancel_job(jid: str) -> dict | None:
    job = get_job(jid)
    if not job:
        return None
    if job["status"] in ("queued", "running"):
        _cancel_flags[jid] = True
        if job["status"] == "queued":
            _finish(jid, "cancelled", error="cancelled before it started")
        bus.publish("job.cancelling", {"job_id": jid}, jid)
    return get_job(jid)


def retry_job(jid: str) -> dict | None:
    job = get_job(jid)
    if not job:
        return None
    return enqueue(job["type"], job["spec"], job["concept_id"], job["version_id"])


def _summary(job: dict) -> dict:
    return {k: job.get(k) for k in
            ("id", "type", "status", "stage", "message", "concept_id",
             "version_id", "progress_index", "progress_total", "created_at",
             "started_at", "finished_at", "error")}


def _update(jid: str, **fields):
    sets, args = [], []
    for k, v in fields.items():
        sets.append(f"{k}=?")
        args.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
    args.append(jid)
    with tx() as c:
        c.execute(f"UPDATE jobs SET {','.join(sets)} WHERE id=?", args)


def _append_log(jid: str, line: str):
    job = get_job(jid)
    logs = job.get("logs") or []
    logs.append(line)
    if len(logs) > 500:
        logs = logs[-500:]
    _update(jid, logs=logs)


def _finish(jid: str, status: str, error: str = "", outputs: dict | None = None):
    _update(jid, status=status, error=error, finished_at=now(),
            outputs=outputs or {},
            stage="DONE" if status == "completed" else status.upper())
    job = get_job(jid)
    bus.publish(f"job.{status}", {"job": _summary(job),
                                  "outputs": outputs or {}}, jid)


# ----------------------------------------------------------------- worker
def _run_job(job: dict):
    jid = job["id"]
    _update(jid, status="running", started_at=now(), stage="CONFIG",
            message="starting")
    bus.publish("job.started", {"job": _summary(get_job(jid))}, jid)

    def emit(stage, message, **extra):
        idx = int(extra.get("index", 0) or 0)
        tot = int(extra.get("total", 0) or 0)
        _update(jid, stage=stage, message=message,
                progress_index=idx, progress_total=tot)
        bus.publish("job.stage", {"stage": stage, "message": message,
                                  "index": idx, "total": tot}, jid)
        _append_log(jid, f"[{stage}] {message}")

    def cancelled():
        return _cancel_flags.get(jid, False)

    spec = job["spec"]
    try:
        version = store.get_version(job["version_id"])
        if not version:
            raise PipelineError("job has no version to work on")
        if version["approved"] and not spec.get("force_unlock"):
            raise PipelineError(
                f"version {version['number']} is approved and write-locked; "
                f"duplicate it or pass force_unlock")
        config = DesignConfig(**version["config"])
        outdir = store.version_dir(version["concept_id"], version["id"])

        result = run_pipeline(
            config, outdir,
            shots=spec.get("shots"),
            export_meshes=spec.get("export_meshes", []),
            save_blend=spec.get("save_blend", True),
            export_glb=spec.get("export_glb", True),
            show_master=spec.get("show_master", False),
            emit=emit, cancelled=cancelled)

        assets = dict(version.get("assets") or {})
        for k, v in result.outputs.items():
            assets[k] = str(Path(v).relative_to(Path(outdir).parents[4]))
        store.update_version(version["id"], assets=assets,
                             validation=result.validation,
                             stats={**result.stats, "split": result.split_meta,
                                    "split_path": result.split_path,
                                    "pipeline_seconds": result.seconds},
                             force_unlock=True)
        _finish(jid, "completed", outputs=assets)
    except PipelineError as exc:
        msg = str(exc)
        _append_log(jid, f"[ERROR] {msg}")
        _finish(jid, "cancelled" if "cancelled" in msg.lower() else "failed", error=msg)
    except Exception as exc:                                  # pragma: no cover
        tb = traceback.format_exc()
        _append_log(jid, f"[ERROR] {tb}")
        _finish(jid, "failed", error=f"{exc!r}")
    finally:
        _cancel_flags.pop(jid, None)


def _worker_loop():
    while not _stop.is_set():
        row = get_conn().execute(
            "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if row is None:
            _stop.wait(0.4)
            continue
        job = row_to_dict(row, JJSON)
        # Claim it atomically so two workers cannot take the same job.
        with tx() as c:
            cur = c.execute(
                "UPDATE jobs SET status='claimed' WHERE id=? AND status='queued'",
                (job["id"],))
        if cur.rowcount == 0:
            continue
        try:
            _run_job(job)
        except Exception:                                     # pragma: no cover
            _finish(job["id"], "failed", error=traceback.format_exc()[-2000:])


def recover_interrupted():
    """A job that was running when the process died is interrupted, not done."""
    rows = get_conn().execute(
        "SELECT id FROM jobs WHERE status IN ('running','claimed')").fetchall()
    for r in rows:
        _update(r["id"], status="failed", finished_at=now(),
                error="interrupted by an application restart",
                stage="INTERRUPTED")
    return len(rows)


def _sweep_stale_tmp(max_age_seconds: int = 3600):
    """Remove leftover pipeline directories -- but only genuinely stale ones.

    Each directory is named pipe_<pid>_<ms>. A directory whose process is still
    alive belongs to a pipeline that is still using it, and deleting it pulls
    the job spec and half-written assets out from under a running Blender. That
    is not hypothetical: a naive sweep here destroyed a live concept run when a
    second process started up alongside it.
    """
    import shutil
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    now_ts = time.time()
    removed = 0
    for path in TMP_DIR.glob("pipe_*"):
        try:
            parts = path.name.split("_")
            pid = int(parts[1]) if len(parts) > 2 else None
        except (ValueError, IndexError):
            pid = None
        if pid is not None and pid != os.getpid() and _pid_alive(pid):
            continue
        try:
            if now_ts - path.stat().st_mtime < 120:
                continue          # very recent: assume someone is still writing
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
        except OSError:
            pass
    return removed


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def start_workers():
    _sweep_stale_tmp()
    n = recover_interrupted()
    if n:
        bus.publish("system.recovery", {"interrupted_jobs": n})
    for i in range(max(1, MAX_CONCURRENT_JOBS)):
        t = threading.Thread(target=_worker_loop, daemon=True,
                             name=f"afri-worker-{i}")
        t.start()
        _workers.append(t)


def stop_workers():
    _stop.set()
