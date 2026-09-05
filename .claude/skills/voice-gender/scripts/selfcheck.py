#!/usr/bin/env python3
"""
Self-validation for the voice-sex pipeline.

Synthesises source-filter voices whose F0 and formants are known exactly,
runs the real extraction and scoring path over them, and asserts that the
measurements recover the ground truth.

The rule this enforces: never debug a classifier when the bug is in a
windowing function. If the extractor cannot recover a 120 Hz source through
a known vocal tract, no verdict it produces on real audio means anything.

Usage:
    python3 selfcheck.py [--keep DIR] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extract_features import analyse, HAVE_PRAAT          # noqa: E402
from score import score                                    # noqa: E402

SR = 16000
PRIORS = json.loads((HERE.parent / "priors.json").read_text())


# ----------------------------------------------------------------------------
def glottal_source(f0, dur, sr=SR, jitter=0.008, shimmer=0.03, seed=0):
    """Harmonic-sum model of the glottal flow derivative after lip radiation.

    Amplitudes fall as 1/h, giving the -6 dB/octave source tilt measured in
    real phonation. A shaped-pulse model is more photogenic but, unless the
    closure discontinuity is modelled exactly, it under-excites the upper
    formants -- and an F4 that is not excited cannot be measured, which would
    make this whole self-check vacuous.
    """
    rng = np.random.default_rng(seed)
    n = int(dur * sr)
    t = np.arange(n) / sr

    def smooth(v, w):
        return np.convolve(v, np.ones(w) / w, mode="same")

    # Realistic prosody: a declination slope with syllabic movement on top,
    # giving roughly the 6-9 semitone range of natural connected speech. A flat
    # contour would make the pitch-floor feature look far more decisive than it
    # is on real voices.
    decl = -0.055 * (t / max(t[-1], 1e-9))
    syll = 0.055 * np.sin(2 * np.pi * 3.1 * t) + 0.028 * np.sin(2 * np.pi * 1.3 * t + 0.7)
    drift = f0 * (1.0 + decl + syll)
    jit = smooth(f0 * jitter * rng.standard_normal(n), 48)       # cycle jitter
    phase = 2 * np.pi * np.cumsum(np.clip(drift + jit, 20, sr / 2)) / sr

    n_harm = max(1, int(sr / (2.2 * f0)))
    src = np.zeros(n)
    for h in range(1, n_harm + 1):
        src += (1.0 / h) * np.sin(h * phase + rng.uniform(0, 2 * np.pi))
    amp = 1.0 + smooth(shimmer * rng.standard_normal(n), 64)
    return src * amp


def formant_filter(x, freqs, bws, sr=SR, amps=None):
    """Parallel formant bank, each branch normalised to unity gain at its own
    resonance.

    A cascade of unity-DC-gain resonators is the textbook vocal-tract model,
    but its inter-formant roll-off puts F4 some 70 dB below F1 -- far too
    weak for any tracker to find. A parallel bank with explicit per-formant
    amplitudes (0, -7, -12, -18 dB, the measured relative levels in real
    vowels) reproduces the spectrum we actually need to test against.
    """
    from scipy.signal import freqz
    if amps is None:
        amps = [1.0, 0.45, 0.25, 0.13][:len(freqs)]
    y = np.zeros_like(x)
    for f, b, a in zip(freqs, bws, amps):
        r = math.exp(-math.pi * b / sr)
        th = 2 * math.pi * f / sr
        den = [1.0, -2 * r * math.cos(th), r * r]
        _, h = freqz([1.0], den, worN=[th])          # exact gain at resonance
        y += a * lfilter([1.0 / abs(h[0])], den, x)
    return y


def synth_voice(f0, formants, dur=4.0, sr=SR, breath=0.0, seed=0):
    """Source-filter synthesis with an optional aspiration component, which is
    how we simulate the breathiness that Tier 2 is built to detect."""
    rng = np.random.default_rng(seed + 7)
    src = glottal_source(f0, dur, sr, seed=seed)
    bws = [70 + 0.055 * f for f in formants]
    v = formant_filter(src, formants, bws, sr)
    if breath > 0:
        noise = formant_filter(rng.normal(0, 1, len(src)), formants, bws, sr)
        v = v + breath * noise * (np.abs(v).mean() / (np.abs(noise).mean() + 1e-12))
    env = np.ones(len(v))
    ramp = int(0.02 * sr)
    env[:ramp] = np.linspace(0, 1, ramp)
    env[-ramp:] = np.linspace(1, 0, ramp)
    v *= env
    m = np.max(np.abs(v))
    return (v / m * 0.85) if m > 0 else v


def write_wav(path, x, sr=SR):
    try:
        import soundfile as sf
        sf.write(path, x.astype(np.float32), sr)
    except ImportError:
        import wave
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


# ----------------------------------------------------------------------------
CASES = [
    {"id": "male_typical",    "f0": 120, "formants": [500, 1500, 2540, 3450],
     "breath": 0.00, "expect": "MALE",   "note": "canonical adult male"},
    {"id": "female_typical",  "f0": 210, "formants": [590, 1720, 2980, 4020],
     "breath": 0.12, "expect": "FEMALE", "note": "canonical adult female"},
    {"id": "male_deep",       "f0": 95,  "formants": [470, 1420, 2400, 3280],
     "breath": 0.00, "expect": "MALE",   "note": "low bass male"},
    {"id": "female_high",     "f0": 245, "formants": [620, 1800, 3080, 4180],
     "breath": 0.15, "expect": "FEMALE", "note": "high soprano-range female"},
    {"id": "male_high_pitch", "f0": 175, "formants": [505, 1510, 2560, 3480],
     "breath": 0.00, "expect": "MALE",
     "note": "HIGH-PITCHED MALE - F0 sits inside the 160-190 Hz overlap band. "
             "This is the case the resonance weighting exists to solve: pitch "
             "is ambiguous, tract length is not."},
    {"id": "female_low_pitch", "f0": 168, "formants": [585, 1710, 2960, 3990],
     "breath": 0.14, "expect": "FEMALE",
     "note": "LOW-PITCHED FEMALE - the mirror-image trap. Formants must carry it."},
]


def run(keep: Path | None, verbose: bool) -> int:
    tmp = keep or Path(tempfile.mkdtemp(prefix="vgender_selfcheck_"))
    tmp.mkdir(parents=True, exist_ok=True)
    print("=" * 78)
    print("  VOICE-SEX PIPELINE SELF-CHECK")
    print(f"  praat backend: {'available' if HAVE_PRAAT else 'ABSENT (numpy fallback)'}")
    print(f"  work dir     : {tmp}")
    print("=" * 78)

    passed = failed = 0

    # ---- Stage 1: does the extractor recover known truth? ------------------
    print("\n  STAGE 1  measurement accuracy against known ground truth")
    print("  " + "-" * 74)
    print(f"  {'case':<18}{'F0 true':>8}{'F0 meas':>9}{'err':>7}"
          f"{'F3 true':>9}{'F3 meas':>9}{'err':>7}")
    print("  " + "-" * 74)
    for c in CASES:
        x = synth_voice(c["f0"], c["formants"], breath=c["breath"],
                        seed=abs(hash(c["id"])) % 9999)
        p = tmp / f"{c['id']}.wav"
        write_wav(p, x)
        f = analyse(str(p))
        c["_features"] = f
        f0m = f["pitch"].get("f0_mean_hz")
        f3m = f["resonance"].get("f3_hz")
        f0e = abs(f0m - c["f0"]) / c["f0"] * 100 if f0m else float("nan")
        f3e = abs(f3m - c["formants"][2]) / c["formants"][2] * 100 if f3m else float("nan")
        ok = (f0m is not None and f0e < 5.0) and (f3m is not None and f3e < 12.0)
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
        print(f"  {c['id']:<18}{c['f0']:>8}{(f'{f0m:.1f}' if f0m else 'n/a'):>9}"
              f"{(f'{f0e:.1f}%' if f0m else '--'):>7}"
              f"{c['formants'][2]:>9}{(f'{f3m:.0f}' if f3m else 'n/a'):>9}"
              f"{(f'{f3e:.1f}%' if f3m else '--'):>7}   {'PASS' if ok else 'FAIL'}")
    print("  " + "-" * 74)
    print("  tolerance: F0 within 5%, F3 within 12%")

    # ---- Stage 2: does the scorer reach the right verdict? -----------------
    print("\n  STAGE 2  end-to-end verdict")
    print("  " + "-" * 74)
    print(f"  {'case':<18}{'expect':>8}{'got':>15}{'p(female)':>11}{'conf':>10}")
    print("  " + "-" * 74)
    for c in CASES:
        r = score(c["_features"], PRIORS)
        got, pf = r["decision"], r.get("p_female", float("nan"))
        ok = got == c["expect"]
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
        print(f"  {c['id']:<18}{c['expect']:>8}{got:>15}{pf:>11.3f}"
              f"{str(r.get('confidence')):>10}   {'PASS' if ok else 'FAIL'}")
        if verbose or not ok:
            for row in r["rows"][:5]:
                print(f"       {row['feature']:<20} {str(row['raw_value']):>9} "
                      f"w={row['effective_weight']:.3f} LLR={row['llr']:+.2f} "
                      f"-> {row['favours']}")
    print("  " + "-" * 74)

    # ---- Stage 3: does it correctly refuse to answer? ----------------------
    print("\n  STAGE 3  abstention behaviour (refusing is the correct answer)")
    print("  " + "-" * 74)

    rng = np.random.default_rng(3)
    neg = [
        ("silence", np.zeros(int(2.0 * SR)), "no voiced audio"),
        ("white_noise", rng.normal(0, 0.25, int(2.0 * SR)), "no periodic source"),
        ("child_like", synth_voice(300, [730, 2100, 3500, 4600], breath=0.10, seed=5),
         "pre-pubertal: high F0 with a short tract"),
    ]
    two = np.concatenate([synth_voice(115, [495, 1490, 2520, 3430], dur=2.0, seed=11),
                          synth_voice(215, [595, 1730, 2990, 4030], dur=2.0,
                                      breath=0.12, seed=12)])
    neg.append(("two_speakers", two, "two speakers in one clip"))

    for name, sig, why in neg:
        p = tmp / f"neg_{name}.wav"
        write_wav(p, sig)
        try:
            f = analyse(str(p))
            r = score(f, PRIORS)
            got = r["decision"]
        except Exception as e:
            got = f"ERROR({type(e).__name__})"
        ok = got == "INDETERMINATE"
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
        reasons = r.get("hard_abstain_reasons", []) if got == "INDETERMINATE" else []
        print(f"  {name:<18}{'INDETERMINATE':>15} -> {got:<15} {'PASS' if ok else 'FAIL'}")
        print(f"       expected because: {why}")
        for rr in reasons[:2]:
            print(f"       abstained: {rr[:80]}")
    print("  " + "-" * 74)

    # ---- Stage 4: do the degradation gates still fire when they should? ----
    print("\n  STAGE 4  gate sensitivity (a relaxed gate must still catch the real thing)")
    print("  " + "-" * 74)
    from scipy.signal import butter, sosfiltfilt

    clean = synth_voice(120, [500, 1500, 2540, 3450], dur=4.0, seed=21)
    checks = []

    # Telephony: band-limit to 3.4 kHz, the classic case F4 cannot survive.
    sos = butter(8, 3400 / (SR / 2), btype="low", output="sos")
    checks.append(("telephony_3.4kHz", sosfiltfilt(sos, clean),
                   "narrowband_f4_unreliable", True))
    # The same voice untouched must NOT trip it, or the gate is useless.
    checks.append(("wideband_control", clean, "narrowband_f4_unreliable", False))
    # Heavy additive noise must trip the SNR gate.
    rng2 = np.random.default_rng(99)
    noisy = clean + 0.55 * rng2.standard_normal(len(clean)) * np.abs(clean).mean() * 3
    checks.append(("noisy_lowSNR", noisy, "low_snr", True))

    for name, sig, gate, want in checks:
        q = tmp / f"gate_{name}.wav"
        m = np.max(np.abs(sig))
        write_wav(q, sig / m * 0.9 if m > 0 else sig)
        f = analyse(str(q))
        got = bool(f["gates"].get(gate))
        ok = got == want
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
        print(f"  {name:<20}{gate:<28} expect={str(want):<6} got={str(got):<6} "
              f"{'PASS' if ok else 'FAIL'}")
        print(f"       measured bandwidth {f['source']['effective_bandwidth_hz']} Hz, "
              f"F4 coverage {f['gates'].get('f4_coverage')}")
    print("  " + "-" * 74)

    print("\n" + "=" * 78)
    print(f"  RESULT   {passed} passed, {failed} failed")
    print("=" * 78)
    if keep:
        print(f"  synthetic audio retained in {tmp}")
    return 0 if failed == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", type=Path, help="retain generated wavs here")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    return run(a.keep, a.verbose)


if __name__ == "__main__":
    sys.exit(main())
