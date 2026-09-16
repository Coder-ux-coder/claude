"""Generate the three initial marigold concepts.

All three derive from the *same* master flower configuration and the same seed.
Only the split differs -- that is the point of the exercise, and three
unrelated flowers labelled as different splits would not answer the brief.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.app.core.config import ensure_dirs
from backend.app.database.db import init_db
from backend.app.jobs.pipeline import run_pipeline
from backend.app.versions import store
from design_engine.configurations.schema import (DesignConfig, RenderQuality,
                                                 SplitConfig, SplitType)

CONCEPTS = [
    {
        "name": "Concept A Balanced Split",
        "description": "A clear, near-symmetric division. The dividing line reads "
                       "as a single confident stroke across the rosette.",
        "split": dict(type=SplitType.BALANCED, position=0.0, amplitude=0.18,
                      smoothness=0.7, orientation_deg=0.0, separation_mm=16.0),
    },
    {
        "name": "Concept B S River Split",
        "description": "The client's priority concept: a flowing S-shaped, "
                       "river-inspired separation with an editable curve.",
        "split": dict(type=SplitType.S_RIVER, position=0.0, amplitude=0.34,
                      smoothness=0.72, orientation_deg=12.0, separation_mm=16.0),
    },
    {
        "name": "Concept C Organic Asymmetric",
        "description": "An expressive, irregular division that wanders with the "
                       "petal arrangement. The two pieces are deliberately unequal.",
        "split": dict(type=SplitType.ORGANIC, position=0.10, amplitude=0.40,
                      smoothness=0.55, orientation_deg=-28.0, separation_mm=16.0,
                      organic_octaves=3, organic_roughness=0.55, organic_seed=11),
    },
]

SHOTS = [
    {"name": "01_complete_flower", "camera": "three_quarter", "separated": False},
    {"name": "02_separated_components", "camera": "three_quarter", "separated": True},
    {"name": "03_top_view", "camera": "top", "separated": False},
    {"name": "04_three_quarter_view", "camera": "hero", "separated": False},
    {"name": "05_split_closeup", "camera": "closeup", "separated": False},
    {"name": "06_side_view", "camera": "side", "separated": False},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", default="preview",
                    choices=["preview", "standard", "high"])
    ap.add_argument("--resolution", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--meshes", action="store_true",
                    help="also export STL and OBJ for both pieces")
    args = ap.parse_args()

    ensure_dirs()
    init_db()
    project = store.ensure_default_project()

    # One shared master flower. Only the split varies between concepts.
    base = DesignConfig()
    base.render.quality = RenderQuality(args.quality)
    if args.resolution:
        base.render.resolution = args.resolution
    base.material.piece_tint = 0.30      # so the division reads in presentation shots

    existing = {c["name"]: c for c in store.list_concepts(project["id"], True)}
    results = []

    for spec in CONCEPTS:
        if args.only and args.only.lower() not in spec["name"].lower():
            continue
        cfg = base.model_copy(deep=True)
        cfg.split = SplitConfig(**spec["split"])

        if spec["name"] in existing:
            concept = existing[spec["name"]]
            version = store.create_version(
                concept["id"], concept["head_version"], cfg,
                f"regenerated at {args.quality} quality", author="user")
        else:
            concept = store.create_concept(project["id"], spec["name"],
                                           spec["description"], cfg)
            version = concept["head"]

        outdir = store.version_dir(concept["id"], version["id"])
        print(f"\n=== {spec['name']} (v{version['number']}) ===", flush=True)
        t0 = time.time()

        def emit(stage, msg, **kw):
            if stage == "RENDER" and "index" in kw:
                return
            print(f"  {stage:14s} {msg}", flush=True)

        try:
            res = run_pipeline(cfg, outdir, shots=SHOTS,
                               export_meshes=["stl", "obj"] if args.meshes else [],
                               save_blend=True, export_glb=True, emit=emit)
        except Exception as exc:
            print(f"  FAILED: {exc}", flush=True)
            results.append({"name": spec["name"], "ok": False, "error": str(exc)})
            continue

        root = Path(__file__).resolve().parents[1]
        assets = {k: str(Path(v).relative_to(root)) for k, v in res.outputs.items()}
        store.update_version(version["id"], assets=assets,
                             validation=res.validation,
                             stats={**res.stats, "split": res.split_meta,
                                    "split_path": res.split_path,
                                    "pipeline_seconds": res.seconds},
                             force_unlock=True)
        v = res.validation
        print(f"  -> {v['passed']}/{v['total']} checks, {len(assets)} assets, "
              f"{time.time() - t0:.0f}s", flush=True)
        results.append({"name": spec["name"], "ok": True,
                        "concept_id": concept["id"], "version_id": version["id"],
                        "validation": f"{v['passed']}/{v['total']}",
                        "assets": len(assets),
                        "measurements": v["measurements"],
                        "seconds": round(time.time() - t0, 1)})

    print("\n" + json.dumps(results, indent=1), flush=True)
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
