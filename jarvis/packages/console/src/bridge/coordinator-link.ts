import { NdjsonRpc } from "@jarvis/core/rpc";
import { JarvisError } from "@jarvis/shared";
import { randomUUID } from "node:crypto";
import type { JarvisEventEnvelope } from "../shared/api.js";

/**
 * The Console's connection to the Coordinator pipe (Electron main or the dev bridge).
 * Says hello with the session secret, keeps one event subscription, and on reconnect
 * re-subscribes from the last seen `seq` so nothing is missed or repeated (12 §17.6).
 */
export class CoordinatorLink {
  private rpc: NdjsonRpc | null = null;
  private lastSeq = -1;
  private listeners = new Set<(e: JarvisEventEnvelope) => void>();
  private stateListeners = new Set<(s: "connected" | "reconnecting") => void>();
  private stopped = false;
  private connecting: Promise<NdjsonRpc> | null = null;

  constructor(private path: string, private secret: string, private opts: { retryMs?: number } = {}) {}

  onEvent(cb: (e: JarvisEventEnvelope) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onConnection(cb: (s: "connected" | "reconnecting") => void): () => void { this.stateListeners.add(cb); return () => this.stateListeners.delete(cb); }

  async start(): Promise<void> { await this.ensure(); }
  stop(): void { this.stopped = true; this.rpc?.close(); this.rpc = null; }

  /**
   * Every call carries an idempotency key; if the pipe drops mid-call it is retried once after
   * reconnecting with the same key, so the Coordinator runs a command at most once (12 §17.6).
   */
  async call<T>(method: string, params: unknown): Promise<T> {
    if (method === "hello" || method.startsWith("events.")) throw new JarvisError("missing_permission", `${method} is managed by the link`);
    const p = { ...((params && typeof params === "object") ? params as Record<string, unknown> : {}), idempotency_key: `idk_${randomUUID()}` };
    const timeout = method === "conversation.send" || method === "task.steer" ? 10 * 60_000 : 60_000;
    try { return await (await this.ensure()).call<T>(method, p, timeout); }
    catch (e) {
      if (!(e instanceof JarvisError) || e.code !== "unavailable_device") throw e;
      return (await this.ensure()).call<T>(method, p, timeout);
    }
  }

  private ensure(): Promise<NdjsonRpc> {
    if (this.rpc && !this.rpc.closed) return Promise.resolve(this.rpc);
    if (this.stopped) return Promise.reject(new JarvisError("cancelled", "link stopped"));
    this.connecting ??= this.connectLoop().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectLoop(): Promise<NdjsonRpc> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const rpc = await NdjsonRpc.connect(this.path, 3000);
        await rpc.call("hello", { protocol_version: "1.0", component: "console", secret: this.secret }, 10_000);
        rpc.onNotification = (m, p) => {
          if (m !== "event") return;
          const env = p as JarvisEventEnvelope;
          if (env.event.seq <= this.lastSeq) return;
          this.lastSeq = env.event.seq;
          for (const l of this.listeners) l(env);
        };
        await rpc.call("events.subscribe", this.lastSeq >= 0 ? { from_seq: this.lastSeq } : {});
        this.rpc = rpc;
        for (const s of this.stateListeners) s("connected");
        this.watch(rpc);
        return rpc;
      } catch (e) {
        if (e instanceof JarvisError && e.code === "auth_required") throw e;     // a wrong secret won't fix itself
        if (attempt === 0) for (const s of this.stateListeners) s("reconnecting");
        await new Promise(r => setTimeout(r, Math.min(10_000, (this.opts.retryMs ?? 250) * 2 ** Math.min(attempt, 6))));
      }
    }
    throw new JarvisError("cancelled", "link stopped");
  }

  private watch(rpc: NdjsonRpc): void {
    rpc.onClose = () => {
      if (this.rpc === rpc) this.rpc = null;
      if (!this.stopped) { for (const s of this.stateListeners) s("reconnecting"); void this.ensure().catch(() => {}); }
    };
    if (rpc.closed) rpc.onClose();
  }
}
