"""Builds one petal as a closed solid shell.

Solidity matters: the split kernel clips triangles against a vertical surface,
and clipping a *closed* solid yields closed solids. If petals were open sheets
the two pieces would have ragged open edges at the cut. So every petal is a
real volume -- a mid-surface offset both ways by half the material thickness,
with a stitched rim.
"""
from __future__ import annotations

import numpy as np

from design_engine.geometry.mesh import Mesh, grid_faces
from design_engine.petals.profile import tip_length_profile, width_profile


def build_petal(
    length: float,
    width: float,
    thickness: float,
    *,
    segments_u: int = 14,
    segments_v: int = 9,
    curl: float = 0.5,
    cup: float = 0.4,
    ruffle_amp: float = 0.3,
    ruffle_freq: float = 3.6,
    notch: float = 0.2,
    twist: float = 0.0,
    tilt: float = 0.0,
    family: str = "obovate",
    phase: float = 0.0,
    part_id: int = 0,
    name: str = "petal",
) -> Mesh:
    """Build a petal in local space.

    Local frame: +X is outward along the petal from its root at the origin,
    +Z is up. ``tilt`` lifts the root tangent; ``curl`` bends the petal along
    its length on top of that tilt.
    """
    nu = max(5, int(segments_u))
    nv = max(3, int(segments_v))
    u = np.linspace(0.0, 1.0, nu)
    v = np.linspace(-1.0, 1.0, nv)
    U, V = np.meshgrid(u, v, indexing="ij")

    # ---- centreline: bend the petal by integrating a turning tangent -----
    # The tangent angle rises from `tilt` at the root by up to ~105 deg of curl.
    bend = curl * np.deg2rad(105.0)
    phi = tilt + bend * (u ** 1.25)
    du = 1.0 / (nu - 1)
    cx = np.concatenate([[0.0], np.cumsum(np.cos(phi[:-1]) * du)]) * length
    cz = np.concatenate([[0.0], np.cumsum(np.sin(phi[:-1]) * du)]) * length

    # ---- width and the bilobed tip --------------------------------------
    half_w = width_profile(u, family=family, ruffle_amp=ruffle_amp,
                           ruffle_freq=ruffle_freq, phase=phase) * (width * 0.5)
    tip_scale = tip_length_profile(v, notch)

    # The tip shaping only bites over the outer part of the petal, so the root
    # and shoulders keep their full width.
    notch_region = np.clip((U - 0.55) / 0.45, 0.0, 1.0) ** 1.1
    U_eff = U * (1.0 - notch_region * (1.0 - tip_scale[None, :]))

    # Re-evaluate the centreline at the per-column effective u.
    X = np.interp(U_eff.ravel(), u, cx).reshape(U.shape)
    Z = np.interp(U_eff.ravel(), u, cz).reshape(U.shape)
    T = np.interp(U_eff.ravel(), u, phi).reshape(U.shape)   # local tangent angle
    W = np.interp(U_eff.ravel(), u, half_w).reshape(U.shape)

    Y = V * W

    # ---- crosswise cupping: lift the edges into a channel -----------------
    Z = Z + cup * W * (V ** 2 - 0.30)

    # ---- edge ruffle: a travelling wave strongest at the rim -------------
    if ruffle_amp > 0:
        ruf = (ruffle_amp * 0.30 * width
               * np.abs(V) ** 2.1
               * np.sin(ruffle_freq * 2 * np.pi * U_eff + phase + 1.7 * V))
        Z = Z + ruf

    # ---- twist about the petal's own long axis ---------------------------
    if abs(twist) > 1e-6:
        ang = twist * U_eff
        Yc, Zc = Y.copy(), Z.copy()
        Zbase = np.interp(U_eff.ravel(), u, cz).reshape(U.shape)
        dz = Zc - Zbase
        Y = Yc * np.cos(ang) - dz * np.sin(ang)
        Z = Zbase + Yc * np.sin(ang) + dz * np.cos(ang)

    # The surface is described in the petal's bending frame; X already carries
    # the arc, so lift Z into world by the tangent-consistent offset.
    mid = np.stack([X, Y, Z], axis=-1)

    # ---- surface normals from the parametric tangents --------------------
    dPdu = np.gradient(mid, axis=0)
    dPdv = np.gradient(mid, axis=1)
    N = np.cross(dPdu, dPdv)
    nl = np.linalg.norm(N, axis=-1, keepdims=True)
    N = np.divide(N, np.where(nl < 1e-12, 1.0, nl))
    # Keep normals pointing generally upward, consistent across the sheet.
    flip = np.sign(np.sum(N[..., 2])) or 1.0
    N = N * flip
    # Where the tangent is near-degenerate, fall back to the local up vector.
    bad = (nl[..., 0] < 1e-9)
    if bad.any():
        up = np.zeros_like(N)
        up[..., 2] = 1.0
        N[bad] = up[bad]

    h = thickness * 0.5
    top = mid + N * h
    bot = mid - N * h

    nvert = nu * nv
    verts = np.concatenate([top.reshape(-1, 3), bot.reshape(-1, 3)], axis=0)

    faces = [grid_faces(nu, nv, flip=False, offset=0),
             grid_faces(nu, nv, flip=True, offset=nvert)]

    # ---- stitch the rim so the petal is a closed volume ------------------
    def quad(a, b, c, d):
        return np.array([[a, b, c], [a, c, d]], dtype=np.int32)

    rim = []
    ti = lambda i, j: i * nv + j            # noqa: E731
    bi = lambda i, j: nvert + i * nv + j    # noqa: E731
    for i in range(nu - 1):                  # v = -1 edge
        rim.append(quad(ti(i, 0), bi(i, 0), bi(i + 1, 0), ti(i + 1, 0)))
    for i in range(nu - 1):                  # v = +1 edge
        rim.append(quad(ti(i, nv - 1), ti(i + 1, nv - 1), bi(i + 1, nv - 1), bi(i, nv - 1)))
    for j in range(nv - 1):                  # root edge
        rim.append(quad(ti(0, j), ti(0, j + 1), bi(0, j + 1), bi(0, j)))
    for j in range(nv - 1):                  # tip edge
        rim.append(quad(ti(nu - 1, j), bi(nu - 1, j), bi(nu - 1, j + 1), ti(nu - 1, j + 1)))
    faces.append(np.concatenate(rim))

    F = np.concatenate(faces).astype(np.int32)
    mesh = Mesh(verts.astype(np.float32), F,
                np.full(len(F), part_id, dtype=np.int32), name=name)
    mesh = mesh.drop_degenerate(1e-12)

    # The tip can collapse to a point where the width profile reaches zero, so
    # weld coincident vertices before orienting -- otherwise the pinch reads as
    # a hole rather than a cone point.
    return mesh.welded(1e-5).oriented()
