"""Split kernel tests -- the most important subsystem."""
import numpy as np
import pytest

from design_engine.configurations.schema import (FlowerConfig, SplitConfig,
                                                 SplitType)
from design_engine.flower.marigold import MM, build_master_flower
from design_engine.geometry.mesh import PART_BOUNDARY, Mesh
from design_engine.splitting.paths import build_split_path
from design_engine.splitting.splitter import (boundary_edges, earclip,
                                              split_flower)
from design_engine.splitting.validate import validate_split

ALL_TYPES = [SplitType.BALANCED, SplitType.S_RIVER, SplitType.ORGANIC]


@pytest.fixture(scope="module")
def flower():
    cfg = FlowerConfig(layer_count=4, petal_count_base=11, petal_density=0.9,
                       petal_segments_u=9, petal_segments_v=7)
    return cfg, build_master_flower(cfg)


def radius_of(cfg):
    return cfg.diameter_mm * 0.5 * MM


# ------------------------------------------------------------------ paths
@pytest.mark.parametrize("t", ALL_TYPES)
def test_path_is_a_function_of_y(t):
    p = build_split_path(SplitConfig(type=t), 4.5)
    assert np.all(np.diff(p.y) > 0), "split path is not single-valued in y"
    assert p.arclength[-1] > 0
    assert len(p.x) == len(p.y)


def test_s_river_actually_meanders():
    p = build_split_path(SplitConfig(type=SplitType.S_RIVER, amplitude=0.4), 4.5)
    mid = len(p.x) // 2
    assert p.x.min() < -0.5 and p.x.max() > 0.5, "S curve does not swing both ways"
    assert abs(p.x[mid]) < 0.35 * abs(p.x).max(), "S curve does not cross the centre"


def test_control_points_must_increase_in_y():
    with pytest.raises(ValueError, match="strictly increase"):
        SplitConfig(control_points=[{"y": 0.5, "x": 0.0}, {"y": -0.5, "x": 0.1}])


# ------------------------------------------------------------------ kernel
@pytest.mark.parametrize("t", ALL_TYPES)
def test_pieces_are_nonempty_and_independent(flower, t):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    assert r.piece_a.n_faces > 0 and r.piece_b.n_faces > 0
    assert r.piece_a.n_verts > 0 and r.piece_b.n_verts > 0
    # Separate vertex buffers: the pieces are genuinely independent meshes.
    assert r.piece_a.verts is not r.piece_b.verts


@pytest.mark.parametrize("t", ALL_TYPES)
def test_volume_is_conserved_exactly(flower, t):
    """A + B must reconstruct the master. This proves the clip loses nothing."""
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    total = r.piece_a.volume() + r.piece_b.volume()
    assert total == pytest.approx(fr.mesh.volume(), rel=1e-4)


@pytest.mark.parametrize("t", ALL_TYPES)
def test_both_pieces_are_closed_solids(flower, t):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    for name, piece in (("A", r.piece_a), ("B", r.piece_b)):
        assert len(boundary_edges(piece.faces)) == 0, f"piece {name} has open edges"


@pytest.mark.parametrize("t", ALL_TYPES)
def test_no_cross_contamination(flower, t):
    """No vertex of A may sit meaningfully on B's side of the dividing line.

    The tolerance is the chord of the curved cut across the widest triangle
    edge -- a real geometric bound, since crossing points are interpolated
    along edges. A misassigned petal would exceed it by orders of magnitude.
    """
    from design_engine.splitting.validate import (_max_edge_span_y,
                                                  chord_tolerance)
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    tol = max(chord_tolerance(r.split_path, _max_edge_span_y(fr.mesh)), 3e-4)
    sa = r.piece_a.verts[:, 0] - r.split_path.f(r.piece_a.verts[:, 1])
    sb = r.piece_b.verts[:, 0] - r.split_path.f(r.piece_b.verts[:, 1])
    assert sa.min() > -tol, "piece A leaked across the boundary"
    assert sb.max() < tol, "piece B leaked across the boundary"
    # And the leak must be far smaller than any real feature.
    assert tol < 0.05 * radius_of(cfg), "tolerance has grown implausibly large"


@pytest.mark.parametrize("t", ALL_TYPES)
def test_boundary_surface_is_built(flower, t):
    """The cut face must be a real surface, not an open hole."""
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    for piece in (r.piece_a, r.piece_b):
        assert int((piece.parts == PART_BOUNDARY).sum()) > 0


def test_split_is_geometric_not_cosmetic(flower):
    """Bodies the line crosses must be physically divided between the pieces."""
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=SplitType.S_RIVER), radius_of(cfg))
    pa = set(np.unique(r.piece_a.parts).tolist()) - {PART_BOUNDARY}
    pb = set(np.unique(r.piece_b.parts).tolist()) - {PART_BOUNDARY}
    assert len(pa & pb) > 0, "no body was actually cut; the split is cosmetic"
    assert r.metadata["bodies_divided"] > 0
    assert r.metadata["triangles_clipped"] > 0


def test_uncut_bodies_go_wholly_to_one_side(flower):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=SplitType.BALANCED), radius_of(cfg))
    assert r.metadata["bodies_divided"] < r.metadata["bodies_total"], \
        "every body was cut, which is implausible"


def test_orientation_rotates_the_division(flower):
    cfg, fr = flower
    a = split_flower(fr.mesh, SplitConfig(type=SplitType.BALANCED,
                                          orientation_deg=0), radius_of(cfg))
    b = split_flower(fr.mesh, SplitConfig(type=SplitType.BALANCED,
                                          orientation_deg=90), radius_of(cfg))
    assert a.piece_a.n_faces != b.piece_a.n_faces or \
        not np.allclose(a.piece_a.bounds(), b.piece_a.bounds())


