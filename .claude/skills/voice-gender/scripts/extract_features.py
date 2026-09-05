#!/usr/bin/env python3
"""
Acoustic feature extraction for voice-sex classification.

Emits a single JSON object holding every measurement named in priors.json,
plus the quality gates that decide whether a verdict may be issued at all.

Hard requirements : numpy, scipy, soundfile
Optional (better) : praat-parselmouth  -> Praat-grade F0, formants, jitter,
                    shimmer and harmonicity. Every one of these has a pure
                    numpy/scipy fallback, so the script never refuses to run.

Usage:
    python3 extract_features.py AUDIO [-o out.json] [--window 3.0] [--quiet]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

try:
    import numpy as np
    from scipy.signal import resample_poly, lfilter, get_window
except ImportError as exc:  # pragma: no cover
    sys.exit(f"FATAL: missing hard requirement ({exc}). "
             f"Install with: pip install numpy scipy soundfile")

try:
    import parselmouth  # type: ignore
    HAVE_PRAAT = True
except ImportError:
    HAVE_PRAAT = False

TARGET_SR = 16000
FRAME_MS = 40.0
HOP_MS = 10.0
F0_MIN, F0_MAX = 60.0, 400.0
VOICING_THRESHOLD = 0.45


# ----------------------------------------------------------------------------
# I/O
# ----------------------------------------------------------------------------
def load_audio(path: str) -> tuple[np.ndarray, int, dict]:
    """Decode to mono float32. Preserves native SR so we can measure the true
    bandwidth of the source before resampling destroys the evidence."""
    meta: dict = {}
    x = sr = None

    try:
        import soundfile as sf
        x, sr = sf.read(path, dtype="float32", always_2d=False)
        meta["decoder"] = "soundfile"
    except Exception as e_sf:
        try:
            out = subprocess.run(
                ["ffmpeg", "-v", "quiet", "-i", path, "-f", "f32le",
                 "-ac", "1", "-ar", str(TARGET_SR), "-"],
                capture_output=True, check=True).stdout
            x = np.frombuffer(out, dtype=np.float32).copy()
            sr = TARGET_SR
            meta["decoder"] = "ffmpeg"
        except Exception as e_ff:
            raise RuntimeError(
                f"could not decode {path!r}. soundfile said: {e_sf}; "
                f"ffmpeg said: {e_ff}") from e_ff

    x = np.asarray(x, dtype=np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)

    meta["native_sr"] = int(sr)
    meta["duration_s"] = round(len(x) / sr, 4)

    # Measure usable bandwidth BEFORE resampling: this is how we detect
    # telephony-band audio whose F4 is simply not present in the signal.
    meta["effective_bandwidth_hz"] = _effective_bandwidth(x, sr)

    if sr != TARGET_SR:
        g = math.gcd(int(sr), TARGET_SR)
        x = resample_poly(x, TARGET_SR // g, int(sr) // g)
        sr = TARGET_SR
    meta["analysis_sr"] = sr

    x = x - np.mean(x)
    peak = np.max(np.abs(x)) if x.size else 0.0
    meta["peak_amplitude"] = round(float(peak), 6)
    meta["clipping_fraction"] = round(
        float(np.mean(np.abs(x) > 0.995)) if x.size else 0.0, 6)
    if peak > 0:
        x = x / peak * 0.95
    return x.astype(np.float64), sr, meta


def _effective_bandwidth(x: np.ndarray, sr: int) -> float:
    """Locate the spectral cliff that marks a codec or telephony band limit.

    An energy-percentile answers the wrong question: a deep male voice keeps
    99.9% of its energy below 3 kHz purely from natural spectral tilt, yet
    its F4 is perfectly measurable. What matters is whether the recording
    chain truncated the band, which shows up as an abrupt sustained drop --
    so we scan down from Nyquist for the first frequency that climbs back
    within 50 dB of the spectral peak.
    """
    if x.size < 2048:
        return float(sr / 2)
    n = min(len(x), sr * 10)
    nfft = 1 << int(math.ceil(math.log2(min(n, 8192))))
    step = nfft // 2
    acc = np.zeros(nfft // 2 + 1)
    cnt = 0
    for i in range(0, min(n, len(x)) - nfft, step):
        seg = x[i:i + nfft] * np.hanning(nfft)
        acc += np.abs(np.fft.rfft(seg)) ** 2
        cnt += 1
    if cnt == 0:
        return float(sr / 2)
    psd = acc / cnt
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    db = np.convolve(10 * np.log10(psd + 1e-20), np.ones(5) / 5, mode="same")

    # Highest frequency still carrying energy within 70 dB of the spectral
    # peak.
    #
    # Two earlier attempts failed instructively. An energy percentile called a
    # deep voice narrowband purely from natural spectral tilt. Scanning for a
    # sharp drop mistook the valley between two formants for a band edge. And
    # subtracting an estimated noise floor breaks under broadband noise, which
    # lifts that floor until only the loudest speech survives -- reporting a
    # band limit where the band is fine and merely noisy, which is what the
    # SNR gate is for. A purely peak-relative threshold answers the question
    # actually being asked: did the recording chain truncate the spectrum?
    peak = float(db.max())
    alive = np.flatnonzero(db > peak - 70.0)
    if alive.size == 0:
        return round(float(freqs[-1]), 1)
    return round(float(freqs[alive[-1]]), 1)



# ----------------------------------------------------------------------------
# Framing + voice activity
# ----------------------------------------------------------------------------
def frame_signal(x: np.ndarray, sr: int):
    flen = int(sr * FRAME_MS / 1000)
    hop = int(sr * HOP_MS / 1000)
    if len(x) < flen:
        x = np.pad(x, (0, flen - len(x)))
    n = 1 + (len(x) - flen) // hop
    idx = np.arange(flen)[None, :] + hop * np.arange(n)[:, None]
    return x[idx], flen, hop


def voice_activity(frames: np.ndarray) -> tuple[np.ndarray, dict]:
    """Energy VAD with a homogeneity escape hatch.

    A purely adaptive threshold assumes the recording contains silence from
    which to learn a noise floor. Continuously-voiced audio -- a sustained
    vowel, or any clip already trimmed to speech -- has almost no dynamic
    range, and a relative threshold then gates out the entire signal. So we
    branch: when the envelope is homogeneous we stop trying to separate
    speech from silence by energy and defer the decision to periodicity,
    which is what actually distinguishes voice from noise.
    """
    ABS_FLOOR_DB = -60.0          # below this is silence in any recording
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    p10 = float(np.percentile(db, 10))
    p95 = float(np.percentile(db, 95))
    dyn = p95 - p10

    if dyn < 12.0:
        mode = "homogeneous_defer_to_periodicity"
        thresh = max(ABS_FLOOR_DB, p95 - 25.0)
        snr = None               # not estimable from a flat envelope
    else:
        mode = "adaptive_energy"
        thresh = max(ABS_FLOOR_DB, p10 + max(6.0, min(0.45 * dyn, 25.0)))
        snr = dyn

    active = db > thresh
    return active, {
        "vad_mode": mode,
        "noise_floor_db": round(p10, 2),
        "speech_peak_db": round(p95, 2),
        "envelope_dynamic_range_db": round(dyn, 2),
        "estimated_snr_db": (round(snr, 2) if snr is not None else None),
        "snr_note": (None if snr is not None else
                     "envelope too flat to estimate SNR; HNR is used instead "
                     "as the noise gate"),
        "vad_threshold_db": round(float(thresh), 2),
        "active_frames": int(active.sum()),
    }


# ----------------------------------------------------------------------------
# F0 (fallback path)
# ----------------------------------------------------------------------------
def _f0_frame(frame: np.ndarray, sr: int) -> tuple[float, float]:
    """Normalised autocorrelation F0 with parabolic refinement and an explicit
    sub-harmonic guard. Octave errors are the number-one cause of confident
    misclassification, so we spend cycles here rather than trusting the peak."""
    f = frame - frame.mean()
    if np.sqrt(np.mean(f ** 2)) < 1e-5:
        return 0.0, 0.0
    w = f * np.hanning(len(f))
    n = len(w)
    nfft = 1 << int(math.ceil(math.log2(2 * n)))
    spec = np.fft.rfft(w, nfft)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]

    lo, hi = int(sr / F0_MAX), min(int(sr / F0_MIN), n - 2)
    if hi <= lo + 1:
        return 0.0, 0.0
    seg = ac[lo:hi + 1]
    i = int(np.argmax(seg))
    peak = float(seg[i])
    lag = float(lo + i)
    if 0 < i < len(seg) - 1:                       # parabolic interpolation
        a, b, c = seg[i - 1], seg[i], seg[i + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag += 0.5 * (a - c) / denom

    # Sub-harmonic guard: if half the lag also correlates strongly, the tracker
    # has locked an octave too low. Prefer the higher (shorter-lag) candidate.
    half = lag / 2.0
    if half >= lo:
        hi_idx = int(round(half))
        if lo <= hi_idx < len(ac) and ac[hi_idx] > 0.85 * peak:
            lag = half
            peak = float(ac[hi_idx])

    return (sr / lag if lag > 0 else 0.0), peak


def track_f0_fallback(frames, sr, active):
    f0 = np.zeros(len(frames))
    conf = np.zeros(len(frames))
    for i in np.flatnonzero(active):
        f0[i], conf[i] = _f0_frame(frames[i], sr)
    voiced = active & (conf > VOICING_THRESHOLD) & (f0 >= F0_MIN) & (f0 <= F0_MAX)
    return f0, conf, voiced


def track_f0_praat(x, sr):
    snd = parselmouth.Sound(x, sampling_frequency=sr)
    pitch = snd.to_pitch_ac(time_step=HOP_MS / 1000,
                            pitch_floor=F0_MIN, pitch_ceiling=F0_MAX)
    vals = pitch.selected_array["frequency"]
    strength = pitch.selected_array["strength"]
    return np.nan_to_num(vals), np.nan_to_num(strength)


# ----------------------------------------------------------------------------
# Formants
# ----------------------------------------------------------------------------
def _levinson(r: np.ndarray, order: int):
    if r[0] <= 0:
        return None
    a = np.zeros(order + 1)
    a[0] = 1.0
    err = float(r[0])
    for i in range(1, order + 1):
        acc = r[i] + (np.dot(a[1:i], r[i - 1:0:-1]) if i > 1 else 0.0)
        k = -acc / err
        if not np.isfinite(k) or abs(k) >= 1.0:
            return None
        prev = a.copy()
        for j in range(1, i):
            a[j] = prev[j] + k * prev[i - j]
        a[i] = k
        err *= (1 - k * k)
        if err <= 0:
            return None
    return a


def _formants_frame(frame, sr, order=None):
    """LPC root-solving. Pre-emphasis lifts the spectral tilt so higher
    formants are not swamped by the glottal source roll-off."""
    if order is None:
        order = int(2 + sr / 1000)
    f = lfilter([1.0, -0.97], [1.0], frame - frame.mean())
    w = f * np.hamming(len(f))
    if np.sqrt(np.mean(w ** 2)) < 1e-6:
        return []
    n = len(w)
    nfft = 1 << int(math.ceil(math.log2(2 * n)))
    spec = np.fft.rfft(w, nfft)
    r = np.fft.irfft(spec * np.conj(spec))[:order + 1]
    a = _levinson(r, order)
    if a is None:
        return []
    try:
        roots = np.roots(a)
    except Exception:
        return []
    roots = roots[np.imag(roots) > 0.01]
    if roots.size == 0:
        return []
    ang = np.arctan2(np.imag(roots), np.real(roots))
    freqs = ang * sr / (2 * np.pi)
    mag = np.abs(roots)
    mag = np.clip(mag, 1e-9, 0.999999)
    bws = -0.5 * (sr / (2 * np.pi)) * np.log(mag)
    keep = (freqs > 90) & (freqs < sr / 2 - 150) & (bws < 450)
    return sorted(float(v) for v in freqs[keep])


def formants_praat(x, sr, max_formant=5500.0):
    snd = parselmouth.Sound(x, sampling_frequency=sr)
    fo = snd.to_formant_burg(time_step=HOP_MS / 1000, max_number_of_formants=5,
                             maximum_formant=max_formant)
    times = np.arange(fo.get_number_of_frames()) * fo.time_step + fo.t1
    out = []
    for t in times:
        row = []
        for k in (1, 2, 3, 4):
            v = fo.get_value_at_time(k, t)
            row.append(float(v) if v and np.isfinite(v) else np.nan)
        out.append(row)
    return np.array(out) if out else np.empty((0, 4)), times


# ----------------------------------------------------------------------------
# Voice quality
# ----------------------------------------------------------------------------
def _h1_h2(frame, sr, f0):
    """Amplitude of the first harmonic minus the second, in dB. Heavy
    zero-padding buys the frequency resolution needed to separate H1 from H2
    at low F0."""
    if f0 <= 0:
        return None
    w = (frame - frame.mean()) * np.hanning(len(frame))
    nfft = 1 << int(math.ceil(math.log2(len(w) * 8)))
    mag = np.abs(np.fft.rfft(w, nfft))
    freqs = np.fft.rfftfreq(nfft, 1 / sr)

    def peak_db(target):
        m = (freqs >= target * 0.85) & (freqs <= target * 1.15)
        if not m.any():
            return None
        return 20 * math.log10(float(mag[m].max()) + 1e-12)

    h1, h2 = peak_db(f0), peak_db(2 * f0)
    if h1 is None or h2 is None:
        return None
    return h1 - h2


def _hnr_frame(frame, sr, f0):
    if f0 <= 0:
        return None
    f = frame - frame.mean()
    w = f * np.hanning(len(f))
    n = len(w)
    nfft = 1 << int(math.ceil(math.log2(2 * n)))
    spec = np.fft.rfft(w, nfft)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lag = int(round(sr / f0))
    if not (1 <= lag < n - 1):
        return None
    r = float(np.clip(ac[lag], 1e-6, 0.999999))
    return 10 * math.log10(r / (1 - r))


def quality_praat(x, sr):
    snd = parselmouth.Sound(x, sampling_frequency=sr)
    out = {}
    try:
        h = snd.to_harmonicity_cc(time_step=HOP_MS / 1000, minimum_pitch=F0_MIN)
        v = h.values[h.values != -200]
        out["hnr_db"] = round(float(np.mean(v)), 3) if v.size else None
    except Exception:
        out["hnr_db"] = None
    try:
        pp = parselmouth.praat.call(snd, "To PointProcess (periodic, cc)",
                                    F0_MIN, F0_MAX)
        j = parselmouth.praat.call(pp, "Get jitter (local)",
                                    0, 0, 1e-4, 0.02, 1.3)
        s = parselmouth.praat.call([snd, pp], "Get shimmer (local)",
                                    0, 0, 1e-4, 0.02, 1.3, 1.6)
        out["jitter_local_pct"] = round(float(j) * 100, 4) if np.isfinite(j) else None
        out["shimmer_local_pct"] = round(float(s) * 100, 4) if np.isfinite(s) else None
    except Exception:
        out["jitter_local_pct"] = out["shimmer_local_pct"] = None
    return out


# ----------------------------------------------------------------------------
# Spectral descriptors + MFCC (no librosa dependency)
# ----------------------------------------------------------------------------
def _mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _imel(m):
    return 700.0 * (10 ** (m / 2595.0) - 1.0)


def mel_filterbank(sr, nfft, n_filters=26, fmin=0.0, fmax=None):
    fmax = fmax or sr / 2
    pts = _imel(np.linspace(_mel(fmin), _mel(fmax), n_filters + 2))
    bins = np.floor((nfft + 1) * pts / sr).astype(int)
    bins = np.clip(bins, 0, nfft // 2)
    fb = np.zeros((n_filters, nfft // 2 + 1))
    for i in range(n_filters):
        l, c, r = bins[i], bins[i + 1], bins[i + 2]
        if c > l:
            fb[i, l:c] = (np.arange(l, c) - l) / (c - l)
        if r > c:
            fb[i, c:r] = (r - np.arange(c, r)) / (r - c)
    return fb


def spectral_features(frames, sr, voiced):
    sel = frames[voiced] if voiced.any() else frames
    if sel.size == 0:
        return {}
    win = get_window("hann", sel.shape[1])
    nfft = 1 << int(math.ceil(math.log2(sel.shape[1])))
    mag = np.abs(np.fft.rfft(sel * win, nfft, axis=1))
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    power = mag ** 2
    tot = power.sum(axis=1) + 1e-12

    centroid = (power * freqs).sum(axis=1) / tot
    spread = np.sqrt((power * (freqs[None, :] - centroid[:, None]) ** 2).sum(axis=1) / tot)
    csum = np.cumsum(power, axis=1) / tot[:, None]
    rolloff = freqs[np.argmax(csum >= 0.85, axis=1)]
    geo = np.exp(np.mean(np.log(power + 1e-12), axis=1))
    flat = geo / (power.mean(axis=1) + 1e-12)
    zcr = np.mean(np.abs(np.diff(np.sign(sel), axis=1)) > 0, axis=1)

    fb = mel_filterbank(sr, nfft)
    melspec = np.log(fb @ power.T + 1e-10)          # (n_filters, frames)
    from scipy.fftpack import dct
    mfcc = dct(melspec, type=2, axis=0, norm="ortho")[:13]

    return {
        "spectral_centroid_hz": round(float(np.mean(centroid)), 2),
        "spectral_spread_hz": round(float(np.mean(spread)), 2),
        "spectral_rolloff85_hz": round(float(np.mean(rolloff)), 2),
        "spectral_flatness": round(float(np.mean(flat)), 6),
        "zero_crossing_rate": round(float(np.mean(zcr)), 6),
        "mfcc_mean": [round(float(v), 4) for v in mfcc.mean(axis=1)],
        "mfcc_std": [round(float(v), 4) for v in mfcc.std(axis=1)],
    }


# ----------------------------------------------------------------------------
# Multi-speaker screen
# ----------------------------------------------------------------------------
def bimodality_screen(f0_voiced) -> dict:
    """Two well-separated F0 modes usually mean two speakers, not one ambiguous
    speaker. Averaging across them yields a confident, meaningless answer."""
    out = {"bimodal": False, "modes_hz": [], "separation_semitones": 0.0}
    if f0_voiced.size < 40:
        return out
    st = 12 * np.log2(f0_voiced / 100.0)
    hist, edges = np.histogram(st, bins=36, range=(float(st.min()) - 1, float(st.max()) + 1))
    if hist.sum() == 0:
        return out
    k = np.array([1, 3, 5, 3, 1], dtype=float)
    sm = np.convolve(hist.astype(float), k / k.sum(), mode="same")
    peaks = [i for i in range(1, len(sm) - 1)
             if sm[i] > sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > 0.18 * sm.max()]
    if len(peaks) < 2:
        return out
    peaks.sort(key=lambda i: sm[i], reverse=True)
    a, b = sorted(peaks[:2])
    centres = (edges[:-1] + edges[1:]) / 2
    sep = abs(centres[b] - centres[a])
    valley = sm[a:b + 1].min()
    if sep >= 4.0 and valley < 0.55 * min(sm[a], sm[b]):
        out.update(bimodal=True,
                   modes_hz=[round(float(100 * 2 ** (centres[i] / 12)), 1) for i in (a, b)],
                   separation_semitones=round(float(sep), 2))
    return out


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------
def analyse(path: str, window_s: float | None = None) -> dict:
    x, sr, meta = load_audio(path)
    frames, flen, hop = frame_signal(x, sr)
    active, vad_meta = voice_activity(frames)

    if HAVE_PRAAT:
        pf0, pconf = track_f0_praat(x, sr)
        n = min(len(pf0), len(frames))
        f0 = np.zeros(len(frames)); conf = np.zeros(len(frames))
        f0[:n], conf[:n] = pf0[:n], pconf[:n]
        voiced = active & (f0 >= F0_MIN) & (f0 <= F0_MAX)
        f0_engine = "praat_ac"
    else:
        f0, conf, voiced = track_f0_fallback(frames, sr, active)
        f0_engine = "autocorrelation_fallback"

    f0v = f0[voiced]
    voiced_dur = float(voiced.sum() * HOP_MS / 1000)

    # ---- pitch block -------------------------------------------------------
    pitch: dict = {"engine": f0_engine,
                   "voiced_frames": int(voiced.sum()),
                   "voiced_duration_s": round(voiced_dur, 3),
                   "voiced_fraction": round(float(voiced.mean()), 4)}
    if f0v.size >= 5:
        st = 12 * np.log2(f0v / 100.0)
        pitch.update({
            "f0_mean_hz": round(float(np.mean(f0v)), 2),
            "f0_median_hz": round(float(np.median(f0v)), 2),
            "f0_std_hz": round(float(np.std(f0v)), 2),
            "f0_p5_hz": round(float(np.percentile(f0v, 5)), 2),
            "f0_p95_hz": round(float(np.percentile(f0v, 95)), 2),
            "f0_min_hz": round(float(np.min(f0v)), 2),
            "f0_max_hz": round(float(np.max(f0v)), 2),
            "f0_std_semitones": round(float(np.std(st)), 3),
            "f0_range_semitones": round(float(np.percentile(st, 95) - np.percentile(st, 5)), 3),
        })
    else:
        pitch["f0_mean_hz"] = None

    # ---- resonance block ---------------------------------------------------
    max_formant = 5500.0 if (f0v.size and np.mean(f0v) > 155) else 5000.0
    formants: dict = {"max_formant_setting_hz": max_formant}
    F = [[], [], [], []]
    if HAVE_PRAAT:
        arr, times = formants_praat(x, sr, max_formant)
        formants["engine"] = "praat_burg"
        vi = np.flatnonzero(voiced)
        for i in vi:
            if i < len(arr):
                for k in range(4):
                    v = arr[i, k]
                    if np.isfinite(v):
                        F[k].append(float(v))
    else:
        formants["engine"] = "lpc_roots_fallback"
        for i in np.flatnonzero(voiced):
            fr = _formants_frame(frames[i], sr)
            for k in range(min(4, len(fr))):
                F[k].append(fr[k])

    def robust(vals, lo, hi):
        """Median over an anatomically plausible band -- rejects LPC spurious
        roots and merged-formant artefacts without discarding the frame."""
        a = np.array([v for v in vals if lo <= v <= hi], dtype=float)
        return (round(float(np.median(a)), 1), int(a.size)) if a.size >= 3 else (None, int(a.size))

    bands = [(250, 1100), (700, 2600), (1600, 3900), (2700, 5200)]
    for k, (lo, hi) in enumerate(bands):
        v, n_ok = robust(F[k], lo, hi)
        formants[f"f{k+1}_hz"] = v
        formants[f"f{k+1}_n_frames"] = n_ok

    # Uniform-tube model: the n-th resonance of a tube closed at one end sits
    # at (2n-1)c/(4L), so every formant yields an independent estimate of L.
    # F1 is the least trustworthy (vowel-dependent, and biased low when a high
    # F0 leaves the harmonics too sparse for LPC), so it gets the least say.
    C_SOUND = 35000.0
    vtl_w = [0.10, 0.20, 0.35, 0.35]
    ests, wts = [], []
    for k in range(4):
        fk = formants.get(f"f{k+1}_hz")
        if fk:
            ests.append((2 * (k + 1) - 1) * C_SOUND / (4 * fk))
            wts.append(vtl_w[k])
    if ests:
        order = np.argsort(ests)
        e = np.array(ests)[order]
        w = np.array(wts)[order]
        cw = np.cumsum(w) / w.sum()
        vtl = float(e[int(np.searchsorted(cw, 0.5))])       # weighted median
        formants["vtl_estimate_cm"] = round(vtl, 2)
        formants["vtl_per_formant_cm"] = [round(v, 2) for v in ests]
        formants["vtl_n_formants"] = len(ests)
        formants["vtl_spread_cm"] = round(float(np.max(e) - np.min(e)), 2)
    else:
        formants["vtl_estimate_cm"] = None
        formants["vtl_per_formant_cm"] = []
        formants["vtl_n_formants"] = 0
        formants["vtl_spread_cm"] = None

    f1, f3, f4 = formants["f1_hz"], formants["f3_hz"], formants["f4_hz"]
    if f1 and f4:
        disp = (f4 - f1) / 3.0
        formants["formant_dispersion_hz"] = round(disp, 1)
        formants["dispersion_basis"] = "F4-F1"
    elif f1 and f3:
        disp = (f3 - f1) / 2.0
        formants["formant_dispersion_hz"] = round(disp, 1)
        formants["dispersion_basis"] = "F3-F1_degraded"
    else:
        disp = None
        formants["formant_dispersion_hz"] = None
        formants["dispersion_basis"] = None
    formants["dispersion_vtl_cm"] = round(35000.0 / (2 * disp), 2) if disp else None

    # ---- voice-quality block ----------------------------------------------
    quality: dict = {}
    if HAVE_PRAAT:
        quality.update(quality_praat(x, sr))
        quality["engine"] = "praat"
    else:
        quality["engine"] = "numpy_fallback"
        hnrs = [v for i in np.flatnonzero(voiced)
                if (v := _hnr_frame(frames[i], sr, f0[i])) is not None]
        quality["hnr_db"] = round(float(np.median(hnrs)), 3) if hnrs else None
        if f0v.size > 3:
            per = 1.0 / f0v
            d = np.abs(np.diff(per))
            quality["jitter_local_pct"] = round(float(100 * d.mean() / per.mean()), 4)
            amp = np.sqrt(np.mean(frames[voiced] ** 2, axis=1))
            if amp.size > 3:
                da = np.abs(np.diff(amp))
                quality["shimmer_local_pct"] = round(float(100 * da.mean() / (amp.mean() + 1e-12)), 4)
            quality["approximation_note"] = (
                "jitter/shimmer derived from frame-level F0 and RMS, not from a "
                "period-synchronous point process; treat as indicative only")
        else:
            quality["jitter_local_pct"] = quality["shimmer_local_pct"] = None

    h = [v for i in np.flatnonzero(voiced)
         if (v := _h1_h2(frames[i], sr, f0[i])) is not None]
    quality["h1_h2_db"] = round(float(np.median(h)), 3) if len(h) >= 3 else None
    quality["h1_h2_n_frames"] = len(h)

    # ---- spectral block ----------------------------------------------------
    spectral = spectral_features(frames, sr, voiced)

    # ---- quality gates -----------------------------------------------------
    bw = meta["effective_bandwidth_hz"]
    snr = vad_meta["estimated_snr_db"]
    hnr = quality.get("hnr_db")
    # When the envelope is too flat to yield an SNR, harmonicity is the honest
    # substitute: HNR is itself a signal-to-noise measure of the voice.
    if snr is not None:
        low_snr, severe_noise = snr < 10.0, snr < 5.0
    elif hnr is not None:
        low_snr, severe_noise = hnr < 8.0, hnr < 4.0
    else:
        low_snr, severe_noise = False, False

    n_voiced = max(int(voiced.sum()), 1)
    f3_cov = formants.get("f3_n_frames", 0) / n_voiced
    f4_cov = formants.get("f4_n_frames", 0) / n_voiced

    gates = {
        "insufficient_voiced_audio": voiced_dur < 0.5 or int(voiced.sum()) < 25,
        "very_short_sample": meta["duration_s"] < 1.0,
        "no_pitch_detected": f0v.size < 5,
        "low_snr": bool(low_snr),
        "severe_noise": bool(severe_noise),
        "clipping": meta["clipping_fraction"] > 0.01,
        "narrowband_f4_unreliable": bool(bw < 4500 and f4_cov < 0.30),
        "narrowband_f3_unreliable": bool(bw < 3600 and f3_cov < 0.30),
        "possible_child_or_prepubertal": bool(
            f0v.size >= 5 and np.mean(f0v) > 240 and
            (formants["vtl_estimate_cm"] or 99) < 13.6),
        "possible_creak": bool(f0v.size >= 5 and np.percentile(f0v, 5) < 75),
        "formants_unavailable": formants["vtl_estimate_cm"] is None,
        # HNR above ~30 dB does not occur in natural phonation: the recording
        # is synthetic, denoised, or aggressively gated. Trusting a breathiness
        # cue from such a signal would be measuring the processing, not the voice.
        "implausible_hnr": bool(quality.get("hnr_db") is not None
                                and quality["hnr_db"] > 30.0),
        # A speaker with almost no pitch movement (TTS, a sustained vowel, a
        # monotone reading) breaks the pitch-floor feature, which presumes a
        # natural prosodic range.
        "monotone_pitch": bool(pitch.get("f0_range_semitones") is not None
                               and pitch["f0_range_semitones"] < 2.0),
        "f3_coverage": round(f3_cov, 3),
        "f4_coverage": round(f4_cov, 3),
        "formant_estimates_inconsistent": bool(
            formants.get("vtl_spread_cm") is not None
            and formants["vtl_spread_cm"] > 5.0),
    }
    gates.update(bimodality_screen(f0v))
    gates["multiple_speakers_suspected"] = bool(gates.get("bimodal"))

    return {
        "schema": "vgender.features/1.0",
        "source": {"path": str(Path(path).resolve()), "name": Path(path).name, **meta},
        "acquisition": vad_meta,
        "pitch": pitch,
        "resonance": formants,
        "quality": quality,
        "spectral": spectral,
        "gates": gates,
        "engines": {"praat_available": HAVE_PRAAT,
                    "f0": f0_engine,
                    "formants": formants["engine"],
                    "quality": quality["engine"]},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="path to an audio file")
    ap.add_argument("-o", "--output", help="write JSON here (default: stdout)")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if not Path(a.audio).exists():
        print(f"ERROR: no such file: {a.audio}", file=sys.stderr)
        return 2
    try:
        res = analyse(a.audio)
    except Exception as e:
        print(f"ERROR: extraction failed: {e}", file=sys.stderr)
        return 1

    text = json.dumps(res, indent=2)
    if a.output:
        Path(a.output).write_text(text)
        if not a.quiet:
            print(f"wrote {a.output}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
