"""Bounded, hypothesis-driven design refinement.

Every iteration targets one *measured* weakness, states what it expects to
change, and is kept only if that measurement actually improved without
regressing the others. Randomly regenerating a design and calling the result an
improvement is not refinement, and this module does not do it.
"""
from __future__ import annotations

import threading
import time

from backend.app.database.db import get_conn, new_id, now, tx
from backend.app.events.bus import bus
from backend.app.jobs import manager
from backend.app.versions import store
from design_engine.configurations.schema import DesignConfig
from design_engine.flower.marigold import MM, build_master_flower
from design_engine.splitting.splitter import split_flower

_runs: dict[str, dict] = {}


# --------------------------------------------------------------------------
def measure(config: DesignConfig) -> dict:
    """Measure the design. Geometry only -- fast, and no Blender needed."""
    fr = build_master_flower(config.flower)
    radius = config.flower.diameter_mm * 0.5 * MM
    sr = split_flower(fr.mesh, config.split, radius)

    va, vb = sr.piece_a.volume(), sr.piece_b.volume()
    total = max(va + vb, 1e-9)
    b = fr.mesh.bounds()
    dia = float(max(b[1][0] - b[0][0], b[1][1] - b[0][1]))
    height = float(b[1][2] - b[0][2])

    # Silhouette raggedness: how much the outer radius varies with angle. A
    # marigold should present a full, even circular outline.
    import numpy as np
    v = fr.mesh.verts
    ang = np.arctan2(v[:, 1], v[:, 0])
    rad = np.hypot(v[:, 0], v[:, 1])
    bins = np.linspace(-np.pi, np.pi, 73)
    idx = np.digitize(ang, bins) - 1
    outer = np.zeros(72)
    for i in range(72):
        sel = rad[idx == i]
        outer[i] = sel.max() if len(sel) else 0.0
    raggedness = float(outer.std() / max(outer.mean(), 1e-9))

    return {
        "petal_count": fr.stats["petal_count"],
        "faces": fr.stats["faces"],
        "diameter_mm": round(dia / MM, 2),
        "height_mm": round(height / MM, 2),
        "relief_ratio": round(height / max(dia, 1e-9), 4),
        "piece_balance": round(min(va, vb) / total * 2, 4),   # 1.0 == even
        "silhouette_raggedness": round(raggedness, 4),
        "petal_density_actual": round(fr.stats["petal_count"] /
                                      max(config.flower.layer_count, 1), 2),
        "boundary_area": round(float(
            sum(m.face_areas()[m.parts >= 4_000_000].sum()
                for m in (sr.piece_a, sr.piece_b))), 4),
        "split_seconds": sr.metadata["split_seconds"],
    }


# --------------------------------------------------------------------------
# Each hypothesis names the weakness, the metric it targets, the direction it
# expects that metric to move, and the parameter change it will make.
HYPOTHESES = [
    dict(key="sparse_petals",
         weakness="The flower reads sparse; a marigold should look packed.",
         metric="petal_count", want="up",
         test=lambda m, c: m["petal_count"] < 120,
         apply=lambda c: _bump(c, "flower", "petal_density", +0.18, 2.5)),
    dict(key="too_few_layers",
         weakness="Too few petal rows, so the layering does not read.",
         metric="petal_count", want="up",
         test=lambda m, c: c.flower.layer_count < 6,
         apply=lambda c: _bump(c, "flower", "layer_count", +1, 12, integer=True)),
    dict(key="ragged_silhouette",
         weakness="The outer silhouette is uneven rather than a full circle.",
         metric="silhouette_raggedness", want="down",
         test=lambda m, c: m["silhouette_raggedness"] > 0.085,
         apply=lambda c: _bump(c, "flower", "organic_variation", -0.08, 1.0, lo=0.0)),
    dict(key="flat_relief",
         weakness="The flower is too flat to read as three-dimensional.",
         metric="relief_ratio", want="up",
         test=lambda m, c: m["relief_ratio"] < 0.17,
         apply=lambda c: _bump(c, "flower", "relief_depth_mm", +2.5, 60.0)),
    dict(key="unbalanced_pieces",
         weakness="The two pieces are very unequal in size.",
         metric="piece_balance", want="up",
         test=lambda m, c: m["piece_balance"] < 0.82,
         apply=lambda c: _toward_zero(c, "split", "position", 0.45)),
    dict(key="weak_split_reading",
         weakness="The dividing line is not visually distinct enough.",
         metric="boundary_area", want="up",
         test=lambda m, c: c.split.amplitude < 0.28 and c.split.type.value != "balanced",
         apply=lambda c: _bump(c, "split", "amplitude", +0.10, 0.9)),
    dict(key="thin_petals",
         weakness="Petals are narrow and strap-like rather than broad.",
         metric="petal_count", want="same",
         test=lambda m, c: c.flower.petal_width_ratio < 0.85,
         apply=lambda c: _bump(c, "flower", "petal_width_ratio", +0.10, 1.4)),
    dict(key="flat_centre",
         weakness="The centre is too flat to read as a mass of florets.",
         metric="relief_ratio", want="up",
         test=lambda m, c: c.flower.center_dome_height < 0.26,
         apply=lambda c: _bump(c, "flower", "center_dome_height", +0.08, 1.2)),
]


