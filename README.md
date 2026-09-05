# voice-gender

A Claude Code skill that determines whether a voice recording is male or
female from its acoustics — with a calibrated probability, a full evidence
ledger, and an explicit refusal to answer when the audio cannot support a
verdict.

## Design

The scripts measure; the model reasons. There is no trained classifier and no
model weights to ship. A DSP layer extracts thirteen acoustic features, scores
each against published population distributions as a log-likelihood ratio, and
emits an auditable ledger. Claude then reads that ledger, reconciles
conflicting cues, applies context the arithmetic cannot see, and writes the
finding.

```
audio ─> extract_features.py ─> features.json ─> score.py ─> ledger ─> Claude ─> report
         DSP measurement                         weighted LLR + gates   judgement
```

Every verdict decomposes into named measurements with units. Nothing is opaque.

## Quick start

```bash
pip install -r requirements.txt

# Validate the pipeline against synthetic voices of known F0 and formants
python3 .claude/skills/voice-gender/scripts/selfcheck.py

# Analyse a recording
python3 .claude/skills/voice-gender/scripts/extract_features.py voice.wav -o f.json
python3 .claude/skills/voice-gender/scripts/score.py f.json
```

In Claude Code the skill triggers on its own — just supply an audio file and
ask.

## What it measures

| Block | Weight | Cues |
|---|---|---|
| Resonance | 0.46 | vocal tract length, F3, F4, F1, F2 |
| Pitch | 0.34 | mean F0, pitch floor |
| Voice quality | 0.15 | H1–H2, HNR, jitter, shimmer |
| Spectral shape | 0.05 | centroid, rolloff |

Resonance outweighs pitch deliberately. Pitch is the more separable cue in
isolation, but it is trainable, performable and consciously modifiable, and it
fails precisely inside the 160–190 Hz band where the sexes overlap. Vocal tract
length is fixed anatomy. That single weighting choice is what lets the system
classify a high-pitched male voice correctly.

## On accuracy

No acoustic system is 100% accurate on all voices, because the underlying
distributions physically overlap. This one instead aims at being right on the
cases it answers, and abstaining on the rest. Twelve quality gates can
disqualify a verdict outright — insufficient voiced audio, no detectable pitch,
a probable child, multiple speakers, a missing resonance block, or evidence
coverage below 55%. **An abstention is a correct outcome.**

## Validation

`selfcheck.py` synthesises voices through a source-filter model with known F0
and formants, then asserts the pipeline recovers them (F0 within 5%, F3 within
12%), reaches the right verdict, abstains on the four cases it should, and
still trips its degradation gates on band-limited and noisy audio. Nineteen
checks; all must pass before any result is trusted.

Included deliberately are `male_high_pitch` and `female_low_pitch` — voices
sitting inside the overlap band, where a pitch-dominant system fails.

## Limits

Read `.claude/skills/voice-gender/references/failure-modes.md` before using
this on anything consequential. In brief: it is near chance on children,
degrades on elderly speakers, cannot detect synthetic or performed speech,
measures anatomy rather than gender identity, and is calibrated on
predominantly English-language corpora.

## Layout

```
.claude/skills/voice-gender/
├── SKILL.md                    workflow and interpretation protocol
├── priors.json                 distributions and weights, as tunable data
├── scripts/
│   ├── extract_features.py     DSP measurement -> JSON
│   ├── score.py                weighted LLR -> evidence ledger
│   └── selfcheck.py            synthetic ground-truth validation
└── references/
    ├── feature-tiers.md        every feature, what it physically measures
    ├── weighting.md            weight table and LLR mathematics
    ├── decision-rules.md       gates, bands, conflict resolution
    └── failure-modes.md        where this degrades and where it must not be used
```
