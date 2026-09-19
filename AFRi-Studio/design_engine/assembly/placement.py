"""Putting the flower on the hat.

The brim is doubly curved, so a flat-backed flower cannot sit flush on it. The
plan for stage two proposed two approaches and said they should be *evaluated*
rather than assumed:

1. **Rigid.** Keep the flower flat and let the fixing take up the gap.
2. **Surface conform.** Deform the base to the local brim surface and rebuild
   the petals on it.

This module implements rigid placement, and measures the gap it leaves. That
measurement is the whole point: conforming is a genuine piece of new work -- the
split path is a function of y in a plane, and lifting it onto a curved base is
not a parameter change -- so it should only be undertaken if the numbers say
the rigid mount is not good enough.

Frame convention: the flower is built +Z up with its base on z = 0 and centred
on the origin, so placing it means mapping its local axes onto a tangent frame
of the hat's outer skin.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from design_engine.geometry.mesh import Mesh
from design_engine.hat.hat import HatResult
from design_engine.hat.profile import MM, brim_span, head_radius


@dataclass
class Frame:
    """A right-handed frame on the hat's outer skin, [tangent, bitangent, normal]."""
    origin: np.ndarray       # (3,) world position on the outer skin
    tangent: np.ndarray      # (3,) along the meridian, pointing outward
    bitangent: np.ndarray    # (3,) circumferential
    normal: np.ndarray       # (3,) away from the hat
    profile_index: int
    radius_mm: float
    surface_z_mm: float

    def matrix(self) -> np.ndarray:
        return np.stack([self.tangent, self.bitangent, self.normal], axis=1)


def _meridian_frame(prof: np.ndarray, index: float) -> tuple[np.ndarray, np.ndarray]:
    """Position and outward normal in the (r, z) plane, at a fractional index."""
    i0 = int(np.clip(np.floor(index), 0, len(prof) - 2))
    f = float(np.clip(index - i0, 0.0, 1.0))
    p = prof[i0] * (1 - f) + prof[i0 + 1] * f
    d = prof[min(i0 + 1, len(prof) - 1)] - prof[max(i0 - 1, 0)]
    n = np.array([-d[1], d[0]], dtype=np.float64)   # rotate the tangent +90 deg
    ln = np.linalg.norm(n)
    n = n / (ln if ln > 1e-12 else 1.0)
    t = np.array([d[0], d[1]], dtype=np.float64)
    lt = np.linalg.norm(t)
    t = t / (lt if lt > 1e-12 else 1.0)
    return p, np.stack([t, n])


def surface_frame(hat: HatResult, hat_cfg, placement_cfg) -> Frame:
    """Where the flower sits, and which way is 'up' for it there.

    ``radial_position`` runs 0 at the crown foot -- against the band, where a
    milliner actually mounts a flower -- to 1 at the brim edge.
    """
    prof = hat.profile
    rh = head_radius(hat_cfg.head_circumference_mm)
    start, end = brim_span(prof, rh)
    t = float(np.clip(placement_cfg.radial_position, 0.0, 1.0))
    index = start + t * (end - start)

    p_rz, (tan_rz, nrm_rz) = _meridian_frame(prof, index)
    # Lift onto the outer skin, then by whatever standoff was asked for.
    lift = hat_cfg.thickness_mm * MM * 0.5 + placement_cfg.surface_offset_mm * MM
    p_rz = p_rz + nrm_rz * lift

    phi = np.deg2rad(placement_cfg.azimuth_deg)
    c, s = np.cos(phi), np.sin(phi)
    origin = np.array([p_rz[0] * c, p_rz[0] * s, p_rz[1]])
    normal = np.array([nrm_rz[0] * c, nrm_rz[0] * s, nrm_rz[1]])
    tangent = np.array([tan_rz[0] * c, tan_rz[0] * s, tan_rz[1]])
    normal /= np.linalg.norm(normal)
    tangent -= normal * float(tangent @ normal)          # re-orthogonalise
    tangent /= np.linalg.norm(tangent)
    bitangent = np.cross(normal, tangent)

    return Frame(origin=origin, tangent=tangent, bitangent=bitangent, normal=normal,
                 profile_index=int(round(index)),
                 radius_mm=float(p_rz[0] / MM), surface_z_mm=float(p_rz[1] / MM))


def placement_matrix(frame: Frame, placement_cfg) -> tuple[np.ndarray, np.ndarray]:
    """The 3x3 rotation and the translation that carry local space to world.

    Roll spins the flower in its own plane -- which is what aims the dividing
    curve -- and tilt then tips it outward over the brim or back toward the
    crown.
    """
    T, B, N = frame.tangent.copy(), frame.bitangent.copy(), frame.normal.copy()

    roll = np.deg2rad(placement_cfg.roll_deg)
    if abs(roll) > 1e-12:
        cr, sr = np.cos(roll), np.sin(roll)
        T, B = T * cr + B * sr, -T * sr + B * cr

    tilt = np.deg2rad(placement_cfg.tilt_deg)
    if abs(tilt) > 1e-12:
        ct, st = np.cos(tilt), np.sin(tilt)
        T, N = T * ct - N * st, T * st + N * ct

    return np.stack([T, B, N], axis=1), frame.origin


def place(mesh: Mesh, rotation: np.ndarray, translation: np.ndarray) -> Mesh:
    """Carry a mesh from flower-local space onto the hat."""
    v = mesh.verts.astype(np.float64) @ rotation.T + translation
    return Mesh(v.astype(np.float32), mesh.faces, mesh.parts, name=mesh.name)


def place_on_hat(meshes: dict[str, Mesh], hat: HatResult, hat_cfg, placement_cfg
                 ) -> tuple[dict[str, Mesh], Frame, np.ndarray, np.ndarray]:
    """Place every given mesh with one shared transform.

    One transform for all of them, so the two pieces keep their exact spatial
    relationship: placing them separately would let them drift apart by a
    rounding error and stop mating.
    """
    frame = surface_frame(hat, hat_cfg, placement_cfg)
    R, t = placement_matrix(frame, placement_cfg)
    return {k: place(m, R, t) for k, m in meshes.items()}, frame, R, t
