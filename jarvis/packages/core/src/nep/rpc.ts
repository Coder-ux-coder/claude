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
  onClose: (() => void) | null = null;
  closed = false;

  private maxLine: number;
  constructor(private sock: Socket, opts: { maxLine?: number } = {}) {
    this.maxLine = opts.maxLine ?? NdjsonRpc.MAX_LINE;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("close", () => { this.closed = true; for (const p of this.pending.values()) p.reject(new JarvisError("unavailable_device", "connection closed")); this.pending.clear(); this.onClose?.(); });
    sock.on("error", () => { /* surfaced through close */ });
  }

  static connect(path: string, timeoutMs = 5000, opts: { maxLine?: number } = {}): Promise<NdjsonRpc> {
    return new Promise((resolve, reject) => {
      const s = connect(path);
      const t = setTimeout(() => { s.destroy(); reject(new JarvisError("unavailable_device", `cannot reach ${path}`)); }, timeoutMs);
      s.once("connect", () => { clearTimeout(t); resolve(new NdjsonRpc(s, opts)); });
      s.once("error", e => { clearTimeout(t); reject(new JarvisError("unavailable_device", `cannot reach ${path}: ${e.message}`)); });
    });
  }

  static MAX_LINE = 16 * 1024 * 1024;
  private onData(d: string): void {
    this.buf += d;
    if (this.buf.length > this.maxLine && this.buf.indexOf("\n") < 0) { this.buf = ""; this.sock.destroy(); return; }
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

/**
 * Client side of the Coordinator handshake (protocol 1.1): verifies the server's proof
 * before sending its own, so the session secret never crosses the pipe.
 */
export async function coordinatorHandshake(rpc: NdjsonRpc, secret: string, component: "console" | "session"): Promise<{ protocol_version: string; safe_mode?: boolean; halted?: boolean }> {
  const { createHmac, createHash, randomBytes: rb, timingSafeEqual } = await import("node:crypto");
  const key = createHash("sha256").update(secret).digest();
  const proof = (role: string, cn: string, sn: string) => createHmac("sha256", key).update(`${role}|${cn}|${sn}`).digest("hex");
  const cn = rb(24).toString("hex");
  const r = await rpc.call<{ server_nonce?: string; server_proof?: string }>("hello", { protocol_version: "1.1", component, client_nonce: cn }, 10_000);
  const expected = r.server_nonce ? proof("server", cn, r.server_nonce) : "";
  if (!r.server_nonce || typeof r.server_proof !== "string" || r.server_proof.length !== expected.length || !timingSafeEqual(Buffer.from(r.server_proof), Buffer.from(expected))) {
    rpc.close();
    throw new JarvisError("auth_required", "the Coordinator could not prove it knows the session secret (wrong secret, or not the real Coordinator)");
  }
  return rpc.call("hello.finish", { client_proof: proof("client", cn, r.server_nonce) }, 10_000);
}
