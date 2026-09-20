"""The browser engine must stay in step with the Python one.

web_studio/engine.js is a hand port of design_engine. A port that silently
drifts is worse than no port at all -- the web studio would show a different
flower from the one Blender renders. These tests run the JavaScript engine
under node and compare it against the authoritative Python result.

Parity is asserted with ``organic_variation = 0`` and ``petal_ruffle_amp = 0``.
Both engines are deterministic, but numpy's PCG64 cannot be reproduced in
JavaScript, so the per-petal random draws (the jitter, and the ruffle phase,
which is drawn regardless of the jitter setting) differ by construction. With
both switched off no random draw reaches the geometry and the two engines must
agree to float precision.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from design_engine.configurations.schema import FlowerConfig, SplitConfig, SplitType
from design_engine.flower.marigold import MM, build_master_flower
from design_engine.splitting.splitter import split_flower

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "web_studio" / "engine.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not ENGINE.exists(),
    reason="node or web_studio/engine.js unavailable",
)

# Vertices are float32 in the Python Mesh and float64 in JavaScript, so exact
# equality is not available; this is the float32 rounding floor.
REL_TOL = 1e-6


def _run_js(script: str) -> dict:
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=ROOT, timeout=300,
    )
    if out.returncode != 0:
        raise AssertionError("node failed:\n" + out.stderr[-2000:])
    return json.loads(out.stdout.strip().splitlines()[-1])


def _js_build(split_type=None) -> dict:
    split = "{...E.SPLIT_DEFAULTS, type: '%s'}" % split_type if split_type else "null"
    return _run_js("""
import * as E from '%s';
const cfg = {...E.FLOWER_DEFAULTS, organic_variation: 0.0, petal_ruffle_amp: 0.0};
const r = E.buildMasterFlower(cfg);
const b = E.meshBounds(r.mesh);
const out = {verts: r.mesh.nVerts, faces: r.mesh.nFaces, petals: r.stats.petal_count,
  volume: E.meshVolume(r.mesh), area: E.meshArea(r.mesh), lo: b[0], hi: b[1]};
const sc = %s;
if (sc) {
  const s = E.splitFlower(r.mesh, r.bodies, sc, cfg.diameter_mm * 0.5 * E.MM);
  out.split = {faces_a: s.pieceA.nFaces, faces_b: s.pieceB.nFaces,
    open_a: s.metadata.residual_open_edges_a, open_b: s.metadata.residual_open_edges_b,
    cap_failures: s.metadata.cap_failures, caps: s.metadata.caps_built,
    divided: s.metadata.bodies_divided,
    volume_a: E.meshVolume(s.pieceA), volume_b: E.meshVolume(s.pieceB)};
}
console.log(JSON.stringify(out));
""" % (ENGINE.as_posix(), split))


@pytest.fixture(scope="module")
def py_master():
    cfg = FlowerConfig(organic_variation=0.0, petal_ruffle_amp=0.0)
    return cfg, build_master_flower(cfg)


def test_master_flower_matches_python(py_master):
    _, py = py_master
    js = _js_build()

    assert js["verts"] == py.mesh.n_verts
    assert js["faces"] == py.mesh.n_faces
    assert js["petals"] == py.stats["petal_count"]

    assert js["volume"] == pytest.approx(py.mesh.volume(), rel=REL_TOL)
    assert js["area"] == pytest.approx(py.mesh.area(), rel=REL_TOL)

    lo, hi = py.mesh.bounds()
    for k in range(3):
        assert js["lo"][k] == pytest.approx(float(lo[k]), abs=1e-5)
        assert js["hi"][k] == pytest.approx(float(hi[k]), abs=1e-5)


@pytest.mark.parametrize("kind", [SplitType.BALANCED, SplitType.S_RIVER])
def test_split_topology_matches_python(py_master, kind):
    cfg, py = py_master
    js = _js_build(kind.value)["split"]
    s = split_flower(py.mesh, SplitConfig(type=kind), cfg.diameter_mm * 0.5 * MM)

    # The cut is topologically identical: the same bodies are divided, the same
    # number of caps is built, and each side carries the same triangle count.
    assert js["divided"] == s.metadata["bodies_divided"]
    assert js["caps"] == s.metadata["caps_built"]
    assert js["faces_a"] == s.piece_a.n_faces
    assert js["faces_b"] == s.piece_b.n_faces


@pytest.mark.parametrize("kind", ["balanced", "s_river", "organic"])
def test_js_split_is_watertight_and_conservative(kind):
    """Whatever the family, the browser engine must produce two closed solids
    that reconstruct the master exactly."""
    js = _js_build(kind)
    s = js["split"]
    assert s["open_a"] == 0, "piece A left open edges"
    assert s["open_b"] == 0, "piece B left open edges"
    assert s["cap_failures"] == 0, "a cut face failed to cap"
    err = abs(s["volume_a"] + s["volume_b"] - js["volume"]) / abs(js["volume"])
    # Not 1e-9. The kernel now makes each piece's winding globally consistent,
    # which flips any inside-out body -- including the specks a cut through a
    # petal tip leaves behind, whose volumes are around 1e-6 of a cubic unit.
    # Flipping one changes the A + B sum by twice its volume, so the sum no
    # longer matches a master that still holds those specks the wrong way
    # round. The correction is worth more than the exactness: a real failure,
    # such as a petal landing on neither side, is four orders of magnitude
    # larger than this bound.
    assert err < 1e-5, "pieces do not reconstruct the master: %.3e" % err


# ---------------------------------------------------------------------------
# Stage two: the hat
# ---------------------------------------------------------------------------
def _js_hat(style: str) -> dict:
    return _run_js("""
import * as E from '%s';
const cfg = {...E.HAT_DEFAULTS, style: '%s'};
const h = E.buildHat(cfg);
const b = E.meshBounds(h.mesh);
const prof = h.profile;
console.log(JSON.stringify({
  triangles: h.mesh.nFaces, verts: h.mesh.nVerts,
  volume: E.meshVolume(h.mesh),
  open_edges: E.boundaryEdges(h.mesh.faces, 3).length,
  head_radius_mm: h.stats.head_radius_mm,
  diameter_mm: h.stats.overall_diameter_mm,
  height_mm: h.stats.overall_height_mm,
  profile_points: prof.length,
  profile_end_r: prof[prof.length - 1][0],
}));
""" % (ENGINE.as_posix(), style))


@pytest.mark.parametrize("style", ["fedora", "boater", "wide_brim", "cloche", "bucket"])
def test_hat_matches_python(style):
    """The browser hat has to be the same hat the renders show."""
    from design_engine.configurations.schema import HatConfig, HatStyle
    from design_engine.hat.hat import build_hat

    js = _js_hat(style)
    cfg = HatConfig(style=HatStyle(style), profile_segments=160, revolve_segments=96)
    py = build_hat(cfg)

    assert js["open_edges"] == 0, "the browser hat is not closed"
    assert js["triangles"] == py.mesh.n_faces
    assert js["verts"] == py.mesh.n_verts
    assert js["profile_points"] == len(py.profile)
    # Head size is the dimension a hat cannot get wrong.
    assert js["head_radius_mm"] == pytest.approx(py.stats["head_radius_mm"], abs=0.01)
    assert js["diameter_mm"] == pytest.approx(py.stats["overall_diameter_mm"], abs=0.05)
    assert js["height_mm"] == pytest.approx(py.stats["overall_height_mm"], abs=0.05)
    assert js["volume"] == pytest.approx(py.mesh.volume(), rel=REL_TOL)
