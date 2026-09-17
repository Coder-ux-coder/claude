"""Generate Concept C v2 beside the preserved v1, and compare them.

v1 is never modified. It is regenerated from its recorded parameters into its
own version directory so the two can be photographed under identical light,
which is the only way a visual comparison means anything.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from concept_c_v2 import CONCEPT_NAME, SHOTS, build_config

from backend.app.core.config import ensure_dirs
from backend.app.database.db import init_db
from backend.app.jobs.pipeline import run_pipeline
from backend.app.versions import store
from design_engine.configurations.schema import RenderQuality


def emit(stage, msg, **kw):
    if stage == "RENDER" and "index" in kw:
        return
    print(f"    {stage:14s} {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", default="high", choices=["preview", "standard", "high"])
    ap.add_argument("--resolution", type=int, default=1400)
    ap.add_argument("--versions", default="v1,v2")
    ap.add_argument("--shots", default="")
    args = ap.parse_args()

    ensure_dirs()
    init_db()
    project = store.ensure_default_project()
    shots = [s for s in SHOTS if not args.shots or s["name"] in args.shots.split(",")]

    concepts = {c["name"]: c for c in store.list_concepts(project["id"], True)}
    concept = concepts.get(CONCEPT_NAME)
    if concept is None:
        cfg0 = build_config("v1")
        concept = store.create_concept(project["id"], CONCEPT_NAME,
                                       "Organic asymmetric division, refined.", cfg0)
        print(f"created concept {concept['id']}")

    out = {}
    for ver in args.versions.split(","):
        cfg = build_config(ver)
        cfg.render.quality = RenderQuality(args.quality)
        cfg.render.resolution = args.resolution

        version = store.create_version(
            concept["id"], concept.get("head_version"), cfg,
            f"Concept C {ver}: " + ("as originally delivered" if ver == "v1"
                                    else "shorter, broader, denser petals; composed organic curve; "
                                         "consolidated into one solid"),
            author="user")
        vdir = store.version_dir(concept["id"], version["id"])
        print(f"\n=== Concept C {ver}  (version {version['id']}, no. {version['number']}) ===")
        t0 = time.time()
        res = run_pipeline(cfg, vdir, shots=shots, export_meshes=["stl"],
                           save_blend=True, export_glb=True, emit=emit)
        root = Path(__file__).resolve().parents[1]
        assets = {k: str(Path(v).relative_to(root)) for k, v in res.outputs.items()}
        store.update_version(version["id"], assets=assets, validation=res.validation,
                             stats={**res.stats, "split": res.split_meta,
                                    "split_path": res.split_path,
                                    "pipeline_seconds": res.seconds},
                             force_unlock=True)
        v = res.validation
        print(f"    -> {v['passed']}/{v['total']} checks, {time.time()-t0:.0f}s, "
              f"{len(assets)} assets")
        out[ver] = {"version_id": version["id"], "dir": str(vdir),
                    "assets": assets, "stats": res.stats, "validation": v}

    report = Path("deliverables") / "concept_c_refinement.json"
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps(out, indent=2, default=str))
    print(f"\nwrote {report}")


if __name__ == "__main__":
    main()
