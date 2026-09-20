"""Geometry kernel unit tests. No Blender, no GPU, no I/O."""
import numpy as np
import pytest

from design_engine.geometry.mesh import Mesh, grid_faces, part_kind, petal_part_id
from design_engine.geometry.curves import (bezier, resample_by_arclength,
                                           smoothstep, value_noise_1d)
from design_engine.petals.petal import build_petal
from design_engine.petals.profile import tip_length_profile, width_profile


def unit_cube() -> Mesh:
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], float)
    f = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
                  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
                  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]])
    return Mesh(v, f)


def test_cube_volume_and_area_are_exact():
    m = unit_cube()
    assert m.volume() == pytest.approx(1.0, abs=1e-9)
    assert m.area() == pytest.approx(6.0, abs=1e-9)
    assert m.n_faces == 12 and m.n_verts == 8


def test_transforms_preserve_volume():
    m = unit_cube()
    assert m.translated((5, -3, 2)).volume() == pytest.approx(1.0, abs=1e-6)
    assert m.rotated_z(0.7).volume() == pytest.approx(1.0, abs=1e-6)
    assert m.scaled(2.0).volume() == pytest.approx(8.0, abs=1e-5)


def test_concat_sums_volume_and_keeps_parts():
    a = unit_cube()
    b = unit_cube().translated((3, 0, 0))
    a.parts[:] = 1
    b.parts[:] = 2
    c = Mesh.concat([a, b])
    assert c.volume() == pytest.approx(2.0, abs=1e-6)
    assert set(np.unique(c.parts).tolist()) == {1, 2}
    assert len(np.unique(c.component_labels())) == 2


def test_orientation_fix_makes_winding_consistent():
    m = unit_cube()
    m.faces[3] = m.faces[3][::-1]          # break one face
    fixed = m.oriented()
    assert fixed.volume() == pytest.approx(1.0, abs=1e-9)


def test_weld_merges_duplicate_vertices():
    m = unit_cube()
    dup = Mesh(np.vstack([m.verts, m.verts]),
               np.vstack([m.faces, m.faces + 8]))
    assert dup.n_verts == 16
    assert dup.welded().n_verts == 8


def test_part_id_encoding():
    pid = petal_part_id(3, 17)
    assert part_kind(pid) == "petal"
    assert part_kind(1_000_000) == "base"
    assert part_kind(2_000_000) == "center"
    assert part_kind(4_000_000) == "boundary"


def test_grid_faces_count():
    assert grid_faces(5, 4).shape == (2 * 4 * 3, 3)


def test_bezier_endpoints_are_interpolated():
    pts = np.array([[0.0, 0.0], [1.0, 2.0], [2.0, -2.0], [3.0, 0.0]])
    out = bezier(pts, np.array([0.0, 1.0]))
    assert out[0] == pytest.approx(pts[0])
    assert out[-1] == pytest.approx(pts[-1])


def test_value_noise_is_deterministic_and_bounded():
    x = np.linspace(0, 5, 64)
    a = value_noise_1d(x, seed=42)
    b = value_noise_1d(x, seed=42)
    assert np.allclose(a, b)
    assert a.min() >= -1.0 and a.max() <= 1.0
    assert not np.allclose(a, value_noise_1d(x, seed=43))


def test_resample_preserves_endpoints():
    p = np.array([[0.0, 0.0], [1.0, 1.0], [3.0, 0.0]])
    out = resample_by_arclength(p, 20)
    assert len(out) == 20
    assert out[0] == pytest.approx(p[0])
    assert out[-1] == pytest.approx(p[-1])


def test_smoothstep_clamps():
    assert smoothstep(0, 1, np.array([-1.0]))[0] == 0.0
    assert smoothstep(0, 1, np.array([2.0]))[0] == 1.0


def test_width_profile_is_broad_at_the_tip():
    """A marigold ray floret stays wide to the end; it must not taper to nothing."""
    u = np.linspace(0, 1, 50)
    w = width_profile(u)
    assert w[-1] > 0.6 * w.max(), "petal tapers away at the tip"
    assert w[0] < w[-1]


def test_tip_profile_centre_leads_the_edges():
    """The tip must be rounded, not a keyhole with the edges furthest forward."""
    v = np.linspace(-1, 1, 41)
    t = tip_length_profile(v, notch=0.16)
    centre = t[len(t) // 2]
    assert centre > t[0] and centre > t[-1]
    assert t.max() <= 1.0 + 1e-9


@pytest.mark.parametrize("kwargs", [
    {}, dict(curl=0.0, cup=0.0, ruffle_amp=0.0, notch=0.0),
    dict(curl=1.0, cup=1.0, ruffle_amp=0.9, notch=0.6, twist=0.5),
    dict(segments_u=5, segments_v=3),
])
def test_petal_is_a_closed_solid(kwargs):
    """Every petal must be a closed solid -- the split kernel depends on it."""
    p = build_petal(1.8, 1.0, 0.11, **kwargs)
    assert p.n_faces > 0
    assert p.volume() > 0, "petal has inverted or inconsistent winding"

    F = p.faces.astype(np.int64)
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    assert int((counts == 1).sum()) == 0, "petal has open edges"
    assert int((counts > 2).sum()) == 0, "petal has non-manifold edges"
