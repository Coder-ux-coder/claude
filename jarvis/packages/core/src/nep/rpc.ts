import { connect, type Socket } from "node:net";
import { JarvisError, ErrorCode } from "@jarvis/shared";

/** Named pipe path: Windows \\.\pipe\NAME; elsewhere the Unix socket .NET uses for the same name. */
export function pipePath(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/CoreFxPipe_${name}`;
}
export function componentPipe(component: string): string {
  return `jarvis-${component}-${process.env.USERNAME ?? process.env.USER ?? "user"}`;
}

type Handler = (method: string, params: unknown) => Promise<unknown> | unknown;

/** JSON-RPC 2.0 over newline-delimited JSON, both directions (12 §17.6 conventions). */
export class NdjsonRpc {
  private buf = "";
  private next = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onRequest: Handler | null = null;
  onNotification: ((method: string, params: unknown) => void) | null = null;
  closed = false;

  constructor(private sock: Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("close", () => { this.closed = true; for (const p of this.pending.values()) p.reject(new JarvisError("unavailable_device", "connection closed")); this.pending.clear(); });
    sock.on("error", () => { /* surfaced through close */ });
  }

  static connect(path: string, timeoutMs = 5000): Promise<NdjsonRpc> {
    return new Promise((resolve, reject) => {
      const s = connect(path);
      const t = setTimeout(() => { s.destroy(); reject(new JarvisError("unavailable_device", `cannot reach ${path}`)); }, timeoutMs);
      s.once("connect", () => { clearTimeout(t); resolve(new NdjsonRpc(s)); });
      s.once("error", e => { clearTimeout(t); reject(new JarvisError("unavailable_device", `cannot reach ${path}: ${e.message}`)); });
    });
  }

  static MAX_LINE = 16 * 1024 * 1024;
  private onData(d: string): void {
    this.buf += d;
    if (this.buf.length > NdjsonRpc.MAX_LINE && this.buf.indexOf("\n") < 0) { this.buf = ""; this.sock.destroy(); return; }
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { message: string; data?: { code?: string } } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method !== undefined) {
        if (msg.id === undefined || msg.id === null) { this.onNotification?.(msg.method, msg.params); continue; }
        const id = msg.id;
        Promise.resolve().then(() => { if (!this.onRequest) throw new JarvisError("unsupported_operation", "no handler"); return this.onRequest(msg.method!, msg.params); })
          .then(result => this.send({ jsonrpc: "2.0", id, result }))
          .catch((e: unknown) => this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message, data: e instanceof JarvisError ? e.structured : { code: "internal_error" } } }));
      } else if (msg.id !== undefined && msg.id !== null) {
        const p = this.pending.get(String(msg.id));
        if (!p) continue;
        this.pending.delete(String(msg.id));
        if (msg.error) {
          const c = msg.error.data?.code;
          p.reject(new JarvisError(c && ErrorCode.safeParse(c).success ? (c as ErrorCode) : "internal_error", msg.error.message));
        } else p.resolve(msg.result);
      }
    }
  }

  /** Sends a pre-serialized message (so embedded params keep their exact bytes). */
  sendRaw(json: string): void { if (!this.closed) this.sock.write(json + "\n"); }
  private send(obj: unknown): void { this.sendRaw(JSON.stringify(obj)); }

  call<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    return this.callRaw<T>(method, JSON.stringify(params ?? null), timeoutMs);
  }

  /** A call whose params are already serialized (their exact bytes matter, e.g. for signatures). */
  callRaw<T = unknown>(method: string, paramsJson: string, timeoutMs = 120_000): Promise<T> {
    const id = `n${++this.next}`;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new JarvisError("timeout", `${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v as T); }, reject: e => { clearTimeout(t); reject(e); } });
      this.sendRaw(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${paramsJson}}`);
    });
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }
  close(): void { this.sock.end(); }
}
