"""Petal outline families.

A marigold ray floret is not a daisy petal. It is broad and obovate -- narrow
at the root, widening quickly, and staying broad right to a rounded, slightly
toothed end.

The end is rounded in *length*, not in width. Tapering the width to nothing at
the tip and separately notching the centre leaves the two edges as the
furthest-forward points, which renders as a squared keyhole rather than a petal.
"""
from __future__ import annotations

import numpy as np

from design_engine.geometry.curves import smoothstep


def width_profile(u: np.ndarray, family: str = "obovate",
                  ruffle_amp: float = 0.0, ruffle_freq: float = 3.0,
                  phase: float = 0.0) -> np.ndarray:
    """Half-width of the petal at each lengthwise position u in [0,1].

    Values are roughly in [0,1] and get scaled by the petal's width. The petal
    stays broad at the tip; rounding happens in ``tip_length_profile``.
    """
    u = np.asarray(u, dtype=np.float64)
    if family == "spoon":
        base = 0.16 + 0.84 * smoothstep(0.0, 0.70, u)
    elif family == "strap":
        base = 0.62 + 0.38 * smoothstep(0.0, 0.30, u)
    else:  # obovate -- the marigold default
        base = 0.22 + 0.78 * np.power(np.clip(u, 0, 1), 0.50)

    # Crenulate edge: shallow scalloping along the rim, not deep stepping.
    if ruffle_amp > 0:
        base = base * (1.0 + 0.10 * ruffle_amp *
                       np.sin(ruffle_freq * 2 * np.pi * u + phase))
    return np.clip(base, 0.0, None)


def tip_length_profile(v: np.ndarray, notch: float) -> np.ndarray:
    """Lengthwise scale across the petal width -- this is what shapes the end.

    A near-elliptical falloff gives the broad rounded end of a ray floret, and
    a shallow central dip adds the gentle bilobing many marigold cultivars show.
    """
    v = np.asarray(v, dtype=np.float64)
    rounding = np.sqrt(np.clip(1.0 - 0.88 * v ** 2, 0.0, 1.0))
    if notch <= 0:
        return rounding
    centre_dip = 0.16 * notch * np.exp(-(v / 0.40) ** 2)
    return rounding - centre_dip
