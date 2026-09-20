"""Turn a sentence into a Blender script.

Claude writes the script. This module tells it what it may use, checks what
comes back against the guard, and gives it one chance to fix a script the guard
turned down. Nothing else.
"""

import re

import anthropic

import guard
import settings

SYSTEM = """You write Blender Python that builds one object.

Rules:
- Use only bpy, bmesh, math, mathutils, random and colorsys.
- Build geometry and materials. Nothing else: no camera, no lights, no world,
  no render settings, no file reading or writing, no add-ons.
- Build at real size, in metres. A mug is about 0.1 m tall, a chair about 0.9 m.
- Stand the object on z = 0 and centre it roughly on the origin.
- Give every surface a material with a sensible colour and roughness. Real
  objects are rarely pure white or pure black.
- Prefer clean, readable construction: primitives, modifiers, bmesh. Keep it
  under about 200 lines.
- Shade curved surfaces smooth so they do not look faceted.

Reply with the Python only. No explanation, no markdown fence."""


def _clean(text: str) -> str:
    """Take the code out, whatever wrapping it arrived in."""
    fenced = re.findall(r"```(?:python|py)?\n(.*?)```", text, re.S)
    if fenced:
        return max(fenced, key=len).strip()
    return text.strip()


def _ask(client, model, messages, spend):
    with client.messages.stream(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=SYSTEM,
        messages=messages,
    ) as stream:
        message = stream.get_final_message()

    # You are paying for this, so it is counted and shown.
    used = message.usage
    spend["input"] += getattr(used, "input_tokens", 0) or 0
    spend["output"] += getattr(used, "output_tokens", 0) or 0
    spend["cache_read"] += getattr(used, "cache_read_input_tokens", 0) or 0
    spend["cache_write"] += getattr(used, "cache_creation_input_tokens", 0) or 0

    if message.stop_reason == "refusal":
        raise RuntimeError("Claude would not build that one.")
    return _clean("".join(b.text for b in message.content if b.type == "text"))


def cost_of(spend, model) -> float:
    """Dollars, at the published rate for the model that ran."""
    per_in, per_out = settings.price_of(model)
    million = 1_000_000
    return round(
        spend["input"] / million * per_in
        + spend["cache_read"] / million * per_in * 0.1
        + spend["cache_write"] / million * per_in * 1.25
        + spend["output"] / million * per_out,
        4,
    )


def write_script(request: str, previous: str | None = None, api_key: str | None = None,
                 model: str | None = None, on_stage=None) -> dict:
    """The script for this request, with what it cost.

    Raises if it cannot produce one the guard will allow.
    """
    key = api_key or settings.get_key()
    if not key:
        raise RuntimeError("No Claude key.")
    model = model or settings.model()
    client = anthropic.Anthropic(api_key=key)
    spend = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}

    if previous:
        first = (f"Here is the script that built the current object:\n\n{previous}\n\n"
                 f"Change it so that: {request}\n\nReply with the whole new script.")
    else:
        first = f"Build this: {request}"

    messages = [{"role": "user", "content": first}]
    if on_stage:
        on_stage("Working out how to build it")
    code = _ask(client, model, messages, spend)

    problems = guard.check(code)
    if problems:
        if on_stage:
            on_stage("Tidying the script")
        messages += [
            {"role": "assistant", "content": code},
            {"role": "user", "content":
                "That script cannot run here:\n- " + "\n- ".join(problems) +
                "\n\nRewrite it within the rules. Reply with the whole script."},
        ]
        code = _ask(client, model, messages, spend)
        problems = guard.check(code)

    if problems:
        raise RuntimeError("That script asked to do things Kiln does not allow: "
                           + "; ".join(problems))
    return {"code": code, "model": model, "cost_usd": cost_of(spend, model), "tokens": spend}
