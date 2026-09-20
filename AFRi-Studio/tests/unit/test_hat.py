"""The hat has to be a real closed solid, and the right size.

Head circumference is the one dimension a hat cannot get wrong, so it is
checked against the derived radius directly rather than through a rendered
image.
"""
from __future__ import annotations

import numpy as np
import pytest

from design_engine.configurations.schema import HatConfig, HatStyle
from design_engine.geometry.mesh import PART_HAT, PART_HATBAND, Mesh, part_kind
from design_engine.hat.hat import build_hat
from design_engine.hat.profile import MM, brim_span, build_hat_profile, head_radius
from design_engine.splitting.splitter import boundary_edges

FAST = dict(profile_segments=90, revolve_segments=48)


@pytest.mark.parametrize("style", list(HatStyle))
def test_every_style_is_a_closed_solid(style):
    r = build_hat(HatConfig(style=style, **FAST))
    assert len(boundary_edges(r.mesh.faces)) == 0, f"{style.value} has open edges"
    assert r.mesh.volume() > 0, f"{style.value} encloses no volume"


@pytest.mark.parametrize("style", list(HatStyle))
def test_every_body_faces_outward(style):
    r = build_hat(HatConfig(style=style, **FAST))
    labels = r.mesh.component_labels()
    for u in np.unique(labels):
        sub = Mesh(r.mesh.verts, r.mesh.faces[labels == u])
        assert sub.volume() > 0, f"{style.value} has an inside-out body"


@pytest.mark.parametrize("circumference", [520.0, 560.0, 580.0, 620.0])
def test_head_opening_matches_the_size_asked_for(circumference):
    """A 58 cm hat is a 92.3 mm radius. Get this wrong and the hat is unwearable."""
    cfg = HatConfig(head_circumference_mm=circumference, **FAST)
    r = build_hat(cfg)
    expected = circumference / (2 * np.pi)
    assert r.stats["head_radius_mm"] == pytest.approx(expected, abs=0.05)
    # The brim starts at the head radius, so the overall size follows from it.
    assert r.stats["overall_diameter_mm"] == pytest.approx(
        2 * (expected + cfg.brim_width_mm), rel=0.04)


def test_brim_span_finds_the_crown_foot_on_a_straight_crown():
    """A boater's crown sits at exactly the head radius for its whole height,
    so nearest-radius search picks the top of the crown, not its foot."""
    for style in (HatStyle.BOATER, HatStyle.FEDORA, HatStyle.CLOCHE):
        cfg = HatConfig(style=style)
        prof = build_hat_profile(cfg, samples=cfg.profile_segments)
        rh = head_radius(cfg.head_circumference_mm)
        start, end = brim_span(prof, rh)
        # The crown foot is the construction corner (rh, 0), but each style
        # radiuses that corner by its own edge softness, so the nearest sample
        # sits a little way up the fillet -- 0.4 mm on a crisp boater, 2.3 mm
        # on a soft cloche. 3 mm still catches the failure this guards: picking
        # the top of a boater's crown instead of its foot, which was 5.4 mm out.
        assert prof[start, 1] == pytest.approx(0.0, abs=3.0 * MM), \
            f"{style.value}: crown foot at z={prof[start, 1] / MM:.2f}mm"
        assert prof[start, 0] == pytest.approx(rh, abs=3.0 * MM), \
            f"{style.value}: crown foot at r={prof[start, 0] / MM:.2f}mm"
        assert end == len(prof) - 1
        assert prof[end, 0] > rh


def test_crease_deforms_the_crown_and_leaves_the_brim_alone():
    smooth = build_hat(HatConfig(crown_crease=0.0, **FAST))
    creased = build_hat(HatConfig(crown_crease=1.0, **FAST))
    a, b = smooth.surface, creased.surface
    assert a.shape == b.shape
    delta = np.linalg.norm(a - b, axis=-1)
    top = a[..., 2] > a[..., 2].max() * 0.7
    assert delta[top].max() > 2.0 * MM, "the crease did not dent the crown"
    brim = a[..., 2] < 0.2 * MM
    assert delta[brim].max() < 0.05 * MM, "the crease reached the brim"


def test_the_apex_stays_a_single_point():
    """The dent varies with angle. If it moved the pole's ring unevenly the
    vertices would stop coinciding and weld would leave a hole at the top."""
    r = build_hat(HatConfig(crown_crease=1.2, **FAST))
    apex = r.surface[0]
    assert np.ptp(apex, axis=0).max() < 1e-9


def test_band_is_its_own_body_with_its_own_part_id():
    r = build_hat(HatConfig(**FAST))
    kinds = {part_kind(int(p)) for p in np.unique(r.mesh.parts)}
    assert kinds == {"hat", "hatband"}
    assert (r.mesh.parts == PART_HAT).any() and (r.mesh.parts == PART_HATBAND).any()


def test_band_can_be_omitted():
    r = build_hat(HatConfig(band_depth_mm=0.0, **FAST))
    assert set(np.unique(r.mesh.parts).tolist()) == {PART_HAT}
    assert len(boundary_edges(r.mesh.faces)) == 0


def test_outer_surface_is_offset_by_half_the_thickness():
    cfg = HatConfig(thickness_mm=2.0, **FAST)
    r = build_hat(cfg)
    d = np.linalg.norm(r.outer_surface() - r.surface, axis=-1)
    assert np.allclose(d, cfg.thickness_mm * MM * 0.5, atol=1e-9)


def test_geometry_is_deterministic():
    a = build_hat(HatConfig(**FAST)).mesh
    b = build_hat(HatConfig(**FAST)).mesh
    assert np.array_equal(a.verts, b.verts)
    assert np.array_equal(a.faces, b.faces)
