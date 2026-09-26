import {
  newId, hashObject, JarvisError, toStructured, ERROR_DEFAULTS, NEP_PROTOCOL_VERSION, READ_EFFECTS, CONSEQUENTIAL_EFFECTS,
  type AuthorizationDecision, type EffectClass, type ResourceSelector, type ToolResult, type StructuredError, type NepInvoke,
  type CapabilityDescriptor, type Money, type DecisionRequest,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { ActionService } from "../tasks/actions.js";
import { actionFingerprint } from "../tasks/actions.js";
import type { LeaseManager } from "../tasks/leases.js";
import type { PolicyEngine, ValueSource } from "../policy/policy-engine.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { CredentialVault } from "../vault/vault.js";
import type { EvidenceStore, Verifier } from "../verifier/verifier.js";
import type { Executor, ExecResult, ExecutorContext } from "./types.js";

export interface BrokerRequest {
  task_id: string;
  step_id?: string;
  capability: string;                       // "tool:files.write" or "tool:files.write@1.0.0"
  params: Record<string, unknown>;
  requested_by: { kind: "boss" | "skill" | "worker"; ref: string };
  targets?: ResourceSelector[];
  account?: string;
  fields?: Record<string, unknown>;         // policy-relevant values (amount, recipients, local_time, refundable, …)
  value_sources?: Record<string, ValueSource[]>;
  preview?: string;
  lease?: { resource: string; lease_id: string; fencing_token: number };
  context_vector?: Record<string, number>;  // memory revisions the parameters were derived from
  verify_fields?: string[];                 // authorized params to compare with the read-back
  criteria?: string[];                      // success criteria this action's evidence supports
}

export type BrokerOutcome =
  | { status: "done"; result: ToolResult; action_id?: string }
  | { status: "waiting_decision"; action_id: string; decision_request: DecisionRequest }
  | { status: "denied" | "error" | "uncertain"; result: ToolResult; action_id?: string };

interface PendingDispatch { req: BrokerRequest; cap: CapabilityDescriptor; effects: EffectClass[] }

/**
 * Execution Broker (05 §11): the enforcement point. Every call is classified,
 * authorized by the Policy Engine, dispatched write-ahead through NEP to an executor,
 * and settled from evidence. It never widens scope, never blindly retries a
 * consequential effect, and refuses everything while halted or without policy.
 */
export class Broker {
  private executors = new Map<string, Executor>();
  private inFlight = new Map<string, AbortController>();
  private pending = new Map<string, PendingDispatch>();
  private halted: { reason: string; at: string } | null = null;
  safeMode = false;

  constructor(
    private ctx: CoreContext, private tasks: TaskEngine, private actions: ActionService, private leases: LeaseManager,
    private policy: PolicyEngine, private registry: CapabilityRegistry, private memory: MemoryService,
    private vault: CredentialVault, private evidence: EvidenceStore, private verifier: Verifier,
  ) {}

  registerExecutor(e: Executor): void { for (const c of e.capabilities) this.executors.set(c, e); }

  /** Pending requests survive a restart (e.g. you approve the next morning): kept in an encrypted payload. */
  private remember(actionId: string, p: PendingDispatch): void {
    this.pending.set(actionId, p);
    const { payload_id } = this.ctx.payloads.put(JSON.stringify({ req: p.req, cap: `${p.cap.id}@${p.cap.version}`, effects: p.effects }), "personal");
    this.ctx.db.prepare("insert or replace into broker_pending(action_id, request_ref, created_at) values (?,?,?)").run(actionId, payload_id, this.ctx.clock.iso());
  }
  private recall(actionId: string): PendingDispatch | undefined {
    const mem = this.pending.get(actionId);
    if (mem) return mem;
    const row = this.ctx.db.prepare("select request_ref from broker_pending where action_id = ?").get(actionId) as { request_ref: string } | undefined;
    if (!row) return undefined;
    const saved = JSON.parse(this.ctx.payloads.getText(row.request_ref)) as { req: BrokerRequest; cap: string; effects: EffectClass[] };
    const cap = this.registry.resolve(saved.cap, { includeAll: true });
    if (!cap) return undefined;
    const p = { req: saved.req, cap, effects: saved.effects };
    this.pending.set(actionId, p);
    return p;
  }
  private forget(actionId: string): void {
    this.pending.delete(actionId);
    const row = this.ctx.db.prepare("select request_ref from broker_pending where action_id = ?").get(actionId) as { request_ref: string } | undefined;
    if (row) { this.ctx.payloads.delete(row.request_ref); this.ctx.db.prepare("delete from broker_pending where action_id = ?").run(actionId); }
  }

  // ---------- emergency stop (04 §10.15) ----------
  halt(reason: string): { cancelled: string[] } {
    this.halted = { reason, at: this.ctx.clock.iso() };
    const cancelled = [...this.inFlight.keys()];
    for (const c of this.inFlight.values()) c.abort(new Error("emergency stop"));
    this.ctx.events.append({ type: "emergency.stop", summary: `Emergency stop: ${reason}`, data: { reason, cancelled_invocations: cancelled } });
    return { cancelled };
  }
  resumeAfterHalt(owner_verified: boolean): void {
    if (!owner_verified) throw new JarvisError("missing_permission", "only you can resume after an emergency stop");
    this.halted = null;
    this.ctx.events.append({ type: "emergency.resumed", summary: "Automation resumed by owner", data: {} });
  }
  isHalted(): boolean { return this.halted !== null; }

  private result(invocation_id: string, req: BrokerRequest, partial: Partial<ToolResult> & Pick<ToolResult, "status" | "effect_state">, started: string, action_id?: string): ToolResult {
    return {
      invocation_id, ...(action_id ? { action_id } : {}), evidence: [], timing: { started_at: started, ended_at: this.ctx.clock.iso() },
      executor: { id: "broker", version: "0.1.0", node_id: this.ctx.nodeId },
      correlation: { task_id: req.task_id, ...(req.step_id ? { step_id: req.step_id } : {}), ...(action_id ? { action_id } : {}) }, ...partial,
    };
  }
  private errorResult(req: BrokerRequest, err: StructuredError, started: string, action_id?: string): ToolResult {
    return this.result(newId("inv", this.ctx.clock.now()), req, { status: "error", effect_state: err.effect_state, error: err }, started, action_id);
  }

  /** What a call would be: resolved capability, effects, real targets, derived fields. No side effects (used by the Plan Validator). */
  describeCall(capability: string, params: Record<string, unknown>): { cap: CapabilityDescriptor; effects: EffectClass[]; targets: ResourceSelector[]; fields: Record<string, unknown> } {
    const cap = this.registry.require(capability);
    const exec = this.executors.get(cap.id);
    let targets: ResourceSelector[] = [], fields: Record<string, unknown> = {};
    try { targets = exec?.targets?.(cap.id, params) ?? []; fields = exec?.fields?.(cap.id, params) ?? {}; } catch { /* params may be incomplete at planning time */ }
    return { cap, effects: [...new Set([...this.registry.effectsFor(cap, params), ...(exec?.classify?.(cap.id, params) ?? [])])], targets, fields };
  }

  hasExecutor(capabilityId: string): boolean { return this.executors.has(capabilityId); }

  /** Entry point for boss, skill, and worker (via the MCP Gateway) tool calls. */
  async execute(req: BrokerRequest): Promise<BrokerOutcome> {
    const started = this.ctx.clock.iso();
    try {
      if (this.halted) throw new JarvisError("cancelled", `emergency stop is active (${this.halted.reason}); resume first`);
      if (this.safeMode) throw new JarvisError("policy_unavailable", "safe mode: rules could not be loaded, so nothing is dispatched");
      const cap = this.registry.require(req.capability);
      const capRef = `${cap.id}@${cap.version}`;
      const h = this.registry.health(cap.id, req.account);
      if (h.state === "unavailable_now") throw new JarvisError("unavailable_device", `${cap.title} is unavailable: ${h.reason ?? "device unavailable"}`);
      if (h.state === "needs_auth") throw new JarvisError("auth_required", `${cap.title} needs you to sign in again`);
      if (cap.policy_scopes.includes("ui_automation")) {
        const site = (req.targets ?? []).find(t => "site" in t) as { site: string } | undefined;
        if (site && this.registry.servicePolicy(site.site).ui_automation === "prohibited")
          throw new JarvisError("external_refusal", `${site.site} prohibits UI automation; use its API or do it yourself`);
      }
      const task = this.tasks.require(req.task_id);
      if (task.status !== "running") throw new JarvisError("conflict", `task is ${task.status}; nothing is dispatched unless it is running`);
      const exec = this.executors.get(cap.id);
      const effects = [...new Set([...this.registry.effectsFor(cap, req.params), ...(exec?.classify?.(cap.id, req.params) ?? [])])];
      // Targets come from the executor's own resolution of the params (real paths, hosts), plus any the caller named.
      const derived = exec?.targets?.(cap.id, req.params) ?? [];
      req = { ...req, targets: [...derived, ...(req.targets ?? []).filter(t => !derived.some(d => JSON.stringify(d) === JSON.stringify(t)))],
        // Policy fields the executor derives from the params (program, path, host) cannot be contradicted by the caller.
        fields: { ...(req.fields ?? {}), ...(exec?.fields?.(cap.id, req.params) ?? {}) } };
      const fingerprint = actionFingerprint(capRef, req.params, req.targets ?? [], req.account ?? null);
      const readOnly = effects.every(e => READ_EFFECTS.has(e) || e === "notify_owner");

      if (readOnly) {
        const ev = this.policy.evaluate({ task, action_id: `read_${fingerprint.slice(0, 16)}`, ...(req.step_id ? { step_id: req.step_id } : {}), capability: capRef, capability_lifecycle: cap.lifecycle,
          effects, tier: cap.isolation_tier === "T2" ? "T2" : cap.isolation_tier === "T3" ? "T3" : "T1", fingerprint, targets: req.targets ?? [], ...(req.account ? { account: req.account } : {}), fields: req.fields ?? {} });
        if (ev.decision.decision === "deny")
          return { status: "denied", result: this.errorResult(req, new JarvisError("missing_permission", ev.decision.reason_for_owner).structured, started) };
        if (ev.decision.decision === "allow") {
          const r = await this.invoke(cap, req, undefined, ev.decision, started);
          this.afterOutcome(cap.id, r, req.account);
          // Reads support the step's criteria too (research results, computed values): tag their evidence.
          if (r.status !== "error" && req.criteria?.length) this.tagCriteria(r.evidence.map(e => e.evidence_id), req.criteria, true);
          return r.status === "error" ? { status: "error", result: r } : { status: "done", result: r };
        }
        // A read that needs your decision (e.g. outside the task's scope) goes through the action lifecycle so it can wait for you.
      }

      // Effectful: the external action lifecycle.
      const a = this.actions.propose({ task_id: task.task_id, ...(req.step_id ? { step_id: req.step_id } : {}), capability: capRef, effects, params: req.params, requested_by: `${req.requested_by.kind}:${req.requested_by.ref}` });
      this.actions.prepare(a.action_id, { resolved_params: req.params, preview: req.preview ?? `${cap.title}`, fingerprint,
        ...(cap.side_effects.reconciliation ? { reconciliation_key: hashObject({ cap: cap.id, targets: req.targets ?? [], params: req.params }) } : {}) });
      this.remember(a.action_id, { req, cap, effects });
      return await this.authorizeAndDispatch(a.action_id, started);
    } catch (e) {
      const err = toStructured(e, { capability_id: req.capability, executor: "broker", node_id: this.ctx.nodeId });
      return { status: err.code === "missing_permission" ? "denied" : "error", result: this.errorResult(req, err, started) };
    }
  }

  private evaluateAction(actionId: string, approvedDecisionId?: string) {
    const p = this.recall(actionId);
    if (!p) throw new JarvisError("internal_error", `no pending dispatch for ${actionId}`);
    const a = this.actions.get(actionId);
    const task = this.tasks.require(a.task_id);
    const capRef = `${p.cap.id}@${p.cap.version}`;
    return {
      p, a, task,
      ev: this.policy.evaluate({
        task, action_id: actionId, ...(a.step_id ? { step_id: a.step_id } : {}), capability: capRef, capability_lifecycle: p.cap.lifecycle, effects: p.effects,
        tier: p.cap.isolation_tier === "T2" ? "T2" : p.cap.isolation_tier === "T3" ? "T3" : "T1", fingerprint: a.fingerprint!, targets: p.req.targets ?? [],
        ...(p.req.account ? { account: p.req.account } : {}), fields: p.req.fields ?? {}, ...(p.req.value_sources ? { value_sources: p.req.value_sources } : {}),
        ...(p.req.lease ? { resources: [p.req.lease.resource] } : {}), ...(approvedDecisionId ? { approved_decision_id: approvedDecisionId } : {}),
      }),
    };
  }

  private async authorizeAndDispatch(actionId: string, started: string, approvedDecisionId?: string): Promise<BrokerOutcome> {
    const { p, a, task, ev } = this.evaluateAction(actionId, approvedDecisionId);
    const d = ev.decision;
    if (d.decision === "deny") {
      this.actions.deny(actionId, d.reason_for_owner);
      this.forget(actionId);
      return { status: "denied", action_id: actionId, result: this.errorResult(p.req, new JarvisError("missing_permission", d.reason_for_owner, { details: { matched_rules: d.matched_rules } }).structured, started, actionId) };
    }
    if (d.decision === "require_decision" || d.decision === "require_presence" || d.decision === "require_clarification") {
      const amount = (p.req.fields?.amount as Money | undefined);
      const recipients = p.req.fields?.recipients as string[] | undefined;
      const req = this.policy.createDecisionRequest({
        task_id: task.task_id, action_ids: [actionId], action_fingerprint: a.fingerprint!,
        why: ev.decision_request?.why ?? { kind: "owner_rule", refs: d.matched_rules.map(m => m.rule_id), text: d.reason_for_owner },
        proposal: { summary: p.req.preview ?? p.cap.title, target: (p.req.targets ?? []).map(t => Object.values(t)[0]).join(", ") || p.cap.title,
          ...(recipients?.length ? { recipient: recipients.join(", ") } : {}), ...(amount ? { amount } : {}),
          important_terms: p.cap.known_limitations.slice(0, 3), expected_effect: p.effects.join(", "), reversibility: p.cap.side_effects.reversibility },
        allowRuleDraft: p.effects.some(e => CONSEQUENTIAL_EFFECTS.has(e)),
      });
      this.actions.awaitDecision(actionId, req.decision_request_id);
      this.tasks.transition(task.task_id, "waiting", { wait_reason: "owner", initiator: "broker", detail: `Needs your decision: ${req.proposal.summary}` });
      return { status: "waiting_decision", action_id: actionId, decision_request: req };
    }
    this.actions.authorize(actionId, d.decision_id, d.policy_revision);
    return this.dispatchAuthorized(actionId, d, started);
  }

  /**
   * decision.respond → approved: re-evaluate bound to the approval, resume the task,
   * and dispatch; declined: the action is denied and the task resumes without it.
   */
  async onDecision(decisionRequestId: string, optionId: string, proposalFingerprint: string, ownerVerified: boolean): Promise<(BrokerOutcome & { rule_draft_id?: string }) | { status: "declined"; action_ids: string[] }> {
    const r = this.policy.respond({ decision_request_id: decisionRequestId, option_id: optionId, proposal_fingerprint: proposalFingerprint, owner_verified: ownerVerified });
    const task = this.tasks.require(r.request.task_id);
    if (task.status === "waiting" && task.wait_reason === "owner") this.tasks.transition(task.task_id, "running", { initiator: "owner", detail: "Decision received" });
    if (r.status === "declined") {
      for (const id of r.request.action_ids) { if (this.actions.get(id).state === "awaiting_decision") this.actions.deny(id, "you declined"); this.forget(id); }
      return { status: "declined", action_ids: r.request.action_ids };
    }
    const actionId = r.request.action_ids[0]!;
    const p = this.recall(actionId);
    if (!p) throw new JarvisError("conflict", `action ${actionId} is no longer pending; prepare it again`);
    const started = this.ctx.clock.iso();
    // "Always allow things like this…" opens a standing-permission DRAFT for you to confirm (04 §10.7); it never activates itself.
    let rule_draft_id: string | undefined;
    if (r.status === "rule_draft") {
      const amount = p.req.fields?.amount as Money | undefined;
      const draft = this.policy.propose({
        kind: "standing_permission", text: `Allow ${p.cap.title}${amount ? ` up to ${amount.amount} ${amount.currency}` : ""} without asking.`,
        source: { type: "owner_statement", channel_verified: true }, applies_to: { effects: p.effects, capabilities: [`${p.cap.id}@^${p.cap.version.split(".")[0]}`] },
        decision: "allow", ...(amount ? { bounds: { max_amount: amount } } : {}), enforcement: "broker", protection: "normal", conflict: "deny_wins",
        compile: { status: "compiled", interpretation: `Standing permission for ${p.cap.title}${amount ? `, each up to ${amount.amount} ${amount.currency}` : ""}. Review and confirm.` },
      });
      rule_draft_id = draft.rule.rule_id;
    }
    const d = this.evaluateAction(actionId, decisionRequestId).ev.decision;
    if (d.decision !== "allow") {
      this.actions.deny(actionId, d.reason_for_owner); this.forget(actionId);
      return { status: "denied", action_id: actionId, result: this.errorResult(p.req, new JarvisError("missing_permission", d.reason_for_owner).structured, started, actionId), ...(rule_draft_id ? { rule_draft_id } : {}) };
    }
    this.actions.authorize(actionId, d.decision_id, d.policy_revision);
    const out = await this.dispatchAuthorized(actionId, d, started);
    return { ...out, ...(rule_draft_id ? { rule_draft_id } : {}) };
  }

  /** Dispatch-time checks (04 §10.6 moment 2), write-ahead, NEP invoke, settle. */
  private async dispatchAuthorized(actionId: string, grant: AuthorizationDecision, started: string): Promise<BrokerOutcome> {
    const p = this.recall(actionId)!;
    if (this.halted) { this.actions.invalidate(actionId, "emergency stop"); this.forget(actionId); return { status: "error", action_id: actionId, result: this.errorResult(p.req, new JarvisError("cancelled", "emergency stop").structured, started, actionId) }; }
    const a = this.actions.get(actionId);
    const task = this.tasks.require(a.task_id);
    let v = this.policy.verifyGrant(grant, { task_revision: task.revision, fingerprint: a.fingerprint! });
    if (!v.ok && v.reevaluate && v.code === "conflict") {
      // Policy changed after the grant: re-evaluate cheaply; allowed again or invalidated with the reason (F03).
      const re = this.evaluateAction(actionId).ev.decision;
      if (re.decision !== "allow") {
        this.actions.invalidate(actionId, `policy changed: ${re.reason_for_owner}`); this.forget(actionId);
        return { status: "denied", action_id: actionId, result: this.errorResult(p.req, new JarvisError("missing_permission", `Policy changed before dispatch: ${re.reason_for_owner}`).structured, started, actionId) };
      }
      grant = re; v = this.policy.verifyGrant(grant, { task_revision: task.revision, fingerprint: a.fingerprint! });
    }
    if (!v.ok) {
      const inv = v.code === "expired" ? () => this.actions.expire(actionId, v.ok ? "" : v.reason) : () => this.actions.invalidate(actionId, v.ok ? "" : v.reason);
      if (["authorized"].includes(this.actions.get(actionId).state)) inv();
      this.forget(actionId);
      return { status: "error", action_id: actionId, result: this.errorResult(p.req, new JarvisError(v.code, v.reason).structured, started, actionId) };
    }
    // Parameters derived from a stale context package are re-evaluated before dispatch (03 §9.9).
    for (const [rid, rev] of Object.entries(p.req.context_vector ?? {})) {
      const cur = this.memory.get(rid);
      if (!cur || cur.revision !== rev || cur.status !== "active") {
        this.actions.invalidate(actionId, `memory ${rid} changed since the parameters were derived`); this.forget(actionId);
        return { status: "error", action_id: actionId, result: this.errorResult(p.req, new JarvisError("precondition_changed", `memory ${rid} changed; re-derive the parameters`).structured, started, actionId) };
      }
    }
    if (p.req.lease) {
      try { this.leases.validateFencing(p.req.lease.resource, p.req.lease.fencing_token); }
      catch (e) { this.actions.invalidate(actionId, "stale lease"); this.forget(actionId); return { status: "error", action_id: actionId, result: this.errorResult(p.req, toStructured(e), started, actionId) }; }
    }
    this.actions.dispatch(actionId);                   // write-ahead: committed before anything leaves
    this.policy.markGrantUsed(grant.decision_id);
    this.policy.recordUsage(grant, p.req.fields?.amount as Money | undefined);
    const r = await this.invoke(p.cap, p.req, actionId, grant, started);
    this.settle(actionId, p, r);
    this.forget(actionId);
    this.afterOutcome(p.cap.id, r, p.req.account);
    const st = this.actions.get(actionId).state;
    if (st === "uncertain") return { status: "uncertain", action_id: actionId, result: r };
    return r.status === "error" ? { status: "error", action_id: actionId, result: r } : { status: "done", action_id: actionId, result: r };
  }

  private executorContext(req: BrokerRequest, actionId: string | undefined, signal: AbortSignal, grant: AuthorizationDecision): ExecutorContext {
    return {
      task_id: req.task_id, ...(actionId ? { action_id: actionId } : {}), signal, evidence: this.evidence, vault: this.vault, redactor: this.vault.redactor, node_id: this.ctx.nodeId,
      resolvePlaceholders: (params: unknown) => this.resolvePlaceholders(params),
      preCommit: (live: Record<string, unknown>) => {
        // Pre-commit re-read: every grant bound must still hold on live values.
        for (const b of grant.bounds) {
          const [head, ...rest] = b.field.split(".");
          let v: unknown = live[head!]; for (const k of rest) v = (v as Record<string, unknown> | undefined)?.[k];
          const ok = b.op === "<=" ? typeof v === "number" && v <= (b.value as number) : b.op === ">=" ? typeof v === "number" && v >= (b.value as number)
            : b.op === "==" ? JSON.stringify(v) === JSON.stringify(b.value) : b.op === "in" ? (b.value as unknown[]).some(x => JSON.stringify(x) === JSON.stringify(v)) : true;
          if (!ok) throw new JarvisError("precondition_changed", `${b.field} is now ${JSON.stringify(v)}, outside your bound (${b.op} ${JSON.stringify(b.value)})`);
        }
        const expectedAccount = req.account;
        if (expectedAccount && live.account !== undefined && live.account !== expectedAccount) throw new JarvisError("precondition_changed", `signed in as a different account (${String(live.account)})`);
        this.ctx.events.append({ type: "action.precommit_checked", correlation: { task_id: req.task_id, ...(actionId ? { action_id: actionId } : {}) }, summary: "pre-commit re-read within bounds", data: { fields: Object.keys(live) } });
      },
    };
  }

  resolvePlaceholders(params: unknown): unknown {
    if (typeof params === "string") return params.replace(/\{\{mem:(mem_[0-9A-Z]{26})#([a-z_]+)\}\}/g, (tok) => String(this.memory.resolvePlaceholder(tok)));
    if (Array.isArray(params)) return params.map(p => this.resolvePlaceholders(p));
    if (params && typeof params === "object") return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, this.resolvePlaceholders(v)]));
    return params;
  }

  private async invoke(cap: CapabilityDescriptor, req: BrokerRequest, actionId: string | undefined, grant: AuthorizationDecision, started: string): Promise<ToolResult> {
    const exec = this.executors.get(cap.id);
    const invocation_id = newId("inv", this.ctx.clock.now());
    if (!exec) return this.result(invocation_id, req, { status: "error", effect_state: "none", error: new JarvisError("unsupported_operation", `no executor for ${cap.id} on this node`).structured }, started, actionId);
    const task = this.tasks.require(req.task_id);
    const nep: NepInvoke = {
      invocation_id, ...(actionId ? { action_id: actionId } : {}), capability: `${cap.id}@${cap.version}`, params: req.params,
      ...(grant.decision === "allow" ? { grant: { decision_id: grant.decision_id, signature: grant.signature, fingerprint: grant.action_fingerprint, expires_at: grant.expires_at } } : {}),
      ...(req.lease ? { lease: { lease_id: req.lease.lease_id, fencing_token: req.lease.fencing_token } } : {}),
      task_revision: task.revision, policy_revision: grant.policy_revision, idempotency_key: actionId ? this.actions.get(actionId).idempotency_key : invocation_id,
      deadline: new Date(this.ctx.clock.now() + cap.timeouts.default_s * 1000).toISOString(),
    };
    this.ctx.db.prepare("insert into invocations(invocation_id, capability, status, task_id, action_id, record) values (?,?,?,?,?,?)").run(invocation_id, nep.capability, "dispatched", req.task_id, actionId ?? null,
      JSON.stringify({ invocation_id, capability: nep.capability, requested_by: req.requested_by, protocol: NEP_PROTOCOL_VERSION, decision_id: grant.decision_id }));
    const ac = new AbortController();
    this.inFlight.set(invocation_id, ac);
    const timer = setTimeout(() => ac.abort(new Error("timeout")), cap.timeouts.default_s * 1000);
    let r: ExecResult;
    try {
      r = await exec.invoke(nep, this.executorContext(req, actionId, ac.signal, grant));
    } catch (e) {
      const aborted = ac.signal.aborted;
      const base = toStructured(e, { capability_id: cap.id, executor: exec.id, node_id: this.ctx.nodeId });
      const effectful = !!actionId;
      const code = aborted ? (String(ac.signal.reason?.message ?? "") === "emergency stop" ? "cancelled" : "timeout") : base.code;
      // A timeout or crash after dispatch of an effectful action is an uncertain effect (02 §8.8).
      const effect_state = effectful && (aborted || base.code === "internal_error" || base.code === "timeout") ? "unknown" : base.effect_state;
      r = { status: "error", effect_state, error: { ...base, code: effectful && effect_state === "unknown" ? "uncertain_external_effect" : code, effect_state, retryable: ERROR_DEFAULTS[code].retryable }, evidence: [] };
    } finally {
      clearTimeout(timer); this.inFlight.delete(invocation_id);
    }
    const out = this.result(invocation_id, req, { status: r.status, effect_state: r.effect_state, ...(r.output !== undefined ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}), evidence: r.evidence, ...(r.usage ? { usage: r.usage } : {}) }, started, actionId);
    out.executor = { id: exec.id, version: exec.version, node_id: this.ctx.nodeId };
    this.ctx.db.prepare("update invocations set status = ? where invocation_id = ?").run(r.status === "error" ? "failed" : "completed", invocation_id);
    (out as ToolResult & { observed_fields?: Record<string, unknown> }).observed_fields = r.observed_fields;
    return out;
  }

  /** Maps an executor result onto the action lifecycle. */
  private settle(actionId: string, p: PendingDispatch, r: ToolResult & { observed_fields?: Record<string, unknown> }): void {
    if (r.status === "error") {
      if (r.effect_state === "none") this.actions.failNoEffect(actionId, r.error?.message ?? "rejected");
      else if (r.effect_state === "unknown") { this.actions.markUncertain(actionId, r.error?.message ?? "outcome unknown"); this.enqueueReconciliation(actionId); }
      else this.actions.acknowledge(actionId, { partial: true });
      return;
    }
    this.actions.acknowledge(actionId, { output_hash: hashObject(r.output ?? null) });
    if (r.evidence.length) {
      this.actions.observeEffect(actionId, r.evidence.map(e => e.evidence_id));
      const fields = p.req.verify_fields ?? [];
      const obs = r.observed_fields ?? {};
      const cmp = this.verifier.verifyAction(p.req.params, obs, fields.filter(f => f in obs));
      const missing = fields.filter(f => !(f in obs));
      this.actions.verify(actionId, cmp.matches && missing.length === 0, cmp.matches ? (missing.length ? `not read back: ${missing.join(", ")}` : "read-back matches the authorized parameters") : `mismatch: ${cmp.mismatches.join(", ")}`);
      if (p.req.criteria?.length) this.tagCriteria(r.evidence.map(e => e.evidence_id), p.req.criteria, cmp.matches && missing.length === 0);
    }
  }

  /** Links an action's evidence to the success criteria its step supports (the Verifier counts only named evidence). */
  private tagCriteria(evidenceIds: string[], criteria: string[], matches: boolean): void {
    for (const id of evidenceIds) {
      const rec = this.evidence.get(id);
      if (rec) this.ctx.db.prepare("update evidence set criterion_id = coalesce(criterion_id, ?), record = ? where evidence_id = ?")
        .run(criteria.length === 1 ? criteria[0] : null, JSON.stringify({ ...rec, data: { ...rec.data, criteria, matches } }), id);
    }
  }

  /** Account revoked: pending actions bound to it are invalidated (04 §10.15). */
  onAccountRevoked(accountId: string): string[] {
    const out: string[] = [];
    const ids = (this.ctx.db.prepare("select action_id from broker_pending").all() as { action_id: string }[]).map(r => r.action_id);
    for (const actionId of ids) {
      const p = this.recall(actionId);
      if (!p || p.req.account !== accountId) continue;
      const st = this.actions.get(actionId).state;
      if (st === "prepared" || st === "awaiting_decision" || st === "authorized") { this.actions.invalidate(actionId, "account disconnected"); out.push(actionId); }
      this.forget(actionId);
    }
    return out;
  }

  /** Health bookkeeping; a capability that degrades suspends its linked standing permissions. */
  private afterOutcome(capId: string, r: ToolResult, account?: string): void {
    const before = this.registry.health(capId, account).state;
    this.registry.recordOutcome(capId, r.status !== "error", { ...(account ? { account_id: account } : {}), ...(r.error ? { error_code: r.error.code } : {}) });
    const after = this.registry.health(capId, account).state;
    if (after === "degraded" && before !== "degraded") this.policy.suspendForCapability(capId, "degraded");
    if (before === "degraded" && after === "available") this.policy.resumeForCapability(capId);
  }

  /** Disabling a capability (05 §11.7): new dispatches refused by the registry, running invocations stopped, linked permissions suspended. */
  disableCapability(capId: string, reason: string): { stopped: string[]; suspended: string[] } {
    this.registry.setAdminState(capId, "disabled", reason);
    const stopped: string[] = [];
    for (const [inv, ac] of this.inFlight) {
      const row = this.ctx.db.prepare("select capability from invocations where invocation_id = ?").get(inv) as { capability: string } | undefined;
      if (row && row.capability.split("@")[0] === capId) { ac.abort(new Error("capability disabled")); stopped.push(inv); }
    }
    return { stopped, suspended: this.policy.suspendForCapability(capId, `disabled: ${reason}`) };
  }

  // ---------- reconciliation (02 §8.7 rules 3–4) ----------
  static RECONCILE_SCHEDULE_MS = [60_000, 5 * 60_000, 20 * 60_000];

  enqueueReconciliation(actionId: string): void {
    const now = this.ctx.clock.now();
    this.ctx.db.prepare("insert into reconciliation_queue(action_id, next_at, attempt, window_ends_at, state) values (?,?,0,?, 'pending') on conflict(action_id) do nothing")
      .run(actionId, new Date(now + Broker.RECONCILE_SCHEDULE_MS[0]!).toISOString(), new Date(now + Broker.RECONCILE_SCHEDULE_MS.at(-1)!).toISOString());
  }

  /** Runs due reconciliations; inconclusive past the window becomes an owner decision, never a retry. */
  async reconcileDue(): Promise<{ action_id: string; outcome: string }[]> {
    const now = this.ctx.clock.iso();
    const due = this.ctx.db.prepare("select * from reconciliation_queue where state = 'pending' and next_at <= ?").all(now) as { action_id: string; attempt: number; window_ends_at: string }[];
    const out: { action_id: string; outcome: string }[] = [];
    for (const q of due) {
      const a = this.actions.get(q.action_id);
      if (a.state !== "uncertain") { this.ctx.db.prepare("update reconciliation_queue set state = 'done' where action_id = ?").run(q.action_id); continue; }
      const cap = this.registry.resolve(a.capability, { includeAll: true });
      const exec = cap ? this.executors.get(cap.id) : undefined;
      let res: Awaited<ReturnType<NonNullable<Executor["reconcile"]>>> = { outcome: "inconclusive", checked: "no reconciliation strategy" };
      if (exec?.reconcile) {
        const ac = new AbortController();
        try {
          res = await exec.reconcile({ capability: a.capability, params: this.actions.resolvedParams(a.action_id), reconciliation_key: a.reconciliation_key, idempotency_key: a.idempotency_key },
            { task_id: a.task_id, action_id: a.action_id, signal: ac.signal, evidence: this.evidence, vault: this.vault, redactor: this.vault.redactor, node_id: this.ctx.nodeId,
              resolvePlaceholders: x => this.resolvePlaceholders(x), preCommit: () => { throw new JarvisError("invalid_input", "no commits during reconciliation"); } });
        } catch (e) { res = { outcome: "inconclusive", checked: `reconciliation failed: ${(e as Error).message}` }; }
      }
      if (res.outcome === "effect_found") {
        this.actions.observeEffect(a.action_id, res.evidence.map(e => e.evidence_id));
        this.actions.verify(a.action_id, true, "reconciliation found the effect");
        this.ctx.db.prepare("update reconciliation_queue set state = 'done' where action_id = ?").run(a.action_id);
      } else if (res.outcome === "no_effect") {
        this.actions.failNoEffect(a.action_id, "reconciliation proved no effect");
        this.ctx.db.prepare("update reconciliation_queue set state = 'done' where action_id = ?").run(a.action_id);
      } else {
        const nextIdx = q.attempt + 1;
        if (nextIdx >= Broker.RECONCILE_SCHEDULE_MS.length || now >= q.window_ends_at) {
          this.ctx.db.prepare("update reconciliation_queue set state = 'asked_owner' where action_id = ?").run(a.action_id);
          const task = this.tasks.require(a.task_id);
          this.policy.createDecisionRequest({ task_id: a.task_id, action_ids: [a.action_id], action_fingerprint: a.fingerprint ?? "",
            why: { kind: "ambiguity", refs: [a.action_id], text: `I couldn't confirm whether "${a.preview ?? a.capability}" happened. Checked: ${res.checked}. Retrying could do it twice.` },
            proposal: { summary: `Outcome unknown: ${a.preview ?? a.capability}`, target: a.capability, important_terms: ["Retrying could duplicate the effect"], expected_effect: "none until you decide", reversibility: "n/a" } });
          if (task.status === "running") this.tasks.transition(a.task_id, "waiting", { wait_reason: "owner", initiator: "reconciler", detail: "Needs you: an action's outcome could not be confirmed" });
        } else {
          this.ctx.db.prepare("update reconciliation_queue set attempt = ?, next_at = ? where action_id = ?")
            .run(nextIdx, new Date(Date.parse(this.actions.get(a.action_id).updated_at) + Broker.RECONCILE_SCHEDULE_MS[nextIdx]!).toISOString(), a.action_id);
        }
      }
      out.push({ action_id: a.action_id, outcome: res.outcome });
    }
    return out;
  }
}
