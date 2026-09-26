import { contextBridge, ipcRenderer } from "electron";
import type { JarvisApi, JarvisEventEnvelope, Transcript } from "../shared/api.js";

// The only bridge between the sandboxed renderer and the main process: named, typed
// channels; no raw ipcRenderer, no Node APIs.
const api: JarvisApi = {
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await ipcRenderer.invoke("jarvis:call", method, params ?? {}) as { result?: T; error?: { code: string; message: string } };
    if (r.error) throw r.error;
    return r.result as T;
  },
  onEvent(cb: (e: JarvisEventEnvelope) => void) {
    const h = (_: unknown, e: JarvisEventEnvelope) => cb(e);
    ipcRenderer.on("jarvis:event", h);
    return () => { ipcRenderer.removeListener("jarvis:event", h); };
  },
  onConnection(cb: (s: "connected" | "reconnecting") => void) {
    const h = (_: unknown, s: "connected" | "reconnecting") => cb(s);
    ipcRenderer.on("jarvis:connection", h);
    return () => { ipcRenderer.removeListener("jarvis:connection", h); };
  },
  async transcribe(wav: Uint8Array): Promise<Transcript> {
    const r = await ipcRenderer.invoke("jarvis:transcribe", wav) as { result?: Transcript; error?: { code: string; message: string } };
    if (r.error) throw r.error;
    return r.result!;
  },
};
contextBridge.exposeInMainWorld("jarvis", api);
