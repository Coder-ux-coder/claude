"""Does the flower actually sit on the hat?

Three questions, all answered by measurement rather than by looking at a render:

1. **Contact.** How big is the gap between the flower's flat underside and the
   doubly curved brim, and over how much of the footprint?
2. **Interference.** Does any of the flower pass *through* the hat?
3. **Load.** Where does the weight sit, and what moment does it put on a brim?

The distance is computed analytically against the meridian rather than by
nearest-neighbour search over the sampled skin. The skin is sampled at about
5.9 mm circumferentially, so a nearest-point search would carry several
millimetres of error -- useless for judging a sub-millimetre gap. The hat is a
surface of revolution away from the crown dent, so the exact distance is the
distance from (radius, height) to the outer meridian, which is a 2-D
point-to-polyline problem solved to the resolution of the profile.
"""
from __future__ import annotations

import numpy as np

from design_engine.geometry.mesh import PART_MOUNT, Mesh
from design_engine.hat.hat import HatResult
from design_engine.hat.profile import MM, head_radius

MM3 = MM ** 3


def outer_meridian(hat: HatResult) -> np.ndarray:
    """The outer skin's meridian, (N,2) of (r, z)."""
    prof = hat.profile
    d = np.gradient(prof, axis=0)
    n = np.stack([-d[:, 1], d[:, 0]], axis=1)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = n / np.where(ln < 1e-12, 1.0, ln)
    return prof + n * (hat.thickness * 0.5)


def signed_distance_to_hat(points: np.ndarray, hat: HatResult) -> np.ndarray:
    """Signed distance from world points to the hat's outer skin, in scene units.

    Positive is clear of the hat, negative is inside it.
    """
    mer = outer_meridian(hat)
    q = np.stack([np.hypot(points[:, 0], points[:, 1]), points[:, 2]], axis=1)

    a = mer[:-1]                      # (S,2) segment starts
    b = mer[1:]                       # (S,2) segment ends
    ab = b - a
    denom = np.einsum("ij,ij->i", ab, ab)
    denom = np.where(denom < 1e-18, 1.0, denom)

    # Closest point on each segment, for every query point.
    diff = q[:, None, :] - a[None, :, :]                      # (Q,S,2)
    t = np.clip(np.einsum("qsj,sj->qs", diff, ab) / denom, 0.0, 1.0)
    closest = a[None, :, :] + t[:, :, None] * ab[None, :, :]  # (Q,S,2)
    delta = q[:, None, :] - closest
    d2 = np.einsum("qsj,qsj->qs", delta, delta)
    best = np.argmin(d2, axis=1)
    rows = np.arange(len(q))
    dist = np.sqrt(d2[rows, best])

    # Sign from the outward normal of the winning segment.
    seg = ab[best]
    nrm = np.stack([-seg[:, 1], seg[:, 0]], axis=1)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = nrm / np.where(ln < 1e-12, 1.0, ln)
    sign = np.sign(np.einsum("qj,qj->q", delta[rows, best], nrm))
    sign[sign == 0] = 1.0

    # The meridian is an OPEN curve: it stops at the brim edge. A point out
    # past that edge clamps onto the final vertex and, being below the brim's
    # plane, comes back negative -- reading as "inside the hat" when it is in
    # open air beyond the hat entirely. Anything whose nearest point is the
    # clamped end of the last segment is outside by definition.
    past_edge = (best == len(ab) - 1) & (t[rows, best] >= 1.0 - 1e-9)
    sign = np.where(past_edge, 1.0, sign)
    return dist * sign


def mesh_centroid(m: Mesh) -> tuple[np.ndarray, float]:
    """Volume centroid and signed volume, via the divergence theorem."""
    t = m.verts[m.faces].astype(np.float64)
    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))
    volume = vol6.sum() / 6.0
    if abs(volume) < 1e-15:
        return m.verts.astype(np.float64).mean(axis=0), 0.0
    centroid = ((a + b + c) * vol6[:, None]).sum(axis=0) / (4.0 * vol6.sum())
    return centroid, volume


def underside_vertices(local_mesh: Mesh, band_mm: float = 0.25) -> np.ndarray:
    """Indices of vertices on the flower's flat underside.

    The base disc is built with its bottom face on z = 0, so the underside is
    whatever sits in a thin band there. Taken in *local* space, before the
    flower is placed, because that is where 'the bottom' is well defined.
    """
    z = local_mesh.verts[:, 2].astype(np.float64)
    inside = z <= band_mm * MM
    # A pin runs several millimetres below the base plane; including its shank
    # would swamp the gap statistics with points that are meant to be down
    # there.
    inside &= z >= -band_mm * MM
    return np.nonzero(inside)[0]


