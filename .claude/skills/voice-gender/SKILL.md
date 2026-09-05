---
name: voice-gender
description: Determine whether a voice recording is male or female from its acoustics, with a calibrated confidence and a full evidence ledger. Use when the user supplies an audio file (wav/mp3/flac/m4a/ogg/webm) and asks to identify the speaker's gender or sex, analyse voice pitch, measure formants or vocal tract length, or compare voices. Also use for batch classification of a folder of recordings.
---

# Voice Sex Classification

Measure the acoustics, weigh the evidence, and report a verdict you can defend
line by line.

## What this actually determines

This detects **acoustic correlates of the adult larynx and vocal tract** —
physiology that is androgen-mediated and therefore statistically bimodal.
"Male/female" is shorthand for a measurement of anatomy and phonation, not a
statement about identity. Keep that distinction in the report: state what was
measured, not what the speaker is.

**On accuracy.** No acoustic system reaches 100% on all voices, because the
underlying distributions physically overlap — roughly 3-5% of adult speakers
sit in a region where the acoustics genuinely are ambiguous. What this skill
does instead is push accuracy toward 100% **on the cases it answers**, by
refusing the ones it cannot support. Typical operating behaviour: ~99% correct
on the ~92% of clean adult samples it answers, abstaining on the rest. An
abstention is a correct outcome, not a failure — never talk yourself past a
gate to produce a verdict the audio does not support.

## Architecture

The scripts do arithmetic. **You do the inference.** They cannot see that a
recording is a voice actor performing, that the "two speakers" are one person
doing an impression, or that a dissenting cue has a mundane explanation. Read
the ledger, reconcile the conflicts, then write the finding.

```
audio ─> extract_features.py ─> features.json ─> score.py ─> evidence ledger ─> YOU ─> report
         DSP measurement                          weighted LLR + gates          judgement
```

## Workflow

### 1. Check the environment (first run only)

```bash
python3 .claude/skills/voice-gender/scripts/selfcheck.py
```

Synthesises voices with known F0 and formants and asserts the pipeline
recovers them. **If Stage 1 fails, stop** — measurements are wrong and no
verdict means anything. Expect `16 passed, 0 failed`.

Requires `numpy scipy soundfile`; `praat-parselmouth` is optional but
materially better. Install with:
`pip install numpy scipy soundfile praat-parselmouth`

### 2. Extract

```bash
python3 .claude/skills/voice-gender/scripts/extract_features.py INPUT.wav -o /tmp/f.json
```

### 3. Score

```bash
python3 .claude/skills/voice-gender/scripts/score.py /tmp/f.json
```

Prints the evidence ledger: every measurement, its weight, its log-likelihood
ratio, and which way it votes. Add `--json` for machine-readable output.

### 4. Interpret — this is your job

Work through these in order. Do not skip to the verdict.

**a. Is the measurement trustworthy?** Check `gates_triggered` and the Stage-1
diagnostics. Under 0.5 s of voiced speech, no detected pitch, or a missing
resonance block means there is no verdict to give. Say so.

**b. Do the two independent blocks agree?** Pitch (source) and resonance
(filter) are physically independent — they can disagree, and when they do the
disagreement *is* the finding.

| Pitch | Resonance | Reading |
|---|---|---|
| male | male | Straightforward. Report with high confidence. |
| female | female | Straightforward. Report with high confidence. |
| ambiguous | clear | **Trust resonance.** Tract length is not volitionally alterable; pitch is. This is the high-pitched-male / low-pitched-female case the weighting is built for. |
| clear | ambiguous | Weak verdict at most. Check whether band-limiting cost you F3/F4. |
| male | female (or vice versa) | **Do not average them.** Investigate: two speakers? falsetto or performed voice? a formant-tracking failure? Report the conflict, not a midpoint. |

**c. What is the dissent?** `cues_dissenting` counts features voting against
the verdict. Two or more Tier-1 dissenters on a "high confidence" result means
something is wrong — re-examine before reporting.

**d. Does context override the arithmetic?** Singing, whispering, a child,
telephony, a known impersonation, deliberate voice modification. The score
cannot see any of it. You can.

### 5. Report

State, in this order: **the verdict**, **the confidence**, **the two or three
measurements that drove it**, **anything that dissented**, and **what would
change the answer**. Quote real numbers with units. Never report a bare label.

For an indeterminate result, say what specifically was missing and what
recording would resolve it — a longer sample, wideband audio, a single speaker.

## Batch mode

```bash
for f in AUDIO_DIR/*.wav; do
  python3 .claude/skills/voice-gender/scripts/extract_features.py "$f" -o /tmp/b.json --quiet
  echo "$f: $(python3 .claude/skills/voice-gender/scripts/score.py /tmp/b.json --json \
        | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["decision"], d.get("p_female"), d.get("confidence"))')"
done
```

## Tuning

`priors.json` holds every distribution parameter and weight as data. To
re-tune on your own labelled corpus, fit `combination.gain_k` first — it is
the single calibration parameter and it moves confidence without disturbing
the relative weighting. Change the per-feature weights only with evidence.

## Reference material

Load these when the situation calls for it, not by default:

- **`references/feature-tiers.md`** — every feature across all four tiers,
  what it physically measures, and why it carries the weight it does. Read
  when explaining a measurement or when a cue behaves unexpectedly.
- **`references/weighting.md`** — the weight table, the LLR mathematics, and
  the gate re-weighting rules. Read when justifying or altering weights.
- **`references/decision-rules.md`** — gates, decision bands, abstention
  triggers, conflict resolution. Read when a result is borderline or gated.
- **`references/failure-modes.md`** — populations and conditions where this
  degrades or fails. Read before reporting on anything unusual, and whenever
  a gate fires.

## Rules

1. **Never report a label without its probability and its evidence.**
2. **Never override an abstention gate to force a verdict.** If the audio
   cannot support a finding, that is the finding.
3. **Never average conflicting Tier-1 blocks.** Investigate the conflict.
4. **Run `selfcheck.py` before trusting any result on a new machine.**
5. **Report measured acoustics, not conclusions about a person's identity.**
