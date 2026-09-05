# Decision Rules

How a score becomes a verdict — and when it must not.

---

## Decision bands

With `p = p(female)`:

| Range | Verdict | Confidence |
|---|---|---|
| p ≥ 0.90 | FEMALE | high |
| 0.75 ≤ p < 0.90 | FEMALE | moderate |
| 0.60 ≤ p < 0.75 | FEMALE | low — flag it |
| 0.40 < p < 0.60 | **INDETERMINATE** | — |
| 0.25 < p ≤ 0.40 | MALE | low — flag it |
| 0.10 < p ≤ 0.25 | MALE | moderate |
| p ≤ 0.10 | MALE | high |

Under `severe_noise` the abstention band widens to 0.30–0.70.

A low-confidence verdict is a real result and should be reported as one, with
the ambiguity stated plainly. It is not a failure — voices near the boundary
genuinely exist, and describing one as borderline is more accurate than
forcing it to a side.

---

## Hard abstention gates

These override the score outright. **Never argue past one.** A high `p` that
survives a hard gate is not evidence the gate is wrong; it is the arithmetic
being confident about a measurement the recording cannot support.

| Gate | Trigger | Why it is disqualifying |
|---|---|---|
| `insufficient_voiced_audio` | < 0.5 s voiced, or < 25 voiced frames | Below the floor at which F0 and formant statistics mean anything |
| `no_pitch_detected` | < 5 voiced frames | Whispered, unvoiced, or not speech. No source to measure |
| `possible_child_or_prepubertal` | F0 > 240 Hz **and** VTL < 13.6 cm | Sex-linked dimorphism has not developed. The system is near chance here and must say so |
| `multiple_speakers_suspected` | Two F0 modes ≥ 4 semitones apart with a clear valley | Averaging across speakers yields a confident, meaningless number. Diarise first |
| `formants_unavailable` | No VTL estimate | The entire resonance block — 0.46 of total weight — is missing |
| coverage < 0.55 | Surviving weight below 55% of total | Too little of the evidence base remains |

When one fires, report **which** gate, **what it means**, and **what recording
would resolve it**. "Indeterminate" alone is not a useful answer; "indeterminate
because only 0.3 s of voiced speech was present — a 3-second sample would
resolve it" is.

---

## Soft gates

These re-weight rather than disqualify. Full multiplier table in
`weighting.md`. They fire on: narrowband audio, low SNR, severe noise,
implausible HNR, monotone pitch, creak, clipping, and inconsistent formant
estimates.

Each one that fires appears in the ledger with a one-line explanation. Reproduce
the relevant ones in your report — a reader is entitled to know that the verdict
rested on a reduced evidence base.

---

## Resolving conflicts

Pitch and resonance are physically independent measurements. When they
disagree, that disagreement is information — not noise to be averaged away.

### Ambiguous pitch, clear resonance

**Trust the resonance.** This is the design case. F0 in the 160–190 Hz band is
genuinely uninformative; a vocal-tract-length estimate of 17 cm is not. Expect
a correct verdict at low-to-moderate confidence, and report the ambiguity.

### Clear pitch, ambiguous resonance

Weak verdict at best. First check *why* resonance is ambiguous:

- Narrowband audio? F3/F4 may simply be absent from the recording.
- Wide `vtl_spread_cm`? A formant-tracking failure — the per-formant estimates
  disagree, so none of them is trustworthy.
- Rhotic speech? /r/ collapses F3 in both sexes.

If the resonance block is degraded by any of these, the honest report is low
confidence, not a pitch-driven verdict dressed up as a full analysis.

### Direct conflict — pitch says one, resonance says the other

**Do not average.** Investigate, in this order:

1. **Two speakers.** Check the bimodality screen even if the gate did not fire.
2. **Octave error.** An F0 at exactly half or double a plausible value is the
   classic tell. Compare against the resonance block.
3. **Falsetto, creak, or performance.** A male speaker in falsetto shows male
   formants with female-range F0 — which is exactly this signature.
4. **Formant-tracking failure.** Check `vtl_per_formant_cm` for an outlier.
5. **Genuinely atypical speaker.** After the above are excluded, this remains a
   real possibility and deserves to be reported as such.

Report the conflict and your reading of it. A confident midpoint is the worst
available answer: it is wrong in a way that looks right.

---

## Two or more Tier-1 dissenters

If `cues_dissenting` includes two or more Tier-1 features on a "high
confidence" verdict, treat the confidence as unearned until you have explained
the dissent. High confidence means the evidence converged; if it did not
converge, the label is wrong even when the verdict is right.

---

## Reporting template

> **FEMALE**, moderate confidence (p = 0.83, 78% evidence coverage).
>
> Driven by mean F0 of 198 Hz — near the female centre of 211 Hz — and an
> estimated vocal tract length of 14.9 cm against a female mean of 14.7 cm.
> H1–H2 of 6.1 dB corroborates, indicating the breathier phonation typical of
> adult female speakers.
>
> One dissent: F3 at 2680 Hz sits between the population means and votes
> weakly male. F4 was excluded — the recording is band-limited to 4 kHz, so
> the fourth formant is not present in the signal.
>
> Wideband audio would raise confidence by restoring F4 and the full
> tract-length estimate.

State the verdict, the confidence, the driving measurements with units, the
dissent, and what would change the answer. Never a bare label.