def contact_report(local_mesh: Mesh, rotation: np.ndarray, translation: np.ndarray,
                   hat: HatResult, hat_cfg, placement_cfg,
                   density_g_cm3: float = 1.24) -> dict:
    """Measure contact, interference and load for one placed piece.

    ``density_g_cm3`` defaults to cast polyurethane resin, a plausible material
    for a piece this size. It is a stated assumption, not a specification: the
    torque figure scales linearly, so another material is a multiplication.
    """
    idx = underside_vertices(local_mesh)
    placed_all = local_mesh.verts.astype(np.float64) @ rotation.T + translation

    report: dict = {"underside_samples": int(len(idx))}

    if len(idx):
        d = signed_distance_to_hat(placed_all[idx], hat) / MM
        tol = placement_cfg.contact_tolerance_mm
        # The number that decides rigid versus conforming is how far the flat
        # back departs from the brim ACROSS the footprint, not how far it sits
        # off it: a deliberate standoff shifts every gap equally and says
        # nothing about whether the shapes match. Measured from the closest
        # approach, so it is independent of surface_offset_mm.
        seated = d - d.min()
        report.update({
            "gap_min_mm": round(float(d.min()), 4),
            "gap_max_mm": round(float(d.max()), 4),
            "gap_mean_mm": round(float(d.mean()), 4),
            "gap_p95_mm": round(float(np.percentile(d, 95)), 4),
            "conformance_error_mm": round(float(d.max() - d.min()), 4),
            "seated_fraction": round(float((seated <= tol).mean()), 4),
            "contact_fraction": round(float((np.abs(d) <= tol).mean()), 4),
            "contact_tolerance_mm": tol,
        })

    # Interference: any part of the flower inside the hat, not just its base.
    #
    # Attachment pins are excluded, because passing through the hat is the
    # entire point of a pin. Counting them made a correctly fitted accessory
    # report 7.2 mm of collision. Their protrusion is measured separately, by
    # attachment.check_pins_clear_the_hat.
    body = np.ones(local_mesh.n_verts, dtype=bool)
    mount_faces = local_mesh.parts >= PART_MOUNT
    if mount_faces.any():
        body[:] = False
        body[np.unique(local_mesh.faces[~mount_faces])] = True
    d_all = signed_distance_to_hat(placed_all[body], hat) / MM
    worst = float(d_all.min())
    report["interference_mm"] = round(-worst, 4) if worst < 0 else 0.0
    report["vertices_inside_hat"] = int((d_all < -1e-6).sum())
    report["mount_vertices_excluded"] = int((~body).sum())

    # Load on the brim.
    centroid, volume = mesh_centroid(local_mesh)
    centroid_world = rotation @ centroid + translation
    r_centroid = float(np.hypot(centroid_world[0], centroid_world[1]))
    rh = head_radius(hat_cfg.head_circumference_mm)
    vol_cm3 = abs(volume) / MM3 / 1000.0
    mass_g = vol_cm3 * density_g_cm3
    arm_mm = max(0.0, (r_centroid - rh) / MM)
    report.update({
        "volume_cm3": round(vol_cm3, 3),
        "assumed_density_g_cm3": density_g_cm3,
        "mass_g": round(mass_g, 2),
        "centroid_radius_mm": round(r_centroid / MM, 2),
        "outboard_of_crown_mm": round(arm_mm, 2),
        # g.mm about the crown foot, where the brim is supported by the head.
        "brim_moment_g_mm": round(mass_g * arm_mm, 1),
    })
    return report


def summarise(reports: dict[str, dict], placement_cfg) -> dict:
    """Roll the per-piece reports into the verdict the design decision needs."""
    gaps = [r["gap_max_mm"] for r in reports.values() if "gap_max_mm" in r]
    inter = [r["interference_mm"] for r in reports.values()]
    contact = [r["contact_fraction"] for r in reports.values() if "contact_fraction" in r]
    conf = [r["conformance_error_mm"] for r in reports.values()
            if "conformance_error_mm" in r]
    seated = [r["seated_fraction"] for r in reports.values() if "seated_fraction" in r]
    return {
        "worst_gap_mm": round(max(gaps), 4) if gaps else None,
        "worst_interference_mm": round(max(inter), 4) if inter else 0.0,
        "conformance_error_mm": round(max(conf), 4) if conf else None,
        "min_seated_fraction": round(min(seated), 4) if seated else None,
        "min_contact_fraction": round(min(contact), 4) if contact else None,
        "total_mass_g": round(sum(r["mass_g"] for r in reports.values()), 2),
        "total_brim_moment_g_mm": round(sum(r["brim_moment_g_mm"] for r in reports.values()), 1),
        "conform_mode": placement_cfg.conform.value
        if hasattr(placement_cfg.conform, "value") else placement_cfg.conform,
    }
