"""Refinement logic: bounded, hypothesis-driven, and never random.

These exercise the decision rules directly with synthetic measurements, so they
run in milliseconds without touching geometry or Blender.
"""
import pytest

from backend.app.agents.refine import (HYPOTHESES, _bump, _improved, _regressed,
                                       _toward_zero)
from design_engine.configurations.schema import DesignConfig


@pytest.fixture
def cfg():
    return DesignConfig()


def test_every_hypothesis_is_well_formed():
    """Each one must name a weakness, a metric and an expected direction."""
    keys = set()
    for h in HYPOTHESES:
        assert h["key"] not in keys, f"duplicate hypothesis key {h['key']}"
        keys.add(h["key"])
        assert h["weakness"] and h["weakness"][0].isupper()
        assert h["metric"] and h["want"] in ("up", "down", "same")
        assert callable(h["test"]) and callable(h["apply"])


def test_hypotheses_apply_cleanly_and_stay_in_range(cfg):
    """Applying any hypothesis must yield a configuration that still validates."""
    measurements = {"petal_count": 40, "silhouette_raggedness": 0.2,
                    "relief_ratio": 0.05, "piece_balance": 0.5,
                    "boundary_area": 1.0}
    for h in HYPOTHESES:
        out = h["apply"](cfg)
        DesignConfig(**out.model_dump(mode="json"))     # revalidates
        assert out is not cfg


def test_bump_respects_the_schema_ceiling(cfg):
    out = _bump(cfg, "flower", "petal_density", +99, 2.5)
    assert out.flower.petal_density == 2.5


def test_bump_respects_the_schema_floor(cfg):
    out = _bump(cfg, "flower", "organic_variation", -99, 1.0, lo=0.0)
    assert out.flower.organic_variation == 0.0


def test_bump_keeps_integers_integral(cfg):
    out = _bump(cfg, "flower", "layer_count", +1, 12, integer=True)
    assert isinstance(out.flower.layer_count, int)
    assert out.flower.layer_count == cfg.flower.layer_count + 1


def test_toward_zero_moves_toward_centre(cfg):
    cfg.split.position = 0.4
    assert _toward_zero(cfg, "split", "position", 0.45).split.position < 0.4


def test_improvement_requires_a_real_move():
    """A change within noise is not an improvement."""
    assert _improved({"m": 100}, {"m": 120}, "m", "up")[0]
    assert not _improved({"m": 100}, {"m": 100}, "m", "up")[0]
    assert not _improved({"m": 100}, {"m": 100.2}, "m", "up")[0]
    assert _improved({"m": 100}, {"m": 80}, "m", "down")[0]
    assert not _improved({"m": 100}, {"m": 110}, "m", "down")[0]


def test_missing_metric_is_not_an_improvement():
    ok, why = _improved({}, {}, "absent", "up")
    assert not ok and "unavailable" in why


def test_regression_guard_catches_collateral_damage():
    base = {"piece_balance": 0.9, "silhouette_raggedness": 0.05, "faces": 100_000}
    assert _regressed(base, {**base, "piece_balance": 0.7}) is not None
    assert _regressed(base, {**base, "silhouette_raggedness": 0.09}) is not None
    assert _regressed(base, {**base, "faces": 1_000_000}) is not None
    assert _regressed(base, {**base, "piece_balance": 0.95}) is None


def test_a_flat_flower_triggers_the_relief_hypothesis(cfg):
    h = next(x for x in HYPOTHESES if x["key"] == "flat_relief")
    assert h["test"]({"relief_ratio": 0.10}, cfg)
    assert not h["test"]({"relief_ratio": 0.25}, cfg)


def test_unbalanced_pieces_trigger_the_balance_hypothesis(cfg):
    h = next(x for x in HYPOTHESES if x["key"] == "unbalanced_pieces")
    assert h["test"]({"piece_balance": 0.6}, cfg)
    assert not h["test"]({"piece_balance": 0.95}, cfg)
    cfg.split.position = 0.5
    assert _toward_zero(cfg, "split", "position", 0.45).split.position == pytest.approx(0.225)
