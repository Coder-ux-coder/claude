# Feature Tiers

Every measurement the pipeline takes, what it physically is, and why it is
trusted as much (or as little) as it is.

The organising principle: **the voice is a source driving a filter.** The
larynx is the source and sets pitch; the vocal tract above it is the filter
and sets resonance. Androgen exposure at puberty enlarges both, but by
different mechanisms and to different degrees — which is precisely why the two
blocks can be read as independent evidence.

---

## Tier 1 — Primary discriminators (0.80 of total weight)

### Pitch block (0.34)

**`f0_mean_log` — mean fundamental frequency, log Hz — weight 0.27**

Rate of vocal-fold vibration. Testosterone at puberty lengthens and thickens
the folds (adult male 17–25 mm, adult female 12.5–17.5 mm); greater length and
mass lower the resonant frequency of the oscillator.

- Male: 85–180 Hz, μ ≈ 120 Hz
- Female: 165–255 Hz, μ ≈ 210 Hz
- **Overlap band 160–190 Hz** — where nearly all error concentrates

Modelled in log space because F0 is log-normally distributed and perception of
pitch is logarithmic; a 20 Hz difference at 100 Hz is a musical third, at 240 Hz
barely a whole tone.

*Failure mode:* octave errors. A tracker that halves or doubles F0 turns a
correct male reading into a confident female one. The extractor runs an
explicit sub-harmonic guard, and any F0 that disagrees with the resonance block
should be treated as suspect until checked.

**`f0_p5_log` — 5th percentile of F0, log Hz — weight 0.07**

The pitch floor: the bottom of the habitual range, reached at phrase-final
falls. Harder to raise deliberately than the mean and less perturbed by
emotional arousal.

*Failure mode:* creak/vocal fry drops F0 to 40–70 Hz in any speaker, and a
monotone or synthetic delivery removes the prosodic range this feature assumes.
Both are gated.

### Resonance block (0.46)

This block outweighs pitch — deliberately. See `weighting.md`.

**`vtl_estimate` — vocal tract length, cm — weight 0.20**

The most anatomically direct measurement available, and after F0 the strongest
single discriminator (d′ 2.94).

A vocal tract is acoustically a tube closed at the glottis and open at the
lips, so its resonances fall at

```
F_n = (2n − 1) · c / (4L)        c = 35 000 cm/s
```

Invert it and every formant independently implies a tube length. Pooling the
four estimates by weighted median (F1 0.10, F2 0.20, F3 0.35, F4 0.35) rejects
the outlier that a single mis-tracked formant would introduce.

- Male: ≈ 17.2 cm
- Female: ≈ 14.7 cm

Roughly 15% shorter, which raises every female formant by 15–20%.

**Why this matters more than pitch:** vocal tract length cannot be altered at
will. Pitch can — it is trainable, performable, and deliberately modifiable.
When the two disagree, anatomy is the more reliable witness.

**`f3` — third formant, Hz — weight 0.12**

Male ≈ 2540 Hz, female ≈ 2980 Hz. Chosen over F1/F2 because it is largely fixed
by tract length rather than tongue position — it reports anatomy rather than
which vowel was spoken.

*Failure mode:* rhotic /r/ collapses F3 dramatically in both sexes.

**`f4` — fourth formant, Hz — weight 0.08**

Male ≈ 3450 Hz, female ≈ 4020 Hz. The most tract-determined and least
articulation-determined formant measurable in practice.

*Failure mode:* absent entirely on 8 kHz telephony (Nyquist 4 kHz). The
pipeline drops it and redistributes weight rather than fabricating a value.

**`f1`, `f2` — first and second formants — weight 0.03 each**

F1 tracks tongue height, F2 tongue front/back position. Both carry genuine
tract-length information, both are dominated by vowel identity. The vowel /i/
in a male voice can show a lower F1 than /a/ in a female voice.

Their low weight is not an oversight. F1 is additionally biased low at high F0,
where sparse harmonics leave LPC fitting harmonic peaks instead of the true
resonance — which is why it contributes only 0.10 to the VTL pooling.

---

## Tier 2 — Voice quality and phonation (0.15)

Measures *how* the folds vibrate rather than how fast — a third axis, partly
independent of both pitch and resonance.

**`h1_h2` — first minus second harmonic amplitude, dB — weight 0.08**

Glottal open quotient; operationally, breathiness. Adult female phonation
commonly shows a **posterior glottal chink** — incomplete closure at the rear
of the folds during vibration — producing turbulent leakage and
disproportionate energy in the first harmonic.

- Male ≈ 1.5 dB, female ≈ 5.5 dB

The highest-weighted Tier 2 feature because it is physiologically independent
of both F0 and tract length: it carries information the other blocks do not.

**`hnr` — harmonics-to-noise ratio, dB — weight 0.04**

Periodic over aperiodic energy. Male ≈ 19 dB, female ≈ 16.5 dB. The
corroborating half of the breathiness signal, but weak alone (d′ 0.61) and
badly confounded by recording noise — a noisy male recording mimics a breathy
female one. Automatically downweighted at low SNR, and dropped entirely above
30 dB, which indicates denoising rather than a clean voice.

**`jitter_local`, `shimmer_local` — weight 0.015 each**

Cycle-to-cycle variation in period and in amplitude. Near-zero weight is
deliberate: these are clinical markers of vocal pathology, not of anatomy
(d′ ≈ 0.35). Retained for the diagnostic record, not for the verdict.

---

## Tier 3 — Spectral shape (0.05)

**`spectral_centroid` (0.03), `spectral_rolloff85` (0.02)**

Centre of spectral mass and the 85%-energy frequency — coarse summaries of the
same tract-length effect the formants measure precisely. Kept as a cheap
sanity check, weighted low because they are as much a property of the
microphone and any applied EQ as of the speaker.

---

## Tier 4 — Learned representations (reported, not scored)

MFCCs 1–13 with their standard deviations are extracted and reported, and
`priors.json` lists them under `unscored_diagnostics`.

They carry no numeric weight because there is no defensible population prior
for an MFCC coefficient without a fitted model — the values depend on the
filterbank, the frame length and the implementation. Assigning them invented
means and sigmas would manufacture confidence rather than measure it.

Read them as corroboration: MFCC 1–4 capture broad spectral tilt and vocal
tract shape, so a male verdict alongside a strongly positive MFCC2 is worth a
second look.

If you later fit a model — a GBM on these features, or a linear probe on
ECAPA-TDNN speaker embeddings, where sex is nearly linearly separable — that
becomes a genuine Tier 4 and should be fused at the logit level with the
existing score, not substituted for it. The interpretable path is what lets
you defend a finding; keep it.
