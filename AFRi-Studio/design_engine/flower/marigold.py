"""The canonical master marigold.

One flower, built once, from which every split concept is derived. The layer
schedule is what makes it read as a marigold rather than a daisy: many rows of
broad ruffled petals, each row shorter, more upright and rotated into the gaps
of the row outside it, over a domed structural base.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from design_engine.configurations.schema import FlowerConfig
from design_engine.flower.base import build_base_disc, build_center
from design_engine.geometry.mesh import Mesh, petal_part_id
from design_engine.petals.petal import build_petal

# 1 Blender/scene unit == 10 mm. Keeps Cycles light falloff and clip ranges sane.
MM = 0.1


@dataclass
class FlowerResult:
    mesh: Mesh
    layers: list[dict]
    stats: dict
    build_seconds: float


def _layer_schedule(cfg: FlowerConfig) -> list[dict]:
    """Radius, petal count, length, width, curl and tilt for each row.

    The schedule is what makes this read as a marigold rather than a daisy:
    many rows, each shorter and more upright than the one outside it, rotated
    into its gaps, with the outer rows lying nearly flat so the flower presents
    a full circular silhouette instead of curling into a bowl.
    """
    R = cfg.diameter_mm * 0.5 * MM
    relief = cfg.relief_depth_mm * MM
    center_r = cfg.center_diameter_ratio * R
    L = max(1, cfg.layer_count)

    outer_len = cfg.petal_length_ratio * R
    # The outer row must reach the nominal radius, so its root sits one petal
    # length in -- allowing for the fact that a curled petal does not project
    # its full length radially.
    r_outer = max(center_r * 1.05, R - outer_len * 0.88)

    layers = []
    for i in range(L):
        f = i / max(1, L - 1)                     # 0 outer -> 1 inner

        r = r_outer * (1 - f) + center_r * 1.02 * f
        r = r * (1.0 - cfg.petal_overlap * 0.16 * f)

        length = outer_len * (1.0 - 0.40 * f ** 1.1)

        circumference_factor = 0.55 + 0.45 * (r / max(r_outer, 1e-6))
        n = max(5, int(round(cfg.petal_count_base * cfg.petal_density
                             * circumference_factor)))

        slot = 2 * np.pi * max(r, 1e-6) / n
        width = slot * cfg.petal_width_ratio * (1.0 + cfg.petal_overlap)

        # Outer rows lie out flat; inner rows stand up. Both the root tilt and
        # the lengthwise curl ramp inward -- curling the outer row is what
        # turned the first attempt into a bowl.
        tilt = np.deg2rad(4.0) + cfg.layer_tilt_gain * np.deg2rad(62.0) * f ** 0.95
        curl = cfg.petal_curvature * (0.28 + 0.72 * f ** 0.85)

        z = relief * cfg.dome_gain * (f ** 1.15)

        # Stagger each row into the gaps of the one outside it, with a golden
        # increment so rows never re-align at any depth.
        phase = (np.pi / n) * (i % 2) + i * 2 * np.pi * 0.381966 / max(n, 1)

        layers.append(dict(index=i, radius=float(r), count=n, length=float(length),
                           width=float(width), tilt=float(tilt), curl=float(curl),
                           z=float(z), phase=float(phase), f=float(f)))
    return layers


def build_master_flower(cfg: FlowerConfig, progress=None) -> FlowerResult:
    """Build the master flower. Pure geometry: no Blender, no file I/O."""
    t0 = time.perf_counter()
    R = cfg.diameter_mm * 0.5 * MM
    relief = cfg.relief_depth_mm * MM
    thickness = cfg.thickness_mm * MM
    rng = np.random.default_rng(cfg.seed)

    layers = _layer_schedule(cfg)
    parts: list[Mesh] = []

    # ---- structural base --------------------------------------------------
    # The disc has to reach past the outermost petal roots, otherwise the outer
    # row is physically unattached and each half would fall apart.
    outer_root = max(l["radius"] for l in layers)
    base_r = max(cfg.base_disc_ratio * R, outer_root * 1.07)
    # Hand the disc the petal-root profile so the dome rises to meet every row.
    # Without it the inner rows float clear of the structure.
    root_r = np.array([l["radius"] for l in layers][::-1], dtype=np.float64)
    root_z = np.array([l["z"] for l in layers][::-1], dtype=np.float64)
    base = build_base_disc(base_r, cfg.base_thickness_mm * MM,
                           relief * 0.16, segments=96, rings=18,
                           root_profile=(root_r, root_z))
    parts.append(base)
    if progress:
        progress("base disc built", 1, len(layers) + 3)

    # ---- petals, outer row first -----------------------------------------
    total_petals = 0
    for li, layer in enumerate(layers):
        n = layer["count"]
        for k in range(n):
            ang = layer["phase"] + 2 * np.pi * k / n
            jitter = cfg.organic_variation
            d_ang = rng.normal(0, 0.30 / n * 2 * np.pi) * jitter
            d_len = 1.0 + rng.normal(0, 0.11) * jitter
            d_wid = 1.0 + rng.normal(0, 0.10) * jitter
            d_tilt = rng.normal(0, np.deg2rad(7.0)) * jitter
            d_curl = 1.0 + rng.normal(0, 0.16) * jitter
            twist = rng.normal(0, 0.28) * jitter
            phase = rng.uniform(0, 2 * np.pi)

            petal = build_petal(
                length=layer["length"] * max(0.45, d_len),
                width=layer["width"] * max(0.45, d_wid),
                thickness=thickness,
                segments_u=cfg.petal_segments_u,
                segments_v=cfg.petal_segments_v,
                curl=float(np.clip(layer["curl"] * d_curl, 0, 1.3)),
                cup=cfg.petal_cup,
                ruffle_amp=cfg.petal_ruffle_amp,
                ruffle_freq=cfg.petal_ruffle_freq,
                notch=cfg.petal_notch,
                twist=twist,
                tilt=layer["tilt"] + d_tilt,
                phase=phase,
                part_id=petal_part_id(li, k),
                name=f"petal_L{li}_{k}",
            )
            # Place: out along +X to the row radius, lifted to the row height,
            # then rotated into position around the flower.
            petal = petal.translated((layer["radius"], 0.0, layer["z"]))
            petal = petal.rotated_z(ang + d_ang)
            parts.append(petal)
            total_petals += 1
        if progress:
            progress(f"petal row {li + 1}/{len(layers)} ({n} petals)", li + 2, len(layers) + 3)

    # ---- centre boss ------------------------------------------------------
    center_r = cfg.center_diameter_ratio * R
    if center_r > 1e-4:
        centre = build_center(center_r, relief * cfg.center_dome_height,
                              floret_rings=cfg.center_floret_rings,
                              segments=56, seed=cfg.seed)
        centre = centre.translated((0, 0, relief * cfg.dome_gain))
        parts.append(centre)
    if progress:
        progress("centre built", len(layers) + 2, len(layers) + 3)

    mesh = Mesh.concat(parts, name="master_flower")
    dt = time.perf_counter() - t0
    b = mesh.bounds()
    stats = {
        **mesh.stats(),
        "petal_count": total_petals,
        "layer_count": len(layers),
        "diameter_mm": round(float(max(b[1][0] - b[0][0], b[1][1] - b[0][1])) / MM, 2),
        "height_mm": round(float(b[1][2] - b[0][2]) / MM, 2),
        "build_seconds": round(dt, 3),
    }
    if progress:
        progress(f"master flower complete: {total_petals} petals, "
                 f"{mesh.n_faces} triangles", len(layers) + 3, len(layers) + 3)
    return FlowerResult(mesh=mesh, layers=layers, stats=stats, build_seconds=dt)
