"""The hat itself: a revolved shell, plus a band around the crown foot.

Construction mirrors the petal exactly, and for the same reason. The meridian
is swept to give a mid-surface, that surface is offset both ways by half the
material thickness and stitched at the brim edge, and the result is a closed
solid. Closed matters here too: an open shell would render with black
back-faces, would not export as a printable body, and could not be tested for
interpenetration against the flower.

A fedora is not a surface of revolution -- it has a lengthwise centre crease
and two finger dents near the front. Those are applied to the mid-surface
before it is thickened, so the shell stays closed and the normals stay correct.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from design_engine.geometry.mesh import PART_HAT, PART_HATBAND, Mesh
from design_engine.hat.profile import (MM, STYLE_PRESETS, brim_span,
                                       build_hat_profile, head_radius)


@dataclass
class HatResult:
    mesh: Mesh
    profile: np.ndarray        # (N,2) mid-surface meridian, (r, z)
    stats: dict
    build_seconds: float


def _crown_dent(mid: np.ndarray, prof: np.ndarray, rt: float, H: float,
                depth: float, pinch: float) -> np.ndarray:
    """The teardrop crease and the two finger dents of a soft-felt crown.

    Both are applied to the mid-surface. The crease is a downward push that is
    strongest on the plane x = 0 and fades toward the crown edge; the dents are
    inward pushes near the front. At the apex the displacement is the same for
    every angle -- which is what keeps the pole a single point rather than a
    ring with a hole in it.
    """
    if depth <= 0 and pinch <= 0:
        return mid
    out = mid.copy()
    x, y, z = out[..., 0], out[..., 1], out[..., 2]

    # Only the crown top creases; weight falls off below the top edge.
    top_z = prof[:, 1].max()
    w = np.clip((z - H * 0.72) / max(top_z - H * 0.72, 1e-6), 0.0, 1.0) ** 1.1

    if depth > 0:
        crease = np.exp(-(x / max(0.30 * rt, 1e-6)) ** 2)
        # Taper the crease out toward the front and back of the crown.
        along = np.clip(1.0 - 0.45 * (y / max(rt, 1e-6)) ** 2, 0.0, 1.0)
        out[..., 2] = z - depth * crease * along * w

    if pinch > 0:
        # Two finger dents, symmetric about the crease, set forward of centre.
        rr = max(0.42 * rt, 1e-6)
        for sx in (-1.0, 1.0):
            cx, cy = sx * 0.62 * rt, 0.58 * rt
            d2 = ((out[..., 0] - cx) ** 2 + (out[..., 1] - cy) ** 2) / rr ** 2
            g = np.exp(-d2) * w
            # Push inward, toward the crown axis.
            rad = np.sqrt(out[..., 0] ** 2 + out[..., 1] ** 2)
            safe = np.where(rad < 1e-9, 1.0, rad)
            out[..., 0] -= pinch * g * out[..., 0] / safe
            out[..., 1] -= pinch * g * out[..., 1] / safe
    return out


def revolve_shell(prof: np.ndarray, segments: int, thickness: float,
                  part_id: int, name: str, dent=None) -> tuple[Mesh, np.ndarray, np.ndarray]:
    """Sweep a meridian into a closed solid of thickness ``thickness``.

    Returns the mesh plus the mid-surface grid and its normals, which the
    placement code needs to put a flower on the outside of this surface.
    """
    n, m = len(prof), int(segments)
    theta = np.linspace(0.0, 2.0 * np.pi, m, endpoint=False)
    ct, st = np.cos(theta), np.sin(theta)

    mid = np.empty((n, m, 3), dtype=np.float64)
    mid[..., 0] = prof[:, 0][:, None] * ct[None, :]
    mid[..., 1] = prof[:, 0][:, None] * st[None, :]
    mid[..., 2] = prof[:, 1][:, None]
    if dent is not None:
        mid = dent(mid)

    # Surface normals from the parametric tangents. theta wraps, so the
    # crosswise difference is periodic; the meridian direction is not.
    dPdu = np.gradient(mid, axis=0)
    dPdv = 0.5 * (np.roll(mid, -1, axis=1) - np.roll(mid, 1, axis=1))
    N = np.cross(dPdu, dPdv)
    ln = np.linalg.norm(N, axis=-1, keepdims=True)
    N = np.divide(N, np.where(ln < 1e-12, 1.0, ln))

    # At a pole the crosswise tangent vanishes and the normal is undefined; the
    # meridian is horizontal there, so the normal is the axis.
    if prof[0, 0] < 1e-9:
        N[0, :, :] = np.array([0.0, 0.0, 1.0])
    if N[0, :, 2].mean() < 0:
        N = -N

    h = thickness * 0.5
    top = (mid + N * h).reshape(-1, 3)
    bot = (mid - N * h).reshape(-1, 3)
    nvert = n * m
    verts = np.concatenate([top, bot])

    def ring_faces(offset: int, flip: bool) -> np.ndarray:
        f = []
        for i in range(n - 1):
            for j in range(m):
                jn = (j + 1) % m
                a = offset + i * m + j
                b = offset + i * m + jn
                c = offset + (i + 1) * m + jn
                d = offset + (i + 1) * m + j
                f += ([[a, c, b], [a, d, c]] if flip else [[a, b, c], [a, c, d]])
        return np.array(f, dtype=np.int32)

    faces = [ring_faces(0, False), ring_faces(nvert, True)]

    # Stitch the outer edge so the shell is a closed volume.
    rim = []
    for j in range(m):
        jn = (j + 1) % m
        t0 = (n - 1) * m + j
        t1 = (n - 1) * m + jn
        rim += [[t0, nvert + t0, nvert + t1], [t0, nvert + t1, t1]]
    faces.append(np.array(rim, dtype=np.int32))

    F = np.concatenate(faces)
    mesh = Mesh(verts.astype(np.float32), F,
                np.full(len(F), part_id, dtype=np.int32), name=name)
    # The apex ring collapses to a point; welding turns it into a cone tip
    # rather than a ring of zero-area triangles around a hole.
    return mesh.welded(1e-5).oriented(), mid, N


def build_hat_band(prof: np.ndarray, rh: float, cfg, segments: int) -> Mesh:
    """The ribbon around the crown foot.

    Modelled as a closed loop in the meridian plane swept around the axis -- a
    torus, watertight and separate from the shell. It is also the landmark a
    real milliner mounts a flower against, so placement measures from it.
    """
    depth = cfg.band_depth_mm * MM
    height = cfg.band_height_mm * MM
    z0 = cfg.band_z_mm * MM
    z1 = z0 + height

    # Follow the crown surface, so the band sits on it rather than through it.
    zs = np.linspace(z0, z1, 24)
    crown = prof[prof[:, 1] >= -1e-6]
    r_in = np.interp(zs, crown[:, 1][::-1], crown[:, 0][::-1]) + cfg.thickness_mm * MM * 0.5
    r_out = r_in + depth

    # A closed loop: up the outside, across the top, down the inside, back.
    loop_r = np.concatenate([r_out, r_in[::-1]])
    loop_z = np.concatenate([zs, zs[::-1]])
    n, m = len(loop_r), int(segments)
    theta = np.linspace(0.0, 2.0 * np.pi, m, endpoint=False)

    verts = np.empty((n, m, 3), dtype=np.float64)
    verts[..., 0] = loop_r[:, None] * np.cos(theta)[None, :]
    verts[..., 1] = loop_r[:, None] * np.sin(theta)[None, :]
    verts[..., 2] = loop_z[:, None]

    f = []
    for i in range(n):
        inx = (i + 1) % n            # the meridian loop closes too
        for j in range(m):
            jn = (j + 1) % m
            a, b = i * m + j, i * m + jn
            c, d = inx * m + jn, inx * m + j
            f += [[a, b, c], [a, c, d]]
    F = np.array(f, dtype=np.int32)
    mesh = Mesh(verts.reshape(-1, 3).astype(np.float32), F,
                np.full(len(F), PART_HATBAND, dtype=np.int32), name="hat_band")
    return mesh.welded(1e-5).oriented()


def build_hat(cfg, progress=None) -> HatResult:
    """Build the hat. Pure geometry: no Blender, no file I/O."""
    t0 = time.perf_counter()
    style = cfg.style.value if hasattr(cfg.style, "value") else cfg.style
    preset = STYLE_PRESETS[style]

    if progress:
        progress("hat meridian", 1, 3)
    prof = build_hat_profile(cfg, samples=cfg.profile_segments)
    rh = head_radius(cfg.head_circumference_mm)
    rt = rh * (cfg.crown_taper if cfg.crown_taper > 0 else preset["crown_taper"])
    H = cfg.crown_height_mm * MM

    crease_depth = cfg.crown_crease * preset["crease"] * H * 0.34
    pinch_depth = cfg.crown_crease * preset["crease"] * rt * 0.14

    def dent(mid):
        return _crown_dent(mid, prof, rt, H, crease_depth, pinch_depth)

    if progress:
        progress("sweeping crown and brim", 2, 3)
    shell, mid, normals = revolve_shell(
        prof, cfg.revolve_segments, cfg.thickness_mm * MM,
        PART_HAT, "hat_shell", dent=dent)

    parts = [shell]
    if cfg.band_depth_mm > 0 and cfg.band_height_mm > 0:
        parts.append(build_hat_band(prof, rh, cfg, cfg.revolve_segments))

    mesh = Mesh.concat(parts, name="hat")
    dt = time.perf_counter() - t0
    b = mesh.bounds()
    bs, be = brim_span(prof, rh)
    stats = {
        **mesh.stats(),
        "style": style,
        "head_circumference_mm": round(cfg.head_circumference_mm, 1),
        "head_radius_mm": round(rh / MM, 2),
        "crown_height_mm": round(float(prof[:, 1].max() - 0.0) / MM, 2),
        "brim_width_mm": round(float(prof[-1, 0] - rh) / MM, 2),
        "overall_diameter_mm": round(float(max(b[1][0] - b[0][0], b[1][1] - b[0][1])) / MM, 2),
        "overall_height_mm": round(float(b[1][2] - b[0][2]) / MM, 2),
        "brim_edge_drop_mm": round(float(prof[-1, 1]) / MM, 2),
        "brim_index_range": [bs, be],
        "build_seconds": round(dt, 3),
    }
    if progress:
        progress(f"hat complete: {mesh.n_faces} triangles", 3, 3)
    return HatResult(mesh=mesh, profile=prof, stats=stats, build_seconds=dt)
