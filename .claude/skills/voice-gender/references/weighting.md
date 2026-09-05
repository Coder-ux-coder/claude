# Weighting and the Evidence Mathematics

Every number in the table below is read at runtime from `priors.json`. This
document is generated from that file — the weights here and the weights the
scorer uses cannot drift apart.

Model `vgender-priors-v1.1`, updated 2026-09-05.

---

## The weight table

| Feature | Tier | Block | Weight | Female μ | Male μ | d′ |
|---|---|---|---|---|---|---|
| `f0_mean_log` | 1 | pitch | **0.270** | 5.352 | 4.787 | 3.32 |
| `vtl_estimate` | 1 | resonance | **0.200** | 14.7 | 17.2 | 2.94 |
| `f3` | 1 | resonance | **0.120** | 2980 | 2540 | 1.95 |
| `f4` | 1 | resonance | **0.080** | 4020 | 3450 | 1.93 |
| `h1_h2` | 2 | quality | **0.080** | 5.5 | 1.5 | 1.23 |
| `f0_p5_log` | 1 | pitch | **0.070** | 5.075 | 4.477 | 3.07 |
| `hnr` | 2 | quality | **0.040** | 16.5 | 19.0 | 0.61 |
| `f1` | 1 | resonance | **0.030** | 590 | 500 | 0.92 |
| `f2` | 1 | resonance | **0.030** | 1720 | 1500 | 1.02 |
| `spectral_centroid` | 3 | spectral | **0.030** | 1750 | 1450 | 0.8 |
| `spectral_rolloff85` | 3 | spectral | **0.020** | 3450 | 2950 | 0.67 |
| `jitter_local` | 2 | quality | **0.015** | 0.52 | 0.62 | 0.34 |
| `shimmer_local` | 2 | quality | **0.015** | 3.1 | 3.6 | 0.37 |
| | | **total** | **1.000** | | | |

### By block

| Block | Weight | Share |
|---|---|---|
| tier1 pitch | 0.34 | 34% |
| tier1 resonance | 0.46 | 46% |
| tier2 quality | 0.15 | 15% |
| tier3 spectral | 0.05 | 5% |

---

## Why resonance outweighs pitch

This is the single most consequential choice in the table, and it is
deliberate: **0.46 to resonance against 0.34 to pitch**, even though F0 is the
more separable cue in isolation (d′ 3.32 against 2.94).

Three reasons.

**Pitch is modifiable; tract length is not.** F0 is trainable, performable and
consciously controllable across roughly an octave. Vocal tract length is fixed
anatomy. When a speaker's pitch and resonance disagree, the resonance is the
more reliable witness.

**Pitch fails exactly where it matters.** The 160–190 Hz overlap band is where
essentially all classification error concentrates. A weighting that leans on
F0 is at its weakest precisely on the cases that decide accuracy.

**The resonance block is four measurements, not one.** F1–F4 pool into a
vocal-tract-length estimate whose errors partly cancel. A single octave error
in F0 has nothing to cancel against.

The self-check case `male_high_pitch` exists to prove this: a 175 Hz male voice
whose pitch sits squarely in the overlap band. Under a pitch-dominant
weighting it classifies female with moderate confidence. Under this weighting
the tract-length estimate carries it to the correct answer — and reports low
confidence, which is the honest description of that voice.

---

## The mathematics

### Per-feature evidence

Each feature is modelled as Gaussian under each class. The evidence it
contributes is the log-likelihood ratio:

```
LLR_i = ln [ N(x_i | μ_F, σ_F) / N(x_i | μ_M, σ_M) ]

      = ln(σ_M/σ_F) − ½((x−μ_F)/σ_F)² + ½((x−μ_M)/σ_M)²
```

Positive favours female, negative male, zero is uninformative. The unit is
nats of evidence — an LLR of +2.3 means the observation is ten times more
likely under the female model.

**Clamped to ±6.0.** Per-feature LLR is clamped to +/-6 so one wild measurement (an octave-doubled F0, a spurious LPC root) cannot dominate the verdict.

### Combination

```
S = Σ (w_i · LLR_i) / Σ w_i        summed over AVAILABLE features only
p(female) = σ(k · S)               k = 2.0
```

Renormalising over available features keeps `S` on a fixed scale when cues go
missing — losing F4 to narrowband audio must not silently shrink the evidence
toward zero and manufacture an abstention.

**Why a weighted mean rather than a naive-Bayes sum.** A plain sum of LLRs
assumes the features are conditionally independent. They are emphatically not:
F0 and vocal tract length both track the same androgen exposure, and F3, F4
and the VTL estimate are arithmetically entangled. Summing would double- and
triple-count one underlying fact and produce absurd confidence. A weighted
mean under-counts instead — the safer error — and the gain `k` restores
calibration.

This makes the model formally a **logistic regression with fixed
coefficients**, where the coefficients are set from published population
statistics rather than fitted. That is the honest description of it.

### Calibration

`k` is the one parameter to fit on labelled data, and the only one to touch
first. It scales confidence without disturbing any relative weighting:

- `k` too low → everything drifts toward 0.5 and the system over-abstains
- `k` too high → confident, and confidently wrong on the overlap band

Fit it by minimising expected calibration error on a **speaker-disjoint**
held-out set. If the same speaker appears in fitting and evaluation, you have
measured memorisation, not generalisation.

Change per-feature weights only with evidence — a measured d′ on your own
corpus, not an intuition.

---

## Gate re-weighting

Gates do not merely annotate the report; they re-weight it. A feature the
recording cannot support must lose its vote rather than cast an unreliable one.
Multipliers are applied to the base weight before combination:

| Gate | Effect |
|---|---|
| `narrowband_f4_unreliable` | `f4` → 0.0, `vtl_estimate` × 0.45 |
| `narrowband_f3_unreliable` | `f3` × 0.25, `spectral_rolloff85` → 0.0 |
| `low_snr` | `hnr` × 0.25, `h1_h2` × 0.6, jitter/shimmer → 0.0 |
| `severe_noise` | `hnr` → 0.0, `h1_h2` × 0.2, abstain band widened to 0.30–0.70 |
| `implausible_hnr` (>30 dB) | `hnr` → 0.0, `h1_h2` × 0.5 |
| `monotone_pitch` (<2 st range) | `f0_p5_log` × 0.2 |
| `possible_creak` | `f0_p5_log` × 0.3 |
| `formant_estimates_inconsistent` | `vtl_estimate` × 0.4 |
| `clipping` | `h1_h2` × 0.5, `shimmer_local` → 0.0 |

**Coverage floor.** If surviving weight falls below 55% of the total, the
result is INDETERMINATE regardless of score. Too much of the evidence base is
missing for the remainder to carry a verdict.