def _bump(cfg, section, field, delta, hi, lo=None, integer=False):
    out = cfg.model_copy(deep=True)
    sec = getattr(out, section)
    val = getattr(sec, field) + delta
    field_info = type(sec).model_fields[field]
    ui = (field_info.json_schema_extra or {}).get("ui", {}) if isinstance(
        field_info.json_schema_extra, dict) else {}
    low = lo if lo is not None else ui.get("min", 0)
    val = max(low, min(hi, val))
    setattr(sec, field, int(round(val)) if integer else round(float(val), 4))
    return out


def _toward_zero(cfg, section, field, factor):
    out = cfg.model_copy(deep=True)
    sec = getattr(out, section)
    setattr(sec, field, round(getattr(sec, field) * factor, 4))
    return out


def _improved(before: dict, after: dict, metric: str, want: str) -> tuple[bool, str]:
    b, a = before.get(metric), after.get(metric)
    if b is None or a is None:
        return False, "metric unavailable"
    if want == "up":
        ok = a > b * 1.005
    elif want == "down":
        ok = a < b * 0.995
    else:
        ok = True
    return ok, f"{metric}: {b} -> {a}"


def _regressed(before: dict, after: dict) -> str | None:
    """Guard against a fix that breaks something else."""
    if after["piece_balance"] < before["piece_balance"] - 0.12:
        return "piece balance got noticeably worse"
    if after["silhouette_raggedness"] > before["silhouette_raggedness"] * 1.35:
        return "the silhouette became markedly more ragged"
    if after["faces"] > 900_000:
        return "triangle count exceeded the practical budget"
    return None


# --------------------------------------------------------------------------
def start_run(concept_id: str, max_iterations: int = 5,
              max_seconds: int = 900, render_each: bool = False) -> dict:
    concept = store.get_concept(concept_id)
    if not concept:
        raise ValueError("concept not found")
    rid = new_id("ref")
    cfg = {"max_iterations": int(max(1, min(20, max_iterations))),
           "max_seconds": int(max(30, min(7200, max_seconds))),
           "render_each": bool(render_each)}
    with tx() as c:
        c.execute("INSERT INTO refine_runs (id,concept_id,status,config,"
                  "iterations,stop_reason,created_at) VALUES (?,?,'running',?,'[]','',?)",
                  (rid, concept_id, __import__("json").dumps(cfg), now()))
    _runs[rid] = {"stop": False}
    t = threading.Thread(target=_loop, args=(rid, concept_id, cfg), daemon=True)
    t.start()
    return get_run(rid)


def stop_run(rid: str):
    if rid in _runs:
        _runs[rid]["stop"] = True
    return get_run(rid)


