#!/usr/bin/env python3
"""Regenerate web/priors.gen.js from the skill's priors.json.

The browser analyser and the CLI must score identically. Keeping one source of
truth and generating the other is the only way to guarantee that; a hand-copied
weight table drifts the moment either side is tuned.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = ROOT / ".claude/skills/voice-gender/priors.json"
dst = ROOT / "web/priors.gen.js"

d = json.loads(src.read_text())
slim = {
    "model_id": d["model_id"],
    "combination": {k: d["combination"][k] for k in ("gain_k", "llr_clamp")},
    "features": {k: {"tier": v["tier"], "group": v["group"], "weight": v["weight"],
                     "unit": v["unit"], "female": v["female"], "male": v["male"],
                     "d_prime": v.get("d_prime")}
                 for k, v in d["features"].items()},
}
dst.write_text(
    "// GENERATED from .claude/skills/voice-gender/priors.json — do not edit by hand.\n"
    "// Regenerate:  python3 web/build_priors.py\n"
    "export const PRIORS = " + json.dumps(slim, indent=2) + ";\n")
w = sum(f["weight"] for f in slim["features"].values())
assert abs(w - 1.0) < 1e-9, f"weights must sum to 1.0, got {w}"
print(f"wrote {dst.relative_to(ROOT)} — {len(slim['features'])} features, sum {w:.4f}")
