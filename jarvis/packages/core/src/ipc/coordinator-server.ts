import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { JarvisError, canonicalJson, hmac, newId, safeEqualHex, sha256, type JarvisEvent } from "@jarvis/shared";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync as exists, mkdirSync } from "node:fs";
import { NdjsonRpc } from "../nep/rpc.js";
import type { JarvisCore } from "../runtime.js";
import type { SessionBridge } from "../nep/session-bridge.js";
import type { NotificationRecord } from "../notify/router.js";
import type { Attachment } from "../boss/attachments.js";
import { isValidZone } from "../scheduler/tz.js";

export const COORDINATOR_PROTOCOL = "1.1";
/** One request line; bounds a message with attachments (32 MB of files is ~43 MB as base64). */
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

export interface CoordinatorServerOptions {
  path: string;                        // pipePath(componentPipe("core"))
  secret: string;                      // the launcher's session secret (sent to each component over stdin)
  sessionBridge?: SessionBridge;
  maxClients?: number;
}

type Component = "console" | "session" | "phone";

/** Commands that change state: they honour idempotency keys (12 §17.6). Credential calls are excluded so no secret is ever hashed to disk; they are idempotent by design (store rotates in place). */
export const MUTATING = new Set(["conversation.send", "task.control", "task.steer", "decision.respond", "memory.delete", "memory.accept", "memory.correct", "memory.markdown_apply",
  "memory.export", "memory.import", "rules.propose", "rules.confirm", "rules.revoke", "accounts.revoke", "schedules.control", "notifications.dismiss", "settings.set", "profile.set",
  "emergency.stop", "emergency.resume", "workshop.approve"]);
interface Client { rpc: NdjsonRpc; component: Component | null; subs: Map<string, () => void>; id: number; challenge?: { component: string; cn: string; sn: string } }

