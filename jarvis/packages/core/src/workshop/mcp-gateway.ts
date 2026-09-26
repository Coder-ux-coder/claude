import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export interface GatewayTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<string>;
}
interface Grant { work_order_id: string; tools: GatewayTool[]; expires: number }

/**
 * MCP Gateway (12 §17.6 "Workers ↔ Broker"), minimal: a per-work-order endpoint over
 * streamable HTTP with JSON responses. Each order gets its own bearer token scoped to
 * its tools and an expiry. M1 tools: ask_boss and report_progress.
 */
export class McpGateway {
  private server: Server | null = null;
  private grants = new Map<string, Grant>();         // sha256(token) → grant
  port = 0;
  constructor(private host = "127.0.0.1", private now: () => number = Date.now) {}

  async listen(port = 0): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); } res.end(); }); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(port, this.host, () => resolve()); });
    this.port = (this.server.address() as { port: number }).port;
  }
  async close(): Promise<void> { await new Promise<void>(r => this.server ? this.server.close(() => r()) : r()); }

  /** A token for one work order; revoked when the order ends. */
  issue(work_order_id: string, tools: GatewayTool[], ttlMs = 4 * 3_600_000, urlHost = this.host): { url: string; token: string; revoke(): void } {
    const token = randomBytes(32).toString("base64url");
    const key = createHash("sha256").update(token).digest("hex");
    this.grants.set(key, { work_order_id, tools, expires: this.now() + ttlMs });
    return { url: `http://${urlHost}:${this.port}/mcp`, token, revoke: () => { this.grants.delete(key); } };
  }

  private grantFor(req: IncomingMessage): Grant | null {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const key = createHash("sha256").update(m[1]!).digest("hex");
    for (const [k, g] of this.grants) {
      if (timingSafeEqual(Buffer.from(k), Buffer.from(key))) {
        if (g.expires < this.now()) { this.grants.delete(k); return null; }
        return g;
      }
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") { res.writeHead(404); res.end(); return; }
    const grant = this.grantFor(req);
    if (!grant) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid or expired token" })); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(c as Buffer); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const msgs = Array.isArray(body) ? body : [body];
    const out: unknown[] = [];
    for (const m of msgs as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }[]) {
      if (m.id === undefined || m.id === null) continue;          // notifications (e.g. notifications/initialized)
      out.push(await this.rpc(grant, m.method ?? "", m.params ?? {}, m.id));
    }
    if (!out.length) { res.writeHead(202); res.end(); return; }
    this.json(res, 200, Array.isArray(body) ? out : out[0]);
  }

  private async rpc(g: Grant, method: string, params: Record<string, unknown>, id: string | number): Promise<unknown> {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": return ok({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "jarvis-workshop", version: "0.1.0" } });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: g.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const t = g.tools.find(x => x.name === params.name);
        if (!t) return ok({ content: [{ type: "text", text: `No tool ${String(params.name)} for this work order.` }], isError: true });
        try { return ok({ content: [{ type: "text", text: await t.call((params.arguments ?? {}) as Record<string, unknown>) }] }); }
        catch (e) { return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true }); }
      }
      default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
}
