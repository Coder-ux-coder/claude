"""Placement has to be a rigid motion, and the contact measurement has to be
right about what is touching what.

The distance function is the part worth testing hardest: it is what the
rigid-versus-conform decision rests on, and a sign error in it would quietly
turn a collision into a clearance.
"""
from __future__ import annotations

import numpy as np
import pytest

from design_engine.configurations.schema import HatConfig, HatStyle, PlacementConfig
from design_engine.geometry.mesh import Mesh
from design_engine.hat.hat import build_hat
from design_engine.hat.profile import MM, head_radius
from design_engine.assembly.contact import (mesh_centroid, outer_meridian,
                                            signed_distance_to_hat,
                                            underside_vertices)
from design_engine.assembly.placement import (place, placement_matrix,
                                              surface_frame)

FAST = dict(profile_segments=120, revolve_segments=64)


@pytest.fixture(scope="module")
def hat():
    return build_hat(HatConfig(**FAST))


def _cube(size=1.0, at=(0.0, 0.0, 0.0)):
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=np.float64)
    v = (v - 0.5) * size + np.asarray(at)
    f = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
                  [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
                  [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]], dtype=np.int32)
    return Mesh(v.astype(np.float32), f)


@pytest.mark.parametrize("rp", [0.0, 0.25, 0.5, 0.75, 1.0])
@pytest.mark.parametrize("azimuth", [-90.0, 0.0, 37.0, 180.0])
def test_frame_is_orthonormal_and_right_handed(hat, rp, azimuth):
    cfg = HatConfig(**FAST)
    pc = PlacementConfig(radial_position=rp, azimuth_deg=azimuth)
    R, _ = placement_matrix(surface_frame(hat, cfg, pc), pc)
    assert np.allclose(R.T @ R, np.eye(3), atol=1e-9), "frame is not orthonormal"
    assert np.linalg.det(R) == pytest.approx(1.0, abs=1e-9), "frame is not right-handed"


@pytest.mark.parametrize("tilt,roll", [(0, 0), (25, 0), (0, 40), (-30, 120)])
def test_tilt_and_roll_stay_rigid(hat, tilt, roll):
    cfg = HatConfig(**FAST)
    pc = PlacementConfig(tilt_deg=tilt, roll_deg=roll)
    R, _ = placement_matrix(surface_frame(hat, cfg, pc), pc)
    assert np.allclose(R.T @ R, np.eye(3), atol=1e-9)
    assert np.linalg.det(R) == pytest.approx(1.0, abs=1e-9)


def test_placement_preserves_shape(hat):
    """Placing must move the flower, never resize or shear it."""
    cfg = HatConfig(**FAST)
    pc = PlacementConfig(radial_position=0.4, azimuth_deg=-52.0, tilt_deg=12.0,
                         roll_deg=33.0)
    R, t = placement_matrix(surface_frame(hat, cfg, pc), pc)
    m = _cube(2.0)
    moved = place(m, R, t)
    assert moved.volume() == pytest.approx(m.volume(), rel=1e-6)
    assert moved.area() == pytest.approx(m.area(), rel=1e-6)
    d0 = np.linalg.norm(m.verts[0] - m.verts[6])
    d1 = np.linalg.norm(moved.verts[0] - moved.verts[6])
    assert d1 == pytest.approx(d0, rel=1e-6)


def test_the_flower_lands_where_it_was_asked_to(hat):
    cfg = HatConfig(**FAST)
    for rp in (0.0, 0.5, 1.0):
        pc = PlacementConfig(radial_position=rp, azimuth_deg=0.0)
        frame = surface_frame(hat, cfg, pc)
        R, t = placement_matrix(frame, pc)
        origin = place(_cube(0.01), R, t).verts.mean(axis=0)
        assert np.hypot(origin[0], origin[1]) == pytest.approx(frame.radius_mm * MM, abs=1e-3)
    rh = head_radius(cfg.head_circumference_mm)
    inner = surface_frame(hat, cfg, PlacementConfig(radial_position=0.0)).radius_mm
    outer = surface_frame(hat, cfg, PlacementConfig(radial_position=1.0)).radius_mm
    assert inner == pytest.approx(rh / MM, abs=4.0), "0 should seat at the crown foot"
    assert outer > inner + cfg.brim_width_mm * 0.7, "1 should reach the brim edge"


