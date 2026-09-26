import { type StructuredError, JarvisError, RETRY_POLICY, backoffMs, TERMINAL_TASK_STATUSES, type PlanStep, type TaskContract, type ToolResult } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { TaskEngine, CriterionVerdict } from "../tasks/task-engine.js";
import type { ActionService } from "../tasks/actions.js";
import type { LeaseManager } from "../tasks/leases.js";
import type { Broker, BrokerOutcome } from "../broker/broker.js";
import type { Verifier, EvidenceStore } from "../verifier/verifier.js";
import type { EpisodicStore } from "../memory/episodic.js";

export interface StepHandlers {
  /** "reason" steps: a bounded agent loop (the Agent Worker); returns evidence ids for the step. */
  reason?(task: TaskContract, step: PlanStep): Promise<{ evidence_ids: string[]; text: string }>;
  /** Gap Resolver hook for unsupported_operation (wired in Phase 8). */
  /** "waiting_subtask": a build (or other resolution) is under way; the task waits for it (07 §12.15). */
  onGap?(task: TaskContract, step: PlanStep, error: string, failure?: StructuredError): Promise<"blocked" | "resolved" | "waiting_subtask">;
  /** worker / skill steps (wired in Phases 8 and 10). */
  runWorker?(task: TaskContract, step: PlanStep): Promise<{ ok: boolean; evidence_ids: string[]; error?: string }>;
  sleep?(ms: number): Promise<void>;
}

/**
 * Step Controller (02 §7.3 task loop): ready steps → leases → Broker → results,
 * retries by error class (02 §8.8), typed waits, checkpoints after every step,
 * and settlement from verifier verdicts. Deterministic; models only in "reason" steps.
 */
export class StepController {
  constructor(private ctx: CoreContext, private tasks: TaskEngine, private actions: ActionService, private leases: LeaseManager, private broker: Broker,
    private verifier: Verifier, private evidence: EvidenceStore, private episodic: EpisodicStore, private h: StepHandlers = {}) {}

  private criteriaFor(step: PlanStep): string[] {
    return (this.episodic.getWorkingState(step.task_id, `criteria:${step.step_id}`) as string[] | undefined) ?? [];
  }

  /** Runs a task until it settles or has to wait. Safe to call again after any wait clears. */
  async run(taskId: string): Promise<TaskContract> {
    for (let guard = 0; guard < 500; guard++) {
      const task = this.tasks.require(taskId);
      if (task.status === "planned") this.tasks.transition(taskId, "running", { initiator: "step_controller" });
      const t = this.tasks.require(taskId);
      if (t.status !== "running") return t;
      if (this.broker.isHalted()) { this.tasks.pause(taskId); return this.tasks.require(taskId); }
      const ready = this.tasks.readySteps(taskId);
      if (!ready.length) {
        if (this.tasks.allStepsSettled(taskId)) return this.verifyAndSettle(taskId);
        return t;       // waiting steps: resumed by their events
      }
      const step = ready[0]!;
      const cont = await this.runStep(t, step);
      this.tasks.checkpoint(taskId, { last_step: step.step_id });
      if (!cont) return this.tasks.require(taskId);
    }
    throw new JarvisError("internal_error", "step controller did not converge");
  }

  /** Returns true to keep looping, false when the task now waits. */
  private async runStep(task: TaskContract, step: PlanStep): Promise<boolean> {
    this.tasks.updateStep(step.step_id, { status: "running", attempts: step.attempts + 1 });
    switch (step.kind) {
      case "tool": return this.runTool(task, step);
      case "verify": {
        const v = this.verifier.checkCriteria(task).filter(x => this.criteriaFor(step).length === 0 || this.criteriaFor(step).includes(x.criterion_id));
        this.tasks.updateStep(step.step_id, { status: v.every(x => x.status === "verified") ? "done" : "failed", outputs: v.flatMap(x => x.evidence_ids) });
        return true;
      }
      case "reason": {
        if (!this.h.reason) { this.tasks.updateStep(step.step_id, { status: "failed" }); return true; }
        try {
          const r = await this.h.reason(task, step);
          this.tasks.updateStep(step.step_id, { status: "done", outputs: r.evidence_ids });
        } catch (e) {
          const code = e instanceof JarvisError ? e.code : "internal_error";
          return this.waitOrFail(task, step, code, (e as Error).message, e instanceof JarvisError ? e.structured : undefined);
        }
        return true;
      }
      case "ask_owner":
        this.tasks.updateStep(step.step_id, { status: "waiting" });
        this.tasks.transition(task.task_id, "waiting", { wait_reason: "owner", initiator: "step_controller", detail: step.description });
        return false;
      case "wait":
        this.tasks.updateStep(step.step_id, { status: "waiting" });
        this.tasks.transition(task.task_id, "waiting", { wait_reason: "until", initiator: "step_controller", detail: step.description });
        return false;
      case "worker": case "skill": {
        if (!this.h.runWorker) return this.gap(task, step, `${step.kind} steps are not available yet`);
        const r = await this.h.runWorker(task, step);
        this.tasks.updateStep(step.step_id, { status: r.ok ? "done" : "failed", outputs: r.evidence_ids });
        return true;
      }
    }
  }

