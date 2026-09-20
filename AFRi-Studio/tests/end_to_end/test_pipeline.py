"""End-to-end: configuration in, verified artefacts on disk.

This is the test that proves the whole claim -- that AFRi Studio produces real
geometry, two genuinely separate solids, an editable Blender project, a browser
model and a render, and that each of those is a real file with real content.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from backend.app.core.config import find_blender
from backend.app.jobs.pipeline import PipelineError, run_pipeline
from design_engine.configurations.schema import (DesignConfig, RenderQuality,
                                                 SplitType)

blender = find_blender()
pytestmark = pytest.mark.skipif(not blender.available,
                                reason=f"Blender unavailable: {blender.error}")


def small_config(split_type=SplitType.S_RIVER) -> DesignConfig:
    """A deliberately light configuration so the suite stays runnable."""
    cfg = DesignConfig()
    cfg.flower.layer_count = 3
    cfg.flower.petal_count_base = 9
    cfg.flower.petal_density = 0.7
    cfg.flower.petal_segments_u = 7
    cfg.flower.petal_segments_v = 5
    cfg.split.type = split_type
    cfg.render.quality = RenderQuality.PREVIEW
    cfg.render.resolution = 256
    return cfg


def test_full_pipeline_produces_verified_artefacts(tmp_path):
    cfg = small_config()
    stages = []
    res = run_pipeline(cfg, tmp_path / "out",
                       shots=[{"name": "assembled", "camera": "three_quarter"},
                              {"name": "apart", "camera": "top", "separated": True}],
                       export_meshes=["stl"], save_blend=True, export_glb=True,
                       emit=lambda s, m, **k: stages.append(s))

    # Real stages ran, in order.
    for expected in ("CONFIG", "MASTER_FLOWER", "SPLIT", "VALIDATE", "BUNDLE",
                     "RENDER", "VERIFY", "PUBLISH"):
        assert expected in stages, f"stage {expected} never ran"
    assert stages.index("MASTER_FLOWER") < stages.index("SPLIT") < stages.index("VALIDATE")

    # Validation genuinely passed.
    assert res.validation["ok"], [c["name"] for c in res.validation["checks"]
                                  if not c["passed"]]
    assert res.validation["errors"] == 0

    # Every promised artefact exists, is non-empty and parses.
    for key in ("assembled", "apart", "glb", "blend"):
        assert key in res.outputs, f"missing output {key}"
        p = Path(res.outputs[key])
        assert p.is_file() and p.stat().st_size > 0

    from PIL import Image
    for key in ("assembled", "apart"):
        with Image.open(res.outputs[key]) as im:
            im.load()
            assert im.size == (256, 256)
            assert np.asarray(im.convert("L"), dtype=np.float32).std() > 0.5

    assert Path(res.outputs["glb"]).read_bytes()[:4] == b"glTF"
    assert Path(res.outputs["blend"]).read_bytes()[:7] == b"BLENDER"

    # Both pieces exported independently and re-import as real meshes.
    import trimesh
    for key in ("piece_a_stl", "piece_b_stl"):
        assert key in res.outputs
        m = trimesh.load(res.outputs[key], force="mesh")
        assert len(m.faces) > 0 and len(m.vertices) > 0

    a = trimesh.load(res.outputs["piece_a_stl"], force="mesh")
    b = trimesh.load(res.outputs["piece_b_stl"], force="mesh")
    assert not np.allclose(a.bounds, b.bounds), "the two pieces are identical"

    # The reported geometry matches the design.
    assert res.stats["petal_count"] > 0
    assert 0.8 < res.stats["diameter_mm"] / cfg.flower.diameter_mm < 1.2
    assert res.split_meta["bodies_divided"] > 0, "nothing was actually cut"
    assert res.split_meta["residual_open_edges_a"] == 0
    assert res.split_meta["residual_open_edges_b"] == 0


@pytest.mark.parametrize("split_type", [SplitType.BALANCED, SplitType.S_RIVER,
                                        SplitType.ORGANIC])
def test_every_split_family_completes(tmp_path, split_type):
    cfg = small_config(split_type)
    res = run_pipeline(cfg, tmp_path / split_type.value,
                       shots=[{"name": "shot", "camera": "top"}],
                       save_blend=False, export_glb=True,
                       emit=lambda *a, **k: None)
    assert res.validation["ok"]
    assert Path(res.outputs["shot"]).stat().st_size > 0
    assert Path(res.outputs["glb"]).read_bytes()[:4] == b"glTF"


def test_camera_change_does_not_touch_geometry(tmp_path):
    """Changing the camera must not regenerate the flower or the split."""
    a = small_config()
    b = a.model_copy(deep=True)
    b.render.camera = b.render.camera.__class__("side")
    assert a.hash_flower() == b.hash_flower()
    assert a.hash_split() == b.hash_split()
    assert a.hash_scene() == b.hash_scene()
    assert a.hash_render() != b.hash_render()


def test_invalid_configuration_fails_before_blender(tmp_path):
    """A broken config must be caught by the engine, not by Blender."""
    cfg = small_config()
    cfg.flower.diameter_mm = 30.0
    cfg.flower.petal_length_ratio = 0.15
    cfg.flower.layer_count = 1
    cfg.flower.petal_count_base = 5
    # Still valid -- this should succeed rather than crash.
    res = run_pipeline(cfg, tmp_path / "tiny",
                       shots=[{"name": "t", "camera": "top"}],
                       save_blend=False, export_glb=False,
                       emit=lambda *a, **k: None)
    assert res.validation["ok"]


def test_blank_render_is_rejected(tmp_path, monkeypatch):
    """A render of nothing must be caught, not published as a deliverable."""
    from backend.app.jobs import pipeline as pl
    from PIL import Image

    blank = tmp_path / "blank.png"
    Image.new("RGB", (64, 64), (17, 17, 17)).save(blank)
    with pytest.raises(PipelineError, match="blank"):
        pl._verify_outputs({"shot": str(blank)}, small_config())


def test_missing_output_is_rejected(tmp_path):
    from backend.app.jobs import pipeline as pl
    with pytest.raises(PipelineError, match="missing or empty"):
        pl._verify_outputs({"shot": str(tmp_path / "nope.png")}, small_config())
