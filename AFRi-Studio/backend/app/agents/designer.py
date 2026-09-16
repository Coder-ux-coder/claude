"""Natural language -> validated design commands."""
from __future__ import annotations

import json
import re

from backend.app.agents.commands import (Command, CommandPlan, CommandType,
                                         schema_digest, validate_command)
from backend.app.agents.providers import ProviderError, active_provider
from design_engine.configurations.schema import DesignConfig

SYSTEM = """You are the design assistant inside AFRi Studio, a local tool for \
designing a two-piece marigold flower accessory.

Translate the user's instruction into a JSON command plan. Reply with JSON only \
-- no prose, no markdown fences.

Shape:
{"explanation": "<one short sentence>", "commands": [ {...}, ... ]}

Command types:
  UPDATE_FLOWER_PARAMETER   {"type":..., "parameter":"<name>", "value":<v>, "reason":"..."}
  UPDATE_SPLIT_PARAMETER    same shape
  UPDATE_MATERIAL_PARAMETER same shape
  UPDATE_RENDER_PARAMETER   same shape
  GENERATE_VARIATION        {"type":..., "count":<1-8>, "reason":"..."}
  GENERATE_CONCEPT          {"type":..., "name":"<name>", "reason":"..."}
  RENDER_PREVIEW            {"type":...}
  RENDER_FINAL              {"type":...}
  COMPARE_VERSIONS          {"type":..., "version_id":"<id>", "compare_with":"<id>"}
  RESTORE_VERSION           {"type":..., "version_id":"<id>"}
  RUN_VALIDATION            {"type":...}
  EXPORT_ASSETS             {"type":...}

Rules:
- Use only the parameter names listed below. Never invent one.
- Respect the stated range of every parameter.
- Prefer a small number of decisive changes over many timid ones.
- "fuller"/"denser" -> raise petal_density, petal_count_base or layer_count.
- "more realistic" -> raise organic_variation, petal_ruffle_amp, layer_tilt_gain.
- "stronger S" -> raise split.amplitude; "smoother" -> raise split.smoothness.
- "move the division right" -> raise split.position; left -> lower it.
- "more balanced pieces" -> move split.position toward 0.
- "show the pieces apart" -> UPDATE_RENDER_PARAMETER separated true.
- After parameter changes, append RENDER_PREVIEW unless the user said otherwise.

Editable parameters:
"""


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start >= 0:
        depth = 0
        for i, ch in enumerate(text[start:], start):
            depth += (ch == "{") - (ch == "}")
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    break
    raise ValueError("the assistant's reply was not valid JSON")


def build_prompt(instruction: str, config: DesignConfig, context: dict) -> tuple[str, str]:
    system = SYSTEM + schema_digest()
    user = (
        f"Current configuration:\n"
        f"{json.dumps(config.model_dump(mode='json'), indent=1)}\n\n"
        f"Context: {json.dumps(context)}\n\n"
        f"Instruction: {instruction}\n\n"
        f"Reply with the JSON command plan only."
    )
    return system, user


def interpret(instruction: str, config: DesignConfig, context: dict | None = None):
    """Translate an instruction into a validated plan.

    Returns (plan, rejected, provider_name, raw). Commands that fail schema
    validation are reported as rejected rather than silently dropped -- and are
    never applied.
    """
    context = context or {}
    provider = active_provider()
    system, user = build_prompt(instruction, config, context)

    if provider.kind == "manual":
        raise ProviderError(
            "No automatic AI provider is available. Use the manual handoff: "
            "copy the prompt shown in the assistant panel into any assistant, "
            "then paste its JSON reply back.")

    raw = provider.complete(system, user)
    data = _extract_json(raw)
    plan = CommandPlan(**data)

    accepted, rejected = [], []
    trial = config.model_copy(deep=True)
    for cmd in plan.commands:
        ok, why = validate_command(cmd, trial)
        if ok:
            accepted.append(cmd)
            from backend.app.agents.commands import apply_command
            trial = apply_command(cmd, trial)
        else:
            rejected.append({"command": cmd.model_dump(mode="json"), "reason": why})
    return CommandPlan(explanation=plan.explanation, commands=accepted), \
        rejected, provider.name, raw


def parse_manual(text: str, config: DesignConfig):
    """Accept a command plan the user pasted in from any assistant."""
    data = _extract_json(text)
    plan = CommandPlan(**data)
    accepted, rejected = [], []
    trial = config.model_copy(deep=True)
    from backend.app.agents.commands import apply_command
    for cmd in plan.commands:
        ok, why = validate_command(cmd, trial)
        if ok:
            accepted.append(cmd)
            trial = apply_command(cmd, trial)
        else:
            rejected.append({"command": cmd.model_dump(mode="json"), "reason": why})
    return CommandPlan(explanation=plan.explanation, commands=accepted), rejected