/** Mutual proof for the handshake (neither side ever sends the secret): HMAC(secret, role|client_nonce|server_nonce). */
export function handshakeProof(secret: string, role: "server" | "client", clientNonce: string, serverNonce: string): string {
  return hmac(Buffer.from(sha256(secret), "hex"), `${role}|${clientNonce}|${serverNonce}`);
}

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
    this.core.track(this.core.notifications.flush());           // anything that fired before we were listening
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
    const c: Client = { rpc: new NdjsonRpc(sock, { maxLine: MAX_REQUEST_BYTES }), component: null, subs: new Map(), id: ++this.nextId };
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

  /**
   * Handshake. Preferred (1.1): `hello {client_nonce}` → server nonce + server proof (the
   * client checks it before revealing anything), then `hello.finish {client_proof}`; the
   * secret never crosses the pipe, so a process squatting the pipe name learns nothing.
   * Legacy (1.0, the C# Session Agent, whose pipe client already verifies the server's
   * owner with CurrentUserOnly): `hello {secret}`.
   */
  private hello(c: Client, p: { protocol_version?: string; component?: string; secret?: string; client_nonce?: string }) {
    const major = String(p.protocol_version ?? "").split(".")[0];
    if (major !== COORDINATOR_PROTOCOL.split(".")[0]) throw new JarvisError("unsupported_operation", `protocol ${p.protocol_version} not supported; server speaks ${COORDINATOR_PROTOCOL}`);
    if (p.component !== "console" && p.component !== "session") throw new JarvisError("invalid_input", `unknown component ${p.component}`);
    if (typeof p.client_nonce === "string") {
      if (!/^[0-9a-f]{32,128}$/.test(p.client_nonce)) throw new JarvisError("invalid_input", "client_nonce must be 32–128 hex characters");
      const sn = randomBytes(24).toString("hex");
      c.challenge = { component: p.component, cn: p.client_nonce, sn };
      return { protocol_version: COORDINATOR_PROTOCOL, server_nonce: sn, server_proof: handshakeProof(this.opts.secret, "server", p.client_nonce, sn) };
    }
    // Constant-time comparison of hashes, so length differences leak nothing either.
    if (typeof p.secret !== "string" || !safeEqualHex(sha256(p.secret), sha256(this.opts.secret))) {
      setTimeout(() => c.rpc.close(), 10).unref();
      throw new JarvisError("auth_required", "bad session secret");
    }
    return this.admit(c, p.component);
  }

  private helloFinish(c: Client, p: { client_proof?: string }) {
    const ch = c.challenge;
    c.challenge = undefined;                       // one attempt per challenge
    if (!ch || typeof p.client_proof !== "string" || !/^[0-9a-f]{64}$/.test(p.client_proof) || !safeEqualHex(p.client_proof, handshakeProof(this.opts.secret, "client", ch.cn, ch.sn))) {
      setTimeout(() => c.rpc.close(), 10).unref();
      throw new JarvisError("auth_required", "bad handshake proof");
    }
    return this.admit(c, ch.component as "console" | "session");
  }

  private admit(c: Client, component: "console" | "session") {
    c.component = component;
    const p = { component };
    this.core.ctx.events.append({ type: "ipc.connected", summary: p.component, data: { component: p.component, client: c.id } });
    setImmediate(() => this.core.track(this.core.notifications.flush()));   // a new client can show what was waiting
    return { protocol_version: COORDINATOR_PROTOCOL, server: "jarvis-core", safe_mode: this.core.broker.safeMode, halted: this.core.broker.isHalted() };
  }

  private async dispatch(c: Client, method: string, params: unknown): Promise<unknown> {
    if ((method === "hello" || method === "hello.finish") && c.component) throw new JarvisError("conflict", "already connected; open a new connection to change role");
    if (method === "hello") return this.hello(c, P(params));
    if (method === "hello.finish") return this.helloFinish(c, P(params));
    if (!c.component) throw new JarvisError("auth_required", "say hello first");
    if (method === "ping") return { ok: true, at: this.core.ctx.clock.iso() };
    const meta = (params && typeof params === "object" ? params : {}) as { deadline?: unknown; idempotency_key?: unknown };
    if (typeof meta.deadline === "string" && Date.parse(meta.deadline) <= this.core.ctx.clock.now()) throw new JarvisError("timeout", `${method}: the deadline passed before the call started`);
    if (c.component === "session") {
      // The Session Agent reports events; its requests are limited to these.
      if (method.startsWith("session.") || method.startsWith("power.") || method.startsWith("hotkey.")) { this.opts.sessionBridge?.handle(method, params); return { ok: true }; }
      throw new JarvisError("missing_permission", `the session agent may not call ${method}`);
    }
    const key = meta.idempotency_key;
    if (key === undefined || !MUTATING.has(method)) return this.consoleMethod(c, method, params);
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw new JarvisError("invalid_input", "idempotency_key must be 8–128 characters [A-Za-z0-9_.:-]");
    return this.idempotent(key, method, params, () => this.consoleMethod(c, method, params));
  }

  private inflight = new Map<string, { method: string; hash: string; p: Promise<unknown> }>();
  /** Same key + same method and params → the first result; same key with different content → conflict. Kept 24 hours. */
  private async idempotent(key: string, method: string, params: unknown, run: () => Promise<unknown>): Promise<unknown> {
    const db = this.core.ctx.db;
    const { idempotency_key: _k, deadline: _d, ...rest } = params as Record<string, unknown>;
    const hash = sha256(canonicalJson(rest));
    const prev = db.prepare("select method, params_hash, result from ipc_idempotency where idempotency_key = ?").get(key) as { method: string; params_hash: string; result: string } | undefined;
    if (prev) {
      if (prev.method !== method || prev.params_hash !== hash) throw new JarvisError("conflict", "that idempotency key was already used for a different command");
      return JSON.parse(prev.result);
    }
    const running = this.inflight.get(key);
    if (running) {
      if (running.method !== method || running.hash !== hash) throw new JarvisError("conflict", "that idempotency key is in use by a different command");
      return running.p;
    }
    const p = run().then(result => {
      const json = JSON.stringify(result ?? null);
      if (json.length <= 1_000_000) {
        const now = this.core.ctx.clock.now();
        db.prepare("delete from ipc_idempotency where at < ?").run(new Date(now - 86_400_000).toISOString());
        db.prepare("insert or ignore into ipc_idempotency(idempotency_key, method, params_hash, result, at) values (?,?,?,?,?)").run(key, method, hash, json, new Date(now).toISOString());
      }
      return result;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, { method, hash, p });
    return p;
  }

  private async consoleMethod(c: Client, method: string, params: unknown): Promise<unknown> {
    const j = this.core;
    // Messages from the Console come from the local interactive session over an ACL'd pipe: owner-verified (12 §17.6).
    const ownerVerified = true;
    switch (method) {
      // ----- conversation -----
      case "conversation.send": {
        const p = P<{ conversation_id?: string; content?: string; modality?: "text" | "voice"; transcript_confidence?: "high" | "medium" | "low"; attachments?: Attachment[] }>(params);
        if (p.attachments !== undefined && !Array.isArray(p.attachments)) throw new JarvisError("invalid_input", "attachments must be a list");
        const text = p.attachments?.length && !p.content ? "(attachments)" : str(p.content, "content");
        if (text.length > 20_000) throw new JarvisError("invalid_input", "message too long");
        const r = await j.conversation.handle({ ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}), text, channel: p.modality === "voice" ? "console_voice" : "console_text",
          owner_verified: ownerVerified, ...(p.transcript_confidence ? { transcript_confidence: p.transcript_confidence } : {}), ...(p.attachments?.length ? { attachments: p.attachments } : {}) }, { background: true });
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
        j.conversation.setFocus(t.origin.conversation_id, t.task_id);      // "change it" refers to this task
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
      case "memory.markdown": {
        // The view plus the ids it contains; send both back to preview/apply an edit (03 §9.18).
        const type = this.memType(P<{ type?: string }>(params).type);
        const markdown = j.portability.markdownView(type);
        return { markdown, exported_ids: [...markdown.matchAll(/<!-- (\S+)@r\d+ -->/g)].map(m => m[1]!) };
      }
      case "memory.markdown_preview": case "memory.markdown_apply": {
        const p = P<{ markdown: string; exported_ids: string[]; accept?: { edits?: string[]; added?: number[]; deletions?: string[] } }>(params);
        const md = str(p.markdown, "markdown");
        if (md.length > 2_000_000) throw new JarvisError("invalid_input", "markdown too large");
        if (!Array.isArray(p.exported_ids) || p.exported_ids.some(id => typeof id !== "string" || !j.memory.get(id))) throw new JarvisError("invalid_input", "exported_ids must be the ids from memory.markdown");
        const diff = j.portability.diffImport(md, p.exported_ids);        // always recomputed here; a client-sent diff is never trusted
        if (method === "memory.markdown_preview") return diff;
        const { payload_id } = j.ctx.payloads.put(md, "personal");
        return j.portability.applyImport(diff, p.accept ?? { edits: diff.edits.map(e => e.record_id), added: diff.added.map((_, i) => i), deletions: diff.deletions.map(d => d.record_id) }, payload_id);
      }
      case "memory.correct": {
        const p = P<{ target_ids: string[]; kind: "should_not_remember" | "outdated" | "wrong_scope" | "wrong_entity"; generalization_limit?: string; note?: string }>(params);
        if (!Array.isArray(p.target_ids) || !p.target_ids.length) throw new JarvisError("invalid_input", "target_ids are required");
        if (!["should_not_remember", "outdated", "wrong_scope", "wrong_entity"].includes(p.kind)) throw new JarvisError("invalid_input", "to change wording use memory.markdown_apply; kind must be should_not_remember, outdated, wrong_scope or wrong_entity");
        const { payload_id } = j.ctx.payloads.put(p.note ?? `Console correction: ${p.kind}`, "personal");
        return j.memory.correct({ kind: p.kind, target_ids: p.target_ids.map(String), owner_statement_ref: payload_id, generalization_limit: p.generalization_limit ?? "Only these records; nothing else is implied." });
      }
      case "memory.export": {
        if (!j.opts.dataDir) throw new JarvisError("unsupported_operation", "no data directory");
        const dir = join(j.opts.dataDir, "exports"); mkdirSync(dir, { recursive: true });
        const path = join(dir, `memory-${j.ctx.clock.iso().slice(0, 10)}-${newId("exp", j.ctx.clock.now()).slice(-6)}.jarvis-archive`);
        return { path, ...j.portability.exportArchive(path) };
      }
      case "memory.import": {
        const path = str(P<{ path: string }>(params).path, "path");
        if (!path.endsWith(".jarvis-archive") || !exists(path)) throw new JarvisError("invalid_input", "choose an existing .jarvis-archive file");
        return j.portability.importArchive(path);
      }
      // ----- rules -----
      case "rules.list": return j.policy.listRules();
      case "rules.get": return j.policy.getRule(str(P<{ rule_id: string }>(params).rule_id, "rule_id")) ?? null;
      case "rules.propose": {
        // A rule typed in the Console's rule editor: compiled and stored as a draft; it applies only after rules.confirm.
        const p = P<{ draft: Record<string, unknown> }>(params);
        if (!p.draft || typeof p.draft !== "object") throw new JarvisError("invalid_input", "draft is required");
        const { rule_id: _id, status: _st, ...draft } = p.draft;
        try { return j.policy.propose({ ...draft, source: { type: "owner_edit", channel_verified: ownerVerified } } as never); }
        catch (e) { if (e instanceof JarvisError) throw e; throw new JarvisError("invalid_input", `rule draft: ${(e as Error).message.slice(0, 300)}`); }
      }
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
      // ----- workshop and gaps (08 §13, 07 §12.15) -----
      case "workshop.list": {
        const rows = j.ctx.db.prepare("select work_order_id, task_id, status, worker, created_at, updated_at, validation_json from dev_orders order by created_at desc limit 50").all() as { work_order_id: string; task_id: string; status: string; worker: string; created_at: string; updated_at: string; validation_json: string | null }[];
        return rows.map(r => { const v = r.validation_json ? JSON.parse(r.validation_json) as { capability_id: string; version: string; risk_class: string; ok: boolean; permission_delta: unknown; untested: string[]; confidence_limits: string; stages: { stage: number; name: string; ok: boolean; findings: unknown[] }[] } : null;
          return { work_order_id: r.work_order_id, task_id: r.task_id, status: r.status, worker: r.worker, created_at: r.created_at, updated_at: r.updated_at,
            ...(v ? { capability_id: v.capability_id, version: v.version, risk_class: v.risk_class, validated: v.ok, permission_delta: v.permission_delta, untested: v.untested, confidence_limits: v.confidence_limits, stages: v.stages } : {}) }; });
      }
      case "workshop.approve": return j.approveBuild(str(P<{ work_order_id: string }>(params).work_order_id, "work_order_id"));
      case "workshop.status": return { configured: !!j.workshop, releases: j.releases ? j.releases.releases().slice(-20) : [] };
      case "gaps.list": return j.gaps.list().slice(0, 50);
      // ----- usage (09 §14.1 Console v1: usage) -----
      case "usage.summary": {
        const p = P<{ since?: string }>(params);
        const since = p.since ?? new Date(j.ctx.clock.now() - 30 * 86_400_000).toISOString();
        const entries = j.gateway.ledger({ since });
        const sum = (k: "actual" | "estimated") => entries.filter(e => e.kind === k && e.amount?.currency === "USD").reduce((a, e) => a + (e.amount?.amount ?? 0), 0);
        const byModel: Record<string, { calls: number; input_tokens: number; output_tokens: number }> = {};
        for (const e of entries) {
          const m = (byModel[e.adapter] ??= { calls: 0, input_tokens: 0, output_tokens: 0 });
          m.calls++; m.input_tokens += e.tokens?.input ?? 0; m.output_tokens += e.tokens?.output ?? 0;
        }
        return { since, calls: entries.length, cost_usd: { actual: sum("actual"), estimated: sum("estimated") }, unknown_cost_calls: entries.filter(e => e.kind === "unknown").length,
          by_model: byModel, budgets: j.gateway.budgets().map(b => ({ ...b, spent: j.gateway.spent(b) })), warnings: j.gateway.lifecycleWarnings() };
      }
      // ----- profile / onboarding -----
      case "profile.get": return j.episodic.getProfile() ?? null;
      case "profile.set": {
        const p = P<Record<string, unknown>>(params);
        const prev = j.episodic.getProfile();
        const tz = typeof p.timezone === "string" ? p.timezone : prev?.timezone ?? "UTC";
        if (!isValidZone(tz)) throw new JarvisError("invalid_input", `unknown timezone ${tz}`);
        const base = prev ?? defaultProfile(tz);
        const { owner_id: _o, schema: _s, revision: _r, updated_at: _u, ...rest } = { ...base, ...p, timezone: tz } as Record<string, unknown>;
        let next;
        try { next = j.episodic.setProfile(rest as never); }
        catch (e) { throw new JarvisError("invalid_input", `profile: ${(e as Error).message.slice(0, 300)}`); }
        if (prev && prev.timezone !== tz) j.scheduler.onOwnerTimezoneChanged(prev.timezone, tz);
        return next;
      }
      // ----- settings, status, safety -----
      case "settings.get": return j.getSettings();
      case "settings.set": { const p = P<{ key: string; value: unknown }>(params); j.setSetting(str(p.key, "key"), p.value); return { ok: true }; }
      case "status.get": {
        // The UI must be able to show a broken state (F22), so every part is read defensively.
        const safe = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
        const dbOk = safe(() => { j.ctx.db.prepare("select 1").get(); return true; }, false);
        return {
          database: dbOk ? "ok" : "unavailable", safe_mode: j.broker.safeMode || !dbOk, halted: j.broker.isHalted(), policy_revision: safe(() => j.policy.currentRevision(), -1),
          anthropic_key: safe(() => !!j.vault.findByProvider("anthropic"), false), boss_route: safe(() => j.gateway.route("boss.reasoning").chain, []), recovery: j.recovery ?? null,
          needs_you: safe(() => j.notifications.needsYou().length, 0), open_decisions: safe(() => j.policy.openDecisionRequests().length, 0),
        };
      }
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

  private memType(t: unknown): "fact" | "preference" | "lesson" {
    if (t === undefined) return "preference";
    if (t === "fact" || t === "preference" || t === "lesson") return t;
    throw new JarvisError("invalid_input", "type must be fact, preference or lesson");
  }

  private memoryView(id: string) {
    const r = this.core.memory.require(id);
    return { id: r.id, type: r.type, text: r.text, status: r.status, sensitivity: r.sensitivity, scope: r.scope, confidence: r.confidence, provenance: { origin: r.provenance.origin, source_trust: r.provenance.source_trust }, updated_at: r.updated_at };
  }
}

/** First-run profile (onboarding); every field is editable in the Console. */
export function defaultProfile(tz: string) {
  return {
    display_name: "Owner", timezone: tz, locale: "en-GB", languages: ["en"], units: "metric" as const,
    working_hours: { tz, windows: [{ days: ["mon", "tue", "wed", "thu", "fri"] as ("mon" | "tue" | "wed" | "thu" | "fri")[], from: "09:00", to: "17:30" }] },
    quiet_hours: { tz, windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[], from: "22:00", to: "07:00" }] },
    assistant: { name: "JARVIS", tone: "calm and direct", verbosity: "brief" as const, humor: "light" as const },
    notification_defaults: { channels: ["console", "toast"] as ("console" | "toast")[] },
    privacy: {
      // Owner decision: general data may go to the cloud model; secrets stay local (never in memory or context).
      default_egress_by_sensitivity: { normal: { policy: "any_approved_provider" as const }, personal: { policy: "any_approved_provider" as const },
        sensitive: { policy: "listed_providers" as const, providers: ["anthropic"] }, restricted: { policy: "local_only" as const } },
      audio_retention: "none" as const, screenshot_retention_days: 7,
    },
    home_node_id: "node_local",
  };
}
