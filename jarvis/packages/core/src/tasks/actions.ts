import {
  newId, hashObject, canonicalJson, JarvisError, canTransitionAction, PRE_DISPATCH_ACTION_STATES,
  type ActionState, type EffectClass, type TaskContract,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { effectCeiling } from "./task-engine.js";

export interface ActionRecord {
  action_id: string; task_id: string; step_id: string | null; capability: string; state: ActionState;
  effects: EffectClass[]; params_ref: string | null; resolved_params_ref: string | null; fingerprint: string | null;
  idempotency_key: string; reconciliation_key: string | null; preview: string | null;
  decision_request_id: string | null; grant_id: string | null; task_revision: number; policy_revision: number | null;
  reason: string | null; compensates_action_id: string | null; created_at: string; updated_at: string;
}

export interface Attempt { attempt_id: string; action_id: string; n: number; idempotency_key: string; state: string; sent_at: string; response: unknown }

/** States in which the effect may exist in the world. */
const EFFECT_POSSIBLE: ReadonlySet<ActionState> = new Set<ActionState>(["dispatched", "acknowledged", "uncertain"]);
const EFFECT_DONE: ReadonlySet<ActionState> = new Set<ActionState>(["effect_observed", "verified", "verification_failed", "compensating", "compensated", "compensation_failed"]);

/** action_fingerprint = sha256(capability id@version + resolved params + targets + account) (04 §10.6). */
export function actionFingerprint(capability: string, resolvedParams: unknown, targets: unknown = null, account: string | null = null): string {
  return hashObject({ capability, params: resolvedParams, targets, account });
}

/**
 * External action lifecycle (02 §8.7). The write-ahead rule: dispatch() commits
 * the attempt and the `dispatched` state BEFORE the caller sends anything, so a
 * crash after sending cannot hide the action.
 */
export class ActionService {
  constructor(private ctx: CoreContext) {}

  private row(actionId: string): ActionRecord {
    const r = this.ctx.db.prepare("select * from actions where action_id = ?").get(actionId) as Record<string, unknown> | undefined;
    if (!r) throw new JarvisError("invalid_input", `unknown action ${actionId}`);
    const { resolved_params, ...rest } = r;
    return { ...(rest as unknown as ActionRecord), effects: JSON.parse(r.effects as string), resolved_params_ref: (resolved_params as string | null) ?? null };
  }
  get(actionId: string): ActionRecord { return this.row(actionId); }

  list(filter: { taskId?: string; states?: ActionState[] } = {}): ActionRecord[] {
    const where: string[] = [], args: unknown[] = [];
    if (filter.taskId) { where.push("task_id = ?"); args.push(filter.taskId); }
    if (filter.states?.length) { where.push(`state in (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
    return (this.ctx.db.prepare(`select action_id from actions ${where.length ? "where " + where.join(" and ") : ""} order by created_at, rowid`).all(...args) as { action_id: string }[])
      .map(r => this.row(r.action_id));
  }

  private move(actionId: string, to: ActionState, reason: string, patch: Record<string, unknown> = {}): ActionRecord {
    return this.ctx.tx(() => {
      const a = this.row(actionId);
      if (!canTransitionAction(a.state, to)) throw new JarvisError("conflict", `action ${actionId}: ${a.state} -> ${to} is not allowed`);
      const sets = ["state = @to", "updated_at = @now", "reason = @reason", ...Object.keys(patch).map(k => `${k} = @${k}`)];
      this.ctx.db.prepare(`update actions set ${sets.join(", ")} where action_id = @id`).run({ to, now: this.ctx.clock.iso(), reason, id: actionId, ...patch });
      this.ctx.events.append({ type: "action.state_changed", correlation: { task_id: a.task_id, action_id: actionId, ...(a.step_id ? { step_id: a.step_id } : {}) },
        summary: `${a.capability}: ${a.state} -> ${to}`, data: { from: a.state, to, reason, capability: a.capability } });
      return this.row(actionId);
    });
  }

  propose(input: { task_id: string; step_id?: string; capability: string; effects: EffectClass[]; params: unknown; requested_by: string; compensates_action_id?: string }): ActionRecord {
    return this.ctx.tx(() => {
      const task = this.ctx.db.prepare("select revision from tasks where task_id = ?").get(input.task_id) as { revision: number } | undefined;
      if (!task) throw new JarvisError("invalid_input", `unknown task ${input.task_id}`);
      if (input.effects.length === 0) throw new JarvisError("invalid_input", "an action must declare its effect classes");
      const action_id = newId("act", this.ctx.clock.now());
      const { payload_id } = this.ctx.payloads.put(canonicalJson(input.params ?? null), "personal");
      const now = this.ctx.clock.iso();
      this.ctx.db.prepare(`insert into actions(action_id, task_id, step_id, capability, state, effects, params_ref, idempotency_key, task_revision, compensates_action_id, created_at, updated_at, reason)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(action_id, input.task_id, input.step_id ?? null, input.capability, "proposed", JSON.stringify(input.effects),
        payload_id, `idk_${action_id}`, task.revision, input.compensates_action_id ?? null, now, now, `proposed by ${input.requested_by}`);
      this.ctx.events.append({ type: "action.proposed", correlation: { task_id: input.task_id, action_id, ...(input.step_id ? { step_id: input.step_id } : {}) },
        summary: `${input.capability} proposed`, data: { capability: input.capability, effects: input.effects, requested_by: input.requested_by, params_ref: payload_id } });
      return this.row(action_id);
    });
  }

  rawParams(actionId: string): unknown {
    const a = this.row(actionId);
    return a.params_ref ? JSON.parse(this.ctx.payloads.getText(a.params_ref)) : null;
  }

  /** Resolved parameters are SENSITIVE: stored encrypted in the payload store; the column holds only the reference. */
  prepare(actionId: string, p: { resolved_params: unknown; preview: string; fingerprint: string; reconciliation_key?: string }): ActionRecord {
    return this.ctx.tx(() => {
      const { payload_id } = this.ctx.payloads.put(canonicalJson(p.resolved_params ?? null), "personal");
      return this.move(actionId, "prepared", "parameters resolved, preconditions checked", {
        resolved_params: payload_id, preview: p.preview, fingerprint: p.fingerprint, reconciliation_key: p.reconciliation_key ?? null,
      });
    });
  }

  resolvedParams(actionId: string): unknown {
    const a = this.row(actionId);
    return a.resolved_params_ref ? JSON.parse(this.ctx.payloads.getText(a.resolved_params_ref)) : null;
  }

  /**
   * 02 §8.7 rule 3: a consequential action may be tried again only after
   * reconciliation proved `failed_no_effect`. The retry is a NEW action with the
   * same reconciliation key; it needs its own preparation and authorization.
   */
  retryAfterNoEffect(actionId: string, requestedBy: string): ActionRecord {
    return this.ctx.tx(() => {
      const a = this.row(actionId);
      if (a.state !== "failed_no_effect") throw new JarvisError("conflict", `retry needs failed_no_effect proven; action is ${a.state}`);
      const next = this.propose({ task_id: a.task_id, ...(a.step_id ? { step_id: a.step_id } : {}), capability: a.capability, effects: a.effects, params: this.rawParams(actionId), requested_by: requestedBy });
      this.ctx.db.prepare("update actions set reconciliation_key = ? where action_id = ?").run(a.reconciliation_key, next.action_id);
      this.ctx.events.append({ type: "action.retry_created", correlation: { task_id: a.task_id, action_id: next.action_id }, summary: `retry of ${actionId} after proven no effect`, data: { previous_action_id: actionId } });
      return this.row(next.action_id);
    });
  }
  awaitDecision(actionId: string, decisionRequestId: string): ActionRecord {
    return this.move(actionId, "awaiting_decision", "policy requires an owner decision", { decision_request_id: decisionRequestId });
  }
  authorize(actionId: string, grantId: string, policyRevision: number): ActionRecord {
    return this.move(actionId, "authorized", "grant bound", { grant_id: grantId, policy_revision: policyRevision });
  }
  deny(actionId: string, reason: string): ActionRecord { return this.move(actionId, "denied", reason); }
  expire(actionId: string, reason = "grant or decision expired before dispatch"): ActionRecord { return this.move(actionId, "expired", reason); }
  invalidate(actionId: string, reason: string): ActionRecord { return this.move(actionId, "invalidated", reason); }
  cancel(actionId: string, reason = "task cancelled"): ActionRecord { return this.move(actionId, "cancelled", reason); }

  /**
   * Write-ahead dispatch. Checks the task revision is still the one the action
   * was authorized under (fencing), records the attempt, sets `dispatched`, commits.
   * Only then may the caller send.
   */
  dispatch(actionId: string): Attempt {
    // The stale-revision invalidation must commit even though dispatch then fails,
    // so the check returns a marker and the error is thrown after the transaction.
    const r = this.ctx.tx((): Attempt | { stale: string } => {
      const a = this.row(actionId);
      if (a.state !== "authorized") throw new JarvisError("conflict", `action ${actionId} is ${a.state}, not authorized`);
      const task = this.ctx.db.prepare("select revision, status from tasks where task_id = ?").get(a.task_id) as { revision: number; status: string };
      if (task.revision !== a.task_revision) {
        this.move(actionId, "invalidated", `task revision changed (${a.task_revision} -> ${task.revision})`);
        return { stale: `stale task revision for ${actionId} (${a.task_revision} -> ${task.revision})` };
      }
      if (task.status !== "running") throw new JarvisError("conflict", `task is ${task.status}; nothing is dispatched unless it is running`);
      const n = ((this.ctx.db.prepare("select coalesce(max(n), 0) n from action_attempts where action_id = ?").get(actionId) as { n: number }).n) + 1;
      const attempt: Attempt = { attempt_id: newId("att", this.ctx.clock.now()), action_id: actionId, n, idempotency_key: a.idempotency_key, state: "dispatched", sent_at: this.ctx.clock.iso(), response: null };
      this.ctx.db.prepare("insert into action_attempts(attempt_id, action_id, n, idempotency_key, state, sent_at) values (?,?,?,?,?,?)")
        .run(attempt.attempt_id, actionId, n, attempt.idempotency_key, "dispatched", attempt.sent_at);
      this.move(actionId, "dispatched", `attempt ${n} committed write-ahead`);
      return attempt;
    });
    if ("stale" in r) throw new JarvisError("conflict", r.stale);
    return r;
  }

  private attemptState(actionId: string, state: string, response?: unknown): void {
    this.ctx.db.prepare("update action_attempts set state = ?, response = coalesce(?, response) where action_id = ? and n = (select max(n) from action_attempts where action_id = ?)")
      .run(state, response === undefined ? null : JSON.stringify(response), actionId, actionId);
  }

  acknowledge(actionId: string, response: unknown): ActionRecord {
    return this.ctx.tx(() => { this.attemptState(actionId, "acknowledged", response); return this.move(actionId, "acknowledged", "executor accepted"); });
  }
  markUncertain(actionId: string, reason: string): ActionRecord {
    return this.ctx.tx(() => { this.attemptState(actionId, "uncertain"); return this.move(actionId, "uncertain", reason); });
  }
  failNoEffect(actionId: string, reason: string, response?: unknown): ActionRecord {
    return this.ctx.tx(() => { this.attemptState(actionId, "failed_no_effect", response); return this.move(actionId, "failed_no_effect", reason); });
  }
  observeEffect(actionId: string, evidenceIds: string[]): ActionRecord {
    if (evidenceIds.length === 0) throw new JarvisError("invalid_input", "an observed effect needs evidence");
    return this.ctx.tx(() => { this.attemptState(actionId, "effect_observed"); return this.move(actionId, "effect_observed", `evidence: ${evidenceIds.join(", ")}`); });
  }
  verify(actionId: string, matches: boolean, detail: string): ActionRecord {
    return this.move(actionId, matches ? "verified" : "verification_failed", detail);
  }
  startCompensation(actionId: string, compensatingActionId: string): ActionRecord {
    return this.move(actionId, "compensating", `compensating action ${compensatingActionId}`);
  }
  finishCompensation(actionId: string, ok: boolean, detail: string): ActionRecord {
    return this.move(actionId, ok ? "compensated" : "compensation_failed", detail);
  }

  attempts(actionId: string): Attempt[] {
    return (this.ctx.db.prepare("select * from action_attempts where action_id = ? order by n").all(actionId) as (Omit<Attempt, "response"> & { response: string | null })[])
      .map(r => ({ ...r, response: r.response ? JSON.parse(r.response) : null }));
  }

  private summarize(taskId: string) {
    const all = this.list({ taskId });
    return {
      pre: all.filter(a => PRE_DISPATCH_ACTION_STATES.has(a.state)),
      inFlight: all.filter(a => EFFECT_POSSIBLE.has(a.state)).map(a => a.action_id),
      completed: all.filter(a => EFFECT_DONE.has(a.state)).map(a => ({ action_id: a.action_id, capability: a.capability, state: a.state })),
    };
  }

  /** 02 §7.9 step 3: pre-dispatch actions are invalidated unless the revision declares their effects non-impacting and they stay in the ceiling. */
  onTaskRevised(task: TaskContract, nonImpacting: EffectClass[]): { invalidated: string[]; inFlight: string[]; completed: { action_id: string; capability: string; state: string }[] } {
    const s = this.summarize(task.task_id);
    const ceiling = effectCeiling(task.mode, task.intended_effects);
    const safe = new Set(nonImpacting);
    const invalidated: string[] = [];
    for (const a of s.pre) {
      const staysInCeiling = a.effects.every(e => ceiling.has(e));
      if (staysInCeiling && a.effects.every(e => safe.has(e))) {
        this.ctx.db.prepare("update actions set task_revision = ? where action_id = ?").run(task.revision, a.action_id);
        continue;
      }
      this.invalidate(a.action_id, `task revision ${task.revision}`);
      invalidated.push(a.action_id);
    }
    return { invalidated, inFlight: s.inFlight, completed: s.completed };
  }

  onTaskCancelled(taskId: string): { cancelled: string[]; inFlight: string[]; completed: { action_id: string; capability: string; state: string }[] } {
    const s = this.summarize(taskId);
    for (const a of s.pre) this.cancel(a.action_id);
    return { cancelled: s.pre.map(a => a.action_id), inFlight: s.inFlight, completed: s.completed };
  }
}
