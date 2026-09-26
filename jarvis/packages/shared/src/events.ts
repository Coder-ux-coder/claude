import { z } from "zod";
import { EvidenceType, Retention, Sensitivity, Money } from "./primitives.js";

// Cross-cutting schemas: docs/jarvis/12-stack-and-contracts.md §17.7

export const Correlation = z.object({
  task_id: z.string().optional(), step_id: z.string().optional(), action_id: z.string().optional(),
  work_order_id: z.string().optional(), conversation_id: z.string().optional(), causation_event_id: z.string().optional(),
});
export type Correlation = z.infer<typeof Correlation>;

export const JarvisEvent = z.object({
  event_id: z.string(),
  schema: z.literal("jarvis.event/1"),
  type: z.string(),
  occurred_at: z.string(), recorded_at: z.string(),
  node_id: z.string(), seq: z.number().int().nonnegative(),
  source: z.object({ component: z.string(), version: z.string(), process_instance: z.string() }),
  correlation: Correlation,
  sensitivity: Sensitivity,
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  data_hash: z.string(),
  payload_ref: z.string().optional(),
  payload_hash: z.string().optional(),
  chain: z.object({ prev_hash: z.string(), hash: z.string() }),
  redaction: z.enum(["none", "data_redacted", "payload_deleted"]),
});
export type JarvisEvent = z.infer<typeof JarvisEvent>;

/** Default strength by evidence type (14 §19.4). */
export const EVIDENCE_STRENGTH: Record<EvidenceType, "strong" | "moderate" | "weak"> = {
  service_readback: "strong",
  service_confirmation: "moderate",
  postcondition_observation: "strong",
  file_check: "strong",
  test_result: "strong",
  process_exit: "moderate",
  screenshot: "weak",
  model_judgement: "weak",
  owner_confirmation: "strong",
};

export const EvidenceRecord = z.object({
  evidence_id: z.string(),
  type: EvidenceType,
  strength: z.enum(["strong", "moderate", "weak"]),
  claim: z.string(),
  criterion_id: z.string().optional(), action_id: z.string().optional(), task_id: z.string(),
  observed_at: z.string(),
  source: z.object({ capability_id: z.string(), executor: z.string(), account_id: z.string().optional(), url: z.string().optional() }),
  data: z.record(z.string(), z.unknown()),
  artifact_refs: z.array(z.string()),
  limitations: z.string().optional(),
  retention: Retention,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const EvidenceRef = z.object({ evidence_id: z.string(), type: EvidenceType, strength: z.enum(["strong", "moderate", "weak"]) });
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const ArtifactRef = z.object({
  artifact_id: z.string(),
  content_hash: z.string(), media_type: z.string(), size_bytes: z.number().int().nonnegative(),
  name: z.string(),
  kind: z.enum(["document", "image", "audio", "dataset", "package", "report", "evidence"]),
  location: z.object({ store: z.enum(["artifacts", "user_path"]), path: z.string().optional() }),
  produced_by: Correlation.extend({ capability_id: z.string().optional() }),
  sensitivity: Sensitivity, encrypted: z.boolean(), retention: Retention, created_at: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const ToolInvocation = z.object({
  invocation_id: z.string(),
  capability: z.string(),
  params_ref: z.string(),
  requested_by: z.object({ kind: z.enum(["boss", "skill", "worker"]), ref: z.string() }),
  action_id: z.string().optional(), decision_id: z.string().optional(), lease_id: z.string().optional(),
  correlation: Correlation,
  status: z.enum(["requested", "denied", "dispatched", "completed", "failed", "cancelled"]),
  result_ref: z.string().optional(), started_at: z.string().optional(), ended_at: z.string().optional(),
});
export type ToolInvocation = z.infer<typeof ToolInvocation>;

export const ResourceLease = z.object({
  lease_id: z.string(),
  resource: z.string(),
  mode: z.enum(["exclusive", "shared_read"]),
  holder: z.object({ task_id: z.string(), work_order_id: z.string().optional(), process_instance: z.string(), node_id: z.string() }),
  fencing_token: z.number().int(),
  acquired_at: z.string(), expires_at: z.string(), heartbeat_at: z.string(),
  state: z.enum(["active", "released", "expired", "revoked"]),
  revoked_reason: z.enum(["owner_takeover", "emergency_stop", "expired", "task_cancelled", "lock"]).optional(),
});
export type ResourceLease = z.infer<typeof ResourceLease>;

export const UsageReport = z.object({
  tokens: z.object({ input: z.number(), output: z.number(), cache_read: z.number().optional(), cache_write: z.number().optional() }).optional(),
  cost: z.object({ amount: Money, kind: z.enum(["actual", "estimated", "unknown"]), basis: z.string() }).optional(),
  subscription: z.object({ provider: z.string(), plan_usage: z.string() }).optional(),
  duration_ms: z.number(),
});
export type UsageReport = z.infer<typeof UsageReport>;
