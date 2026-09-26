import type { JarvisApi, JarvisEventEnvelope, Transcript } from "../shared/api.js";

/** window.jarvis for the dev web bridge (the Electron build injects its own via preload). */
export function createWebApi(token: string): JarvisApi {
  const eventCbs = new Set<(e: JarvisEventEnvelope) => void>();
  const connCbs = new Set<(s: "connected" | "reconnecting") => void>();
  const es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("event", ev => { const d = JSON.parse((ev as MessageEvent).data) as JarvisEventEnvelope; for (const cb of eventCbs) cb(d); });
  es.addEventListener("connection", ev => { const s = JSON.parse((ev as MessageEvent).data); for (const cb of connCbs) cb(s); });
  es.onerror = () => { for (const cb of connCbs) cb("reconnecting"); };
  es.onopen = () => { for (const cb of connCbs) cb("connected"); };
  const post = async (path: string, body: BodyInit, type: string) => {
    const r = await fetch(path, { method: "POST", headers: { "x-jarvis-token": token, "content-type": type }, body });
    return r.json();
  };
  return {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const r = await post("/rpc", JSON.stringify({ method, params: params ?? {} }), "application/json") as { result?: T; error?: { code: string; message: string } };
      if (r.error) throw r.error;
      return r.result as T;
    },
    onEvent(cb) { eventCbs.add(cb); return () => eventCbs.delete(cb); },
    onConnection(cb) { connCbs.add(cb); return () => connCbs.delete(cb); },
    async transcribe(wav: Uint8Array): Promise<Transcript> {
      const r = await post("/transcribe", new Blob([wav as unknown as ArrayBuffer]), "audio/wav") as Transcript & { code?: string; message?: string };
      if (r.code) throw { code: r.code, message: r.message };
      return r;
    },
  };
}
