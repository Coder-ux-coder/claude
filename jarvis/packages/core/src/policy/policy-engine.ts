import { join } from "node:path";
import {
  newId, hashObject, hmac, safeEqualHex, canonicalJson, JarvisError, OwnerRule, AuthorizationDecision, DecisionRequest,
  CONSEQUENTIAL_EFFECTS, READ_EFFECTS, EFFECT_CLASSES,
  type EffectClass, type TaskContract, type Constraint, type ResourceSelector, type AuthorizationEnvelope, type Money,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { PolicyReader } from "../context/context-builder.js";
import { effectCeiling } from "../tasks/task-engine.js";
import { capabilityMatches, evalCondition, getField, resourceMatches, typeCheckCondition } from "./match.js";

export const POLICY_ENGINE_VERSION = "0.1.0";

/** A grounding source for a consequential parameter value (04 §10.6, §10.11 rule 3). */
export type ValueSource =
  | { kind: "owner_message"; ref: string }
  | { kind: "rule"; ref: string }
  | { kind: "memory"; ref: string }
  | { kind: "displayed_selection"; ref: string }
  | { kind: "owner_criterion"; ref: string }
  | { kind: "untrusted"; ref: string }
  | { kind: "worker_output"; ref: string };

export interface ActionRequest {
  task: TaskContract;
  action_id: string;
  step_id?: string;
  capability: string;                     // "tool:mail.send@1.0.0"
  capability_lifecycle?: string;          // for require_skill_lifecycle
  effects: EffectClass[];
  tier: "T1" | "T2" | "T3";
  fingerprint: string;
  targets: ResourceSelector[];            // files, sites, accounts, recipients
  account?: string;
  fields: Record<string, unknown>;        // values conditions and bounds refer to (amount, recipient.*, local_time, …)
  value_sources?: Record<string, ValueSource[]>;   // consequential params → where each value came from
  resources?: string[];                   // lease keys
  approved_decision_id?: string;          // an owner decision bound to this fingerprint
}

export interface Evaluation {
  decision: AuthorizationDecision;
  decision_request?: { why: DecisionRequest["why"] };
}

/** Everything the engine needs from other modules, injected to keep it testable. */
export interface PolicyDeps {
  messageTrust(messageId: string): "owner_verified" | "owner_unverified" | "system" | undefined;
  memoryRecordTrusted(recordId: string): boolean;       // active and owner-stated/confirmed
  presenceVerifier?(): boolean;                          // M6: Windows Hello via the Guard
  /** Where plan/research/monitor tasks may write their artifact (02 §8.3: "the plan artifact", "notes", "records"). */
  artifactsRoot?: string;
  grantTtlMs?: number;
}

const DEFAULT_GRANT_TTL = 15 * 60_000;

/** Rule specificity: the number of selectors narrowing where it applies. */
function specificity(r: OwnerRule): number {
  const a = r.applies_to;
  return (a.capabilities?.length ? 1 : 0) + (a.resources?.length ? 1 : 0) + (a.accounts?.length ? 1 : 0) + (a.projects?.length ? 1 : 0) + (a.entities?.length ? 1 : 0) + (r.conditions ? 1 : 0);
}
/** Effects an envelope may only authorize with at least one bound. */
const BOUND_REQUIRED: ReadonlySet<EffectClass> = new Set<EffectClass>(["communicate", "publish", "spend", "commit", "access_control", "execute_code", "install", "admin", "delete.local", "delete.account"]);
const SCOPE_BOUND_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>(["read.local", "write.local", "delete.local"]);
const DEFAULT_REQUIRE_AUTHORITY: ReadonlySet<EffectClass> = new Set<EffectClass>(["delete.local", "write.account", "delete.account", "communicate", "publish", "spend", "commit", "access_control", "install", "admin", "execute_code"]);

/**
 * Policy Engine (04 §10): rule compile-and-confirm, revisions, precedence, grants
 * signed with a core key (v1), grounding checks, decision requests, and the
 * PolicyReader view the Context Builder uses.
 */
export class PolicyEngine implements PolicyReader {
  private snapshot: { revision: number; rules: OwnerRule[] } | null = null;
  constructor(private ctx: CoreContext, private deps: PolicyDeps) {}

  // ---------- revisions and snapshot ----------
  currentRevision(): number {
    return (this.ctx.db.prepare("select coalesce(max(revision), 0) r from policy_revisions").get() as { r: number }).r;
  }

  /** Compiled snapshot cached by revision. Throws (→ policy_unavailable upstream) if the store cannot be read. */
  activeRules(): OwnerRule[] {
    const rev = this.currentRevision();
    if (this.snapshot?.revision !== rev) {
      const rows = this.ctx.db.prepare("select rule from rules where status = 'active'").all() as { rule: string }[];
      this.snapshot = { revision: rev, rules: rows.map(r => OwnerRule.parse(JSON.parse(r.rule))) };
    }
    const now = this.ctx.clock.iso();
    return this.snapshot.rules.filter(r => (!r.effective_from || r.effective_from <= now) && (!r.effective_until || r.effective_until > now));
  }

  getRule(ruleId: string): OwnerRule | undefined {
    const r = this.ctx.db.prepare("select rule from rules where rule_id = ?").get(ruleId) as { rule: string } | undefined;
    return r ? OwnerRule.parse(JSON.parse(r.rule)) : undefined;
  }

  listRules(status?: OwnerRule["status"][]): OwnerRule[] {
    const rows = (status?.length
      ? this.ctx.db.prepare(`select rule from rules where status in (${status.map(() => "?").join(",")})`).all(...status)
      : this.ctx.db.prepare("select rule from rules").all()) as { rule: string }[];
    return rows.map(r => OwnerRule.parse(JSON.parse(r.rule)));
  }

  private bump(source: string, change: Record<string, unknown>): number {
    const rev = this.currentRevision() + 1;
    this.ctx.db.prepare("insert into policy_revisions(revision, at, source, change) values (?,?,?,?)").run(rev, this.ctx.clock.iso(), source, JSON.stringify(change));
    this.ctx.events.append({ type: "policy.revised", summary: `Policy revision ${rev}: ${String(change.op ?? "change")}`, data: { revision: rev, ...change } });
    return rev;
  }

  private store(r: OwnerRule): void {
    const rule = OwnerRule.parse(r);
    this.ctx.db.prepare("insert into rules(rule_id, revision, status, kind, protection, rule) values (?,?,?,?,?,?) on conflict(rule_id) do update set revision = excluded.revision, status = excluded.status, kind = excluded.kind, protection = excluded.protection, rule = excluded.rule")
      .run(rule.rule_id, rule.revision, rule.status, rule.kind, rule.protection, JSON.stringify(rule));
    this.ctx.db.prepare("insert or replace into rule_history(rule_id, revision, rule, at) values (?,?,?,?)").run(rule.rule_id, rule.revision, JSON.stringify(rule), this.ctx.clock.iso());
  }

  // ---------- authoring (04 §10.4) ----------
  /**
   * Deterministic validation of a drafted rule, stored as `draft`. Enforceable kinds
   * need confirm(); vague rules are advisory guidance. Returns overlaps and conflicts
   * so they are resolved now, not mid-task (04 §10.5).
   */
  propose(draft: Omit<OwnerRule, "rule_id" | "schema" | "revision" | "status" | "created_at" | "created_in_policy_revision"> & { rule_id?: string }):
    { rule: OwnerRule; errors: string[]; overlaps: string[]; conflicts_with_protected: string[]; needs_confirmation: boolean } {
    const errors: string[] = [];
    for (const e of draft.applies_to.effects) if (!(EFFECT_CLASSES as readonly string[]).includes(e)) errors.push(`unknown effect class ${e}`);
    if (!draft.applies_to.effects.length) errors.push("a rule must name at least one effect class");
    if (draft.conditions) errors.push(...typeCheckCondition(draft.conditions));
    const money: (Money | undefined)[] = [draft.bounds?.max_amount, draft.bounds?.per_period?.max_total];
    for (const m of money) if (m && !/^[A-Z]{3}$/.test(m.currency)) errors.push("amounts need an ISO 4217 currency");
    if (draft.kind === "standing_permission" && draft.decision !== "allow") errors.push("a standing permission allows within bounds");
    if (draft.kind === "constraint" && draft.decision === "allow") errors.push("a constraint denies or requires a decision");
    if (!draft.source.channel_verified && draft.kind !== "guidance") errors.push("enforceable rules come only from a verified owner channel");
    const rule = OwnerRule.parse({ ...draft, rule_id: draft.rule_id ?? newId("rul", this.ctx.clock.now()), schema: "jarvis.rule/1", revision: 1, status: "draft",
      created_at: this.ctx.clock.iso(), created_in_policy_revision: this.currentRevision() });
    const overlaps: string[] = [], conflicts: string[] = [];
    for (const other of this.activeRules()) {
      if (!other.applies_to.effects.some(e => rule.applies_to.effects.includes(e))) continue;
      const capsOverlap = !other.applies_to.capabilities || !rule.applies_to.capabilities || other.applies_to.capabilities.some(a => rule.applies_to.capabilities!.some(b => capabilityMatches(a, b.replace(/@.*$/, "")) || capabilityMatches(b, a.replace(/@.*$/, ""))));
      const resOverlap = !other.applies_to.resources || !rule.applies_to.resources || other.applies_to.resources.some(a => rule.applies_to.resources!.some(b => resourceMatches(a, b) || resourceMatches(b, a)));
      if (!capsOverlap || !resOverlap) continue;
      overlaps.push(other.rule_id);
      if (other.protection === "protected" && other.decision === "deny" && rule.decision === "allow") conflicts.push(other.rule_id);
    }
    if (conflicts.length) errors.push(`conflicts with protected rule(s) ${conflicts.join(", ")}; those change only through the protected process`);
    if (errors.length) rule.compile.status = "needs_clarification";
    this.ctx.tx(() => { this.store(rule); });
    const enforceable = rule.kind !== "guidance" && rule.compile.status === "compiled";
    return { rule, errors, overlaps, conflicts_with_protected: conflicts, needs_confirmation: enforceable };
  }

  /**
   * The one-time confirmation card (04 §10.4 step 4). Protected rules need a typed
   * confirmation naming the rule from the Console, plus presence from M6.
   */
  confirm(ruleId: string, c: { channel: "console" | "push_to_talk" | "other"; owner_verified: boolean; typed_confirmation?: string }): OwnerRule {
    return this.ctx.tx(() => {
      const r = this.getRule(ruleId);
      if (!r || r.status !== "draft") throw new JarvisError("conflict", `rule ${ruleId} is not a draft`);
      if (r.compile.status === "needs_clarification") throw new JarvisError("invalid_input", "the rule has validation errors; edit it first");
      if (!c.owner_verified || c.channel === "other") throw new JarvisError("missing_permission", "rules are confirmed only from a verified owner channel");
      if (r.protection === "protected") this.requireProtectedProcess(r, c);
      if (r.supersedes) {
        const old = this.getRule(r.supersedes);
        if (old?.protection === "protected") this.requireProtectedProcess(old, c);
        if (old && old.status === "active") this.store({ ...old, status: "superseded", revision: old.revision + 1 });
      }
      const active: OwnerRule = { ...r, status: "active", compile: { ...r.compile, confirmed_at: this.ctx.clock.iso() } };
      this.store(active);
      this.bump("owner_confirmation", { op: "rule_activated", rule_id: ruleId, supersedes: r.supersedes ?? null });
      return active;
    });
  }

  private requireProtectedProcess(r: OwnerRule, c: { channel: string; typed_confirmation?: string }): void {
    if (c.channel !== "console") throw new JarvisError("missing_permission", `protected rule "${r.text}" changes only from the Console`);
    const typed = (c.typed_confirmation ?? "").trim();
    if (typed !== r.rule_id && typed !== r.text) throw new JarvisError("missing_permission", "type the rule's text or id to confirm a protected change");
    if (this.deps.presenceVerifier && !this.deps.presenceVerifier()) throw new JarvisError("missing_permission", "presence proof failed");
  }

  /** Revocation stops future actions immediately (04 §10.7); pending ones are re-evaluated at dispatch. */
  revoke(ruleId: string, c: { channel: "console" | "push_to_talk" | "other"; owner_verified: boolean; typed_confirmation?: string }): OwnerRule {
    return this.ctx.tx(() => {
      const r = this.getRule(ruleId);
      if (!r || r.status !== "active") throw new JarvisError("conflict", `rule ${ruleId} is not active`);
      if (!c.owner_verified) throw new JarvisError("missing_permission", "only you can revoke a rule");
      if (r.protection === "protected") this.requireProtectedProcess(r, c);
      const next = { ...r, status: "revoked" as const, revision: r.revision + 1 };
      this.store(next);
      this.bump("owner_revocation", { op: "rule_revoked", rule_id: ruleId });
      return next;
    });
  }

  /** Suspension without owner action: a standing permission whose linked skill degraded (04 §10.7). */
  suspend(ruleId: string, reason: string): void {
    this.ctx.tx(() => {
      const r = this.getRule(ruleId);
      if (!r || r.status !== "active") return;
      this.store({ ...r, status: "suspended", revision: r.revision + 1 });
      this.bump("system", { op: "rule_suspended", rule_id: ruleId, reason });
    });
  }

  /** A standing permission is suspended when its linked capability degrades, is quarantined, or is disabled (04 §10.7, 05 §11.7). */
  suspendForCapability(capabilityId: string, reason: string): string[] {
    const out: string[] = [];
    for (const r of this.activeRules().filter(r => r.kind === "standing_permission" && r.applies_to.capabilities?.some(p => capabilityMatches(p, capabilityId)))) {
      this.suspend(r.rule_id, `${capabilityId}: ${reason}`); out.push(r.rule_id);
    }
    return out;
  }

  /** Re-activates permissions suspended for a capability once it is healthy again. */
  resumeForCapability(capabilityId: string): string[] {
    const out: string[] = [];
    this.ctx.tx(() => {
      for (const r of this.listRules(["suspended"]).filter(r => r.applies_to.capabilities?.some(p => capabilityMatches(p, capabilityId)))) {
        this.store({ ...r, status: "active", revision: r.revision + 1 }); out.push(r.rule_id);
      }
      if (out.length) this.bump("system", { op: "rules_resumed", rule_ids: out, capability: capabilityId });
    });
    return out;
  }

  // ---------- context view ----------
  applicableRules(d: { effects: EffectClass[]; capabilities: string[]; entity_ids: string[]; project_id?: string; at: string }) {
    return this.activeRules()
      .filter(r => r.applies_to.effects.some(e => d.effects.includes(e)))
      .filter(r => !r.applies_to.capabilities || d.capabilities.length === 0 || r.applies_to.capabilities.some(p => d.capabilities.some(c => capabilityMatches(p, c))))
      .filter(r => !r.applies_to.projects || !d.project_id || r.applies_to.projects.includes(d.project_id))
      .map(r => ({ rule_id: r.rule_id, revision: r.revision, kind: r.kind, decision: r.decision, text: r.text, protection: r.protection }));
  }

  // ---------- evaluation (04 §10.5–10.7) ----------
  private ruleMatches(r: OwnerRule, a: ActionRequest, unknownMeans: boolean): boolean {
    if (!r.applies_to.effects.some(e => a.effects.includes(e))) return false;
    if (r.applies_to.capabilities && !r.applies_to.capabilities.some(p => capabilityMatches(p, a.capability))) return false;
    if (r.applies_to.resources && !r.applies_to.resources.some(rs => a.targets.some(t => resourceMatches(rs, t)))) return false;
    if (r.applies_to.accounts && (!a.account || !r.applies_to.accounts.includes(a.account))) return false;
    if (r.applies_to.projects && (!a.task.project_id || !r.applies_to.projects.includes(a.task.project_id))) return false;
    if (r.applies_to.entities) {
      const ents = (getField(a.fields, "entities").value as string[] | undefined) ?? [];
      if (!r.applies_to.entities.some(e => ents.includes(e))) return false;
    }
    if (r.conditions) {
      const v = evalCondition(r.conditions, a.fields);
      if (v === "unknown") return unknownMeans;
      return v;
    }
    return true;
  }

  private checkConstraint(b: Constraint, fields: Record<string, unknown>): boolean {
    const { found, value } = getField(fields, b.field);
    if (!found) return false;                      // an unverifiable bound is not satisfied (fail closed)
    const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
    switch (b.op) {
      case "==": return eq(value, b.value);
      case "<=": return typeof value === "number" && typeof b.value === "number" && value <= b.value;
      case ">=": return typeof value === "number" && typeof b.value === "number" && value >= b.value;
      case "in": return Array.isArray(b.value) && (Array.isArray(value) ? value : [value]).every(v => (b.value as unknown[]).some(x => eq(x, v)));
      case "not_in": return Array.isArray(b.value) && !(Array.isArray(value) ? value : [value]).some(v => (b.value as unknown[]).some(x => eq(x, v)));
      case "between": { const [lo, hi] = b.value as [unknown, unknown]; return typeof value === typeof lo && (value as number | string) >= (lo as number | string) && (value as number | string) <= (hi as number | string); }
      case "matches": return typeof value === "string" && new RegExp(String(b.value)).test(value);
    }
  }

  /** The grounding check for an explicit-instruction envelope (04 §10.6). */
  validateEnvelope(env: AuthorizationEnvelope, task: TaskContract): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const ceiling = effectCeiling(task.mode, task.intended_effects);
    for (const e of env.effects) if (!ceiling.has(e)) problems.push(`effect ${e} is inconsistent with a ${task.mode} request`);
    const needBound = env.effects.filter(e => BOUND_REQUIRED.has(e));
    if (needBound.length && env.bounds.filter(b => b.hard).length === 0) problems.push(`an instruction authorizing ${needBound.join(", ")} must bound it (target, recipient, amount, or program)`);
    for (const b of env.bounds) {
      const g = env.grounding.find(x => x.constraint_id === b.id);
      if (!g) { problems.push(`bound ${b.id} (${b.field}) has no source`); continue; }
      switch (g.source.kind) {
        case "owner_message":
          if (!task.origin.message_ids.includes(g.source.ref)) problems.push(`bound ${b.id} cites a message outside this task`);
          else if (this.deps.messageTrust(g.source.ref) !== "owner_verified") problems.push(`bound ${b.id} cites a message that is not owner-verified`);
          break;
        case "rule": if (this.getRule(g.source.ref)?.status !== "active") problems.push(`bound ${b.id} cites an inactive rule`); break;
        case "memory": if (!this.deps.memoryRecordTrusted(g.source.ref)) problems.push(`bound ${b.id} cites memory that is not owner-confirmed`); break;
        case "displayed_selection": case "owner_criterion": if (!g.source.ref) problems.push(`bound ${b.id} has an empty source`); break;
      }
    }
    return { ok: problems.length === 0, problems };
  }

  private usage(ruleId: string, period: "day" | "week" | "month"): { total: number; count: number } {
    const days = period === "day" ? 1 : period === "week" ? 7 : 30;
    const since = new Date(this.ctx.clock.now() - days * 86_400_000).toISOString();
    return this.ctx.db.prepare("select coalesce(sum(amount), 0) total, count(*) count from rule_usage where rule_id = ? and at > ?").get(ruleId, since) as { total: number; count: number };
  }

  private standingCovers(r: OwnerRule, a: ActionRequest, effect: EffectClass): { ok: boolean; why?: string } {
    if (r.kind !== "standing_permission" && r.kind !== "exception") return { ok: false };
    if (r.decision !== "allow" || !r.applies_to.effects.includes(effect)) return { ok: false };
    if (!this.ruleMatches(r, a, false)) return { ok: false };
    const b = r.bounds ?? {};
    const amount = getField(a.fields, "amount").value as Money | undefined;
    if (b.max_amount) {
      if (!amount || amount.currency !== b.max_amount.currency) return { ok: false, why: "amount unknown or in another currency" };
      if (amount.amount > b.max_amount.amount) return { ok: false, why: `amount ${amount.amount} ${amount.currency} is above ${b.max_amount.amount}` };
    }
    if (b.per_period) {
      const u = this.usage(r.rule_id, b.per_period.period);
      if (b.per_period.max_count !== undefined && u.count + 1 > b.per_period.max_count) return { ok: false, why: `used ${u.count} times this ${b.per_period.period}` };
      if (b.per_period.max_total && (!amount || u.total + amount.amount > b.per_period.max_total.amount)) return { ok: false, why: `would exceed ${b.per_period.max_total.amount} ${b.per_period.max_total.currency} this ${b.per_period.period}` };
    }
    if (b.recipients) {
      const rec = getField(a.fields, "recipients").value as string[] | undefined;
      if (!rec || !rec.every(x => b.recipients!.includes(x))) return { ok: false, why: "recipient outside the permission" };
    }
    if (b.destinations && !a.targets.every(t => b.destinations!.some(d => resourceMatches(d, t)))) return { ok: false, why: "destination outside the permission" };
    if (b.time_window) {
      const t = getField(a.fields, "local_time").value;
      const inWin = evalCondition({ field: "t", op: "within", value: b.time_window }, { t });
      if (inWin !== true) return { ok: false, why: "outside the permitted time window" };
    }
    if (b.require_refundable && getField(a.fields, "refundable").value !== true) return { ok: false, why: "not refundable" };
    if (b.require_skill_lifecycle && a.capability_lifecycle !== "active") return { ok: false, why: "the skill is not a validated active version" };
    return { ok: true };
  }

  private approvedDecisionCovers(a: ActionRequest): boolean {
    if (!a.approved_decision_id) return false;
    const row = this.ctx.db.prepare("select status, request from decision_requests where id = ?").get(a.approved_decision_id) as { status: string; request: string } | undefined;
    if (!row || row.status !== "approved") return false;
    const req = DecisionRequest.parse(JSON.parse(row.request));
    return req.action_ids.includes(a.action_id) && req.expires_at > this.ctx.clock.iso() &&
      (this.ctx.db.prepare("select 1 from decision_requests where id = ? and json_extract(request, '$.bound_fingerprint') = ?").get(a.approved_decision_id, a.fingerprint) !== undefined);
  }

  /** Evaluates one prepared action and returns a signed decision (a grant when allow). */
  evaluate(a: ActionRequest, opts: { dryRun?: boolean } = {}): Evaluation {
    let rules: OwnerRule[];
    try { rules = this.activeRules(); } catch (e) { throw new JarvisError("policy_unavailable", `policy cannot be read: ${(e as Error).message}`); }
    const matched: AuthorizationDecision["matched_rules"] = [];
    const reasons: string[] = [];
    let denied = false, presence = false;
    let needDecision: DecisionRequest["why"] | undefined;
    const want = (why: DecisionRequest["why"]) => { needDecision ??= why; };
    const overriddenRules = new Set(a.task.overrides.filter(o => o.target.kind === "rule").map(o => o.target.ref));
    // Your approval of this exact proposal (bound to its fingerprint) answers every "ask me" rule; it never lifts a deny or a presence requirement.
    const ownerDecision = this.approvedDecisionCovers(a);

    // 1. Protected constraints (rank 1): not overridable inside a task.
    for (const r of rules.filter(r => r.kind === "constraint" && r.protection === "protected")) {
      if (!this.ruleMatches(r, a, true)) continue;
      if (r.decision === "deny") { denied = true; matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "denied" }); reasons.push(`your protected rule "${r.text}" applies`); }
      else if (r.decision === "require_presence") { presence = true; matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "required_decision" }); reasons.push(`"${r.text}" needs you present`); }
      else if (r.decision === "require_decision") { if (!ownerDecision) want({ kind: "owner_rule", refs: [r.rule_id], text: `Your rule "${r.text}" applies.` }); matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "required_decision" }); }
    }
    // 2. Task effect ceiling (rank 2), regardless of any permission.
    const ceiling = effectCeiling(a.task.mode, a.task.intended_effects);
    const outside = a.effects.filter(e => !ceiling.has(e));
    if (outside.length) { denied = true; reasons.push(`this ${a.task.mode} task may not ${outside.join(", ")}`); }
    // 2b. Plan, research and monitor tasks write only their own artifact, never your files.
    if (["plan", "research", "monitor"].includes(a.task.mode) && a.effects.includes("write.local")) {
      const root = this.deps.artifactsRoot;
      const paths = a.targets.filter(t => "path_prefix" in t);
      if (!root || !paths.length || !paths.every(p => resourceMatches({ path_prefix: root }, p))) { denied = true; reasons.push(`a ${a.task.mode} task only writes its own ${a.task.mode === "plan" ? "plan" : a.task.mode === "research" ? "notes" : "records"}, not your files`); }
    }
    // 3. Normal constraints (rank 3): deny wins; an owner override for this task skips the rule.
    for (const r of rules.filter(r => r.kind === "constraint" && r.protection === "normal")) {
      if (overriddenRules.has(r.rule_id) || !this.ruleMatches(r, a, true)) continue;
      if (r.decision === "deny" && r.conflict === "most_specific_wins") {
        // A strictly more specific standing permission covering every denied effect wins (04 §10.5: deny wins only at equal specificity).
        const denied_effects = a.effects.filter(e => r.applies_to.effects.includes(e));
        const winner = rules.find(sp => sp.kind === "standing_permission" && specificity(sp) > specificity(r) && denied_effects.every(e => this.standingCovers(sp, a, e).ok));
        if (winner) { matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "advisory" }); continue; }
      }
      if (r.decision === "deny" && r.conflict === "ask") { if (!ownerDecision) want({ kind: "owner_rule", refs: [r.rule_id], text: `Your rule "${r.text}" applies; it is set to ask you.` }); matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "required_decision" }); continue; }
      if (r.decision === "deny") { denied = true; matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "denied" }); reasons.push(`your rule "${r.text}" applies`); }
      else if (r.decision === "require_presence") { presence = true; matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "required_decision" }); }
      else if (r.decision === "require_decision") { if (!ownerDecision) { want({ kind: "owner_rule", refs: [r.rule_id], text: `Your rule "${r.text}" applies.` }); reasons.push(`your rule "${r.text}" asks me to check with you`); } matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "required_decision" }); }
    }
    // 4. Authorization sources per effect (rank 4) and defaults when no rule matches.
    let basis: AuthorizationDecision["basis"] = { kind: "default_allow", refs: [] };
    const env = a.task.authorization.envelope;
    const envOk = env ? this.validateEnvelope(env, a.task) : { ok: false, problems: ["no envelope"] };
    const bounds: Constraint[] = [];
    for (const effect of a.effects) {
      if (READ_EFFECTS.has(effect) || effect === "notify_owner") {
        if (SCOPE_BOUND_EFFECTS.has(effect) && !this.inScope(a)) want({ kind: "scope_expansion", refs: [], text: "This reads outside the task's scope." });
        continue;
      }
      if (effect === "write.local" && this.inScope(a)) continue;
      if ((effect === "execute_code" || effect === "install") && a.tier === "T2" && a.task.mode === "build") continue;
      if (ownerDecision) { basis = { kind: "owner_decision", refs: [a.approved_decision_id!] }; continue; }
      // Bounds apply to the actions they describe: those whose field this action has. An effect that
      // must be bounded needs at least one applicable bound, so a missing field never widens authority.
      const applicable = env ? env.bounds.filter(b => getField(a.fields, b.field).found) : [];
      if (env && envOk.ok && env.effects.includes(effect) && applicable.every(b => this.checkConstraint(b, a.fields)) && (applicable.length > 0 || !BOUND_REQUIRED.has(effect))) {
        basis = { kind: a.task.origin.channel === "schedule" ? "schedule_owner_intent" : "explicit_instruction", refs: a.task.origin.message_ids };
        bounds.push(...applicable.filter(b => !bounds.some(x => x.id === b.id)));
        continue;
      }
      const standing = rules.map(r => ({ r, c: this.standingCovers(r, a, effect) })).find(x => x.c.ok);
      if (standing) {
        basis = { kind: "standing_permission", refs: [standing.r.rule_id] };
        matched.push({ rule_id: standing.r.rule_id, revision: standing.r.revision, effect: "bounded" });
        const src = { kind: "rule" as const, ref: standing.r.rule_id };
        if (standing.r.bounds?.max_amount) bounds.push({ id: `${standing.r.rule_id}:max_amount`, field: "amount.amount", op: "<=", value: standing.r.bounds.max_amount.amount, source: src, hard: true });
        if (standing.r.bounds?.require_refundable) bounds.push({ id: `${standing.r.rule_id}:refundable`, field: "refundable", op: "==", value: true, source: src, hard: true });
        if (standing.r.bounds?.recipients) bounds.push({ id: `${standing.r.rule_id}:recipients`, field: "recipients", op: "in", value: standing.r.bounds.recipients, source: src, hard: true });
        continue;
      }
      if (effect === "write.local" && !this.inScope(a)) { want({ kind: "scope_expansion", refs: [], text: "This writes outside the task's scope." }); continue; }
      if (DEFAULT_REQUIRE_AUTHORITY.has(effect)) {
        const near = rules.map(r => this.standingCovers(r, a, effect)).find(c => c.why);
        want({ kind: "no_authority", refs: [], text: near?.why ? `Your standing permission doesn't cover this: ${near.why}.` : `Nothing you said or set up authorizes "${effect}" here.` });
      }
    }
    // 5. Value grounding for consequential parameters (04 §10.11 rule 3).
    if (a.effects.some(e => CONSEQUENTIAL_EFFECTS.has(e) && e !== "delete.local") && !ownerDecision) {
      for (const [param, sources] of Object.entries(a.value_sources ?? {})) {
        const grounded = sources.some(s => ["owner_message", "rule", "memory", "displayed_selection", "owner_criterion"].includes(s.kind) &&
          (s.kind !== "owner_message" || (a.task.origin.message_ids.includes(s.ref) && this.deps.messageTrust(s.ref) === "owner_verified")) &&
          (s.kind !== "memory" || this.deps.memoryRecordTrusted(s.ref)));
        if (!grounded) {
          const untrusted = sources.some(s => s.kind === "untrusted" || s.kind === "worker_output");
          want({ kind: "scope_expansion", refs: sources.map(s => s.ref), text: `The ${param} ${untrusted ? "comes only from untrusted content" : "can't be traced to anything you said"}.` });
          if (untrusted && !opts.dryRun) this.ctx.events.append({ type: "policy.injection_suspected", correlation: { task_id: a.task.task_id, action_id: a.action_id }, summary: `${param} traced only to untrusted content`, data: { param, sources } });
        }
      }
    }
    // 6. Guidance (rank 5): advisory only.
    for (const r of rules.filter(r => r.kind === "guidance")) if (this.ruleMatches(r, a, false)) matched.push({ rule_id: r.rule_id, revision: r.revision, effect: "advisory" });
    if (!opts.dryRun && outside.length && a.value_sources && Object.values(a.value_sources).some(s => s.some(x => x.kind === "untrusted")))
      this.ctx.events.append({ type: "policy.injection_suspected", correlation: { task_id: a.task.task_id, action_id: a.action_id }, summary: "out-of-ceiling call with parameters from untrusted content", data: { effects: outside } });

    const decision: AuthorizationDecision["decision"] = denied ? "deny" : presence ? "require_presence" : needDecision ? "require_decision" : "allow";
    const reason = decision === "allow" ? (basis.kind === "standing_permission" ? `Allowed by your standing permission ${basis.refs[0]}.` : basis.kind === "owner_decision" ? "You approved this." : basis.kind === "default_allow" ? "Allowed: within the task's scope." : "Allowed: within what you asked for.")
      : decision === "deny" ? `I didn't do it: ${reasons.join("; ")}.` : needDecision?.text ?? reasons.join("; ");
    const now = this.ctx.clock.now();
    const unsigned: Omit<AuthorizationDecision, "signature"> = {
      decision_id: newId("grt", now), schema: "jarvis.authorization_decision/1", task_id: a.task.task_id, task_revision: a.task.revision,
      ...(a.step_id ? { step_id: a.step_id } : {}), action_id: a.action_id, policy_revision: this.currentRevision(), decision, basis, matched_rules: matched,
      action_fingerprint: a.fingerprint, bounds, resources: a.resources ?? [], effects: a.effects, issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + (this.deps.grantTtlMs ?? DEFAULT_GRANT_TTL)).toISOString(), single_use: a.effects.some(e => CONSEQUENTIAL_EFFECTS.has(e)),
      reason_for_owner: reason, issuer: { component: "policy_engine", version: POLICY_ENGINE_VERSION },
    };
    const signed = AuthorizationDecision.parse({ ...unsigned, signature: this.sign(unsigned) });
    if (opts.dryRun) return { decision: { ...signed, signature: "dry-run" }, ...(decision === "require_decision" && needDecision ? { decision_request: { why: needDecision } } : {}) };
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into grants(decision_id, action_id, task_id, decision) values (?,?,?,?)").run(signed.decision_id, a.action_id, a.task.task_id, JSON.stringify(signed));
      this.ctx.events.append({ type: "policy.decision", correlation: { task_id: a.task.task_id, action_id: a.action_id }, summary: `${decision}: ${a.capability}`,
        data: { decision_id: signed.decision_id, decision, basis: basis.kind, matched_rules: matched.map(m => m.rule_id), effects: a.effects } });
    });
    return { decision: signed, ...(decision === "require_decision" && needDecision ? { decision_request: { why: needDecision } } : {}) };
  }

  private inScope(a: ActionRequest): boolean {
    const scope = a.task.scope;
    const paths = a.targets.filter(t => "path_prefix" in t);
    if (paths.some(p => scope.exclusions.some(x => resourceMatches(x, p)))) return false;
    // JARVIS's own quarantine areas are in every task's scope for writes: downloads, and the
    // task's own artifact folder. They are never your files (the rest of the artifacts root,
    // e.g. other conversations' attachments, is not included).
    const root = this.deps.artifactsRoot;
    const own = root && a.effects.every(e => !e.startsWith("delete.")) ? [{ path_prefix: join(root, "downloads") }, { path_prefix: join(root, "tasks", a.task.task_id) }] : [];
    const scopePaths = [...scope.resources.filter(r => "path_prefix" in r), ...own];
    if (!paths.length) return true;
    if (!scopePaths.length) return false;
    return paths.every(p => scopePaths.some(s => resourceMatches(s, p)));
  }

  sign(d: Omit<AuthorizationDecision, "signature">): string {
    return hmac(this.ctx.keys.dataKey("grants"), canonicalJson(d));
  }

  /**
   * Dispatch-time check (04 §10.6 moment 2): signature, expiry, single use, task
   * revision, fingerprint, and policy revision (re-evaluated if it changed).
   */
  verifyGrant(grant: AuthorizationDecision, current: { task_revision: number; fingerprint: string }): { ok: true } | { ok: false; code: "expired" | "conflict" | "missing_permission" | "precondition_changed"; reason: string; reevaluate?: boolean } {
    const { signature, ...rest } = grant;
    if (!safeEqualHex(signature, this.sign(rest))) return { ok: false, code: "missing_permission", reason: "grant signature is invalid" };
    if (grant.decision !== "allow") return { ok: false, code: "missing_permission", reason: "not an allow decision" };
    if (grant.expires_at <= this.ctx.clock.iso()) return { ok: false, code: "expired", reason: "grant expired before dispatch" };
    const row = this.ctx.db.prepare("select used from grants where decision_id = ?").get(grant.decision_id) as { used: number } | undefined;
    if (!row) return { ok: false, code: "missing_permission", reason: "unknown grant" };
    if (grant.single_use && row.used) return { ok: false, code: "conflict", reason: "single-use grant already used" };
    if (grant.task_revision !== current.task_revision) return { ok: false, code: "conflict", reason: "task revision changed" };
    if (grant.action_fingerprint !== current.fingerprint) return { ok: false, code: "precondition_changed", reason: "the action changed after authorization", reevaluate: true };
    if (grant.policy_revision !== this.currentRevision()) return { ok: false, code: "conflict", reason: "policy changed since authorization", reevaluate: true };
    return { ok: true };
  }

  markGrantUsed(decisionId: string): void {
    this.ctx.db.prepare("update grants set used = 1 where decision_id = ?").run(decisionId);
  }

  /** Usage is recorded for every standing permission the grant relied on (matched as "bounded"). */
  recordUsage(grant: AuthorizationDecision, amount?: Money): void {
    const ruleIds = [...new Set(grant.matched_rules.filter(m => m.effect === "bounded").map(m => m.rule_id))];
    for (const ruleId of ruleIds)
      this.ctx.db.prepare("insert into rule_usage(rule_id, action_id, amount, currency, at) values (?,?,?,?,?)").run(ruleId, grant.action_id, amount?.amount ?? null, amount?.currency ?? null, this.ctx.clock.iso());
  }

  /** "used 3 times this month, £142 of £300" (04 §10.7). */
  usageSummary(ruleId: string): string {
    const r = this.getRule(ruleId);
    if (!r?.bounds?.per_period) return "";
    const u = this.usage(ruleId, r.bounds.per_period.period);
    const cap = r.bounds.per_period.max_total;
    return `used ${u.count} time(s) this ${r.bounds.per_period.period}${cap ? `, ${u.total} of ${cap.amount} ${cap.currency}` : ""}`;
  }

  // ---------- decision requests (04 §10.7) ----------
  createDecisionRequest(input: { task_id: string; action_ids: string[]; action_fingerprint: string; why: DecisionRequest["why"]; proposal: DecisionRequest["proposal"]; ttlMs?: number; allowRuleDraft?: boolean }): DecisionRequest {
    const expires_at = new Date(this.ctx.clock.now() + (input.ttlMs ?? 24 * 3_600_000)).toISOString();
    const options: DecisionRequest["options"] = [{ id: "approve", label: "Approve", creates: "grant" }, { id: "decline", label: "Don't", creates: "cancel" }];
    if (input.allowRuleDraft) options.push({ id: "always", label: "Always allow things like this…", creates: "rule_draft" });
    const req = DecisionRequest.parse({ decision_request_id: newId("dec", this.ctx.clock.now()), task_id: input.task_id, action_ids: input.action_ids, why: input.why,
      proposal: input.proposal, options, proposal_fingerprint: hashObject({ proposal: input.proposal, action: input.action_fingerprint, actions: input.action_ids }), expires_at });
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into decision_requests(id, task_id, status, request) values (?,?,?,?)").run(req.decision_request_id, req.task_id, "open", JSON.stringify({ ...req, bound_fingerprint: input.action_fingerprint }));
      this.ctx.events.append({ type: "decision.requested", correlation: { task_id: req.task_id }, summary: req.proposal.summary, data: { decision_request_id: req.decision_request_id, why: req.why.kind } });
    });
    return req;
  }

  getDecisionRequest(id: string): (DecisionRequest & { status: string }) | undefined {
    const r = this.ctx.db.prepare("select status, request from decision_requests where id = ?").get(id) as { status: string; request: string } | undefined;
    return r ? { ...DecisionRequest.parse(JSON.parse(r.request)), status: r.status } : undefined;
  }

  /**
   * decision.respond (12 §17.6): must come from an owner channel and carry the exact
   * proposal fingerprint, so an approval binds to exactly what you saw.
   */
  respond(input: { decision_request_id: string; option_id: string; proposal_fingerprint: string; owner_verified: boolean }): { status: "approved" | "declined" | "rule_draft"; request: DecisionRequest } {
    return this.ctx.tx(() => {
      const r = this.getDecisionRequest(input.decision_request_id);
      if (!r) throw new JarvisError("invalid_input", "unknown decision request");
      if (!input.owner_verified) throw new JarvisError("missing_permission", "decisions come only from a verified owner channel");
      if (r.status !== "open") throw new JarvisError("conflict", `decision already ${r.status}`);
      if (r.expires_at <= this.ctx.clock.iso()) { this.ctx.db.prepare("update decision_requests set status = 'expired' where id = ?").run(r.decision_request_id); throw new JarvisError("expired", "this decision request expired"); }
      if (r.proposal_fingerprint !== input.proposal_fingerprint) throw new JarvisError("precondition_changed", "the proposal changed; review the new one");
      const opt = r.options.find(o => o.id === input.option_id);
      if (!opt) throw new JarvisError("invalid_input", "unknown option");
      const status = opt.creates === "grant" || opt.creates === "rule_draft" ? "approved" : "declined";
      this.ctx.db.prepare("update decision_requests set status = ?, option_id = ?, responded_at = ? where id = ?").run(status, opt.id, this.ctx.clock.iso(), r.decision_request_id);
      this.ctx.events.append({ type: "decision.responded", correlation: { task_id: r.task_id }, summary: `${opt.label}`, data: { decision_request_id: r.decision_request_id, option: opt.id, status } });
      return { status: opt.creates === "rule_draft" ? "rule_draft" : status, request: r };
    });
  }

  /** Withdraws an open request nobody should answer any more (its action was abandoned). */
  withdrawDecisionRequest(id: string, reason: string): boolean {
    const n = this.ctx.db.prepare("update decision_requests set status = 'withdrawn', responded_at = ? where id = ? and status = 'open'").run(this.ctx.clock.iso(), id).changes;
    if (n) this.ctx.events.append({ type: "decision.withdrawn", summary: reason.slice(0, 200), data: { decision_request_id: id } });
    return n === 1;
  }

  openDecisionRequests(taskId?: string): DecisionRequest[] {
    const rows = (taskId ? this.ctx.db.prepare("select request from decision_requests where status = 'open' and task_id = ?").all(taskId)
      : this.ctx.db.prepare("select request from decision_requests where status = 'open'").all()) as { request: string }[];
    return rows.map(r => DecisionRequest.parse(JSON.parse(r.request)));
  }
}
