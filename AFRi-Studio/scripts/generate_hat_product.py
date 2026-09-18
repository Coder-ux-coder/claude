"""Stage two: the accessory on the hat.

Two configurations are generated, and the difference between them is the
finding, not a styling choice.

The refined 90 mm flower measures 96.6 mm across its outermost petals. A
standard fedora brim offers 67 mm of radial room between the crown foot and the
brim edge, so a 96.6 mm flower laid flat on it either rides up the crown or
hangs off the edge -- there is no collision-free placement at any position or
tilt. It needs a wide brim. Conversely, a flower sized to a fedora brim has to
come down to roughly 60 mm.

So: the 90 mm accessory is shown on a wide-brim hat, and a 58 mm version of the
same design is shown on the fedora it was originally drawn against.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from concept_c_v2 import SPLIT, V2_FLOWER

from backend.app.core.config import ensure_dirs
from backend.app.database.db import init_db
from backend.app.jobs.pipeline import run_pipeline
from backend.app.versions import store
from design_engine.configurations.schema import (DesignConfig, HatMaterial,
                                                 HatStyle, RenderQuality,
                                                 SplitConfig)

SHOTS = [
    {"name": "01_worn_angle", "camera": "hat_worn", "separated": False},
    {"name": "02_three_quarter", "camera": "hat_three_quarter", "separated": False},
    {"name": "03_top", "camera": "hat_top", "separated": False},
    {"name": "04_side", "camera": "hat_side", "separated": False},
    # Framed on the accessory rather than the hat, so the division reads.
    {"name": "05_accessory_detail", "camera": "hat_detail", "separated": False,
     "detail": True},
    {"name": "06_pieces_lifted", "camera": "hat_detail", "separated": True,
     "detail": True},
    # The fixing, seen from underneath with the hat and floor out of the way.
    # Every camera above the hat sees the top of the accessory and none of the
    # pins, which point down through the brim.
    {"name": "07_fixing_underside", "camera": "hat_underside", "separated": True,
     "detail": True, "show_hat": False, "show_backdrop": False},
]

BUILDS = {
    "wide_brim": dict(
        name="Stage Two Wide Brim",
        description="The 90 mm accessory on a wide-brim hat, the only silhouette "
                    "with enough brim to carry it.",
        flower=dict(diameter_mm=90.0),
        hat=dict(style=HatStyle.WIDE_BRIM, brim_width_mm=110.0, crown_height_mm=104.0,
                 brim_droop_deg=12.0, material=HatMaterial.FELT, base_color="#2C2A27"),
        placement=dict(radial_position=0.45, azimuth_deg=-52.0, surface_offset_mm=2.0,
                       roll_deg=18.0),
    ),
    "fedora": dict(
        name="Stage Two Fedora",
        description="The same design at 58 mm, sized to a standard fedora brim.",
        flower=dict(diameter_mm=58.0),
        hat=dict(style=HatStyle.FEDORA, brim_width_mm=68.0, crown_height_mm=112.0,
                 brim_droop_deg=9.0, material=HatMaterial.FELT, base_color="#3A3631"),
        placement=dict(radial_position=0.55, azimuth_deg=-52.0, surface_offset_mm=2.0,
                       roll_deg=18.0),
    ),
}


def build_config(key: str) -> DesignConfig:
    spec = BUILDS[key]
    cfg = DesignConfig()
    for k, v in V2_FLOWER.items():
        setattr(cfg.flower, k, v)
    for k, v in spec["flower"].items():
        setattr(cfg.flower, k, v)
    cfg.split = SplitConfig(**SPLIT)
    cfg.split.separation_mm = 26.0
    for k, v in spec["hat"].items():
        setattr(cfg.hat, k, v)
    for k, v in spec["placement"].items():
        setattr(cfg.placement, k, v)
    cfg.placement.show_hat = True
    cfg.material.piece_tint = 0.52
    return cfg


def emit(stage, msg, **kw):
    if stage == "RENDER" and "index" in kw:
        return
    print(f"    {stage:14s} {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quality", default="standard",
                    choices=["preview", "standard", "high"])
    ap.add_argument("--resolution", type=int, default=1200)
    ap.add_argument("--builds", default="wide_brim,fedora")
    ap.add_argument("--shots", default="")
    args = ap.parse_args()

    ensure_dirs()
    init_db()
    project = store.ensure_default_project()
    shots = [s for s in SHOTS if not args.shots or s["name"] in args.shots.split(",")]

    existing = {c["name"]: c for c in store.list_concepts(project["id"], True)}
    out = {}
    for key in args.builds.split(","):
        spec = BUILDS[key]
        cfg = build_config(key)
        cfg.render.quality = RenderQuality(args.quality)
        cfg.render.resolution = args.resolution

        if spec["name"] in existing:
            concept = existing[spec["name"]]
            version = store.create_version(concept["id"], concept.get("head_version"),
                                           cfg, "stage two assembly", author="user")
        else:
            concept = store.create_concept(project["id"], spec["name"],
                                           spec["description"], cfg)
            version = concept["head"]
        vdir = store.version_dir(concept["id"], version["id"])
        print(f"\n=== {spec['name']} ({version['id']}) ===")
        t0 = time.time()
        res = run_pipeline(cfg, vdir, shots=shots, export_meshes=["stl"],
                           save_blend=True, export_glb=True, emit=emit)
        root = Path(__file__).resolve().parents[1]
        assets = {k: str(Path(v).relative_to(root)) for k, v in res.outputs.items()}
        store.update_version(version["id"], assets=assets, validation=res.validation,
                             stats={**res.stats, "split": res.split_meta,
                                    "pipeline_seconds": res.seconds},
                             force_unlock=True)
        print(f"    -> {res.validation['passed']}/{res.validation['total']} checks, "
              f"{time.time() - t0:.0f}s, {len(assets)} assets")
        out[key] = {"version_id": version["id"], "assets": assets,
                    "stats": res.stats, "validation": res.validation}

    report = Path("deliverables") / "stage_two_assembly.json"
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps(out, indent=2, default=str))
    print(f"\nwrote {report}")


if __name__ == "__main__":
    main()
