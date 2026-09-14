#!/usr/bin/env python3
"""Generate models.json from the live Higgsfield OpenAPI specification.

The catalogue is generated, never hand-edited, so the client's validation and
the reference documentation cannot drift from the API the server actually
exposes. Re-run this when Higgsfield ships new models:

    python3 build_models.py            # fetch the live spec and rewrite models.json
    python3 build_models.py --check    # exit 1 if models.json is stale
    python3 build_models.py --spec f   # build from a local spec instead

Only public schema data is read. No credentials are used or required.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.request

SPEC_URL = "https://docs.higgsfield.ai/docs/openapi.json"
OUT = pathlib.Path(__file__).resolve().parent.parent / "models.json"

# Endpoints that manage a request rather than create one. They are part of the
# client, not the model catalogue.
CONTROL_PATHS = ("/requests",)

# Parameters that carry input media. Used to decide whether a model needs an
# image before it can run.
MEDIA_PARAMS = (
    "image_url",
    "image_urls",
    "input_images",
    "first_frame_url",
    "last_frame_url",
    "end_image_url",
    "audio_url",
    "image_reference_url",
)

# Params that only appear on video models, and params that only appear on image
# models. Used to classify the handful of endpoints whose path does not say.
VIDEO_TELLS = ("duration", "generate_audio", "motions", "end_image_url", "first_frame_url")
IMAGE_TELLS = ("num_images", "batch_size", "output_format")


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolver(spec: dict):
    def deref(node):
        seen = 0
        while isinstance(node, dict) and "$ref" in node:
            seen += 1
            if seen > 20:
                raise ValueError("circular $ref")
            cur = spec
            for part in node["$ref"].lstrip("#/").split("/"):
                cur = cur[part]
            node = cur
        return node

    return deref


def classify_output(path: str, params: dict) -> str:
    """image or video. Path wins; parameter shape decides the rest."""
    if "-to-video" in path:
        return "video"
    if "-to-image" in path:
        return "image"
    if any(p in params for p in VIDEO_TELLS):
        return "video"
    if any(p in params for p in IMAGE_TELLS):
        return "image"
    return "image"


def family_of(path: str) -> str:
    parts = path.strip("/").split("/")
    if parts[0] == "higgsfield-ai" and len(parts) > 1:
        return f"{parts[0]}/{parts[1]}"
    if parts[0] in ("bytedance", "minimax", "kling-video") and len(parts) > 1:
        return f"{parts[0]}/{parts[1]}" if parts[0] == "bytedance" else parts[0]
    return parts[0]


def describe_param(name: str, schema: dict, deref) -> dict:
    schema = deref(schema)
    out: dict = {}

    # anyOf is how the spec spells "optional" and "one of these shapes".
    variants = [deref(v) for v in schema.get("anyOf", [])] or [schema]
    non_null = [v for v in variants if v.get("type") != "null"] or variants
    primary = non_null[0]

    enum = schema.get("enum") or primary.get("enum")
    ptype = primary.get("type")
    if isinstance(ptype, list):
        ptype = next((t for t in ptype if t != "null"), None)
    if not ptype and enum:
        ptype = "string" if all(isinstance(e, str) for e in enum) else "integer"

    out["type"] = ptype or "string"
    if enum:
        out["enum"] = list(enum)
    for key in ("minimum", "maximum", "minItems", "maxItems"):
        if key in primary:
            out[key] = primary[key]
    if "default" in schema and schema["default"] is not None:
        out["default"] = schema["default"]
    if out["type"] == "array":
        items = deref(primary.get("items", {}))
        out["items"] = items.get("type", "string")
    desc = schema.get("description") or primary.get("description")
    if desc:
        out["description"] = desc.strip()
    return out


def build(spec: dict) -> dict:
    deref = resolver(spec)
    base = (spec.get("servers") or [{}])[0].get("url", "https://api.higgsfield.ai")
    models: dict = {}

    for path in sorted(spec.get("paths", {})):
        if path.startswith(CONTROL_PATHS):
            continue
        op = spec["paths"][path].get("post")
        if not op:
            continue
        try:
            schema = deref(op["requestBody"]["content"]["application/json"]["schema"])
        except (KeyError, TypeError):
            continue

        props = schema.get("properties", {})
        required = list(schema.get("required", []))
        params = {n: describe_param(n, s, deref) for n, s in props.items()}
        for name in required:
            if name in params:
                params[name]["required"] = True

        output = classify_output(path, params)
        needs = [p for p in required if p in MEDIA_PARAMS]
        accepts = [p for p in params if p in MEDIA_PARAMS]

        models[path] = {
            "family": family_of(path),
            "output": output,
            "kind": f"{'image' if needs else 'text'}-to-{output}",
            "requires_media": needs,
            "accepts_media": accepts,
            "summary": (op.get("summary") or "").strip(),
            "params": params,
        }

    return {
        "$comment": "GENERATED by scripts/build_models.py -- do not edit by hand.",
        "source": SPEC_URL,
        "openapi_version": spec.get("openapi"),
        "base_url": base,
        "model_count": len(models),
        "models": models,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", help="path to a local openapi.json instead of fetching")
    ap.add_argument("--check", action="store_true", help="verify models.json is current; do not write")
    args = ap.parse_args()

    spec = json.loads(pathlib.Path(args.spec).read_text()) if args.spec else fetch(SPEC_URL)
    catalogue = build(spec)
    if not catalogue["models"]:
        print("error: spec produced no models", file=sys.stderr)
        return 1

    rendered = json.dumps(catalogue, indent=2, sort_keys=False) + "\n"

    if args.check:
        current = OUT.read_text() if OUT.exists() else ""
        if current != rendered:
            print(f"stale: {OUT} differs from the live spec. Run build_models.py.", file=sys.stderr)
            return 1
        print(f"current: {catalogue['model_count']} models match the live spec")
        return 0

    OUT.write_text(rendered)
    video = sum(1 for m in catalogue["models"].values() if m["output"] == "video")
    print(f"wrote {OUT}")
    print(f"  {catalogue['model_count']} models  ({video} video, {catalogue['model_count'] - video} image)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