def test_signed_distance_is_exact_on_the_skin(hat):
    mer = outer_meridian(hat)
    d = np.gradient(mer, axis=0)
    for i in (40, 80, 110):
        p = mer[i]
        n = np.array([-d[i, 1], d[i, 0]]); n /= np.linalg.norm(n)
        on = np.array([[p[0], 0.0, p[1]]])
        out = np.array([[p[0] + n[0] * 0.4, 0.0, p[1] + n[1] * 0.4]])
        inn = np.array([[p[0] - n[0] * 0.15, 0.0, p[1] - n[1] * 0.15]])
        assert signed_distance_to_hat(on, hat)[0] == pytest.approx(0.0, abs=2e-3)
        assert signed_distance_to_hat(out, hat)[0] == pytest.approx(0.4, abs=2e-3)
        assert signed_distance_to_hat(inn, hat)[0] == pytest.approx(-0.15, abs=2e-3)


def test_beyond_the_brim_edge_is_outside_not_inside(hat):
    """The meridian is an open curve. A point out past the brim edge clamps
    onto the final vertex, and if the sign came from that segment's normal it
    would read as 'inside the hat' while sitting in open air."""
    mer = outer_meridian(hat)
    edge = mer[-1]
    for dz in (-2.0, -0.5, 0.0, 0.5):
        q = np.array([[edge[0] + 3.0, 0.0, edge[1] + dz]])
        assert signed_distance_to_hat(q, hat)[0] > 0, \
            f"point {3.0 / MM:.0f}mm past the brim edge read as inside"


