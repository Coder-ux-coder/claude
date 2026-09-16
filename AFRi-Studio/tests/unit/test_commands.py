"""AI command validation: a hallucinated parameter must never reach the pipeline."""
import pytest

from backend.app.agents.commands import (Command, CommandPlan, CommandType,
                                         apply_command, schema_digest,
                                         validate_command)
from backend.app.agents.designer import _extract_json
from design_engine.configurations.schema import DesignConfig


@pytest.fixture
def cfg():
    return DesignConfig()


def test_valid_parameter_is_accepted(cfg):
    ok, why = validate_command(
        Command(type=CommandType.UPDATE_FLOWER_PARAMETER,
                parameter="petal_density", value=1.6), cfg)
    assert ok, why


def test_out_of_range_value_is_rejected(cfg):
    ok, why = validate_command(
        Command(type=CommandType.UPDATE_FLOWER_PARAMETER,
                parameter="petal_density", value=99), cfg)
    assert not ok and "less than or equal" in why


def test_unknown_parameter_is_rejected(cfg):
    ok, why = validate_command(
        Command(type=CommandType.UPDATE_FLOWER_PARAMETER,
                parameter="fluffiness", value=1), cfg)
    assert not ok and "not a flower parameter" in why


def test_wrong_section_is_rejected(cfg):
    ok, why = validate_command(
        Command(type=CommandType.UPDATE_SPLIT_PARAMETER,
                parameter="petal_density", value=1.2), cfg)
    assert not ok


def test_unknown_command_type_cannot_be_constructed():
    with pytest.raises(Exception):
        Command(type="DELETE_EVERYTHING")


def test_extra_fields_are_forbidden():
    with pytest.raises(Exception):
        Command(type=CommandType.RUN_VALIDATION, shell="rm -rf /")


def test_apply_command_changes_only_its_field(cfg):
    out = apply_command(Command(type=CommandType.UPDATE_FLOWER_PARAMETER,
                                parameter="layer_count", value=9), cfg)
    assert out.flower.layer_count == 9
    assert out.split == cfg.split
    assert cfg.flower.layer_count != 9, "the original config was mutated"


def test_plan_size_is_bounded():
    with pytest.raises(Exception):
        CommandPlan(commands=[
            Command(type=CommandType.RUN_VALIDATION) for _ in range(40)])


@pytest.mark.parametrize("raw", [
    '{"explanation":"x","commands":[]}',
    '```json\n{"explanation":"x","commands":[]}\n```',
    'Sure!\n{"explanation":"x","commands":[]}\nHope that helps.',
])
def test_json_extraction_survives_chatty_replies(raw):
    assert _extract_json(raw)["explanation"] == "x"


def test_json_extraction_reports_failure():
    with pytest.raises(ValueError):
        _extract_json("no json at all here")


def test_schema_digest_lists_every_section():
    d = schema_digest()
    for s in ("[flower]", "[split]", "[material]", "[render]"):
        assert s in d
    assert "petal_density" in d and "amplitude" in d