  private async runTool(task: TaskContract, step: PlanStep): Promise<boolean> {
    if (step.capability?.startsWith("gap:")) return this.gap(task, step, `This step needs a capability that doesn't exist yet: ${step.description}`);
    // Leases for declared resources (02 §7.8): an exclusive holder elsewhere means waiting_for_resource.
    const held = [];
    for (const r of step.resources) {
      const l = this.leases.acquire(r, r.startsWith("desktop:observe") ? "shared_read" : "exclusive", { task_id: task.task_id });
      if (!l.granted) {
        this.tasks.updateStep(step.step_id, { status: "ready" });
        this.tasks.transition(task.task_id, "waiting", { wait_reason: "resource", initiator: "lease_manager", detail: `Waiting for ${r} (position ${l.queue_position})` });
        return false;
      }
      held.push(l.lease);
    }
    const params = (step.params ?? {}) as Record<string, unknown>;
    const out = await this.broker.execute({ task_id: task.task_id, step_id: step.step_id, capability: step.capability!, params, requested_by: { kind: "boss", ref: task.task_id },
      criteria: this.criteriaFor(step), ...(held[0] ? { lease: { resource: held[0].resource, lease_id: held[0].lease_id, fencing_token: held[0].fencing_token } } : {}) });
    return this.applyOutcome(task, step, out);
  }

  /** Applies a Broker outcome to its step (also used after an owner decision). */
  async applyOutcome(task: TaskContract, step: PlanStep, out: BrokerOutcome | { status: "declined"; action_ids: string[] }): Promise<boolean> {
    switch (out.status) {
      case "done":
        this.tasks.updateStep(step.step_id, { status: "done", outputs: out.result.evidence.map(e => e.evidence_id) });
        return true;
      case "waiting_decision":
        this.tasks.updateStep(step.step_id, { status: "waiting" });
        return false;
      case "declined":
        this.tasks.updateStep(step.step_id, { status: "skipped" });
        return true;
      case "uncertain":
        this.tasks.updateStep(step.step_id, { status: "waiting" });
        this.tasks.transition(task.task_id, "waiting", { wait_reason: "subtask", initiator: "broker", detail: "Checking whether an action took effect before doing anything else" });
        return false;
      case "denied":
        this.tasks.updateStep(step.step_id, { status: "failed" });
        this.ctx.events.append({ type: "step.denied", correlation: { task_id: task.task_id, step_id: step.step_id }, summary: out.result.error?.message ?? "denied", data: {} });
        return true;
      case "error":
        return this.onError(task, step, out.result);
    }
  }

  private async onError(task: TaskContract, step: PlanStep, r: ToolResult): Promise<boolean> {
    const code = r.error?.code ?? "internal_error";
    const rule = RETRY_POLICY[code];
    const readOnly = step.effects.every(e => e.startsWith("read.") || e === "notify_owner");
    const attempts = this.tasks.getStep(step.step_id)!.attempts;
    const retryable = (rule.retry === "if_safe" && (readOnly || r.effect_state === "none")) || rule.retry === "once" || rule.retry === "reacquire" || (rule.retry === "classify" && readOnly);
    if (retryable && attempts <= rule.max_retries) {
      await (this.h.sleep ?? (ms => new Promise(res => setTimeout(res, ms))))(backoffMs(rule, attempts));
      this.tasks.updateStep(step.step_id, { status: "ready" });
      return true;
    }
    const detail = code === "rate_limited" && r.error?.retry_after_s ? `${r.error.message} (resets in about ${Math.ceil(r.error.retry_after_s / 60)} min)` : r.error?.message ?? code;
    return this.waitOrFail(task, step, code, detail, r.error);
  }

