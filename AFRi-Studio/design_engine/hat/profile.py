"""The hat's meridian profile.

A hat is very nearly a surface of revolution, so the honest way to model one is
to get the meridian right and sweep it. The profile is the *mid-surface*: the
sheet the felt or straw occupies, before it is given thickness.

The profile runs from the crown apex outward and downward to the brim edge, in
scene units, with r measured from the axis and z from the plane where the crown
meets the brim.

    z
    ^    ___
    |   /   \\        crown        <- apex at r = 0
    |  |     |
    +--+-----+------------------  brim starts where the crown foot lands
    |        \\______              brim, drooping and curling at the edge
    +-----------------> r

Everything is driven by real hat sizing: head circumference sets the radius,
because that is the one dimension a hat cannot get wrong.
"""
from __future__ import annotations

import numpy as np

from design_engine.geometry.curves import resample_by_arclength

MM = 0.1  # 1 scene unit == 10 mm, matching the flower engine


# Style presets. Each is a set of shape multipliers applied on top of the
# explicit millimetre dimensions, so a style can be chosen and then overridden.
STYLE_PRESETS = {
    # crown_taper, crown_dome, side_flare, brim_rise, edge_softness, crease
    # edge_softness is the corner radius as a fraction of profile length. It
    # has to stay small: a fedora's crown top edge is a defined break, and
    # smoothing it generously turns the hat into a bowler.
    "fedora":     dict(crown_taper=0.86, crown_dome=0.085, side_flare=0.72,
                       brim_rise=1.25, edge_softness=0.013, crease=1.0),
    "boater":     dict(crown_taper=1.00, crown_dome=0.00, side_flare=1.00,
                       brim_rise=1.00, edge_softness=0.005, crease=0.0),
    "wide_brim":  dict(crown_taper=0.90, crown_dome=0.075, side_flare=0.80,
                       brim_rise=1.35, edge_softness=0.016, crease=0.45),
    "cloche":     dict(crown_taper=0.72, crown_dome=0.38, side_flare=0.55,
                       brim_rise=1.55, edge_softness=0.030, crease=0.0),
    "bucket":     dict(crown_taper=0.94, crown_dome=0.16, side_flare=0.88,
                       brim_rise=1.15, edge_softness=0.028, crease=0.0),
}


def head_radius(head_circumference_mm: float) -> float:
    """Radius of the head opening, in scene units.

    This is the dimension that makes a hat wearable, so it is derived from the
    circumference rather than guessed: a 58 cm hat is a 92.3 mm radius.
    """
    return (head_circumference_mm / (2.0 * np.pi)) * MM


def _smooth(prof: np.ndarray, softness: float) -> np.ndarray:
    """Round the profile's corners with a small Gaussian pass.

    Felt and straw do not fold to a mathematical corner; the crown top edge and
    the crown-to-brim break are radiused. Smoothing the sampled meridian is a
    far more robust way to get that than constructing fillets by hand, and the
    radius it produces is controlled by the style.
    """
    n = len(prof)
    sigma = max(0.5, softness * n)
    half = int(np.ceil(sigma * 3))
    if half < 1:
        return prof
    x = np.arange(-half, half + 1)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    k /= k.sum()
    # Replicate the ends so smoothing cannot shorten the profile.
    pad = np.concatenate([np.repeat(prof[:1], half, axis=0), prof,
                          np.repeat(prof[-1:], half, axis=0)])
    out = np.stack([np.convolve(pad[:, c], k, mode="valid") for c in range(2)], axis=1)
    out[0, 0] = 0.0 if prof[0, 0] < 1e-9 else out[0, 0]
    return out


def build_hat_profile(cfg, samples: int = 200) -> np.ndarray:
    """The mid-surface meridian, (N,2) of (r, z), apex first.

    Sampled densely per section, smoothed to round the two real corners, then
    resampled to uniform arclength so the revolved mesh tessellates evenly.
    """
    preset = STYLE_PRESETS[cfg.style.value if hasattr(cfg.style, "value") else cfg.style]
    taper = cfg.crown_taper if cfg.crown_taper > 0 else preset["crown_taper"]

    rh = head_radius(cfg.head_circumference_mm)
    rt = rh * taper                                  # crown top radius
    H = cfg.crown_height_mm * MM
    bw = cfg.brim_width_mm * MM
    dome = preset["crown_dome"] * H
    droop = np.deg2rad(cfg.brim_droop_deg)

    # ---- crown top: a shallow dome falling to the top edge ---------------
    nA = 64
    rA = np.linspace(0.0, rt, nA)
    u = rA / max(rt, 1e-9)
    zA = H + dome * np.clip(1.0 - u ** 2, 0.0, 1.0) ** 1.35

    # ---- crown side: down to the brim, flaring slightly outward ----------
    nC = 96
    t = np.linspace(0.0, 1.0, nC + 1)[1:]
    rC = rt + (rh - rt) * t ** preset["side_flare"]
    zC = H * (1.0 - t) ** 1.12

    # ---- brim: droops on the way out, then curls up at the very edge -----
    nE = 110
    v = np.linspace(0.0, 1.0, nE + 1)[1:]
    rE = rh + bw * v
    zE = (-np.tan(droop) * bw * v ** preset["brim_rise"]
          + cfg.brim_curl * bw * v ** 3.4)

    prof = np.concatenate([
        np.stack([rA, zA], axis=1),
        np.stack([rC, zC], axis=1),
        np.stack([rE, zE], axis=1),
    ])
    prof = _smooth(prof, preset["edge_softness"])
    prof = resample_by_arclength(prof, samples)
    prof[0, 0] = 0.0          # the apex must sit exactly on the axis
    return prof


def brim_span(prof: np.ndarray, rh: float) -> tuple[int, int]:
    """Index range of the brim section: from the crown foot to the outer edge.

    Found by radius rather than assumed by index, because smoothing and
    arclength resampling both move the section boundaries.
    """
    # The LAST point at or inside the head radius is the crown foot. Taking the
    # nearest one instead breaks on a boater, whose crown side sits at exactly
    # rh for its whole height.
    inside = np.nonzero(prof[:, 0] <= rh + 1e-6)[0]
    start = int(inside[-1]) if len(inside) else 0
    return start, len(prof) - 1
