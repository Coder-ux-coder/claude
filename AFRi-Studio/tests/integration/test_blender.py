"""Blender integration. Skipped automatically when Blender is not installed."""
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from backend.app.core.config import BLENDER_SCRIPT, find_blender

blender = find_blender()
pytestmark = pytest.mark.skipif(not blender.available,
                                reason=f"Blender unavailable: {blender.error}")


def test_blender_runs_in_background():
    out = subprocess.run([blender.path, "--version"], capture_output=True,
                         text=True, timeout=60)
    assert out.returncode == 0
    assert "Blender" in out.stdout


def test_blender_python_has_numpy():
    code = "import numpy, sys; print('NP', numpy.__version__)"
    out = subprocess.run([blender.path, "-b", "--factory-startup", "-noaudio",
                          "--python-expr", code],
                         capture_output=True, text=True, timeout=120)
    assert "NP" in out.stdout


def test_scene_script_exists():
    assert Path(BLENDER_SCRIPT).is_file()


def test_full_scene_build_and_render(tmp_path):
    """Build a real scene from a real mesh bundle and render it."""
    from design_engine.configurations.schema import FlowerConfig, SplitConfig
    from design_engine.flower.marigold import MM, build_master_flower
    from design_engine.splitting.splitter import split_flower

    cfg = FlowerConfig(layer_count=2, petal_count_base=7, petal_density=0.6,
                       petal_segments_u=6, petal_segments_v=5)
    fr = build_master_flower(cfg)
    sr = split_flower(fr.mesh, SplitConfig(), cfg.diameter_mm * 0.5 * MM)

    bundle = tmp_path / "bundle.npz"
    np.savez_compressed(bundle, **fr.mesh.to_npz_dict("master"),
                        **sr.piece_a.to_npz_dict("piece_a"),
                        **sr.piece_b.to_npz_dict("piece_b"))

    outdir = tmp_path / "out"
    spec = {"bundle": str(bundle), "outdir": str(outdir), "radius": 4.5,
            "separation": 1.5, "separation_normal": [1.0, 0.0],
            "material": {"preset": "satin_silk", "base_color": "#F2A007",
                         "roughness": 0.4, "metallic": 0.0, "sheen": 0.3,
                         "piece_tint": 0.3},
            "render": {"quality": "preview", "camera": "three_quarter",
                       "lighting": "studio_soft", "resolution": 200,
                       "background": "#14161A", "separated": False},
            "shots": [{"name": "t_assembled", "camera": "three_quarter"},
                      {"name": "t_separated", "camera": "top", "separated": True}],
            "export_meshes": ["stl"], "save_blend": True, "export_glb": True}
    spec_path = tmp_path / "job.json"
    spec_path.write_text(json.dumps(spec))

    out = subprocess.run(
        [blender.path, "-b", "--factory-startup", "-noaudio",
         "-P", str(BLENDER_SCRIPT), "--", str(spec_path)],
        capture_output=True, text=True, timeout=900)

    result = None
    stages = []
    for line in out.stdout.splitlines():
        if line.startswith("AFRI_RESULT "):
            result = json.loads(line[12:])
        elif line.startswith("AFRI_EVENT "):
            stages.append(json.loads(line[11:])["stage"])

    assert result is not None, f"no result line.\n{out.stdout[-3000:]}"
    assert result["ok"], result.get("error")

    # Real stage transitions were reported, not invented.
    for expected in ("SCENE", "LIGHTING", "EXPORT", "RENDER", "DONE"):
        assert expected in stages, f"stage {expected} never reported"

    outputs = result["outputs"]
    for key in ("t_assembled", "t_separated", "glb", "blend"):
        assert key in outputs, f"missing output {key}"
        p = Path(outputs[key])
        assert p.is_file() and p.stat().st_size > 0, f"{key} is missing or empty"

    from PIL import Image
    for key in ("t_assembled", "t_separated"):
        with Image.open(outputs[key]) as im:
            im.load()
            assert im.size == (200, 200), f"{key} wrong resolution: {im.size}"
            arr = np.asarray(im.convert("L"), dtype=np.float32)
            assert arr.std() > 0.5, f"{key} is a blank frame"

    # The GLB must be a real glTF binary.
    glb = Path(outputs["glb"]).read_bytes()
    assert glb[:4] == b"glTF", "GLB has no glTF magic number"
    assert len(glb) > 1000

    # Both pieces exported independently.
    assert "piece_a_stl" in outputs and "piece_b_stl" in outputs
    for k in ("piece_a_stl", "piece_b_stl"):
        assert Path(outputs[k]).stat().st_size > 0
