// The API the renderer sees (window.jarvis). Implemented by the Electron preload, or by the
// dev web bridge client when the renderer runs in an ordinary browser for testing.

export interface JarvisEventEnvelope { subscription: string; event: { seq: number; type: string; summary?: string; at?: string; correlation?: Record<string, string>; data?: Record<string, unknown> } }

export interface Transcript { text: string; confidence: "high" | "medium" | "low" }

export interface JarvisApi {
  /** A Coordinator method (12 §17.6 UI ↔ Coordinator). Rejects with { code, message }. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Live events; returns an unsubscribe function. */
  onEvent(cb: (e: JarvisEventEnvelope) => void): () => void;
  /** Connection state changes (the Coordinator restarting, the pipe dropping). */
  onConnection(cb: (state: "connected" | "reconnecting") => void): () => void;
  /** Local speech-to-text (whisper.cpp); audio never leaves this PC. */
  transcribe(wav: Uint8Array): Promise<Transcript>;
}

export interface RpcError { code: string; message: string }

export const isRpcError = (e: unknown): e is RpcError => !!e && typeof e === "object" && "code" in e && "message" in e;
