"""Split path families.

Every path is expressed as ``x = f(y)`` -- a function of y, never an arbitrary
parametric curve. That restriction is what guarantees the path divides the
plane into exactly two simply-connected regions, so ``sign(x - f(y))`` is a
sound two-way classifier with no self-intersection ambiguity.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from design_engine.configurations.schema import SplitConfig, SplitType
from design_engine.geometry.curves import value_noise_1d

SAMPLES = 512


@dataclass
class SplitPath:
    """A sampled ``x = f(y)`` path plus its arclength parameterisation.

    The path lives in the *split frame*. An angled split is produced by rotating
    the flower into that frame, cutting, and rotating the pieces back, so
    ``orientation_deg`` records the rotation needed to get from world space back
    here. Anything measuring which side of the cut a world-space point lies on
    must go through :meth:`signed`, not ``f`` directly.
    """
    y: np.ndarray          # (N,) strictly increasing
    x: np.ndarray          # (N,)
    arclength: np.ndarray  # (N,) cumulative, starting at 0
    kind: str
    extent: float
    orientation_deg: float = 0.0

    def f(self, y: np.ndarray) -> np.ndarray:
        """Lateral position of the path at the given y (clamped outside)."""
        return np.interp(np.asarray(y, dtype=np.float64), self.y, self.x)

    def to_split_frame(self, verts: np.ndarray) -> np.ndarray:
        """Rotate world-space points into the split frame."""
        v = np.asarray(verts, dtype=np.float64)
        if abs(self.orientation_deg) < 1e-12:
            return v
        t = np.deg2rad(-self.orientation_deg)
        c, s = np.cos(t), np.sin(t)
        out = v.copy()
        out[:, 0] = v[:, 0] * c - v[:, 1] * s
        out[:, 1] = v[:, 0] * s + v[:, 1] * c
        return out

    def signed(self, verts: np.ndarray) -> np.ndarray:
        """Signed distance-ish field for world-space points.

        Positive means piece A's side. This is the only correct way to ask which
        side of the cut a point is on once the pieces have been rotated back to
        world space.
        """
        v = self.to_split_frame(verts)
        return v[:, 0] - self.f(v[:, 1])

    def t_of_y(self, y: np.ndarray) -> np.ndarray:
        """Arclength coordinate at the given y. Flattens the cut wall to 2D."""
        return np.interp(np.asarray(y, dtype=np.float64), self.y, self.arclength)

    def mean_normal(self) -> np.ndarray:
        """Average in-plane normal, used as the separation direction."""
        dy = np.gradient(self.y)
        dx = np.gradient(self.x)
        n = np.stack([dy, -dx], axis=1)
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        n = n / np.where(ln < 1e-12, 1.0, ln)
        m = n.mean(axis=0)
        ln = np.linalg.norm(m)
        return (m / ln) if ln > 1e-9 else np.array([1.0, 0.0])

    def polyline3d(self, z: float = 0.0) -> np.ndarray:
        return np.stack([self.x, self.y, np.full_like(self.y, z)], axis=1)

    def to_dict(self) -> dict:
        step = max(1, len(self.y) // 128)
        return {"kind": self.kind, "extent": float(self.extent),
                "points": [[round(float(a), 5), round(float(b), 5)]
                           for a, b in zip(self.x[::step], self.y[::step])],
                "length": float(self.arclength[-1])}


def _catmull_rom_1d(ys: np.ndarray, xs: np.ndarray, query: np.ndarray,
                    tension: float) -> np.ndarray:
    """Catmull-Rom interpolation of x over a strictly increasing y.

    Interpolating in y (rather than sampling a 2-D spline) keeps the result a
    function of y by construction. ``tension`` controls how taut or flowing the
    curve is between control points.
    """
    ys = np.asarray(ys, dtype=np.float64)
    xs = np.asarray(xs, dtype=np.float64)
    if len(ys) < 3:
        return np.interp(query, ys, xs)

    # Phantom endpoints so the first and last spans are shaped, not linear.
    Y = np.concatenate([[2 * ys[0] - ys[1]], ys, [2 * ys[-1] - ys[-2]]])
    X = np.concatenate([[2 * xs[0] - xs[1]], xs, [2 * xs[-1] - xs[-2]]])

    q = np.clip(query, ys[0], ys[-1])
    idx = np.clip(np.searchsorted(ys, q, side="right") - 1, 0, len(ys) - 2)
    i = idx + 1                                   # index into padded arrays
    y0, y1 = Y[i], Y[i + 1]
    span = np.where((y1 - y0) == 0, 1.0, y1 - y0)
    t = (q - y0) / span

    p0, p1, p2, p3 = X[i - 1], X[i], X[i + 1], X[i + 2]
    m1 = tension * (p2 - p0)
    m2 = tension * (p3 - p1)
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1
            + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2)


def build_split_path(cfg: SplitConfig, radius: float) -> SplitPath:
    """Build the dividing curve for a flower of the given radius (scene units).

    The path is extended well beyond the flower so every triangle is classified.
    """
    extent = radius * 1.35
    y = np.linspace(-extent, extent, SAMPLES)
    yn = y / extent                                 # normalised to [-1, 1]
    pos = cfg.position * radius
    tension = 0.12 + 0.83 * cfg.smoothness

    if cfg.control_points:
        cys = np.array([p.y for p in cfg.control_points]) * extent
        cxs = np.array([p.x for p in cfg.control_points]) * radius
        x = _catmull_rom_1d(cys, cxs, y, tension)
        kind = f"{cfg.type.value}:custom"

    elif cfg.type == SplitType.BALANCED:
        # Straight, or gently sheared by a small fraction of the amplitude.
        x = pos + (cfg.amplitude * 0.30 * radius) * yn
        kind = "balanced"

    elif cfg.type == SplitType.S_RIVER:
        # A single river meander: swing to one bank, cross, swing to the other.
        amp = cfg.amplitude * radius
        cys = np.array([-1.0, -0.55, 0.0, 0.55, 1.0]) * extent
        cxs = pos + np.array([0.0, -1.0, 0.0, 1.0, 0.0]) * amp
        x = _catmull_rom_1d(cys, cxs, y, tension)
        kind = "s_river"

    elif cfg.type == SplitType.ORGANIC:
        # A gentler spine, plus seeded fractal wander that makes the division
        # irregular and asymmetric rather than merely wavy.
        amp = cfg.amplitude * radius
        cys = np.array([-1.0, -0.42, 0.18, 1.0]) * extent
        cxs = pos + np.array([0.35, -0.75, 0.30, -0.55]) * amp
        spine = _catmull_rom_1d(cys, cxs, y, tension)
        noise = value_noise_1d(yn * 1.6 + 3.0, seed=cfg.organic_seed,
                               octaves=cfg.organic_octaves,
                               roughness=0.35 + 0.5 * cfg.organic_roughness,
                               base_freq=1.5)
        x = spine + noise * amp * (0.30 + 0.70 * cfg.organic_roughness)
        kind = "organic"
    else:
        raise ValueError(f"unknown split type {cfg.type}")

    seg = np.sqrt(np.diff(x) ** 2 + np.diff(y) ** 2)
    arc = np.concatenate([[0.0], np.cumsum(seg)])
    return SplitPath(y=y, x=x, arclength=arc, kind=kind, extent=float(extent))
