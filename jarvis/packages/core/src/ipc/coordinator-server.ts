import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { JarvisError, safeEqualHex, sha256, type JarvisEvent } from "@jarvis/shared";
import { NdjsonRpc } from "../nep/rpc.js";
import type { JarvisCore } from "../runtime.js";
import type { SessionBridge } from "../nep/session-bridge.js";
import type { NotificationRecord } from "../notify/router.js";

export const COORDINATOR_PROTOCOL = "1.0";

export interface CoordinatorServerOptions {
  path: string;                        // pipePath(componentPipe("core"))
  secret: string;                      // the launcher's session secret (sent to each component over stdin)
  sessionBridge?: SessionBridge;
  maxClients?: number;
}

type Component = "console" | "session" | "phone";
interface Client { rpc: NdjsonRpc; component: Component | null; subs: Map<string, () => void>; id: number }

const P = <T>(p: unknown): T => (p ?? {}) as T;
const str = (v: unknown, name: string): string => { if (typeof v !== "string" || !v) throw new JarvisError("invalid_input", `${name} is required`); return v; };

/**
 * The Coordinator's client endpoint (12 §17.6 UI ↔ Coordinator): JSON-RPC 2.0 over NDJSON
 * on the per-user pipe. Every connection starts with `hello` carrying the session secret;
 * the Session Agent may only send session and hotkey events; Console messages are
 * owner-verified. Streams (`events.subscribe`) replay from a cursor, then go live.
 */
export class CoordinatorServer {
  private server: Server | null = null;
  private clients = new Set<Client>();
  private nextId = 0;

  constructor(private core: JarvisCore, private opts: CoordinatorServerOptions) {}

