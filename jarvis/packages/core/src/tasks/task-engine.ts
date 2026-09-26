import {
  newId, JarvisError, TaskContract, PlanStep, canTransitionTask, TERMINAL_TASK_STATUSES, MODE_CEILINGS, MODE_FORBIDDEN,
  type TaskStatus, type WaitReason, type EffectClass, type TaskMode,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { applyPatch, type PatchOp } from "./json-patch.js";
import type { ActionService } from "./actions.js";
import type { LeaseManager } from "./leases.js";

export type NewTaskInput = Omit<TaskContract, "task_id" | "root_task_id" | "schema" | "revision" | "created_at" | "updated_at" | "status" | "wait_reason" | "status_detail"> & {
  task_id?: string; root_task_id?: string;
};

export interface CriterionVerdict {
  criterion_id: string;
  status: "verified" | "unmet" | "unverified";
  evidence_ids: string[];
  note?: string;
}

export interface RevisionImpact {
  task_id: string; revision: number;
  invalidated_actions: string[];
  in_flight_actions: string[];
  completed_effects: { action_id: string; capability: string; state: string }[];
  replanned_steps: string[];
}

export interface CancellationReport {
  task_id: string;
  completed_effects: { action_id: string; capability: string; state: string }[];
  cancelled_actions: string[];
  in_flight_actions: string[];
  children_cancelled: string[];
  children_kept: string[];
}

/** Effects a task may ever have: mode ceiling (plus execute's explicit authority), minus forbidden ones (02 §8.3). */
export function effectCeiling(mode: TaskMode, intended: EffectClass[]): Set<EffectClass> {
  const forbidden = new Set(MODE_FORBIDDEN[mode] ?? []);
  const base = mode === "execute" ? intended : MODE_CEILINGS[mode];
  return new Set(base.filter(e => !forbidden.has(e)));
}

/**
 * Task Engine (02 §8): contracts and revisions, the task state machine, plan steps,
 * checkpoints, pause/resume/cancel, and settlement from verifier verdicts.
 */
export class TaskEngine {
  actions!: ActionService;
  leases!: LeaseManager;
  constructor(private ctx: CoreContext) {}

  create(input: NewTaskInput): TaskContract {
    const now = this.ctx.clock.iso();
    const task_id = input.task_id ?? newId("tsk", this.ctx.clock.now());
    const contract = TaskContract.parse({
      ...input, task_id, root_task_id: input.root_task_id ?? task_id, schema: "jarvis.task_contract/1",
      revision: 1, created_at: now, updated_at: now, status: "accepted",
    });
    // intended_effects must be inside the mode's ceiling (02 §8.3)
    const ceiling = effectCeiling(contract.mode, contract.intended_effects);
    const outside = contract.intended_effects.filter(e => !ceiling.has(e));
    if (outside.length) throw new JarvisError("invalid_input", `mode ${contract.mode} cannot carry effects: ${outside.join(", ")}`);
    return this.ctx.tx(() => {
      if (contract.parent_task_id && !this.get(contract.parent_task_id)) throw new JarvisError("invalid_input", "parent task not found");
      this.ctx.db.prepare(`insert into tasks(task_id, root_task_id, parent_task_id, revision, status, wait_reason, mode, conversation_id, contract, created_at, updated_at)
        values (?,?,?,?,?,?,?,?,?,?,?)`).run(task_id, contract.root_task_id, contract.parent_task_id ?? null, 1, "accepted", null, contract.mode,
        contract.origin.conversation_id ?? null, JSON.stringify(contract), now, now);
      this.ctx.db.prepare("insert into task_revisions(task_id, revision, reason, source_message_id, patch, at) values (?,?,?,?,?,?)")
        .run(task_id, 1, "created", contract.origin.message_ids[0] ?? null, "[]", now);
      this.ctx.events.append({ type: "task.created", correlation: { task_id, ...(contract.origin.conversation_id ? { conversation_id: contract.origin.conversation_id } : {}) },
        summary: `Task created (${contract.mode})`, data: { mode: contract.mode, effects: contract.intended_effects, origin: contract.origin.channel } });
      return contract;
    });
  }

  get(taskId: string): TaskContract | undefined {
    const r = this.ctx.db.prepare("select contract from tasks where task_id = ?").get(taskId) as { contract: string } | undefined;
    return r ? TaskContract.parse(JSON.parse(r.contract)) : undefined;
  }

  require(taskId: string): TaskContract {
    const t = this.get(taskId);
    if (!t) throw new JarvisError("invalid_input", `unknown task ${taskId}`);
    return t;
  }

  list(filter: { status?: TaskStatus[]; parent?: string; limit?: number } = {}): TaskContract[] {
    const where: string[] = [], args: unknown[] = [];
    if (filter.status?.length) { where.push(`status in (${filter.status.map(() => "?").join(",")})`); args.push(...filter.status); }
    if (filter.parent) { where.push("parent_task_id = ?"); args.push(filter.parent); }
    const rows = this.ctx.db.prepare(`select contract from tasks ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ?`)
      .all(...args, filter.limit ?? 200) as { contract: string }[];
    return rows.map(r => TaskContract.parse(JSON.parse(r.contract)));
  }

  private save(c: TaskContract): void {
    c.updated_at = this.ctx.clock.iso();
    const closed = TERMINAL_TASK_STATUSES.has(c.status) ? c.updated_at : null;
    this.ctx.db.prepare("update tasks set revision = ?, status = ?, wait_reason = ?, mode = ?, contract = ?, updated_at = ?, closed_at = coalesce(closed_at, ?) where task_id = ?")
      .run(c.revision, c.status, c.wait_reason ?? null, c.mode, JSON.stringify(c), c.updated_at, closed, c.task_id);
  }

  /**
   * State transition with validation. Completion is never set here: only settle()
   * may move a task to completed or partially_completed (02 §8.5, "a model's
   * statement cannot trigger this transition").
   */
  transition(taskId: string, to: TaskStatus, opts: { wait_reason?: WaitReason; detail?: string; initiator: string } = { initiator: "task_engine" }): TaskContract {
    if (to === "completed" || to === "partially_completed") throw new JarvisError("invalid_input", "completion only through settle() with verifier verdicts");
    if (to === "waiting" && !opts.wait_reason) throw new JarvisError("invalid_input", "waiting requires a wait_reason");
    return this.ctx.tx(() => {
      const c = this.require(taskId);
      if (c.status === to && to === "waiting" && c.wait_reason === opts.wait_reason) return c;
      const reasonChange = c.status === "waiting" && to === "waiting";   // e.g. auth resolved, now waiting for quota
      if (!reasonChange && !canTransitionTask(c.status, to)) throw new JarvisError("conflict", `task ${taskId}: ${c.status} -> ${to} is not allowed`);
      const from = c.status;
      c.status = to;
      if (to === "waiting") c.wait_reason = opts.wait_reason; else delete c.wait_reason;
      if (opts.detail) c.status_detail = opts.detail; else delete c.status_detail;
      this.save(c);
      this.ctx.events.append({ type: "task.state_changed", correlation: { task_id: taskId }, summary: `${from} -> ${to}${opts.wait_reason ? ` (${opts.wait_reason})` : ""}`,
        data: { from, to, wait_reason: opts.wait_reason ?? null, initiator: opts.initiator, detail: opts.detail ?? null } });
      return c;
    });
  }

  /** Contract revision: a JSON Patch plus reason (02 §7.9). Computes and applies the impact set. */
  revise(taskId: string, ops: PatchOp[], reason: string, sourceMessageId?: string, opts: { nonImpactingEffects?: EffectClass[] } = {}): RevisionImpact {
    const forbiddenPaths = ["/task_id", "/root_task_id", "/schema", "/revision", "/created_at", "/status", "/wait_reason"];
    for (const op of ops) if (forbiddenPaths.some(p => op.path === p || op.path.startsWith(p + "/")))
      throw new JarvisError("invalid_input", `revision may not change ${op.path}`);
    return this.ctx.tx(() => {
      const before = this.require(taskId);
      if (TERMINAL_TASK_STATUSES.has(before.status)) throw new JarvisError("conflict", `task ${taskId} is closed (${before.status})`);
      const after = TaskContract.parse(applyPatch(before, ops));
      const ceiling = effectCeiling(after.mode, after.intended_effects);
      const outside = after.intended_effects.filter(e => !ceiling.has(e));
      if (outside.length) throw new JarvisError("invalid_input", `mode ${after.mode} cannot carry effects: ${outside.join(", ")}`);
      after.revision = before.revision + 1;
      this.save(after);
      this.ctx.db.prepare("insert into task_revisions(task_id, revision, reason, source_message_id, patch, at) values (?,?,?,?,?,?)")
        .run(taskId, after.revision, reason, sourceMessageId ?? null, JSON.stringify(ops), this.ctx.clock.iso());
      const impact = this.actions.onTaskRevised(after, opts.nonImpactingEffects ?? []);
      // Unstarted steps are replanned: mark them invalidated; the planner produces new ones.
      const replanned: string[] = [];
      for (const s of this.steps(taskId)) {
        if (s.status === "pending" || s.status === "ready") {
          const removedEffect = s.effects.some(e => !ceiling.has(e));
          if (removedEffect || ops.some(o => o.path.startsWith("/scope") || o.path.startsWith("/mode") || o.path.startsWith("/constraints") || o.path.startsWith("/objective"))) {
            this.updateStep(s.step_id, { status: "invalidated" }); replanned.push(s.step_id);
          }
        }
      }
      this.ctx.events.append({ type: "task.revised", correlation: { task_id: taskId }, summary: `Revision ${after.revision}: ${reason}`,
        data: { revision: after.revision, paths: ops.map(o => o.path), invalidated_actions: impact.invalidated, replanned_steps: replanned } });
      return { task_id: taskId, revision: after.revision, invalidated_actions: impact.invalidated, in_flight_actions: impact.inFlight,
        completed_effects: impact.completed, replanned_steps: replanned };
    });
  }

  // ---- plan steps ----
  setPlan(taskId: string, steps: Omit<PlanStep, "task_id" | "task_revision" | "status" | "attempts" | "outputs">[]): PlanStep[] {
    return this.ctx.tx(() => {
      const c = this.require(taskId);
      const ceiling = effectCeiling(c.mode, c.intended_effects);
      const ids = new Set(steps.map(s => s.step_id));
      for (const s of steps) {
        const bad = s.effects.filter(e => !ceiling.has(e));
        if (bad.length) throw new JarvisError("missing_permission", `step "${s.description}" has effects outside the task ceiling: ${bad.join(", ")}`);
        for (const d of s.depends_on) if (!ids.has(d) && !this.getStep(d)) throw new JarvisError("invalid_input", `step ${s.step_id} depends on unknown step ${d}`);
      }
      if (hasCycle(steps)) throw new JarvisError("invalid_input", "plan has a dependency cycle");
      const existing = (this.ctx.db.prepare("select coalesce(max(ordinal), 0) m from plan_steps where task_id = ?").get(taskId) as { m: number }).m;
      const out: PlanStep[] = [];
      steps.forEach((s, i) => {
        const step = PlanStep.parse({ ...s, task_id: taskId, task_revision: c.revision, status: "pending", attempts: 0, outputs: [] });
        this.ctx.db.prepare("insert into plan_steps(step_id, task_id, ordinal, status, step) values (?,?,?,?,?)")
          .run(step.step_id, taskId, existing + i + 1, step.status, JSON.stringify(step));
        out.push(step);
      });
      this.ctx.events.append({ type: "task.plan_set", correlation: { task_id: taskId }, summary: `${out.length} plan steps`, data: { steps: out.map(s => ({ id: s.step_id, kind: s.kind, capability: s.capability ?? null })) } });
      return out;
    });
  }

  steps(taskId: string): PlanStep[] {
    return (this.ctx.db.prepare("select step from plan_steps where task_id = ? order by ordinal").all(taskId) as { step: string }[])
      .map(r => PlanStep.parse(JSON.parse(r.step)));
  }

  getStep(stepId: string): PlanStep | undefined {
    const r = this.ctx.db.prepare("select step from plan_steps where step_id = ?").get(stepId) as { step: string } | undefined;
    return r ? PlanStep.parse(JSON.parse(r.step)) : undefined;
  }

  updateStep(stepId: string, patch: Partial<Pick<PlanStep, "status" | "attempts" | "outputs" | "checkpoint_ref" | "capability" | "params">>): PlanStep {
    return this.ctx.tx(() => {
      const s = this.getStep(stepId);
      if (!s) throw new JarvisError("invalid_input", `unknown step ${stepId}`);
      const next = PlanStep.parse({ ...s, ...patch });
      this.ctx.db.prepare("update plan_steps set status = ?, step = ? where step_id = ?").run(next.status, JSON.stringify(next), stepId);
      if (patch.status && patch.status !== s.status)
        this.ctx.events.append({ type: "step.state_changed", correlation: { task_id: s.task_id, step_id: stepId }, summary: `${s.status} -> ${next.status}`, data: { from: s.status, to: next.status } });
      return next;
    });
  }

  /** Steps whose dependencies are all done or skipped, and that are not started. */
  readySteps(taskId: string): PlanStep[] {
    const steps = this.steps(taskId).filter(s => s.status !== "invalidated");
    const done = new Set(steps.filter(s => s.status === "done" || s.status === "skipped").map(s => s.step_id));
    return steps.filter(s => (s.status === "pending" || s.status === "ready") && s.depends_on.every(d => done.has(d)));
  }

  /** All live steps settled: done, skipped, or failed (02 §8.5 running → verifying). */
  allStepsSettled(taskId: string): boolean {
    return this.steps(taskId).filter(s => s.status !== "invalidated").every(s => ["done", "skipped", "failed"].includes(s.status));
  }

  // ---- checkpoints (02 §8.6) ----
  checkpoint(taskId: string, extra: Record<string, unknown> = {}): string {
    return this.ctx.tx(() => {
      const c = this.require(taskId);
      const id = newId("ckp", this.ctx.clock.now());
      const data = {
        task_revision: c.revision, status: c.status,
        steps: this.steps(taskId).map(s => ({ step_id: s.step_id, status: s.status, attempts: s.attempts, outputs: s.outputs })),
        leases: this.leases ? this.leases.heldBy(taskId).map(l => l.lease_id) : [],
        ...extra,
      };
      this.ctx.db.prepare("insert into checkpoints(checkpoint_id, task_id, at, data) values (?,?,?,?)").run(id, taskId, this.ctx.clock.iso(), JSON.stringify(data));
      return id;
    });
  }

  lastCheckpoint(taskId: string): { checkpoint_id: string; at: string; data: Record<string, unknown> } | undefined {
    const r = this.ctx.db.prepare("select checkpoint_id, at, data from checkpoints where task_id = ? order by at desc, rowid desc limit 1").get(taskId) as
      { checkpoint_id: string; at: string; data: string } | undefined;
    return r ? { checkpoint_id: r.checkpoint_id, at: r.at, data: JSON.parse(r.data) } : undefined;
  }

  // ---- control (02 §8.9) ----
  pause(taskId: string): TaskContract {
    return this.ctx.tx(() => {
      const c = this.transition(taskId, "paused", { initiator: "owner", detail: "Paused. Nothing new will happen. Resume or cancel." });
      this.leases?.releaseForTask(taskId, { only: r => r.startsWith("desktop:") });
      return c;
    });
  }

  /** Paused tasks keep non-desktop leases up to a maximum pause duration, then release them (02 §8.9). */
  releaseLongPausedLeases(maxPauseMs: number): string[] {
    const released: string[] = [];
    for (const t of this.list({ status: ["paused"] })) {
      const since = Date.parse(t.updated_at);
      if (this.ctx.clock.now() - since >= maxPauseMs && this.leases.heldBy(t.task_id).length) {
        this.leases.releaseForTask(t.task_id); released.push(t.task_id);
      }
    }
    return released;
  }

  resume(taskId: string): TaskContract {
    return this.transition(taskId, "running", { initiator: "owner", detail: "Resumed; re-observing before the next step" });
  }

  cancel(taskId: string, opts: { children?: "cancel" | "keep" } = {}): CancellationReport {
    return this.ctx.tx(() => {
      const c = this.require(taskId);
      if (TERMINAL_TASK_STATUSES.has(c.status)) throw new JarvisError("conflict", `task ${taskId} is already ${c.status}`);
      const childMode = opts.children ?? c.cancellation.children;
      const report: CancellationReport = { task_id: taskId, completed_effects: [], cancelled_actions: [], in_flight_actions: [], children_cancelled: [], children_kept: [] };
      for (const child of this.list({ parent: taskId })) {
        if (TERMINAL_TASK_STATUSES.has(child.status)) continue;
        if (childMode === "cancel") { this.cancel(child.task_id, { children: "cancel" }); report.children_cancelled.push(child.task_id); }
        else report.children_kept.push(child.task_id);
      }
      const a = this.actions.onTaskCancelled(taskId);
      report.cancelled_actions = a.cancelled; report.in_flight_actions = a.inFlight; report.completed_effects = a.completed;
      for (const s of this.steps(taskId)) if (s.status === "pending" || s.status === "ready" || s.status === "waiting") this.updateStep(s.step_id, { status: "skipped" });
      this.leases?.releaseForTask(taskId);
      this.transition(taskId, "cancelled", { initiator: "owner" });
      this.ctx.events.append({ type: "task.cancelled", correlation: { task_id: taskId }, summary: `Cancelled; ${report.completed_effects.length} completed effect(s) listed`, data: { ...report } });
      return report;
    });
  }

  /**
   * verifying → completed | partially_completed (02 §8.5). Completed only if every
   * required criterion has a "verified" verdict backed by evidence.
   */
  settle(taskId: string, verdicts: CriterionVerdict[]): TaskContract {
    return this.ctx.tx(() => {
      const c = this.require(taskId);
      if (c.status !== "verifying") throw new JarvisError("conflict", `settle requires verifying, task is ${c.status}`);
      const byId = new Map(verdicts.map(v => [v.criterion_id, v]));
      const required = c.success_criteria.filter(sc => sc.required);
      const isVerified = (id: string) => { const v = byId.get(id); return v?.status === "verified" && v.evidence_ids.length > 0; };
      const ok = required.every(sc => isVerified(sc.id));
      const to: TaskStatus = ok && required.length > 0 ? "completed" : "partially_completed";
      const from = c.status;
      c.status = to; delete c.wait_reason;
      c.status_detail = to === "completed" ? "All required criteria verified" :
        required.length === 0 ? "No success criteria were defined, so nothing could be verified" :
        `Unverified or unmet: ${required.filter(sc => !isVerified(sc.id)).map(sc => sc.description).join("; ")}`;
      this.save(c);
      this.ctx.events.append({ type: "task.state_changed", correlation: { task_id: taskId }, summary: `${from} -> ${to}`,
        data: { from, to, initiator: "verifier", verdicts: verdicts.map(v => ({ id: v.criterion_id, status: v.status, evidence: v.evidence_ids })) } });
      return c;
    });
  }
}

function hasCycle(steps: { step_id: string; depends_on: string[] }[]): boolean {
  const deps = new Map(steps.map(s => [s.step_id, s.depends_on]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const st = state.get(id);
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some(s => visit(s.step_id));
}
