import { z } from "zod";
import { EffectClass, EffectState, EvidenceType, PolicyCondition } from "./primitives.js";
import { StructuredError } from "./errors.js";
import { Correlation, EvidenceRef, UsageReport } from "./events.js";

// Capability registry schemas: docs/jarvis/05-capabilities-and-execution.md §11.2–11.3, §11.14

export const JSONSchemaObject = z.record(z.string(), z.unknown());

export const LIFECYCLES = ["draft", "under_test", "validated", "active", "degraded", "quarantined", "superseded", "retired"] as const;

export const CapabilityDescriptor = z.object({
  id: z.string().regex(/^(tool|skill|worker|model_function):[a-z0-9_.\-]+$/i),
  kind: z.enum(["tool", "skill", "worker", "model_function"]),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  package: z.object({ id: z.string(), version: z.string(), hash: z.string(), provenance_ref: z.string() }),
  title: z.string(),
  purpose: z.string(),
  goal_patterns: z.array(z.string()).optional(),
  input_schema: JSONSchemaObject,
  output_schema: JSONSchemaObject,
  prerequisites: z.object({
    capabilities: z.array(z.string()).optional(),
    software: z.array(z.object({ name: z.string(), version_range: z.string(), detect: z.string() })).optional(),
    config: z.array(z.string()).optional(),
  }),
  environment: z.object({
    node_kinds: z.array(z.enum(["windows_desktop", "cloud_runner", "phone"])),
    requires_signed_in_session: z.boolean(),
    requires_unlocked_desktop: z.boolean(),
    os_min: z.string().optional(),
    network: z.enum(["none", "local", "internet"]),
  }),
  auth: z.object({
    type: z.enum(["none", "oauth2", "api_key", "browser_session", "subscription_cli", "os_user"]),
    account_binding: z.enum(["required", "optional", "none"]),
    scopes: z.array(z.string()).optional(),
  }),
  side_effects: z.object({
    effect_classes: z.array(EffectClass),
    param_dependent: z.array(z.object({ when: PolicyCondition, effect_classes: z.array(EffectClass) })).optional(),
    reversibility: z.enum(["reversible", "compensable", "irreversible", "none"]),
    idempotency: z.enum(["natural", "key_supported", "none"]),
    reconciliation: z.string().optional(),
  }),
  policy_scopes: z.array(z.string()),
  cost: z.object({
    kind: z.enum(["free", "subscription", "metered"]), unit: z.string().optional(),
    estimate: z.object({ typical: z.number(), high: z.number(), basis: z.string() }).optional(),
  }),
  rate_limits: z.object({ per_minute: z.number().optional(), per_day: z.number().optional(), notes: z.string().optional() }).optional(),
  cancellation: z.enum(["immediate", "cooperative", "not_supported"]),
  timeouts: z.object({ default_s: z.number().positive(), max_s: z.number().positive() }),
  verification: z.object({ method: z.enum(["service_readback", "service_confirmation", "file_check", "postcondition", "none"]), describe: z.string() }),
  evidence_emitted: z.array(EvidenceType),
  known_limitations: z.array(z.string()),
  isolation_tier: z.enum(["T0", "T1", "T2", "T3"]),
  service_policy_ref: z.string().optional(),
  lifecycle: z.enum(LIFECYCLES),
  admin_state: z.enum(["enabled", "disabled"]),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

export const CapabilityHealth = z.object({
  capability_id: z.string(), node_id: z.string(), account_id: z.string().optional(),
  state: z.enum(["installed", "available", "needs_auth", "degraded", "outdated", "disabled", "unsupported_on_node", "unavailable_now"]),
  reason: z.string().optional(),
  checked_at: z.string(), probe: z.enum(["active", "passive"]),
  recent: z.object({ successes: z.number().int(), failures: z.number().int(), window: z.string() }),
});
export type CapabilityHealth = z.infer<typeof CapabilityHealth>;

export const ToolResult = z.object({
  invocation_id: z.string(),
  action_id: z.string().optional(),
  status: z.enum(["ok", "error", "partial"]),
  effect_state: EffectState,
  output: z.unknown().optional(),
  error: StructuredError.optional(),
  evidence: z.array(EvidenceRef),
  observations: z.array(z.object({ kind: z.enum(["page", "uia", "screenshot", "file", "api"]), ref: z.string(), at: z.string() })).optional(),
  timing: z.object({ started_at: z.string(), ended_at: z.string() }),
  usage: UsageReport.optional(),
  executor: z.object({ id: z.string(), version: z.string(), node_id: z.string() }),
  correlation: Correlation,
});
export type ToolResult = z.infer<typeof ToolResult>;
