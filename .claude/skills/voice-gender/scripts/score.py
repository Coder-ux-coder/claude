#!/usr/bin/env python3
"""
Evidence scoring for voice-sex classification.

Consumes the JSON from extract_features.py, scores every measurement against
the population priors, and prints an auditable evidence ledger.

This script does NOT deliver the verdict. It computes the arithmetic and
surfaces the conflicts; the analyst (Claude) reads the ledger, weighs the
gate flags and contextual overrides, and writes the finding. Keeping the
arithmetic reproducible and the judgement explicit is the whole point.

Usage:
    python3 score.py FEATURES.json [--priors priors.json] [--json] [--gain K]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PRIORS = HERE.parent / "priors.json"


# ----------------------------------------------------------------------------
def gaussian_llr(x, mu_f, sd_f, mu_m, sd_m, clamp=6.0):
    """ln[ N(x | female) / N(x | male) ].  Positive favours female."""
    llr = (math.log(sd_m / sd_f)
           - 0.5 * ((x - mu_f) / sd_f) ** 2
           + 0.5 * ((x - mu_m) / sd_m) ** 2)
    return max(-clamp, min(clamp, llr))


def pick(feats: dict, name: str):
    """Map a prior name onto the measured value, applying the declared transform."""
    p, r, q, s = (feats.get(k, {}) for k in ("pitch", "resonance", "quality", "spectral"))
    table = {
        "f0_mean_log":        (lambda: math.log(p["f0_mean_hz"]), p.get("f0_mean_hz")),
        "f0_p5_log":          (lambda: math.log(p["f0_p5_hz"]),   p.get("f0_p5_hz")),
        "vtl_estimate":       (lambda: r["vtl_estimate_cm"], r.get("vtl_estimate_cm")),
        "f3":                 (lambda: r["f3_hz"], r.get("f3_hz")),
        "f4":                 (lambda: r["f4_hz"], r.get("f4_hz")),
        "f1":                 (lambda: r["f1_hz"], r.get("f1_hz")),
        "f2":                 (lambda: r["f2_hz"], r.get("f2_hz")),
        "h1_h2":              (lambda: q["h1_h2_db"], q.get("h1_h2_db")),
        "hnr":                (lambda: q["hnr_db"], q.get("hnr_db")),
        "jitter_local":       (lambda: q["jitter_local_pct"], q.get("jitter_local_pct")),
        "shimmer_local":      (lambda: q["shimmer_local_pct"], q.get("shimmer_local_pct")),
        "spectral_centroid":  (lambda: s["spectral_centroid_hz"], s.get("spectral_centroid_hz")),
        "spectral_rolloff85": (lambda: s["spectral_rolloff85_hz"], s.get("spectral_rolloff85_hz")),
    }
    if name not in table:
        return None, None
    fn, raw = table[name]
    if raw is None:
        return None, None
    try:
        v = fn()
    except Exception:
        return None, None
    if v is None or not math.isfinite(v) or v <= 0 and name.endswith("_log"):
        return None, raw
    return v, raw


def gate_adjustments(gates: dict) -> tuple[dict, list[str]]:
    """Gates do not merely annotate the report -- they re-weight it. A feature
    the recording cannot support must lose its vote, not cast an unreliable one."""
    mult: dict[str, float] = {}
    notes: list[str] = []
    if gates.get("narrowband_f4_unreliable"):
        mult["f4"] = 0.0
        mult["vtl_estimate"] = 0.45
        notes.append("F4 dropped and the vocal-tract estimate downweighted to "
                     "0.45x: source bandwidth cannot support a fourth formant.")
    if gates.get("narrowband_f3_unreliable"):
        mult["f3"] = 0.25
        mult["spectral_rolloff85"] = 0.0
        notes.append("F3 downweighted to 0.25x and rolloff dropped: severe "
                     "band-limiting.")
    if gates.get("low_snr"):
        mult["hnr"] = 0.25
        mult["h1_h2"] = 0.6
        mult["jitter_local"] = 0.0
        mult["shimmer_local"] = 0.0
        notes.append("Voice-quality cues downweighted: SNR below 10 dB makes "
                     "breathiness indistinguishable from recording noise.")
    if gates.get("severe_noise"):
        mult["hnr"] = 0.0
        mult["h1_h2"] = 0.2
        notes.append("HNR dropped entirely: SNR below 5 dB.")
    if gates.get("possible_creak"):
        mult["f0_p5_log"] = 0.3
        notes.append("Pitch floor downweighted to 0.3x: creak/vocal fry "
                     "detected below 75 Hz, which depresses F0 in any speaker.")
    if gates.get("implausible_hnr"):
        mult["hnr"] = 0.0
        mult["h1_h2"] = 0.5
        notes.append("HNR dropped: a harmonicity above 30 dB does not occur in "
                     "natural phonation, so the signal is synthetic, denoised "
                     "or noise-gated and its breathiness cues measure the "
                     "processing rather than the speaker.")
    if gates.get("monotone_pitch"):
        mult["f0_p5_log"] = 0.2
        notes.append("Pitch floor downweighted to 0.2x: F0 range under 2 "
                     "semitones. The feature presumes a natural prosodic range, "
                     "which a monotone reading, a sustained vowel or synthetic "
                     "speech does not provide.")
    if gates.get("formant_estimates_inconsistent"):
        mult["vtl_estimate"] = 0.4
        notes.append("Vocal-tract estimate downweighted to 0.4x: per-formant "
                     "tube-length estimates disagree by more than 5 cm, which "
                     "indicates a formant-tracking failure.")
    if gates.get("clipping"):
        mult["h1_h2"] = mult.get("h1_h2", 1.0) * 0.5
        mult["shimmer_local"] = 0.0
        notes.append("Amplitude-derived cues downweighted: clipping present.")
    return mult, notes


def score(feats: dict, priors: dict, gain: float | None = None) -> dict:
    # A multiplier naming a feature that no longer exists would silently
    # announce a downweight it never applied -- exactly the failure the
    # dispersion->VTL rename introduced. Fail loudly instead.
    _known = set(priors["features"])
    comb = priors["combination"]
    k = gain if gain is not None else comb["gain_k"]
    clamp = comb.get("llr_clamp", 6.0)
    gates = feats.get("gates", {})
    mult, gate_notes = gate_adjustments(gates)
    _stale = set(mult) - _known
    if _stale:
        raise KeyError(f"gate multipliers name unknown feature(s): {sorted(_stale)}; "
                       f"priors.json defines: {sorted(_known)}")

    rows, missing = [], []
    num = den = 0.0
    for name, spec in priors["features"].items():
        val, raw = pick(feats, name)
        w = spec["weight"] * mult.get(name, 1.0)
        if val is None:
            missing.append({"feature": name, "weight_forfeited": spec["weight"],
                            "reason": "not measurable in this recording"})
            continue
        if w <= 0:
            missing.append({"feature": name, "weight_forfeited": spec["weight"],
                            "reason": "zeroed by a quality gate", "raw": raw})
            continue
        llr = gaussian_llr(val, spec["female"]["mu"], spec["female"]["sd"],
                           spec["male"]["mu"], spec["male"]["sd"], clamp)
        num += w * llr
        den += w
        rows.append({
            "feature": name, "tier": spec["tier"], "group": spec["group"],
            "raw_value": raw, "scored_value": round(val, 4),
            "unit": spec["unit"],
            "female_mu": spec["female"]["mu"], "male_mu": spec["male"]["mu"],
            "d_prime": spec.get("d_prime"),
            "base_weight": spec["weight"],
            "effective_weight": round(w, 4),
            "llr": round(llr, 4),
            "contribution": round(w * llr, 4),
            "favours": "female" if llr > 0.15 else "male" if llr < -0.15 else "neutral",
        })

    if den <= 0:
        return {"decision": "INDETERMINATE", "reason": "no scorable features survived the quality gates",
                "rows": rows, "missing": missing, "gate_notes": gate_notes,
                "gates_triggered": [g for g, v in gates.items() if v is True]}

    S = num / den
    p_female = 1.0 / (1.0 + math.exp(-k * S))
    coverage = den / sum(f["weight"] for f in priors["features"].values())

    # ---- decision bands ----------------------------------------------------
    abstain_lo, abstain_hi = 0.40, 0.60
    hard_abstain, hard_reasons = False, []
    for g, msg in (
        ("insufficient_voiced_audio", "under 0.5 s of voiced speech - below the floor for any acoustic verdict"),
        ("no_pitch_detected", "no usable F0 - whispered, unvoiced or non-speech audio"),
        ("possible_child_or_prepubertal", "high F0 with a short estimated vocal tract - consistent with a pre-pubertal speaker, where sex-linked dimorphism has not yet developed"),
        ("multiple_speakers_suspected", "two separated F0 modes - more than one speaker present; diarise before classifying"),
        ("formants_unavailable", "no formant estimates - the entire resonance block (0.46 of total weight) is missing"),
    ):
        if gates.get(g):
            hard_abstain = True
            hard_reasons.append(msg)

    if coverage < 0.55:
        hard_abstain = True
        hard_reasons.append(
            f"only {coverage:.0%} of the evidence weight was measurable; "
            f"below the 55% floor required for a verdict")
    if gates.get("severe_noise"):
        abstain_lo, abstain_hi = 0.30, 0.70
        hard_reasons.append("abstention band widened to 0.30-0.70 for severe noise")

    if hard_abstain:
        decision, conf = "INDETERMINATE", "n/a"
    elif p_female >= abstain_hi:
        decision = "FEMALE"
        conf = ("high" if p_female >= 0.90 else
                "moderate" if p_female >= 0.75 else "low")
    elif p_female <= abstain_lo:
        decision = "MALE"
        pm = 1 - p_female
        conf = "high" if pm >= 0.90 else "moderate" if pm >= 0.75 else "low"
    else:
        decision, conf = "INDETERMINATE", "n/a"

    rows.sort(key=lambda r: abs(r["contribution"]), reverse=True)
    agree = sum(1 for r in rows if r["favours"] == ("female" if S > 0 else "male"))
    against = sum(1 for r in rows if r["favours"] not in (
        "neutral", "female" if S > 0 else "male"))

    return {
        "decision": decision,
        "confidence": conf,
        "p_female": round(p_female, 4),
        "p_male": round(1 - p_female, 4),
        "weighted_mean_llr": round(S, 4),
        "gain_k": k,
        "evidence_coverage": round(coverage, 4),
        "abstain_band": [abstain_lo, abstain_hi],
        "hard_abstain": hard_abstain,
        "hard_abstain_reasons": hard_reasons,
        "cues_agreeing": agree,
        "cues_dissenting": against,
        "rows": rows,
        "missing": missing,
        "gate_notes": gate_notes,
        "gates_triggered": [g for g, v in gates.items() if v is True],
    }


# ----------------------------------------------------------------------------
def render(res: dict, feats: dict) -> str:
    L: list[str] = []
    src = feats.get("source", {})
    pit, res_, qual = feats.get("pitch", {}), feats.get("resonance", {}), feats.get("quality", {})
    acq = feats.get("acquisition", {})
    W = 78

    L.append("=" * W)
    L.append(f"  VOICE SEX ANALYSIS  |  {src.get('name','?')}")
    L.append("=" * W)
    L.append(f"  duration {src.get('duration_s','?')} s   native SR {src.get('native_sr','?')} Hz"
             f"   bandwidth {src.get('effective_bandwidth_hz','?')} Hz")
    L.append(f"  voiced   {pit.get('voiced_duration_s','?')} s "
             f"({pit.get('voiced_fraction',0):.0%})   SNR {acq.get('estimated_snr_db','?')} dB")
    L.append(f"  engines  F0={feats.get('engines',{}).get('f0','?')}  "
             f"formants={feats.get('engines',{}).get('formants','?')}")
    L.append("")

    if res.get("rows"):
        L.append("  EVIDENCE LEDGER   (LLR>0 favours female, <0 favours male)")
        L.append("  " + "-" * (W - 4))
        L.append(f"  {'feature':<21}{'measured':>11} {'wgt':>6} {'LLR':>7} {'contrib':>9}  {'favours':<8}")
        L.append("  " + "-" * (W - 4))
        for r in res["rows"]:
            rv = r["raw_value"]
            rv = f"{rv:.1f}" if isinstance(rv, (int, float)) else str(rv)
            bar = "F" if r["favours"] == "female" else "M" if r["favours"] == "male" else "."
            L.append(f"  {r['feature']:<21}{rv:>11} {r['effective_weight']:>6.3f} "
                     f"{r['llr']:>+7.2f} {r['contribution']:>+9.3f}  {bar} {r['favours']:<7}")
        L.append("  " + "-" * (W - 4))
        L.append(f"  {'weighted mean LLR':<21}{'':>11} {res['evidence_coverage']:>6.2f} "
                 f"{res['weighted_mean_llr']:>+7.2f}")
        L.append("")

    for m in res.get("missing", []):
        L.append(f"  [-] {m['feature']:<20} excluded ({m['weight_forfeited']:.3f} weight): {m['reason']}")
    if res.get("missing"):
        L.append("")

    for n in res.get("gate_notes", []):
        L.append(f"  [!] {n}")
    if res.get("gate_notes"):
        L.append("")

    L.append("  " + "=" * (W - 4))
    L.append(f"  PRELIMINARY   {res.get('decision','?')}"
             f"   p(female)={res.get('p_female','?')}   p(male)={res.get('p_male','?')}"
             f"   confidence={res.get('confidence','?')}")
    L.append(f"  coverage {res.get('evidence_coverage',0):.0%} of evidence weight"
             f"   |   {res.get('cues_agreeing',0)} cues agree, "
             f"{res.get('cues_dissenting',0)} dissent")
    L.append("  " + "=" * (W - 4))

    for r in res.get("hard_abstain_reasons", []):
        L.append(f"  [ABSTAIN] {r}")
    if res.get("gates_triggered"):
        L.append(f"  gates: {', '.join(res['gates_triggered'])}")
    L.append("")
    L.append("  NOTE: this is arithmetic, not the finding. The analyst must now")
    L.append("  reconcile dissenting cues and contextual gates before reporting.")
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("features", help="JSON produced by extract_features.py")
    ap.add_argument("--priors", default=str(DEFAULT_PRIORS))
    ap.add_argument("--gain", type=float, default=None,
                    help="override calibration gain k")
    ap.add_argument("--json", action="store_true", help="emit JSON not a table")
    a = ap.parse_args()

    try:
        feats = json.loads(Path(a.features).read_text())
        priors = json.loads(Path(a.priors).read_text())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    res = score(feats, priors, a.gain)
    print(json.dumps(res, indent=2) if a.json else render(res, feats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