def test_a_point_under_the_brim_is_inside(hat):
    """Under the brim but within its radial reach is genuinely through the
    surface for a flower mounted on top -- that must not be softened."""
    mer = outer_meridian(hat)
    mid = mer[len(mer) * 3 // 4]
    q = np.array([[mid[0], 0.0, mid[1] - 0.3]])
    assert signed_distance_to_hat(q, hat)[0] < 0


def test_centroid_and_volume_of_a_known_solid():
    m = _cube(2.0, at=(3.0, -1.0, 0.5))
    c, v = mesh_centroid(m)
    assert v == pytest.approx(8.0, rel=1e-9)
    assert np.allclose(c, [3.0, -1.0, 0.5], atol=1e-9)


def test_underside_picks_the_flat_back_only():
    m = _cube(2.0, at=(0.0, 0.0, 1.0))      # spans z = 0 .. 2
    idx = underside_vertices(m)
    assert len(idx) == 4
    assert np.allclose(m.verts[idx][:, 2], 0.0)


def test_a_flower_pushed_into_the_hat_reports_interference(hat):
    """Negative standoff must show up as interference, or the check is inert."""
    cfg = HatConfig(**FAST)
    # Sitting ON local z = 0, like the flower's base disc: a probe centred on
    # the origin would hang half its height below the seat and always collide.
    probe = _cube(1.0, at=(0.0, 0.0, 0.5))
    for offset, expect_hit in ((4.0, False), (-3.0, True)):
        pc = PlacementConfig(radial_position=0.5, surface_offset_mm=offset)
        R, t = placement_matrix(surface_frame(hat, cfg, pc), pc)
        d = signed_distance_to_hat(place(probe, R, t).verts.astype(np.float64), hat)
        assert (d.min() < 0) == expect_hit, f"offset {offset}mm: min distance {d.min() / MM:.2f}mm"


# ---------------------------------------------------------------------------
# Attachment
# ---------------------------------------------------------------------------
def _disc(radius=3.0, thickness=0.2, segments=48):
    """A flat disc standing in for a piece's base: bottom face on z = 0."""
    th = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    top = np.stack([radius * np.cos(th), radius * np.sin(th),
                    np.full(segments, thickness)], axis=1)
    bot = np.stack([radius * np.cos(th), radius * np.sin(th),
                    np.zeros(segments)], axis=1)
    ct = np.array([[0.0, 0.0, thickness]])
    cb = np.array([[0.0, 0.0, 0.0]])
    v = np.concatenate([top, bot, ct, cb])
    it, ib, c_t, c_b = 0, segments, 2 * segments, 2 * segments + 1
    f = []
    for j in range(segments):
        jn = (j + 1) % segments
        f += [[c_t, it + j, it + jn], [c_b, ib + jn, ib + j],
              [it + j, ib + j, ib + jn], [it + j, ib + jn, it + jn]]
    return Mesh(v.astype(np.float32), np.array(f, dtype=np.int32)).welded(1e-6).oriented()


def test_pins_sit_inside_the_material():
    from design_engine.assembly.attachment import build_pins
    piece = _disc(radius=3.0)
    pins, rep = build_pins(piece, PlacementConfig(pin_count=2, pin_diameter_mm=1.6))
    assert rep["placed"] == 2
    assert rep["all_sites_have_material"], rep
    for s in rep["sites"]:
        r = np.hypot(s["x_mm"], s["y_mm"])
        assert r + 0.8 < 3.0 / MM, f"pin at r={r:.1f}mm is outside a 30mm disc"


def test_pins_are_spread_apart_not_clustered():
    """Two pins in the same place are one pin, and the piece pivots on them."""
    from design_engine.assembly.attachment import build_pins
    piece = _disc(radius=3.0)
    _, rep = build_pins(piece, PlacementConfig(pin_count=2, pin_diameter_mm=1.6))
    (a, b) = rep["sites"]
    sep = np.hypot(a["x_mm"] - b["x_mm"], a["y_mm"] - b["y_mm"])
    assert sep > 0.25 * (2 * 3.0 / MM), f"pins only {sep:.1f}mm apart on a 60mm piece"


def test_pins_are_closed_solids():
    from design_engine.assembly.attachment import build_pins
    from design_engine.splitting.splitter import boundary_edges
    pins, _ = build_pins(_disc(), PlacementConfig(pin_count=2))
    assert pins is not None
    assert len(boundary_edges(pins.faces)) == 0
    labels = pins.component_labels()
    assert len(np.unique(labels)) == 2
    for u in np.unique(labels):
        assert Mesh(pins.verts, pins.faces[labels == u]).volume() > 0


def test_pins_carry_the_mount_part_id():
    from design_engine.assembly.attachment import build_pins
    from design_engine.geometry.mesh import PART_MOUNT, part_kind
    pins, _ = build_pins(_disc(), PlacementConfig(pin_count=2))
    assert set(np.unique(pins.parts).tolist()) == {PART_MOUNT}
    assert part_kind(PART_MOUNT) == "mount"


@pytest.mark.parametrize("length,thickness,offset,expected", [
    (9.0, 1.6, 2.0, True),      # plenty of shank for a clutch
    (4.0, 1.6, 2.0, False),     # barely through
    (9.0, 6.0, 2.0, False),   # 9 - 6 - 2 = 1 mm of shank: not enough to grip
    (5.0, 3.0, 2.0, False),
])
def test_pin_reach_through_the_hat_is_judged(length, thickness, offset, expected):
    from design_engine.assembly.attachment import check_pins_clear_the_hat
    rep = check_pins_clear_the_hat(
        {"placed": 2}, HatConfig(thickness_mm=thickness),
        PlacementConfig(pin_length_mm=length, surface_offset_mm=offset))
    assert rep["takes_a_clutch"] is expected
    assert rep["protrusion_mm"] == pytest.approx(length - thickness - offset, abs=1e-6)


def test_pins_do_not_count_as_interference(hat):
    """A pin passing through the hat is the point of a pin, not a collision."""
    from design_engine.assembly.attachment import build_pins
    from design_engine.assembly.contact import contact_report
    from design_engine.geometry.mesh import Mesh as M

    cfg = HatConfig(**FAST)
    pc = PlacementConfig(radial_position=0.5, surface_offset_mm=3.0, pin_count=2)
    piece = _disc(radius=2.0)
    pins, _ = build_pins(piece, pc)
    with_pins = M.concat([piece, pins])
    R, t = placement_matrix(surface_frame(hat, cfg, pc), pc)

    bare = contact_report(piece, R, t, hat, cfg, pc)
    fitted = contact_report(with_pins, R, t, hat, cfg, pc)
    assert bare["interference_mm"] == pytest.approx(0.0, abs=1e-6)
    assert fitted["interference_mm"] == pytest.approx(0.0, abs=1e-6), \
        "the pins were counted as a collision"
    assert fitted["mount_vertices_excluded"] > 0
