import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { CoordinatorLink } from "./coordinator-link.js";
import type { SpeechToText } from "../main/whisper.js";

export interface DevBridgeOptions {
  link: Pick<CoordinatorLink, "call" | "onEvent" | "onConnection">;
  staticDir: string;                        // dist/renderer
  stt?: SpeechToText | null;
  port?: number;                            // 0 = any free port
  token?: string;
}

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".map": "application/json" };
const MAX_BODY = 48 * 1024 * 1024;               // matches the Coordinator's request limit

/**
 * Development/test host for the Console renderer in an ordinary browser. The Electron
 * build doesn't use it. Loopback only; every request needs the per-run token; the Host
 * header must be the loopback address (DNS-rebinding defence); static files come only
 * from `staticDir`.
 */
export class DevBridge {
  readonly token: string;
  private server: Server | null = null;
  private port = 0;
  private sse = new Set<ServerResponse>();
  private unsub: (() => void)[] = [];

  constructor(private o: DevBridgeOptions) { this.token = o.token ?? randomBytes(24).toString("hex"); }

  get url(): string { return `http://127.0.0.1:${this.port}/#token=${this.token}`; }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(e => this.json(res, 500, { code: "internal_error", message: String((e as Error).message) })); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.o.port ?? 0, "127.0.0.1", () => resolve()); });
    this.port = (this.server.address() as { port: number }).port;
    this.unsub.push(this.o.link.onEvent(e => this.broadcast("event", e)));
    this.unsub.push(this.o.link.onConnection(s => this.broadcast("connection", s)));
  }

  async close(): Promise<void> {
    for (const u of this.unsub) u();
    for (const r of this.sse) r.end();
    this.sse.clear();
    await new Promise<void>(r => this.server ? this.server.close(() => r()) : r());
  }

  private broadcast(kind: string, data: unknown): void {
    const line = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of this.sse) r.write(line);
  }

  private tokenOk(given: string | null | undefined): boolean {
    if (!given) return false;
    const a = createHash("sha256").update(given).digest(), b = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.json(res, 421, { code: "invalid_input", message: "wrong host" });
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.pathname === "/rpc" || url.pathname === "/transcribe") {
      if (req.method !== "POST") return this.json(res, 405, { code: "invalid_input", message: "POST only" });
      if (!this.tokenOk(req.headers["x-jarvis-token"] as string | undefined)) return this.json(res, 401, { code: "auth_required", message: "bad token" });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) return this.json(res, 403, { code: "missing_permission", message: "cross-origin" });
      const body = await readBody(req);
      if (url.pathname === "/transcribe") {
        if (!this.o.stt) return this.json(res, 501, { code: "unsupported_operation", message: "speech recognition is not installed" });
        try { return this.json(res, 200, await this.o.stt.transcribe(new Uint8Array(body))); }
        catch (e) { return this.json(res, 400, { code: (e as { code?: string }).code ?? "internal_error", message: (e as Error).message }); }
      }
      let msg: { method?: unknown; params?: unknown };
      try { msg = JSON.parse(body.toString("utf8")); } catch { return this.json(res, 400, { code: "invalid_input", message: "bad JSON" }); }
      if (typeof msg.method !== "string") return this.json(res, 400, { code: "invalid_input", message: "method is required" });
      try { return this.json(res, 200, { result: await this.o.link.call(msg.method, msg.params ?? {}) }); }
      catch (e) { return this.json(res, 200, { error: { code: (e as { code?: string }).code ?? "internal_error", message: (e as Error).message } }); }
    }

    if (url.pathname === "/events") {
      if (!this.tokenOk(url.searchParams.get("token"))) return this.json(res, 401, { code: "auth_required", message: "bad token" });
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(": connected\n\n");
      this.sse.add(res);
      req.on("close", () => this.sse.delete(res));
      return;
    }

    if (req.method !== "GET") return this.json(res, 405, { code: "invalid_input", message: "GET only" });
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(this.o.staticDir, rel));
    if (!file.startsWith(normalize(this.o.staticDir) + sep) || !existsSync(file) || !statSync(file).isFile()) return this.json(res, 404, { code: "invalid_input", message: "not found" });
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("request too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
