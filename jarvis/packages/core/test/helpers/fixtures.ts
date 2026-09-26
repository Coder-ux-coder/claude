import { SimClock, type EffectClass, type TaskMode } from "@jarvis/shared";
import { createContext, type CoreContext } from "../../src/context.js";
import { TaskEngine, type NewTaskInput } from "../../src/tasks/task-engine.js";
import { ActionService } from "../../src/tasks/actions.js";
import { LeaseManager } from "../../src/tasks/leases.js";

export interface Harness { ctx: CoreContext; clock: SimClock; tasks: TaskEngine; actions: ActionService; leases: LeaseManager }

export function harness(opts: { dataDir?: string; clock?: SimClock } = {}): Harness {
  const clock = opts.clock ?? new SimClock("2026-10-01T09:00:00Z");
  const ctx = createContext({ dataDir: opts.dataDir ?? null, clock });
  const tasks = new TaskEngine(ctx);
  const actions = new ActionService(ctx);
  const leases = new LeaseManager(ctx);
  tasks.actions = actions; tasks.leases = leases;
  return { ctx, clock, tasks, actions, leases };
}

/** A minimal valid contract (HYPOTHETICAL data). */
export function contract(mode: TaskMode = "execute", effects: EffectClass[] = ["read.local", "write.local", "communicate"], extra: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    origin: { channel: "console_text", conversation_id: "cnv_test", message_ids: ["msg_1"], owner_verified: true },
    request_text_ref: "pld_test", objective: "HYPOTHETICAL: copy notes and email Sam a summary", mode,
    inputs: [], assumptions: [], open_questions: [],
    scope: { resources: [{ path_prefix: "C:\\Users\\owner\\Notes\\" }], accounts: [], exclusions: [] },
    intended_effects: effects, constraints: [], overrides: [],
    authorization: { basis: ["explicit_instruction"], grant_ids: [], policy_revision: 1 },
    success_criteria: [
      { id: "c1", description: "Summary file exists", check: { kind: "file_exists", spec: { path: "C:\\Users\\owner\\Notes\\summary.md" } }, acceptable_evidence: ["file_check"], required: true },
      { id: "c2", description: "Email sent to Sam", check: { kind: "service_readback", spec: {} }, acceptable_evidence: ["service_readback"], required: true },
    ],
    budget: { ai_cost_cap: { amount: { amount: 1, currency: "USD" }, kind: "hard" }, subscription_usage: "allowed", paid_api_fallback: "never", max_dev_depth: 2, max_attempts_per_gap: 3 },
    retry_policy: "default", cancellation: { on_cancel: "stop_and_report", children: "cancel" },
    required_capabilities: [], dependencies: [], planned_artifacts: [],
    notifications: { progress: "milestones", on_complete: ["console"], on_decision: ["console", "toast"] },
    memory_plan: { propose_updates: true, retain_task_details: "summary" },
    ...extra,
  };
}

/** Drives a task to running with a two-step plan. */
export function runningTask(h: Harness, mode: TaskMode = "execute", effects?: EffectClass[]) {
  const t = h.tasks.create(contract(mode, effects));
  h.tasks.transition(t.task_id, "planned", { initiator: "plan_validator" });
  h.tasks.setPlan(t.task_id, [
    { step_id: `stp_${t.task_id}_1`, kind: "tool", description: "write summary", capability: "tool:files.write@1.0.0", depends_on: [], effects: ["write.local"], resources: ["fs:C:\\Users\\owner\\Notes\\"] },
    { step_id: `stp_${t.task_id}_2`, kind: "tool", description: "send email", capability: "tool:mail.send@1.0.0", depends_on: [`stp_${t.task_id}_1`], effects: ["communicate"], resources: [] },
  ]);
  h.tasks.transition(t.task_id, "running", { initiator: "step_controller" });
  return t;
}
