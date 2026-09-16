"""Same configuration and seed must reproduce the same geometry, byte for byte."""
import numpy as np

from design_engine.configurations.schema import (DesignConfig, FlowerConfig,
                                                 SplitConfig, SplitType)
from design_engine.flower.marigold import MM, build_master_flower
from design_engine.splitting.splitter import split_flower


def test_flower_is_reproducible():
    cfg = FlowerConfig(layer_count=3, petal_count_base=9, petal_segments_u=8,
                       petal_segments_v=5)
    a = build_master_flower(cfg).mesh
    b = build_master_flower(cfg).mesh
    assert np.array_equal(a.verts, b.verts)
    assert np.array_equal(a.faces, b.faces)
    assert np.array_equal(a.parts, b.parts)


def test_seed_changes_the_flower():
    base = FlowerConfig(layer_count=3, petal_count_base=9, petal_segments_u=8,
                        petal_segments_v=5)
    other = base.model_copy(update={"seed": base.seed + 1})
    assert not np.array_equal(build_master_flower(base).mesh.verts,
                              build_master_flower(other).mesh.verts)


def test_split_is_reproducible():
    cfg = FlowerConfig(layer_count=3, petal_count_base=9, petal_segments_u=8,
                       petal_segments_v=5)
    m = build_master_flower(cfg).mesh
    r = cfg.diameter_mm * 0.5 * MM
    a = split_flower(m, SplitConfig(type=SplitType.S_RIVER), r)
    b = split_flower(m, SplitConfig(type=SplitType.S_RIVER), r)
    assert np.array_equal(a.piece_a.verts, b.piece_a.verts)
    assert np.array_equal(a.piece_b.faces, b.piece_b.faces)


def test_stage_hashes_isolate_their_sections():
    """A camera change must not invalidate the flower or split stages."""
    c1 = DesignConfig()
    c2 = c1.model_copy(deep=True)
    c2.render.camera = c2.render.camera.__class__("top")
    assert c1.hash_flower() == c2.hash_flower()
    assert c1.hash_split() == c2.hash_split()
    assert c1.hash_scene() == c2.hash_scene()
    assert c1.hash_render() != c2.hash_render()

    c3 = c1.model_copy(deep=True)
    c3.material.roughness = 0.9
    assert c1.hash_flower() == c3.hash_flower()
    assert c1.hash_split() == c3.hash_split()
    assert c1.hash_scene() != c3.hash_scene()

    c4 = c1.model_copy(deep=True)
    c4.flower.petal_density = 1.9
    assert c1.hash_flower() != c4.hash_flower()
    assert c1.hash_split() != c4.hash_split()
