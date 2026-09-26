import { z } from "zod";
import { EffectClass, Money, PolicyCondition, ResourceSelector, TimeWindow } from "./primitives.js";
import { ConstraintSchema } from "./task.js";

// Rules and authorization: docs/jarvis/04-policy-and-trust.md §10.3–10.7; services 05 §11.8, processes 05 §11.10

export const OwnerRule = z.object({
  rule_id: z.string(),
  schema: z.literal("jarvis.rule/1"),
  revision: z.number().int().positive(),
  kind: z.enum(["guidance", "constraint", "standing_permission", "exception"]),
  text: z.string(),
  source: z.object({ type: z.enum(["owner_statement", "owner_edit", "onboarding", "migration"]), message_id: z.string().optional(), channel_verified: z.boolean() }),
  applies_to: z.object({
    effects: z.array(EffectClass),
    capabilities: z.array(z.string()).optional(),
    resources: z.array(ResourceSelector).optional(),
    accounts: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(), entities: z.array(z.string()).optional(),
  }),
  conditions: PolicyCondition.optional(),
  decision: z.enum(["allow", "deny", "require_decision", "require_presence"]),
  bounds: z.object({
    max_amount: Money.optional(),
    per_period: z.object({ period: z.enum(["day", "week", "month"]), max_total: Money.optional(), max_count: z.number().int().optional() }).optional(),
    recipients: z.array(z.string()).optional(),
    destinations: z.array(ResourceSelector).optional(),
    time_window: TimeWindow.optional(),
    require_refundable: z.boolean().optional(),
    require_skill_lifecycle: z.literal("active").optional(),
    payment_method_ref: z.string().optional(),
  }).optional(),
  effective_from: z.string().optional(), effective_until: z.string().optional(),
  enforcement: z.enum(["advisory", "broker", "os", "provider"]),
  protection: z.enum(["normal", "protected"]),
  conflict: z.enum(["deny_wins", "most_specific_wins", "ask"]),
  status: z.enum(["draft", "active", "suspended", "expired", "revoked", "superseded"]),
  compile: z.object({ status: z.enum(["compiled", "advisory_only", "needs_clarification"]), interpretation: z.string(), confirmed_at: z.string().optional() }),
  supersedes: z.string().optional(),
  created_at: z.string(), created_in_policy_revision: z.number().int(),
});
export type OwnerRule = z.infer<typeof OwnerRule>;

export const AuthorizationDecision = z.object({
  decision_id: z.string(),
  schema: z.literal("jarvis.authorization_decision/1"),
  task_id: z.string(), task_revision: z.number().int(), step_id: z.string().optional(), action_id: z.string(),
  policy_revision: z.number().int(),
  decision: z.enum(["allow", "deny", "require_decision", "require_presence", "require_clarification"]),
  basis: z.object({ kind: z.enum(["explicit_instruction", "standing_permission", "owner_decision", "schedule_owner_intent", "default_allow"]), refs: z.array(z.string()) }),
  matched_rules: z.array(z.object({ rule_id: z.string(), revision: z.number().int(), effect: z.enum(["allowed", "denied", "bounded", "required_decision", "advisory"]) })),
  action_fingerprint: z.string(),
  bounds: z.array(ConstraintSchema),
  resources: z.array(z.string()), effects: z.array(EffectClass),
  issued_at: z.string(), expires_at: z.string(), single_use: z.boolean(),
  reason_for_owner: z.string(),
  issuer: z.object({ component: z.literal("policy_engine"), version: z.string() }),
  signature: z.string(),
});
export type AuthorizationDecision = z.infer<typeof AuthorizationDecision>;

export const DecisionRequest = z.object({
  decision_request_id: z.string(),
  task_id: z.string(), action_ids: z.array(z.string()),
  why: z.object({ kind: z.enum(["owner_rule", "no_authority", "ambiguity", "scope_expansion", "account_requirement", "new_skill_first_use"]), refs: z.array(z.string()), text: z.string() }),
  proposal: z.object({
    summary: z.string(), target: z.string(), recipient: z.string().optional(), amount: Money.optional(), dates: z.string().optional(),
    important_terms: z.array(z.string()), expected_effect: z.string(), reversibility: z.string(),
  }),
  options: z.array(z.object({ id: z.string(), label: z.string(), creates: z.enum(["grant", "revision", "cancel", "rule_draft"]) })),
  proposal_fingerprint: z.string(),
  expires_at: z.string(),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export const ServicePolicy = z.object({
  service: z.string(),
  ui_automation: z.enum(["allowed", "restricted", "prohibited", "unknown"]),
  api: z.enum(["public", "approval_required", "none"]),
  notes: z.string(),
  sources: z.array(z.object({ url: z.string(), checked_at: z.string(), status: z.enum(["V", "V-S", "U"]) })),
});
export type ServicePolicy = z.infer<typeof ServicePolicy>;

export const ProcessRequest = z.object({
  program: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env_allowlist: z.array(z.string()),
  env_inject: z.array(z.object({ name: z.string(), secret_ref: z.string() })).optional(),
  stdin_ref: z.string().optional(),
  timeout_s: z.number().positive(),
  max_output_bytes: z.number().int().positive(),
  tier: z.enum(["T1", "T2", "T3"]),
  job_limits: z.object({ memory_mb: z.number().optional(), cpu_percent: z.number().optional(), max_processes: z.number().int().optional() }),
  script_hash: z.string().optional(),
});
export type ProcessRequest = z.infer<typeof ProcessRequest>;
