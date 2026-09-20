"""Concept C, version 2: the refined organic-split marigold.

v1 read as a daisy with a wandering cut. The changes here are all in service
of two things the client asked for -- a flower that reads as a *marigold*, and
a division that looks decided rather than accidental.

Marigold ray florets are short, broad and crowded; the flower is a pompon, not
a rosette of long petals. So the petals get shorter and wider, there are more
of them in more rows, they overlap harder, and the crenulated edge is deeper
and finer. The curve work is in design_engine/splitting/paths.py.
"""
from __future__ import annotations

from design_engine.configurations.schema import (DesignConfig, SplitConfig,
                                                 SplitType)

CONCEPT_NAME = "Concept C Organic Asymmetric"

# v1, kept so the two can be generated side by side and compared honestly.
V1_FLOWER = dict(
    layer_count=7, petal_count_base=21, petal_density=1.25,
    petal_length_ratio=0.46, petal_width_ratio=1.02, petal_overlap=0.34,
    petal_curvature=0.62, petal_cup=0.45, petal_ruffle_amp=0.24,
    petal_ruffle_freq=3.6, petal_notch=0.16, layer_tilt_gain=0.62,
    center_diameter_ratio=0.22, center_dome_height=0.30,
    relief_depth_mm=18.0, dome_gain=0.40, organic_variation=0.35,
)

V2_FLOWER = dict(
    # More rows, more per row, packed tighter: a marigold is a dense pompon.
    layer_count=9, petal_count_base=26, petal_density=1.65, petal_overlap=0.56,
    # Shorter and broader is the single biggest change. Long narrow petals are
    # what made v1 read as a daisy. Width is held at 1.12 rather than pushed
    # further: at 1.28, combined with a deep tip notch, each floret stopped
    # reading as a petal and started reading as a clover leaf.
    petal_length_ratio=0.37, petal_width_ratio=1.12,
    # Curl and tilt carry the rows up into a dome. A marigold is a pompon, and
    # at relief 20 mm the flower came out 18 mm tall on a 93 mm face -- a disc.
    # Curl and tilt are held back deliberately. Pushed to 0.78 / 1.00 the
    # florets pointed up instead of lying over the row below, the rows
    # terraced, and the receptacle showed through between them as bare bands.
    petal_curvature=0.64, petal_cup=0.58, layer_tilt_gain=0.80,
    # dome_gain is what actually lifts the rows. At the engine default of 0.40
    # the flower stayed a 0.21 height-to-width disc however much relief it was
    # given; at 0.72 it became a stepped cone. 0.56 domes it without terracing.
    relief_depth_mm=40.0, dome_gain=0.56,
    # Deep, fine crenulation along the edge; only a gentle notch at the tip.
    petal_ruffle_amp=0.42, petal_ruffle_freq=4.6, petal_notch=0.10,
    # The florets crowd in over the centre, so barely any of it shows -- and a
    # tall floret dome spiked through the middle of them.
    center_diameter_ratio=0.14, center_dome_height=0.16, center_floret_rings=3,
    # More per-petal variation: real florets are not stamped from one die.
    organic_variation=0.52,
)

# 18 mm of separation left the two halves overlapping in frame on a flower
# this dense, so the exploded shot read as one clump rather than two parts.
SPLIT = dict(type=SplitType.ORGANIC, position=0.10, amplitude=0.40,
             smoothness=0.55, orientation_deg=-28.0, separation_mm=55.0,
             organic_octaves=3, organic_roughness=0.55, organic_seed=11)

SHOTS = [
    {"name": "01_assembled_three_quarter", "camera": "three_quarter", "separated": False},
    {"name": "02_exploded", "camera": "three_quarter", "separated": True},
    {"name": "03_top", "camera": "top", "separated": False},
    {"name": "04_side", "camera": "side", "separated": False},
    {"name": "05_three_quarter_hero", "camera": "hero", "separated": False},
]


def build_config(version: str) -> DesignConfig:
    cfg = DesignConfig()
    flower = V1_FLOWER if version == "v1" else V2_FLOWER
    for k, v in flower.items():
        setattr(cfg.flower, k, v)
    cfg.split = SplitConfig(**SPLIT)
    # Piece B is mixed toward the deeper saffron so the division reads in the
    # assembled views. At 0.34 it disappeared into a pompon this dense. This is
    # a presentation aid, not two materials, and the deliverables say so.
    cfg.material.piece_tint = 0.52
    # v1 is reproduced exactly as it shipped: as overlapping shells.
    cfg.flower.consolidate = (version != "v1")
    return cfg
