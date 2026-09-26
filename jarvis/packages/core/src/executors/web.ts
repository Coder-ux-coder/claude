import { newId, JarvisError, type NepInvoke, type ResourceSelector } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";

/** Wraps untrusted material for models (04 §10.11). Presentation only; enforcement is E1. */
export function wrapUntrusted(source: string, id: string, text: string): string {
  const safe = text.replace(/<\/?untrusted[^>]*>/gi, "[tag removed]");
  return `<untrusted source="${source.replace(/"/g, "'")}" id="${id}" trust="external_content">\n${safe}\n</untrusted>`;
}

/** Loopback, private, link-local and unique-local addresses (by literal; DNS rebinding is a known limitation). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:") || h.startsWith("::ffff:");
}

/** Headless web fetch for research (read-only). Pages come back wrapped as untrusted content. */
export class WebFetchExecutor implements Executor {
  id = "exec:web"; version = "0.1.0";
  capabilities = ["tool:web.fetch"];
  constructor(private fetchImpl: typeof fetch = fetch) {}

  targets(_cap: string, params: Record<string, unknown>): ResourceSelector[] {
    try { return [{ site: new URL(String(params.url)).hostname }]; } catch { return []; }
  }

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const { url, max_chars } = nep.params as { url: string; max_chars?: number };
    let u: URL;
    try { u = new URL(url); } catch { throw new JarvisError("invalid_input", "invalid URL"); }
    if (!["http:", "https:"].includes(u.protocol)) throw new JarvisError("invalid_input", "only http and https");
    if (isPrivateHost(u.hostname)) throw new JarvisError("missing_permission", "local network addresses are not fetched by research tools");
    let res: Response;
    try { res = await this.fetchImpl(u, { signal: ectx.signal, redirect: "follow", headers: { "user-agent": "JARVIS-research/0.1" } }); }
    catch (e) { throw new JarvisError("transient_service_error", `fetch failed: ${(e as Error).message}`); }
    if (res.status === 429) throw new JarvisError("rate_limited", "rate limited", { retry_after_s: Number(res.headers.get("retry-after") ?? 60) });
    if (res.status >= 500) throw new JarvisError("transient_service_error", `HTTP ${res.status}`);
    if (res.status >= 400) throw new JarvisError("external_refusal", `HTTP ${res.status}`);
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const id = newId("art", Date.now());
    return { status: "ok", effect_state: "none", output: { url: res.url, status: res.status, content: wrapUntrusted(res.url, id, text.slice(0, max_chars ?? 20_000)), truncated: text.length > (max_chars ?? 20_000) }, evidence: [] };
  }
}