def get_run(rid: str) -> dict | None:
    import json as _json
    r = get_conn().execute("SELECT * FROM refine_runs WHERE id=?", (rid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["config"] = _json.loads(d["config"])
    d["iterations"] = _json.loads(d["iterations"])
    return d


def list_runs(concept_id: str | None = None) -> list[dict]:
    import json as _json
    q = "SELECT * FROM refine_runs"
    args: list = []
    if concept_id:
        q += " WHERE concept_id=?"
        args.append(concept_id)
    q += " ORDER BY created_at DESC LIMIT 25"
    out = []
    for r in get_conn().execute(q, args).fetchall():
        d = dict(r)
        d["config"] = _json.loads(d["config"])
        d["iterations"] = _json.loads(d["iterations"])
        out.append(d)
    return out


def _save(rid, iterations, status=None, stop_reason=None):
    import json as _json
    sets = ["iterations=?"]
    args: list = [_json.dumps(iterations)]
    if status:
        sets.append("status=?")
        args.append(status)
        if status != "running":
            sets.append("finished_at=?")
            args.append(now())
    if stop_reason is not None:
        sets.append("stop_reason=?")
        args.append(stop_reason)
    args.append(rid)
    with tx() as c:
        c.execute(f"UPDATE refine_runs SET {','.join(sets)} WHERE id=?", args)


def _loop(rid: str, concept_id: str, cfg: dict):
    t0 = time.time()
    iterations: list[dict] = []
    stop_reason = ""
    tried: set[str] = set()
    no_gain = 0
    try:
        concept = store.get_concept(concept_id)
        version = store.get_version(concept["head_version"])
        config = DesignConfig(**version["config"])
        current = measure(config)
        bus.publish("refine.started", {"run_id": rid, "concept_id": concept_id,
                                       "baseline": current})

        for i in range(cfg["max_iterations"]):
            if _runs.get(rid, {}).get("stop"):
                stop_reason = "stopped by the user"
                break
            if time.time() - t0 > cfg["max_seconds"]:
                stop_reason = f"execution budget of {cfg['max_seconds']}s exhausted"
                break

            hypo = next((h for h in HYPOTHESES
                         if h["key"] not in tried and h["test"](current, config)), None)
            if hypo is None:
                stop_reason = "no measured weakness remains that this engine can address"
                break
            tried.add(hypo["key"])

            candidate = hypo["apply"](config)
            if candidate.model_dump() == config.model_dump():
                iterations.append({"index": i + 1, "hypothesis": hypo["key"],
                                   "weakness": hypo["weakness"],
                                   "outcome": "rejected",
                                   "note": "the parameter is already at its limit"})
                _save(rid, iterations)
                continue

            bus.publish("refine.iteration", {
                "run_id": rid, "index": i + 1, "weakness": hypo["weakness"],
                "hypothesis": hypo["key"]})

            after = measure(candidate)
            ok, detail = _improved(current, after, hypo["metric"], hypo["want"])
            regression = _regressed(current, after)

            if ok and not regression:
                version = store.create_version(
                    concept_id, version["id"], candidate,
                    f"refinement {i + 1}: {hypo['weakness']}",
                    author="refiner",
                    hypothesis=f"{hypo['key']} -- expect {hypo['metric']} to go "
                               f"{hypo['want']}. Result: {detail}")
                config, current = candidate, after
                outcome, note = "kept", detail
                no_gain = 0
                if cfg["render_each"]:
                    manager.enqueue("GENERATE",
                                    {"shots": [{"name": "preview",
                                                "camera": "three_quarter"}],
                                     "save_blend": False, "export_glb": True},
                                    concept_id, version["id"],
                                    f"{version['id']}:{candidate.hash_render()}")
            else:
                outcome = "reverted"
                note = regression or f"no demonstrated improvement ({detail})"
                no_gain += 1

            iterations.append({"index": i + 1, "hypothesis": hypo["key"],
                               "weakness": hypo["weakness"],
                               "metric": hypo["metric"], "direction": hypo["want"],
                               "outcome": outcome, "note": note,
                               "measurements": after,
                               "version_id": version["id"] if outcome == "kept" else None})
            _save(rid, iterations)
            bus.publish("refine.result", {"run_id": rid, "index": i + 1,
                                          "outcome": outcome, "note": note})

            if no_gain >= 2:
                stop_reason = "two consecutive iterations showed no demonstrated improvement"
                break
        else:
            stop_reason = stop_reason or f"reached the {cfg['max_iterations']}-iteration limit"

        _save(rid, iterations, "completed", stop_reason or "finished")
        bus.publish("refine.finished", {"run_id": rid, "stop_reason": stop_reason,
                                        "iterations": len(iterations)})
    except Exception as exc:                                   # pragma: no cover
        _save(rid, iterations, "failed", f"{exc!r}")
        bus.publish("refine.failed", {"run_id": rid, "error": repr(exc)})
    finally:
        _runs.pop(rid, None)