  private async waitOrFail(task: TaskContract, step: PlanStep, code: string, message: string, failure?: StructuredError): Promise<boolean> {
    const wait = code === "auth_required" || code === "missing_credential" ? "auth" : code === "unavailable_device" ? "device" : code === "rate_limited" ? "quota" : null;
    if (wait) {
      this.tasks.updateStep(step.step_id, { status: "ready" });
      this.tasks.transition(task.task_id, "waiting", { wait_reason: wait, initiator: "step_controller", detail: message });
      return false;
    }
    if (code === "unsupported_operation") return this.gap(task, step, message, failure);
    if (code === "precondition_changed") {
      // Out of bounds at the pre-commit re-read (04 §10.6): stop and ask, never proceed or silently fail.
      this.tasks.updateStep(step.step_id, { status: "ready" });
      this.tasks.transition(task.task_id, "waiting", { wait_reason: "owner", initiator: "broker", detail: `${message}. Proceed with a new limit, or stop?` });
      return false;
    }
    if (code === "transient_service_error" && step.kind === "reason") {
      this.tasks.updateStep(step.step_id, { status: "ready" });
      this.tasks.transition(task.task_id, "waiting", { wait_reason: "device", initiator: "model_gateway", detail: "Waiting for network: the model provider can't be reached" });
      return false;
    }
    if (code === "budget_exhausted") {
      this.tasks.updateStep(step.step_id, { status: "ready" });
      this.tasks.transition(task.task_id, "waiting", { wait_reason: "owner", initiator: "model_gateway", detail: `Budget reached: ${message}. Raise the cap, or stop here?` });
      return false;
    }
    this.tasks.updateStep(step.step_id, { status: "failed" });
    this.ctx.events.append({ type: "step.failed", correlation: { task_id: task.task_id, step_id: step.step_id }, summary: `${code}: ${message}`.slice(0, 300), data: { code } });
    return true;
  }

  private async gap(task: TaskContract, step: PlanStep, message: string, failure?: StructuredError): Promise<boolean> {
    const r = this.h.onGap ? await this.h.onGap(task, step, message, failure) : "blocked";
    if (r === "resolved") { this.tasks.updateStep(step.step_id, { status: "ready" }); return true; }
    if (r === "waiting_subtask") {
      this.tasks.updateStep(step.step_id, { status: "ready" });
      if (this.tasks.require(task.task_id).status === "running") this.tasks.transition(task.task_id, "waiting", { wait_reason: "subtask", initiator: "gap_resolver", detail: message });
      return false;
    }
    this.tasks.updateStep(step.step_id, { status: "ready" });
    this.tasks.transition(task.task_id, "blocked", { initiator: "gap_resolver", detail: message });
    return false;
  }

  /** running → verifying → settle (02 §8.5). Returns the settled task. */
  verifyAndSettle(taskId: string): TaskContract {
    const t = this.tasks.require(taskId);
    if (t.status !== "running") return t;
    this.tasks.transition(taskId, "verifying", { initiator: "step_controller" });
    const verdicts: CriterionVerdict[] = this.verifier.checkCriteria(this.tasks.require(taskId));
    const settled = this.tasks.settle(taskId, verdicts);
    this.episodic.clearWorkingState(taskId);
    return settled;
  }

  /** Owner decision arrived: dispatch through the Broker, apply to the step, continue. */
  async onDecision(decisionRequestId: string, optionId: string, fingerprint: string, ownerVerified: boolean): Promise<TaskContract> {
    const out = await this.broker.onDecision(decisionRequestId, optionId, fingerprint, ownerVerified);
    const actionId = "action_id" in out ? out.action_id : out.status === "declined" ? out.action_ids[0] : undefined;
    const a = actionId ? this.actions.get(actionId) : undefined;
    const step = a?.step_id ? this.tasks.getStep(a.step_id) : undefined;
    const task = this.tasks.require(a?.task_id ?? "");
    if (step) await this.applyOutcome(task, step, out);
    return TERMINAL_TASK_STATUSES.has(task.status) ? task : this.run(task.task_id);
  }
}
