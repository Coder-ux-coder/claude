"""Structural base disc and the domed centre boss.

The base disc is the part that gives each half physical integrity: without it
the two pieces would be loose bundles of petals. It is a shallow domed disc
that every petal root sits on.
"""
from __future__ import annotations

import numpy as np

from design_engine.geometry.mesh import PART_BASE, PART_CENTER, Mesh, grid_faces


def build_base_disc(radius: float, thickness: float, dome_height: float,
                    segments: int = 64, rings: int = 10,
                    root_profile: tuple[np.ndarray, np.ndarray] | None = None) -> Mesh:
    """A domed disc, closed, centred at the origin, sitting on z=0.

    ``root_profile`` is ``(radius_ascending, root_z)`` sampled from the petal
    layer schedule. When given, the dome is built to *follow the petal roots*
    rather than to an arbitrary height, so every row is physically embedded in
    the structure.

    This matters more than it looks. With a plain shallow dome the inner rows
    end up floating above the base with nothing holding them: measured on the
    shipped defaults, rows 4 and 5 sat 0.64 mm and 1.61 mm clear of it. They
    render perfectly well -- and are not attached to anything. A receptacle
    that rises to meet each root is also what a real composite flower has.
    """
    segments = max(12, int(segments))
    rings = max(3, int(rings))
    theta = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    rr = np.linspace(0.0, 1.0, rings)

    R, T = np.meshgrid(rr, theta, indexing="ij")
    x = R * radius * np.cos(T)
    y = R * radius * np.sin(T)
    if root_profile is None:
        # Dome falls off toward the rim.
        z_top = dome_height * np.cos(np.clip(R, 0, 1) * np.pi * 0.5) ** 1.5 + thickness
    else:
        r_asc, z_asc = root_profile
        z_root = np.interp((R * radius).ravel(), r_asc, z_asc).reshape(R.shape)
        # The disc keeps its flat thickness out at the rim, where there are no
        # roots left to reach.
        z_top = np.maximum(thickness, z_root)
    z_bot = np.zeros_like(x)

    top = np.stack([x, y, z_top], -1).reshape(-1, 3)
    bot = np.stack([x, y, z_bot], -1).reshape(-1, 3)
    nvert = len(top)
    verts = np.concatenate([top, bot])

    def ring_faces(offset, flip):
        f = []
        for i in range(rings - 1):
            for j in range(segments):
                jn = (j + 1) % segments
                a = offset + i * segments + j
                b = offset + i * segments + jn
                c = offset + (i + 1) * segments + jn
                d = offset + (i + 1) * segments + j
                if flip:
                    f += [[a, c, b], [a, d, c]]
                else:
                    f += [[a, b, c], [a, c, d]]
        return np.array(f, dtype=np.int32)

    faces = [ring_faces(0, False), ring_faces(nvert, True)]
    # rim wall
    rim = []
    for j in range(segments):
        jn = (j + 1) % segments
        t0 = (rings - 1) * segments + j
        t1 = (rings - 1) * segments + jn
        b0 = nvert + t0
        b1 = nvert + t1
        rim += [[t0, b0, b1], [t0, b1, t1]]
    faces.append(np.array(rim, dtype=np.int32))

    F = np.concatenate(faces)
    m = Mesh(verts.astype(np.float32), F,
             np.full(len(F), PART_BASE, dtype=np.int32), name="base_disc")
    return m.welded(1e-5).oriented()


def build_center(radius: float, height: float, floret_rings: int = 5,
                 segments: int = 72, seed: int = 0) -> Mesh:
    """The marigold centre: a dome packed with tiny disc florets.

    A real marigold centre is a mass of tiny tubular florets, not a flat button.
    The dome carries rings of small bumps to read that way at accessory scale.
    """
    segments = max(12, int(segments))
    rings = 20
    theta = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    rr = np.linspace(0.0, 1.0, rings)
    R, T = np.meshgrid(rr, theta, indexing="ij")

    # Spherical-cap dome.
    z = height * np.cos(np.clip(R, 0, 1) * np.pi * 0.5)
    x = R * radius * np.cos(T)
    y = R * radius * np.sin(T)

    # Floret texture. A marigold centre is a mass of tiny tubular florets, not
    # a smooth button, and at accessory scale that has to read as distinct
    # bumps rather than a faint ripple.
    if floret_rings > 0:
        petal_ripple = np.sin(T * max(10, segments // 3))
        ring_ripple = np.sin(R * np.pi * floret_rings * 2.0)
        falloff = np.sin(np.clip(R, 0, 1) * np.pi) ** 0.6
        z = z + ring_ripple * petal_ripple * falloff * height * 0.30
        # A spiral component so the florets do not sit in neat radial rows.
        z = z + np.sin(T * 7 + R * np.pi * 5) * falloff * height * 0.12
        rad_bump = 1.0 + 0.055 * ring_ripple * petal_ripple
        x, y = x * rad_bump, y * rad_bump

    top = np.stack([x, y, z], -1).reshape(-1, 3)
    bot = np.stack([x, y, np.zeros_like(z)], -1).reshape(-1, 3)
    nvert = len(top)
    verts = np.concatenate([top, bot])

    def ring_faces(offset, flip):
        f = []
        for i in range(rings - 1):
            for j in range(segments):
                jn = (j + 1) % segments
                a = offset + i * segments + j
                b = offset + i * segments + jn
                c = offset + (i + 1) * segments + jn
                d = offset + (i + 1) * segments + j
                f += ([[a, c, b], [a, d, c]] if flip else [[a, b, c], [a, c, d]])
        return np.array(f, dtype=np.int32)

    faces = [ring_faces(0, False), ring_faces(nvert, True)]
    rim = []
    for j in range(segments):
        jn = (j + 1) % segments
        t0 = (rings - 1) * segments + j
        t1 = (rings - 1) * segments + jn
        rim += [[t0, nvert + t0, nvert + t1], [t0, nvert + t1, t1]]
    faces.append(np.array(rim, dtype=np.int32))

    F = np.concatenate(faces)
    m = Mesh(verts.astype(np.float32), F,
             np.full(len(F), PART_CENTER, dtype=np.int32), name="center")
    return m.welded(1e-5).oriented()
