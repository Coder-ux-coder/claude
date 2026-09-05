# Failure Modes and Limits

Where this degrades, where it fails, and where it must not be used. Read this
before reporting on anything unusual — and whenever a gate fires.

Publishing these is not a disclaimer. A system whose failure envelope is
documented can be relied on within it; one whose limits are unstated cannot be
relied on anywhere.

---

## Populations where accuracy degrades

### Children and pre-pubertal speakers — **near chance**

Before puberty there is minimal laryngeal dimorphism. F0 runs 250–400 Hz in all
children and vocal tracts are uniformly short. The acoustic differences this
system measures **have not developed yet**.

Gated by `possible_child_or_prepubertal`. Do not override it. A verdict here is
not a low-confidence answer, it is a meaningless one.

### Transgender and gender-diverse speakers

The system measures larynx and vocal-tract acoustics. For a speaker whose
voice does not align with their gender identity — in either direction, whether
or not they have undergone voice training or hormone therapy — the measurement
and the identity will diverge.

This is not a defect to be corrected; it is what the instrument measures.
Report the acoustics ("mean F0 172 Hz, estimated VTL 16.8 cm") rather than a
conclusion about the person. Never present an acoustic reading as a
determination of someone's gender.

### Elderly speakers (65+) — **degraded**

The distributions converge with age. Male F0 rises as the folds thin and
stiffen; female F0 falls after menopause. A 75-year-old male and a
75-year-old female may sit within 20 Hz of one another. Resonance remains
informative and should carry more of the reading here.

### Adolescents mid-voice-change — **unstable**

Male F0 during the change is erratic and may break by an octave within a
phrase. Expect a bimodality flag; treat any verdict as provisional.

---

## Recording conditions

| Condition | Effect | Handling |
|---|---|---|
| **Narrowband / telephony (8 kHz)** | F4 absent, F3 unreliable — the strongest resonance cues are simply not in the signal | Gated; F4 dropped, VTL downweighted to 0.45× |
| **Heavy noise (SNR < 10 dB)** | Quality features collapse first: noise mimics breathiness | Gated; HNR and H1–H2 downweighted |
| **Reverberation** | Smears formants, widens bandwidths, biases VTL | **Not currently detected.** Judge by ear and discount resonance |
| **Clipping** | Spurious harmonics corrupt jitter, shimmer and H1–H2 | Gated above 1% of samples |
| **Aggressive denoising / noise gates** | Removes the aperiodic energy HNR measures, producing impossible values | Gated above 30 dB HNR |
| **Low bitrate MP3/Opus** | Truncates high frequencies, quantises the spectrum | Partly caught by bandwidth detection |
| **Music or speech overlay** | Formant tracking fails outright | **Not detected.** Separate sources first |

---

## Speech conditions

**Whispered speech** — no vocal fold vibration, therefore no F0 at all. The
entire pitch block (0.34) is unavailable. Gated by `no_pitch_detected`.
Formant-only inference is possible in principle but is not supported here, and
confidence would not exceed low.

**Singing** — pitch is dictated by the melody, not the speaker. The pitch block
is actively misleading. Trained singers also modify resonance deliberately
(the "singer's formant" clusters F3–F5 near 3 kHz). Use speech, not song.

**Falsetto** — male speakers produce female-range F0 with unchanged male
formants. This is the classic pitch/resonance conflict; see
`decision-rules.md`. The formants are correct.

**Vocal fry / creak** — F0 drops to 40–70 Hz regardless of speaker sex.
Partly gated; corrupts the pitch floor specifically.

**Performed or impersonated voices** — voice actors and impressionists modify
both pitch and resonance deliberately, and can do so convincingly. The system
measures the performance, not the performer. **It cannot detect that a voice is
being performed.** Only context can tell you that.

**Emotional arousal** — raises F0 by 10–30 Hz and increases variability in any
speaker. Shifts a borderline case, will not flip a clear one.

**Illness** — laryngitis, upper respiratory infection and vocal fold oedema all
lower F0 and raise jitter/shimmer.

---

## Cross-linguistic and cross-cultural limits

The priors derive predominantly from English-language corpora. Habitual pitch
carries a **learned, culturally-conditioned component** on top of the
anatomical one — mean F0 for women differs measurably between language
communities, with Japanese women typically speaking well above the
English-speaking average and Dutch women below it, at comparable anatomy.

Tract length is the more stable cue across languages. On non-English audio,
weight resonance more heavily still, and recalibrate `gain_k` on in-language
data before making any accuracy claim.

Tonal languages (Mandarin, Cantonese, Yoruba, Punjabi) add lexical F0 movement
that inflates pitch variance without saying anything about the speaker.

---

## What the system cannot do

Stated plainly, because these are the questions most likely to be asked of it:

- **It cannot identify a speaker.** It measures a population-level acoustic
  property, not an individual signature. That is speaker verification, a
  different task requiring different models.
- **It cannot detect synthetic or cloned speech.** Modern TTS reproduces these
  acoustics faithfully. The `monotone_pitch` gate catches some older systems;
  it should not be relied on for anything.
- **It cannot determine gender identity.** It measures anatomy. See above.
- **It cannot establish age**, beyond the coarse child/adult gate.
- **It cannot be used as evidence about a person** in any consequential
  process — employment, access control, legal or investigative — without a
  human decision-maker who has read the ledger and the limits, and an
  accuracy figure established on data representative of the affected
  population. The abstention rate is part of that figure, not an exception to
  it.

---

## When you are unsure

Abstain. An honest "the audio does not support a determination" costs nothing
and is always defensible. A confident wrong answer costs the credibility of
every correct answer beside it.
