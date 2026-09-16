"""Curve sampling and value noise shared by the petal and split engines."""
from __future__ import annotations

import numpy as np


def bezier(points: np.ndarray, t: np.ndarray) -> np.ndarray:
    """De Casteljau evaluation of a Bezier curve of any degree at parameters t."""
    pts = np.asarray(points, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64).reshape(-1, 1)
    cur = np.broadcast_to(pts[None, :, :], (len(t), *pts.shape)).copy()
    n = pts.shape[0]
    for k in range(1, n):
        cur = cur[:, :n - k] * (1 - t)[:, :, None] + cur[:, 1:n - k + 1] * t[:, :, None]
    return cur[:, 0, :]


def catmull_rom(points: np.ndarray, samples: int) -> np.ndarray:
    """Centripetal Catmull-Rom spline through the given points."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        t = np.linspace(0, 1, samples)[:, None]
        return p[0] * (1 - t) + p[-1] * t
    ext = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    segs = len(p) - 1
    per = max(2, samples // segs)
    out = []
    for i in range(segs):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        t = np.linspace(0, 1, per, endpoint=(i == segs - 1))[:, None]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t
                          + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t ** 2
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return np.vstack(out)


def resample_by_arclength(pts: np.ndarray, n: int) -> np.ndarray:
    """Resample a polyline to n points at uniform arclength."""
    p = np.asarray(pts, dtype=np.float64)
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    if s[-1] <= 0:
        return np.repeat(p[:1], n, axis=0)
    target = np.linspace(0, s[-1], n)
    return np.stack([np.interp(target, s, p[:, k]) for k in range(p.shape[1])], axis=1)


def value_noise_1d(x: np.ndarray, seed: int, octaves: int = 3,
                   roughness: float = 0.5, base_freq: float = 1.0) -> np.ndarray:
    """Deterministic smooth 1-D fractal value noise in roughly [-1, 1].

    Used for the organic split's wander and per-petal variation. Seeded so the
    same config always produces the same shape.
    """
    x = np.asarray(x, dtype=np.float64)
    total = np.zeros_like(x)
    amp, freq, norm = 1.0, base_freq, 0.0
    for o in range(octaves):
        rng = np.random.default_rng(seed * 7919 + o * 104729)
        n_knots = int(max(4, 8 * freq)) + 1
        knots = rng.uniform(-1.0, 1.0, n_knots)
        pos = x * freq
        i0 = np.floor(pos).astype(np.int64)
        frac = pos - i0
        a = knots[np.mod(i0, n_knots)]
        b = knots[np.mod(i0 + 1, n_knots)]
        sm = frac * frac * (3 - 2 * frac)          # smoothstep
        total += amp * (a * (1 - sm) + b * sm)
        norm += amp
        amp *= roughness
        freq *= 2.0
    return total / max(norm, 1e-9)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((np.asarray(x, dtype=np.float64) - edge0) / max(edge1 - edge0, 1e-9), 0.0, 1.0)
    return t * t * (3 - 2 * t)
