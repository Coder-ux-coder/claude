"""The design command schema.

The assistant never executes code and never touches the filesystem. It emits
JSON that is validated against this closed set before anything runs, so a model
that hallucinates a parameter or invents an operation cannot corrupt a design --
the command is rejected and the rejection is shown to the user.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from design_engine.configurations.schema import (DesignConfig, FlowerConfig,
                                                 MaterialConfig, RenderConfig,
                                                 SplitConfig)


class CommandType(str, Enum):
    UPDATE_FLOWER_PARAMETER = "UPDATE_FLOWER_PARAMETER"
    UPDATE_SPLIT_PARAMETER = "UPDATE_SPLIT_PARAMETER"
    UPDATE_MATERIAL_PARAMETER = "UPDATE_MATERIAL_PARAMETER"
    UPDATE_RENDER_PARAMETER = "UPDATE_RENDER_PARAMETER"
    GENERATE_VARIATION = "GENERATE_VARIATION"
    GENERATE_CONCEPT = "GENERATE_CONCEPT"
    RENDER_PREVIEW = "RENDER_PREVIEW"
    RENDER_FINAL = "RENDER_FINAL"
    COMPARE_VERSIONS = "COMPARE_VERSIONS"
    RESTORE_VERSION = "RESTORE_VERSION"
    RUN_VALIDATION = "RUN_VALIDATION"
    EXPORT_ASSETS = "EXPORT_ASSETS"


SECTION_MODELS = {
    CommandType.UPDATE_FLOWER_PARAMETER: ("flower", FlowerConfig),
    CommandType.UPDATE_SPLIT_PARAMETER: ("split", SplitConfig),
    CommandType.UPDATE_MATERIAL_PARAMETER: ("material", MaterialConfig),
    CommandType.UPDATE_RENDER_PARAMETER: ("render", RenderConfig),
}


class Command(BaseModel):
    model_config = {"extra": "forbid"}
    type: CommandType
    parameter: str | None = None
    value: Any = None
    count: int | None = Field(None, ge=1, le=8)
    version_id: str | None = None
    compare_with: str | None = None
    name: str | None = None
    reason: str = ""


class CommandPlan(BaseModel):
    model_config = {"extra": "forbid"}
    explanation: str = ""
    commands: list[Command] = Field(default_factory=list, max_length=24)


def validate_command(cmd: Command, config: DesignConfig) -> tuple[bool, str]:
    """Check a command against the live schema. Returns (ok, reason)."""
    if cmd.type in SECTION_MODELS:
        section, model = SECTION_MODELS[cmd.type]
        if not cmd.parameter:
            return False, f"{cmd.type.value} needs a parameter name"
        if cmd.parameter not in model.model_fields:
            valid = ", ".join(sorted(model.model_fields))
            return False, (f"'{cmd.parameter}' is not a {section} parameter. "
                           f"Valid names: {valid}")
        trial = config.model_copy(deep=True)
        current = getattr(trial, section)
        try:
            setattr(current, cmd.parameter, cmd.value)
            model(**current.model_dump(mode="json"))
        except (ValidationError, ValueError) as exc:
            first = exc.errors()[0] if isinstance(exc, ValidationError) else None
            detail = first.get("msg") if first else str(exc)
            return False, f"{section}.{cmd.parameter} rejected: {detail}"
        return True, "ok"

    if cmd.type in (CommandType.GENERATE_VARIATION, CommandType.GENERATE_CONCEPT):
        if cmd.count is not None and not (1 <= cmd.count <= 8):
            return False, "count must be between 1 and 8"
        return True, "ok"

    if cmd.type in (CommandType.RESTORE_VERSION, CommandType.COMPARE_VERSIONS):
        if not cmd.version_id:
            return False, f"{cmd.type.value} needs version_id"
        return True, "ok"

    return True, "ok"


def apply_command(cmd: Command, config: DesignConfig) -> DesignConfig:
    """Apply a validated parameter command, returning a new config."""
    if cmd.type not in SECTION_MODELS:
        return config
    section, _ = SECTION_MODELS[cmd.type]
    out = config.model_copy(deep=True)
    setattr(getattr(out, section), cmd.parameter, cmd.value)
    return out


def schema_digest() -> str:
    """A compact description of every editable parameter, for the AI prompt."""
    lines = []
    for section, model in (("flower", FlowerConfig), ("split", SplitConfig),
                           ("material", MaterialConfig), ("render", RenderConfig)):
        lines.append(f"[{section}]")
        for name, f in model.model_fields.items():
            ui = (f.json_schema_extra or {}).get("ui", {}) if isinstance(
                f.json_schema_extra, dict) else {}
            ann = f.annotation
            if isinstance(ann, type) and issubclass(ann, Enum):
                rng = "one of " + "|".join(e.value for e in ann)
            elif ui.get("min") is not None:
                rng = f"{ui['min']}..{ui['max']}"
            elif ann is bool:
                rng = "true|false"
            else:
                rng = "value"
            desc = ui.get("description", "") or ""
            lines.append(f"  {name}: {rng} -- {desc}")
    return "\n".join(lines)
