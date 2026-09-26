import { encodeWav16k } from "../shared/wav.js";

/**
 * Speech output (09 §14.3): the platform voice through speechSynthesis. "Stop speaking" is
 * local and immediate; it never waits on the Coordinator. Speaking starts only on your
 * request or for replies to voice input.
 */
export class Speaker {
  private synth: SpeechSynthesis | null = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  speaking = false;
  onChange: ((speaking: boolean) => void) | null = null;
  get available(): boolean { return !!this.synth; }

  speak(text: string, opts: { voiceName?: string; rate?: number } = {}): void {
    if (!this.synth || !text.trim()) return;
    this.stop();
    const u = new SpeechSynthesisUtterance(text.slice(0, 5000));
    const v = opts.voiceName ? this.synth.getVoices().find(x => x.name === opts.voiceName) : undefined;
    if (v) u.voice = v;
    u.rate = opts.rate ?? 1;
    u.onend = u.onerror = () => { this.set(false); };
    this.set(true);
    this.synth.speak(u);
  }

  /** Barge-in: pressing push-to-talk or saying/clicking "stop" silences output at once. */
  stop(): void {
    if (!this.synth) return;
    this.synth.cancel();
    this.set(false);
  }
  private set(s: boolean): void { if (this.speaking !== s) { this.speaking = s; this.onChange?.(s); } }
}

/** Push-to-talk capture: microphone → mono float samples → 16 kHz WAV (for local whisper.cpp). */
export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  recording = false;
  static MAX_SECONDS = 120;

  async start(): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but universally available and needs no worklet file (CSP-friendly).
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    let total = 0;
    this.node.onaudioprocess = e => {
      if (total > Recorder.MAX_SECONDS * (this.ctx?.sampleRate ?? 48000)) return;
      const c = new Float32Array(e.inputBuffer.getChannelData(0)); this.chunks.push(c); total += c.length;
    };
    src.connect(this.node); this.node.connect(this.ctx.destination);
    this.recording = true;
  }

  /** Stops and returns the WAV; audio stays in memory only (retention "none"). */
  async stop(): Promise<Uint8Array | null> {
    if (!this.recording) return null;
    this.recording = false;
    const rate = this.ctx?.sampleRate ?? 48000;
    this.node?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close();
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    if (n < rate * 0.3) { this.chunks = []; return null; }          // under 0.3 s: treat as an accidental tap
    const all = new Float32Array(n); let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    return encodeWav16k(all, rate);
  }
}
