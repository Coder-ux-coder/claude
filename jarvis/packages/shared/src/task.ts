import { z } from "zod";
import {
  EffectClass, EvidenceType, InputRef, Money, ResourceSelector, TaskMode, TaskStatus, WaitReason, Channel, ErrorCode,
} from "./primitives.js";

// Task contract and state machines: docs/jarvis/02-boss-and-tasks.md §8

export const ConstraintSchema = z.object({
  id: z.string(), field: z.string(),
  op: z.enum(["<=", ">=", "==", "in", "not_in", "between", "matches"]),
  value: z.unknown(),
  source: z.object({ kind: z.enum(["owner_message", "rule", "memory"]), ref: z.string() }),
  hard: z.boolean(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const TaskOverride = z.object({
  id: z.string(),
  target: z.object({ kind: z.enum(["preference", "rule"]), ref: z.string() }),
  replacement: z.unknown(),
  source_message_id: z.string(),
});
export type TaskOverride = z.infer<typeof TaskOverride>;

export const BudgetEnvelope = z.object({
  ai_cost_cap: z.object({ amount: Money, kind: z.enum(["hard", "soft"]) }),
  subscription_usage: z.enum(["allowed", "not_allowed"]),
  paid_api_fallback: z.enum(["never", "within_cap", "ask"]),
  max_wall_time: z.string().optional(),
  max_dev_depth: z.number().int().nonnegative(),
  max_attempts_per_gap: z.number().int().positive(),
});
export type BudgetEnvelope = z.infer<typeof BudgetEnvelope>;

export const SuccessCriterion = z.object({
  id: z.string(),
  description: z.string(),
  check: z.object({
    kind: z.enum(["file_exists", "file_content", "service_readback", "confirmation_captured", "tests_pass",
      "postcondition", "model_judgement", "owner_confirmation"]),
    spec: z.record(z.string(), z.unknown()),
  }),
  acceptable_evidence: z.array(EvidenceType),
  required: z.boolean(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

export const AuthorizationEnvelope = z.object({
  effects: z.array(EffectClass),
  bounds: z.array(ConstraintSchema),
  substitution: z.enum(["exact_target", "any_within_bounds"]),
  grounding: z.array(z.object({
    constraint_id: z.string(),
    // 04 §10.6 lists five grounding sources; the envelope sketch names three kinds, so the
    // other two (a displayed item you selected, records chosen by your criterion) are added.
    source: z.object({ kind: z.enum(["owner_message", "rule", "memory", "displayed_selection", "owner_criterion"]), ref: z.string(),
      span: z.tuple([z.number(), z.number()]).optional() }),
  })),
  derived_by: z.object({ adapter: z.string(), at: z.string() }),
  validated_at: z.string(),
});
export type AuthorizationEnvelope = z.infer<typeof AuthorizationEnvelope>;

const RetryOverride = z.record(ErrorCode, z.object({ max_attempts: z.number(), backoff: z.string() }));

export const TaskContract = z.object({
  task_id: z.string(),
  parent_task_id: z.string().optional(),
  root_task_id: z.string(),
  schema: z.literal("jarvis.task_contract/1"),
  revision: z.number().int().positive(),
  created_at: z.string(), updated_at: z.string(),
  origin: z.object({
    channel: z.enum(["console_text", "console_voice", "schedule", "monitor", "phone", "system"]),
    conversation_id: z.string().optional(),
    message_ids: z.array(z.string()),
    owner_verified: z.boolean(),
    transcript_confidence: z.enum(["high", "medium", "low"]).optional(),
  }),
  request_text_ref: z.string(),
  objective: z.string(),
  mode: TaskMode,
  project_id: z.string().optional(),
  inputs: z.array(InputRef),
  assumptions: z.array(z.object({ text: z.string(), basis: z.enum(["memory", "default", "inference"]), source_ids: z.array(z.string()), material: z.boolean() })),
  open_questions: z.array(z.object({ question: z.string(), why_material: z.string(), blocks_step_ids: z.array(z.string()) })),
  scope: z.object({ resources: z.array(ResourceSelector), accounts: z.array(z.string()), exclusions: z.array(ResourceSelector) }),
  intended_effects: z.array(EffectClass),
  constraints: z.array(ConstraintSchema),
  overrides: z.array(TaskOverride),
  authorization: z.object({
    basis: z.array(z.enum(["explicit_instruction", "standing_permission", "schedule_owner_intent", "owner_decision"])),
    envelope: AuthorizationEnvelope.optional(),
    grant_ids: z.array(z.string()),
    policy_revision: z.number().int().nonnegative(),
  }),
  success_criteria: z.array(SuccessCriterion),
  budget: BudgetEnvelope,
  deadline: z.string().optional(),
  retry_policy: z.union([z.literal("default"), RetryOverride]),
  cancellation: z.object({ on_cancel: z.enum(["stop_and_report", "stop_and_offer_compensation"]), children: z.enum(["cancel", "keep"]) }),
  required_capabilities: z.array(z.string()),
  dependencies: z.array(z.string()),
  planned_artifacts: z.array(z.object({ name: z.string(), kind: z.string(), destination: ResourceSelector.optional() })),
  notifications: z.object({ progress: z.enum(["quiet", "milestones", "verbose"]), on_complete: z.array(Channel), on_decision: z.array(Channel) }),
  memory_plan: z.object({ propose_updates: z.boolean(), retain_task_details: z.enum(["summary", "full", "none"]) }),
  status: TaskStatus,
  wait_reason: WaitReason.optional(),
  status_detail: z.string().optional(),
});
export type TaskContract = z.infer<typeof TaskContract>;

export const PlanStep = z.object({
  step_id: z.string(), task_id: z.string(), task_revision: z.number().int(),
  kind: z.enum(["tool", "skill", "worker", "ask_owner", "reason", "verify", "wait"]),
  description: z.string(),
  capability: z.string().optional(),
  params: z.unknown().optional(),
  depends_on: z.array(z.string()),
  effects: z.array(EffectClass),
  resources: z.array(z.string()),
  status: z.enum(["pending", "ready", "running", "waiting", "done", "failed", "skipped", "invalidated"]),
  attempts: z.number().int().nonnegative(),
  outputs: z.array(z.string()),
  checkpoint_ref: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;
export type StepStatus = PlanStep["status"];

/** Default effect ceiling per mode (02 §8.3). "execute" has no default: it is exactly what authority allows. */
export const MODE_CEILINGS: Record<TaskMode, readonly EffectClass[]> = {
  advise: ["read.local", "read.account"],
  plan: ["read.local", "read.account", "write.local"],
  research: ["read.local", "read.account", "write.local"],
  draft: ["read.local", "read.account", "write.local", "write.account"],
  prepare: ["read.local", "read.account", "write.local", "write.account"],
  execute: [],
  monitor: ["read.local", "read.account", "notify_owner", "write.local"],
  build: ["read.local", "write.local", "execute_code", "install"],
};
/** Effects a mode may NEVER carry, whatever authority exists. */
export const MODE_FORBIDDEN: Partial<Record<TaskMode, readonly EffectClass[]>> = {
  prepare: ["communicate", "publish", "spend", "commit"],
  advise: ["write.local", "write.account", "delete.local", "delete.account", "communicate", "publish", "spend", "commit", "access_control", "install", "admin", "execute_code"],
};

// ---- Task state machine (02 §8.5) ----
// The table's "* → cancelled (owner)" row is applied to every non-terminal state,
// so needs_clarification and verifying can be cancelled too (the diagram omits them).
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  accepted: ["needs_clarification", "planned", "cancelled"],
  needs_clarification: ["accepted", "cancelled"],
  planned: ["running", "cancelled"],
  running: ["waiting", "paused", "verifying", "failed", "blocked", "cancelled"],
  waiting: ["running", "paused", "cancelled"],
  paused: ["running", "cancelled"],
  verifying: ["running", "completed", "partially_completed", "cancelled"],
  completed: [],
  partially_completed: ["planned"],
  failed: ["planned"],
  blocked: ["running", "cancelled"],
  cancelled: [],
};
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "partially_completed", "failed", "cancelled"]);

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

// ---- External action lifecycle (02 §8.7) ----
// Transitions are the diagram's, plus three the text requires: steering invalidates
// actions that are proposed or awaiting a decision (02 §7.9 step 3), a decision
// request can expire (04 §10.7 `expires_at`), and a task cancel stops a proposed action.
export const ActionState = z.enum(["proposed", "prepared", "awaiting_decision", "authorized", "denied", "cancelled",
  "invalidated", "expired", "dispatched", "acknowledged", "uncertain", "failed_no_effect", "effect_observed",
  "verified", "verification_failed", "compensating", "compensated", "compensation_failed"]);
export type ActionState = z.infer<typeof ActionState>;

export const ACTION_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  proposed: ["prepared", "cancelled", "invalidated"],
  prepared: ["awaiting_decision", "authorized", "denied", "cancelled", "invalidated"],
  awaiting_decision: ["authorized", "denied", "cancelled", "invalidated", "expired"],
  authorized: ["cancelled", "invalidated", "expired", "dispatched"],
  dispatched: ["acknowledged", "uncertain", "failed_no_effect"],
  acknowledged: ["effect_observed"],
  uncertain: ["effect_observed", "failed_no_effect"],
  effect_observed: ["verified", "verification_failed"],
  verification_failed: ["compensating"],
  verified: ["compensating"],
  compensating: ["compensated", "compensation_failed"],
  denied: [], cancelled: [], invalidated: [], expired: [], failed_no_effect: [], compensated: [], compensation_failed: [],
};
export const PRE_DISPATCH_ACTION_STATES: ReadonlySet<ActionState> = new Set<ActionState>(["proposed", "prepared", "awaiting_decision", "authorized"]);

export function canTransitionAction(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}
