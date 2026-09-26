import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transcript } from "../shared/api.js";

export interface SpeechToText {
  readonly id: string;
  transcribe(wav16kMono: Uint8Array, opts?: { language?: string; signal?: AbortSignal }): Promise<Transcript>;
}

export interface WhisperCppOptions {
  binary: string;              // whisper.cpp's CLI (named "whisper-cli" in current releases)
  model: string;               // a ggml model file, e.g. ggml-base.en.bin
  threads?: number;
  timeoutMs?: number;
}

/**
 * Local STT through whisper.cpp (09 §14.3; 12 §17.1): audio is written to a private temp
 * file, transcribed on this PC, and deleted; nothing is uploaded. Confidence comes from
 * token probabilities when the full JSON output has them; otherwise it is "medium", which
 * keeps consequential voice requests behind a confirmation (09 §14.3).
 */
export class WhisperCppAdapter implements SpeechToText {
  readonly id = "stt:whisper.cpp";
  constructor(private o: WhisperCppOptions) {}

  available(): boolean { return existsSync(this.o.binary) && existsSync(this.o.model); }

  async transcribe(wav: Uint8Array, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Transcript> {
    if (!this.available()) throw Object.assign(new Error("speech recognition is not installed (whisper.cpp binary or model missing)"), { code: "unsupported_operation" });
    if (wav.byteLength < 44 || String.fromCharCode(...wav.subarray(0, 4)) !== "RIFF") throw Object.assign(new Error("audio must be a WAV file"), { code: "invalid_input" });
    const dir = mkdtempSync(join(tmpdir(), "jv-stt-"));
    try {
      const input = join(dir, "in.wav"), outBase = join(dir, "out");
      writeFileSync(input, wav, { mode: 0o600 });
      const args = ["-m", this.o.model, "-f", input, "-l", opts.language ?? "auto", "-nt", "-np", "-ojf", "-of", outBase, "-t", String(this.o.threads ?? 4)];
      await run(this.o.binary, args, this.o.timeoutMs ?? 120_000, opts.signal);
      const json = existsSync(`${outBase}.json`) ? JSON.parse(readFileSync(`${outBase}.json`, "utf8")) as WhisperJson : null;
      return fromJson(json);
    } finally {
      rmSync(dir, { recursive: true, force: true });           // audio retention "none" by default
    }
  }
}

interface WhisperJson { transcription?: { text?: string; tokens?: { text?: string; p?: number }[] }[] }

export function fromJson(json: WhisperJson | null): Transcript {
  const segs = json?.transcription ?? [];
  const text = segs.map(s => (s.text ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  // Special tokens look like [_BEG_] or <|endoftext|>; they don't count toward confidence.
  const ps = segs.flatMap(s => s.tokens ?? []).filter(t => typeof t.p === "number" && !/^\s*(\[_|<\|)/.test(t.text ?? "")).map(t => t.p!);
  if (!text) return { text: "", confidence: "low" };
  if (!ps.length) return { text, confidence: "medium" };
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const min = Math.min(...ps);
  return { text, confidence: mean >= 0.85 && min >= 0.4 ? "high" : mean >= 0.6 ? "medium" : "low" };
}

function run(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    p.stderr.on("data", d => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { p.kill(); reject(Object.assign(new Error("speech recognition timed out"), { code: "timeout" })); }, timeoutMs);
    const onAbort = () => { p.kill(); reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.once("error", e => { clearTimeout(t); reject(Object.assign(new Error(`cannot run whisper.cpp: ${e.message}`), { code: "unsupported_operation" })); });
    p.once("exit", code => {
      clearTimeout(t); signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(Object.assign(new Error(`whisper.cpp failed (${code}): ${err.slice(-300)}`), { code: "internal_error" }));
    });
  });
}