def test_separated_moves_the_pieces_apart(flower):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=SplitType.S_RIVER), radius_of(cfg))
    a, b = r.separated(3.0)
    shift = np.linalg.norm(a.bounds()[0] - r.piece_a.bounds()[0])
    assert shift > 0.5


def test_earclip_triangulates_a_square():
    poly = np.array([[0.0, 0], [1, 0], [1, 1], [0, 1]])
    assert len(earclip(poly)) == 2


def test_earclip_handles_a_sliver():
    """Sliver cross-sections must still triangulate fully, or the cap leaks."""
    poly = np.array([[0.0, 0], [1, 1e-6], [2, 0], [2, 1e-5], [1, 2e-5], [0, 1e-5]])
    assert len(earclip(poly)) == len(poly) - 2


# -------------------------------------------------------------- validation
@pytest.mark.parametrize("t", ALL_TYPES)
def test_validation_suite_passes(flower, t):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=t), radius_of(cfg))
    v = validate_split(fr.mesh, r.piece_a, r.piece_b, r.split_path)
    failed = [c["name"] for c in v["checks"] if not c["passed"]]
    assert v["ok"], f"validation reported errors: {failed}"
    assert v["errors"] == 0
    assert failed == [], f"unexpected failures: {failed}"


# ------------------------------------------------------- angled splits
@pytest.mark.parametrize("orientation", [0.0, 12.0, -28.0, 90.0, -135.0, 179.0])
def test_angled_split_validates_in_the_right_frame(flower, orientation):
    """An angled split rotates the pieces back to world space.

    Anything asking which side of the cut a point is on has to rotate back into
    the split frame first; testing world coordinates against the split-frame
    path silently reports every vertex as contaminated.
    """
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=SplitType.S_RIVER,
                                          orientation_deg=orientation),
                     radius_of(cfg))
    v = validate_split(fr.mesh, r.piece_a, r.piece_b, r.split_path)
    failed = [c["name"] for c in v["checks"] if not c["passed"]]
    assert v["ok"], f"orientation {orientation} failed: {failed}"
    assert r.split_path.orientation_deg == pytest.approx(orientation)


def test_signed_field_matches_the_frame(flower):
    cfg, fr = flower
    r = split_flower(fr.mesh, SplitConfig(type=SplitType.S_RIVER,
                                          orientation_deg=45.0), radius_of(cfg))
    sa = r.split_path.signed(r.piece_a.verts)
    sb = r.split_path.signed(r.piece_b.verts)
    assert sa.max() > 0 and sb.min() < 0
    assert sa.min() > -0.05 and sb.max() < 0.05


# ---------------------------------------------------------------------------
# Cut-wall orientation
# ---------------------------------------------------------------------------
def test_cut_caps_are_wound_outward():
    """Every body of every piece must enclose positive volume.

    This guards a bug that shipped: cut caps were triangulated in whatever
    rotational direction the undirected boundary walk produced, so some were
    wound inside-out. Volume conservation could not see it, because the two
    pieces' caps are exact negatives and the error cancels in the A + B sum.
    """
    from design_engine.configurations.schema import FlowerConfig
    from design_engine.flower.marigold import MM, build_master_flower

    cfg = FlowerConfig(layer_count=3, petal_count_base=9, petal_density=0.8,
                       petal_segments_u=8, petal_segments_v=5)
    master = build_master_flower(cfg).mesh
    for kind in (SplitType.BALANCED, SplitType.S_RIVER, SplitType.ORGANIC):
        res = split_flower(master, SplitConfig(type=kind, amplitude=0.35),
                           cfg.diameter_mm * 0.5 * MM)
        for name, piece in (("A", res.piece_a), ("B", res.piece_b)):
            labels = piece.component_labels()
            floor = abs(piece.volume()) * 1e-5
            bad = []
            for u in np.unique(labels):
                sub = Mesh(piece.verts, piece.faces[labels == u])
                v = sub.volume()
                if v < 0 and abs(v) >= floor:
                    bad.append(float(v))
            assert not bad, f"{kind.value} piece {name}: {len(bad)} inside-out bodies"


def test_validator_detects_inverted_bodies():
    """The check has to fail on bad input, or it is not a check."""
    from design_engine.configurations.schema import FlowerConfig
    from design_engine.flower.marigold import MM, build_master_flower
    from design_engine.splitting.validate import validate_split

    cfg = FlowerConfig(layer_count=2, petal_count_base=7, petal_density=0.7,
                       petal_segments_u=7, petal_segments_v=5)
    master = build_master_flower(cfg).mesh
    res = split_flower(master, SplitConfig(type=SplitType.BALANCED),
                       cfg.diameter_mm * 0.5 * MM)
    ok = validate_split(master, res.piece_a, res.piece_b, res.split_path)
    assert next(c for c in ok["checks"] if c["name"] == "outward_normals")["passed"]

    # Turn one body inside-out and confirm the validator says so.
    labels = res.piece_a.component_labels()
    # Invert the LARGEST body, so the test is about a real defect rather than
    # a sliver the check is entitled to ignore.
    target = max(np.unique(labels),
                 key=lambda u: abs(Mesh(res.piece_a.verts,
                                        res.piece_a.faces[labels == u]).volume()))
    faces = res.piece_a.faces.copy()
    faces[labels == target] = faces[labels == target][:, ::-1]
    broken = Mesh(res.piece_a.verts, faces, res.piece_a.parts)
    bad = validate_split(master, broken, res.piece_b, res.split_path)
    check = next(c for c in bad["checks"] if c["name"] == "outward_normals")
    assert not check["passed"], "validator missed an inside-out body"
    assert check["value"] >= 1
