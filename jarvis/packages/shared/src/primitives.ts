import { z } from "zod";

// Shared primitive types: docs/jarvis/12-stack-and-contracts.md §17.7

export const EFFECT_CLASSES = [
  "read.local", "read.account", "write.local", "delete.local", "write.account", "delete.account",
  "communicate", "publish", "spend", "commit", "access_control", "execute_code", "install", "admin", "notify_owner",
] as const;
export const EffectClass = z.enum(EFFECT_CLASSES);
export type EffectClass = z.infer<typeof EffectClass>;

/** Effects that can never be blindly retried from `uncertain` (02 §8.7 rule 3). */
export const CONSEQUENTIAL_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>([
  "communicate", "publish", "spend", "commit", "access_control", "delete.local", "delete.account",
]);
export const READ_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>(["read.local", "read.account"]);

export const TaskMode = z.enum(["advise", "plan", "research", "draft", "prepare", "execute", "monitor", "build"]);
export type TaskMode = z.infer<typeof TaskMode>;

export const TaskStatus = z.enum(["accepted", "needs_clarification", "planned", "running", "waiting", "paused",
  "verifying", "completed", "partially_completed", "failed", "blocked", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const WaitReason = z.enum(["owner", "auth", "device", "quota", "subtask", "resource", "until"]);
export type WaitReason = z.infer<typeof WaitReason>;

export const Sensitivity = z.enum(["normal", "personal", "sensitive", "restricted"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const SourceTrust = z.enum(["owner_verified", "owner_unverified", "trusted_service", "external_content", "worker_claim", "system"]);
export type SourceTrust = z.infer<typeof SourceTrust>;

export const Channel = z.enum(["console", "toast", "sound", "speech", "calendar_mirror", "phone_push", "email_self"]);
export type Channel = z.infer<typeof Channel>;

export const Money = z.object({ amount: z.number(), currency: z.string().regex(/^[A-Z]{3}$/) });
export type Money = z.infer<typeof Money>;

export const Retention = z.object({
  policy: z.enum(["keep", "until", "task_end", "days"]),
  value: z.union([z.string(), z.number()]).optional(),
  review_at: z.string().optional(),
});
export type Retention = z.infer<typeof Retention>;

export const EgressPolicy = z.object({
  policy: z.enum(["any_approved_provider", "listed_providers", "local_only"]),
  providers: z.array(z.string()).optional(),
});
export type EgressPolicy = z.infer<typeof EgressPolicy>;

export const DayName = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const WeeklyHours = z.object({
  tz: z.string(),
  windows: z.array(z.object({ days: z.array(DayName), from: z.string(), to: z.string() })),
});
export type WeeklyHours = z.infer<typeof WeeklyHours>;

export const TimeWindow = z.object({ tz: z.string().optional(), from: z.string(), to: z.string() });
export type TimeWindow = z.infer<typeof TimeWindow>;

export const ResourceSelector = z.union([
  z.object({ path_prefix: z.string() }).strict(),
  z.object({ account: z.string() }).strict(),
  z.object({ site: z.string() }).strict(),
  z.object({ entity: z.string() }).strict(),
  z.object({ app: z.string() }).strict(),
  z.object({ recipient_set: z.string() }).strict(),
]);
export type ResourceSelector = z.infer<typeof ResourceSelector>;

export const SourceRef = z.object({
  kind: z.enum(["message", "evidence", "artifact", "event", "owner_edit"]),
  ref: z.string(),
  locator: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Provenance = z.object({
  origin: z.enum(["stated", "observed", "derived", "inferred", "imported"]),
  source_refs: z.array(SourceRef),
  source_trust: SourceTrust,
  recorded_by: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Confidence = z.object({ level: z.enum(["confirmed", "high", "medium", "low"]), basis: z.string() });
export type Confidence = z.infer<typeof Confidence>;

export const RecordTimes = z.object({
  created_at: z.string(), observed_at: z.string().optional(), last_verified_at: z.string().optional(),
  valid_from: z.string().optional(), valid_until: z.string().optional(), expires_at: z.string().optional(),
});
export type RecordTimes = z.infer<typeof RecordTimes>;

export const InputRef = z.object({ kind: z.enum(["artifact", "path", "record", "url"]), ref: z.string() });
export type InputRef = z.infer<typeof InputRef>;

export const SessionRef = z.object({ adapter: z.string(), session_id: z.string() });
export type SessionRef = z.infer<typeof SessionRef>;

export type PolicyCondition =
  | { all: PolicyCondition[] }
  | { any: PolicyCondition[] }
  | { not: PolicyCondition }
  | { field: string; op: PolicyOp; value: unknown };
export const POLICY_OPS = ["==", "!=", "<", "<=", ">", ">=", "in", "not_in", "matches", "within"] as const;
export type PolicyOp = (typeof POLICY_OPS)[number];
export const PolicyCondition: z.ZodType<PolicyCondition> = z.lazy(() => z.union([
  z.object({ all: z.array(PolicyCondition) }).strict(),
  z.object({ any: z.array(PolicyCondition) }).strict(),
  z.object({ not: PolicyCondition }).strict(),
  z.object({ field: z.string(), op: z.enum(POLICY_OPS), value: z.unknown() }).strict(),
]));

export const ErrorCode = z.enum(["invalid_input", "missing_permission", "missing_credential", "auth_required",
  "unavailable_device", "unsupported_operation", "transient_service_error", "rate_limited",
  "uncertain_external_effect", "verification_failed", "precondition_changed", "conflict", "timeout",
  "budget_exhausted", "policy_unavailable", "expired", "external_refusal", "cancelled", "internal_error"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const EffectState = z.enum(["none", "unknown", "partial", "complete"]);
export type EffectState = z.infer<typeof EffectState>;

export const EVIDENCE_TYPES = ["service_readback", "service_confirmation", "postcondition_observation", "file_check",
  "test_result", "process_exit", "screenshot", "model_judgement", "owner_confirmation"] as const;
export const EvidenceType = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceType>;
