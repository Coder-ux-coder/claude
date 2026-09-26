/**
 * Encodes mono float samples as a 16 kHz 16-bit PCM WAV, the input whisper.cpp expects.
 * Resamples with linear interpolation (adequate for speech).
 */
export function encodeWav16k(samples: Float32Array, sampleRate: number): Uint8Array {
  const target = 16_000;
  const n = Math.max(0, Math.floor(samples.length * target / sampleRate));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * sampleRate / target;
    const i0 = Math.floor(x), i1 = Math.min(samples.length - 1, i0 + 1), f = x - i0;
    const v = (samples[i0] ?? 0) * (1 - f) + (samples[i1] ?? 0) * f;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true); ascii(8, "WAVE");
  ascii(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, "data"); dv.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
}