  async listen(): Promise<void> {
    if (process.platform !== "win32" && existsSync(this.opts.path)) unlinkSync(this.opts.path);   // stale Unix socket
    this.server = createServer(sock => this.accept(sock));
    this.server.maxConnections = this.opts.maxClients ?? 16;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.opts.path, () => resolve()); });
    // Toasts go to the Session Agent's tray; Console notifications arrive through the event stream.
    this.core.notifications.registerSink("toast", n => this.toast(n));
    this.core.notifications.registerSink("console", () => this.clientsOf("console").length > 0);
  }

  async close(): Promise<void> {
    for (const c of this.clients) { for (const u of c.subs.values()) u(); c.rpc.close(); }
    this.clients.clear();
    await new Promise<void>(r => this.server ? this.server.close(() => r()) : r());
  }

  private clientsOf(component: Component): Client[] { return [...this.clients].filter(c => c.component === component && !c.rpc.closed); }

  private async toast(n: NotificationRecord): Promise<boolean> {
    const s = this.clientsOf("session")[0];
    if (!s) return false;
    try { await s.rpc.call("notify.toast", { title: n.title, body: n.body }, 5000); return true; } catch { return false; }
  }

  private accept(sock: Socket): void {
    const c: Client = { rpc: new NdjsonRpc(sock), component: null, subs: new Map(), id: ++this.nextId };
    this.clients.add(c);
    // An unauthenticated connection gets 10 seconds to say hello.
    const t = setTimeout(() => { if (!c.component) c.rpc.close(); }, 10_000); t.unref();
    sock.on("close", () => { for (const u of c.subs.values()) u(); this.clients.delete(c); });
    c.rpc.onRequest = (method, params) => this.dispatch(c, method, params);
    c.rpc.onNotification = (method, params) => {
      if (c.component === "session" && this.opts.sessionBridge) {
        try { this.opts.sessionBridge.handle(method, params); } catch (e) { this.core.ctx.events.append({ type: "ipc.error", summary: String((e as Error).message).slice(0, 200), data: { method } }); }
      }
    };
  }

  private hello(c: Client, p: { protocol_version?: string; component?: string; secret?: string }) {
    const major = String(p.protocol_version ?? "").split(".")[0];
    if (major !== COORDINATOR_PROTOCOL.split(".")[0]) throw new JarvisError("unsupported_operation", `protocol ${p.protocol_version} not supported; server speaks ${COORDINATOR_PROTOCOL}`);
    // Constant-time comparison of hashes, so length differences leak nothing either.
    if (typeof p.secret !== "string" || !safeEqualHex(sha256(p.secret), sha256(this.opts.secret))) {
      setTimeout(() => c.rpc.close(), 10).unref();
      throw new JarvisError("auth_required", "bad session secret");
    }
    if (p.component !== "console" && p.component !== "session") throw new JarvisError("invalid_input", `unknown component ${p.component}`);
    c.component = p.component;
    this.core.ctx.events.append({ type: "ipc.connected", summary: p.component, data: { component: p.component, client: c.id } });
    return { protocol_version: COORDINATOR_PROTOCOL, server: "jarvis-core", safe_mode: this.core.broker.safeMode, halted: this.core.broker.isHalted() };
  }

  private async dispatch(c: Client, method: string, params: unknown): Promise<unknown> {
    if (method === "hello") return this.hello(c, P(params));
    if (!c.component) throw new JarvisError("auth_required", "say hello first");
    if (method === "ping") return { ok: true, at: this.core.ctx.clock.iso() };
    if (c.component === "session") {
      // The Session Agent reports events; its requests are limited to these.
      if (method.startsWith("session.") || method.startsWith("power.") || method.startsWith("hotkey.")) { this.opts.sessionBridge?.handle(method, params); return { ok: true }; }
      throw new JarvisError("missing_permission", `the session agent may not call ${method}`);
    }
    return this.consoleMethod(c, method, params);
  }

  private async consoleMethod(c: Client, method: string, params: unknown): Promise<unknown> {
    const j = this.core;
    // Messages from the Console come from the local interactive session over an ACL'd pipe: owner-verified (12 §17.6).
    const ownerVerified = true;
    switch (method) {
      // ----- conversation -----
      case "conversation.send": {
        const p = P<{ conversation_id?: string; content?: string; modality?: "text" | "voice"; transcript_confidence?: "high" | "medium" | "low" }>(params);
        const text = str(p.content, "content");
        if (text.length > 20_000) throw new JarvisError("invalid_input", "message too long");
        const r = await j.conversation.handle({ ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}), text, channel: p.modality === "voice" ? "console_voice" : "console_text",
          owner_verified: ownerVerified, ...(p.transcript_confidence ? { transcript_confidence: p.transcript_confidence } : {}) }, { background: true });
        return r;
      }
      case "conversation.messages": {
        const p = P<{ conversation_id: string; limit?: number }>(params);
        const conv = str(p.conversation_id, "conversation_id");
        return j.episodic.recentMessages(conv, Math.min(200, p.limit ?? 50)).map(m => {
          let text: string | null = null;
          try { text = j.episodic.messageText(m.id); } catch { text = null; }
          return { id: m.id, author: m.author, modality: m.modality, created_at: m.created_at, text };
        });
      }
      case "conversation.list": {
        return (j.ctx.db.prepare("select id, channel, started_at, last_message_at from conversations order by last_message_at desc limit 50").all());
      }
      // ----- tasks -----
      case "task.list": {
        const p = P<{ status?: string[]; limit?: number }>(params);
        return j.tasks.list({ ...(p.status ? { status: p.status as never } : {}), limit: Math.min(200, p.limit ?? 50) }).map(t => ({
          task_id: t.task_id, objective: t.objective, mode: t.mode, status: t.status, wait_reason: t.wait_reason ?? null, status_detail: t.status_detail ?? null, updated_at: t.updated_at, origin: t.origin.channel }));
      }
      case "task.get": {
        const id = str(P<{ task_id: string }>(params).task_id, "task_id");
        const t = j.tasks.require(id);
        return { task: t, steps: j.tasks.steps(id), decisions: j.policy.openDecisionRequests(id), report: j.conversation.report(id) };
      }
      case "task.control": {
        const p = P<{ task_id: string; op: "pause" | "resume" | "cancel" }>(params);
        if (!["pause", "resume", "cancel"].includes(p.op)) throw new JarvisError("invalid_input", "op must be pause, resume, or cancel");
        const t = j.controlTask(str(p.task_id, "task_id"), p.op);
        return { task_id: t.task_id, status: t.status };
      }
      case "task.steer": {
        const p = P<{ task_id: string; text: string }>(params);
        const t = j.tasks.require(str(p.task_id, "task_id"));
        if (!t.origin.conversation_id) throw new JarvisError("invalid_input", "this task has no conversation to steer it in");
        return j.conversation.handle({ conversation_id: t.origin.conversation_id, text: str(p.text, "text"), channel: "console_text", owner_verified: ownerVerified }, { background: true });
      }
      // ----- decisions -----
      case "decision.list": return j.policy.openDecisionRequests();
      case "decision.respond": {
        const p = P<{ decision_request_id: string; option_id: string; proposal_fingerprint: string }>(params);
        return j.respondDecision({ decision_request_id: str(p.decision_request_id, "decision_request_id"), option_id: str(p.option_id, "option_id"),
          proposal_fingerprint: str(p.proposal_fingerprint, "proposal_fingerprint"), owner_verified: ownerVerified });
      }
      // ----- memory -----
      case "memory.search": {
        const p = P<{ query: string; limit?: number }>(params);
        return j.memory.search(str(p.query, "query"), { limit: Math.min(100, p.limit ?? 20) }).map(r => this.memoryView(r.id));
      }
      case "memory.list": {
        const p = P<{ type?: "fact" | "preference" | "lesson" | "note"; limit?: number }>(params);
        return j.memory.list({ ...(p.type ? { type: p.type as never } : {}), status: ["active", "pending_confirmation", "disputed"] as never, limit: Math.min(500, p.limit ?? 100) }).map(r => this.memoryView(r.id));
      }
      case "memory.get": return this.memoryView(str(P<{ id: string }>(params).id, "id"));
      case "memory.delete": {
        const p = P<{ ids: string[]; reason?: string }>(params);
        if (!Array.isArray(p.ids) || !p.ids.length) throw new JarvisError("invalid_input", "ids are required");
        return j.memory.delete(p.ids.map(String), p.reason ?? "deleted in the Console");
      }
      case "memory.accept": return j.memory.accept(str(P<{ id: string }>(params).id, "id"), { by: "owner" });
      case "memory.markdown": return j.portability.markdownView((P<{ type?: "fact" | "preference" }>(params).type ?? "preference") as never);
      // ----- rules -----
      case "rules.list": return j.policy.listRules();
      case "rules.get": return j.policy.getRule(str(P<{ rule_id: string }>(params).rule_id, "rule_id")) ?? null;
      case "rules.confirm": {
        const p = P<{ rule_id: string; typed_confirmation?: string }>(params);
        return j.policy.confirm(str(p.rule_id, "rule_id"), { channel: "console", owner_verified: ownerVerified, ...(p.typed_confirmation ? { typed_confirmation: p.typed_confirmation } : {}) });
      }
      case "rules.revoke": {
        const p = P<{ rule_id: string; typed_confirmation?: string }>(params);
        return j.policy.revoke(str(p.rule_id, "rule_id"), { channel: "console", owner_verified: ownerVerified, ...(p.typed_confirmation ? { typed_confirmation: p.typed_confirmation } : {}) });
      }
      // ----- accounts and credentials (metadata only; secrets go in, never out) -----
      case "accounts.list": return j.accounts.list();
      case "accounts.revoke": return j.accounts.revoke(str(P<{ account_id: string }>(params).account_id, "account_id"), ownerVerified);
      case "credentials.list": return j.vault.list();
      case "credentials.store": {
        const p = P<{ provider: string; label?: string; kind?: "api_key" | "connector_secret"; secret: string }>(params);
        const provider = str(p.provider, "provider");
        if (!/^[a-z0-9_.-]{2,40}$/.test(provider)) throw new JarvisError("invalid_input", "bad provider name");
        const secret = str(p.secret, "secret");
        if (secret.length > 8192) throw new JarvisError("invalid_input", "secret too long");
        j.vault.redactor.register(secret);        // scrubbed from logs and model context from now on
        const existing = j.vault.findByProvider(provider);
        if (existing) { j.vault.rotate(existing.credential_ref, secret); j.ctx.events.append({ type: "credential.rotated", summary: provider, data: { credential_ref: existing.credential_ref } }); return j.vault.meta(existing.credential_ref); }
        const m = j.vault.put({ kind: p.kind ?? "api_key", provider, label: (p.label ?? `${provider} key`).slice(0, 80) }, secret);
        j.ctx.events.append({ type: "credential.stored", summary: provider, data: { credential_ref: m.credential_ref } });
        return m;
      }
      case "credentials.delete": {
        const ref = str(P<{ credential_ref: string }>(params).credential_ref, "credential_ref");
        const ok = j.vault.delete(ref);
        if (ok) j.ctx.events.append({ type: "credential.deleted", summary: ref, data: { credential_ref: ref } });
        return { deleted: ok };
      }
      // ----- schedules and notifications -----
      case "schedules.list": return j.scheduler.list(["active", "paused"]).map(s => ({ schedule_id: s.schedule_id, kind: s.kind, interpretation: s.interpretation, status: s.status, next_fire_utc: s.next_fire_utc ?? null, last_fire: s.last_fire ?? null }));
      case "schedules.control": {
        const p = P<{ schedule_id: string; op: "pause" | "resume" | "cancel" | "run_now" }>(params);
        const id = str(p.schedule_id, "schedule_id");
        if (p.op === "run_now") return { task_id: j.schedules.runNow(id).task_id };
        if (!["pause", "resume", "cancel"].includes(p.op)) throw new JarvisError("invalid_input", "op must be pause, resume, cancel, or run_now");
        const s = j.scheduler.setStatus(id, p.op === "pause" ? "paused" : p.op === "resume" ? "active" : "cancelled");
        return { schedule_id: s.schedule_id, status: s.status, next_fire_utc: s.next_fire_utc ?? null };
      }
      case "notifications.needs_you": return j.notifications.needsYou();
      case "notifications.dismiss": j.notifications.dismiss(str(P<{ id: string }>(params).id, "id")); return { ok: true };
      // ----- settings, status, safety -----
      case "settings.get": return j.getSettings();
      case "settings.set": { const p = P<{ key: string; value: unknown }>(params); j.setSetting(str(p.key, "key"), p.value); return { ok: true }; }
      case "status.get": return {
        safe_mode: j.broker.safeMode, halted: j.broker.isHalted(), policy_revision: j.policy.currentRevision(),
        anthropic_key: !!j.vault.findByProvider("anthropic"), boss_route: j.gateway.route("boss.reasoning").chain, recovery: j.recovery ?? null,
        needs_you: j.notifications.needsYou().length, open_decisions: j.policy.openDecisionRequests().length,
      };
      case "emergency.stop": return j.emergencyStop("emergency stop from the Console");
      case "emergency.resume": j.broker.resumeAfterHalt(ownerVerified); return { ok: true };
      // ----- streams -----
      case "events.subscribe": {
        const p = P<{ from_seq?: number; types?: string[]; task_id?: string }>(params);
        const subId = `sub_${c.id}_${c.subs.size + 1}`;
        const types = Array.isArray(p.types) ? p.types.map(String) : null;
        const filter = (e: JarvisEvent) => (!types || types.some(t => e.type === t || e.type.startsWith(`${t}.`))) && (!p.task_id || e.correlation?.task_id === p.task_id);
        const from = Number.isInteger(p.from_seq) && p.from_seq! >= 0 ? p.from_seq! : j.ctx.events.lastSeq();
        const unsub = j.ctx.events.subscribe(from, e => c.rpc.notify("event", { subscription: subId, event: e }), filter);
        c.subs.set(subId, unsub);
        return { subscription: subId, from_seq: from };
      }
      case "events.unsubscribe": {
        const id = str(P<{ subscription: string }>(params).subscription, "subscription");
        c.subs.get(id)?.(); c.subs.delete(id);
        return { ok: true };
      }
      default: throw new JarvisError("unsupported_operation", `unknown method ${method}`);
    }
  }

  private memoryView(id: string) {
    const r = this.core.memory.require(id);
    return { id: r.id, type: r.type, text: r.text, status: r.status, sensitivity: r.sensitivity, scope: r.scope, confidence: r.confidence, provenance: { origin: r.provenance.origin, source_trust: r.provenance.source_trust }, updated_at: r.updated_at };
  }
}
