import { z } from "zod";
import {
  Channel, Confidence, EgressPolicy, PolicyCondition, Provenance, RecordTimes, ResourceSelector, Retention,
  Sensitivity, SourceRef, SourceTrust, WeeklyHours,
} from "./primitives.js";

// Personal memory schemas: docs/jarvis/03-memory.md §9.5–9.6

export const ScopeCondition = PolicyCondition;

export const FactContent = z.object({ predicate: z.string(), value: z.unknown(), unit: z.string().optional(), qualifiers: z.record(z.string(), z.unknown()).optional() });
export type FactContent = z.infer<typeof FactContent>;
export const PreferenceContent = z.object({
  domain: z.string(), value: z.unknown(), kind: z.enum(["taste", "requirement"]), strength: z.enum(["strong", "mild"]),
  applies_when: ScopeCondition.optional(),
});
export type PreferenceContent = z.infer<typeof PreferenceContent>;
export const LessonContent = z.object({
  applies_to: z.object({ goal_class: z.string().optional(), skill_id: z.string().optional(), site: z.string().optional(), app: z.string().optional() }),
  statement: z.string(),
  kind: z.enum(["method", "pitfall", "parameter_default", "environment_fact"]),
  replication: z.object({ successes: z.number().int(), failures: z.number().int(), independent_runs: z.number().int() }),
});
export type LessonContent = z.infer<typeof LessonContent>;

export const MemoryScope = z.object({
  level: z.enum(["global", "project", "entity", "task"]),
  project_id: z.string().optional(), entity_ids: z.array(z.string()).optional(), task_id: z.string().optional(),
  condition: ScopeCondition.optional(),
});
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryStatus = z.enum(["pending_review", "active", "disputed", "superseded", "expired", "deleted"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryRecord = z.object({
  id: z.string(),
  schema: z.string(),
  type: z.enum(["fact", "preference", "lesson"]),
  text: z.string(),
  content: z.union([FactContent, PreferenceContent, LessonContent, z.object({}).strict()]),
  scope: MemoryScope,
  subject_entity_ids: z.array(z.string()),
  provenance: Provenance,
  confidence: Confidence,
  sensitivity: Sensitivity,
  egress: EgressPolicy,
  times: z.object({
    created_at: z.string(), observed_at: z.string(), last_verified_at: z.string().optional(),
    valid_from: z.string().optional(), valid_until: z.string().optional(), expires_at: z.string().optional(),
  }),
  status: MemoryStatus,
  supersedes: z.array(z.string()), superseded_by: z.string().optional(),
  contradicts: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  retention: Retention,
  revision: z.number().int().positive(), updated_at: z.string(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

export const OwnerProfile = z.object({
  owner_id: z.literal("owner"), schema: z.literal("jarvis.owner_profile/1"), revision: z.number().int(), updated_at: z.string(),
  display_name: z.string(),
  pronouns: z.string().optional(),
  timezone: z.string(),
  locale: z.string(), languages: z.array(z.string()), units: z.enum(["metric", "imperial", "mixed"]),
  working_hours: WeeklyHours, quiet_hours: WeeklyHours,
  assistant: z.object({ name: z.string(), tone: z.string(), verbosity: z.enum(["brief", "normal", "detailed"]), humor: z.enum(["none", "light"]), voice_id: z.string().optional() }),
  notification_defaults: z.object({ digest_time: z.string().optional(), channels: z.array(Channel) }),
  privacy: z.object({
    default_egress_by_sensitivity: z.record(Sensitivity, EgressPolicy),
    audio_retention: z.enum(["none", "24h"]), screenshot_retention_days: z.number().int().nonnegative(),
  }),
  home_node_id: z.string(),
});
export type OwnerProfile = z.infer<typeof OwnerProfile>;

export const Project = z.object({
  id: z.string(), schema: z.literal("jarvis.project/1"),
  name: z.string(), description: z.string().optional(),
  status: z.enum(["active", "paused", "completed", "archived"]),
  goals: z.array(z.object({ text: z.string(), target_date: z.string().optional(), status: z.enum(["open", "met", "dropped"]) })),
  stakeholders: z.array(z.object({ entity_id: z.string(), role: z.string() })),
  resources: z.array(ResourceSelector),
  convention_ids: z.array(z.string()),
  provenance: Provenance, sensitivity: Sensitivity, egress: EgressPolicy,
  times: RecordTimes, revision: z.number().int(),
});
export type Project = z.infer<typeof Project>;

export const Commitment = z.object({
  id: z.string(), schema: z.literal("jarvis.commitment/1"),
  text: z.string(),
  holder: z.enum(["owner", "jarvis", "third_party"]),
  counterparty_entity_ids: z.array(z.string()),
  certainty: z.enum(["explicit", "tentative"]),
  due: z.object({ local: z.string(), tz: z.string() }).optional(),
  status: z.enum(["open", "done", "cancelled", "snoozed", "missed"]),
  linked_schedule_ids: z.array(z.string()), linked_task_ids: z.array(z.string()), project_id: z.string().optional(),
  provenance: Provenance, times: RecordTimes, revision: z.number().int(),
});
export type Commitment = z.infer<typeof Commitment>;

export const Entity = z.object({
  id: z.string(), schema: z.literal("jarvis.entity/1"),
  kind: z.enum(["person", "organization", "org_unit", "place", "account", "device", "resource", "product", "other"]),
  names: z.array(z.object({ value: z.string(), kind: z.enum(["primary", "alias", "handle"]) })),
  identifiers: z.array(z.object({ system: z.enum(["email", "phone", "url", "path", "gdrive_file_id", "service_id", "other"]), value: z.string(), verified: z.boolean() })),
  attributes: z.record(z.string(), z.unknown()).optional(),
  provenance: Provenance, sensitivity: Sensitivity, egress: EgressPolicy,
  status: z.enum(["active", "merged", "deleted"]), merged_into: z.string().optional(), revision: z.number().int(), times: RecordTimes,
});
export type Entity = z.infer<typeof Entity>;

export const RELATIONSHIP_TYPES = ["works_at", "member_of", "client_of", "reports_to", "located_in", "owns", "contact_for", "family", "other"] as const;
export const Relationship = z.object({
  id: z.string(), schema: z.literal("jarvis.relationship/1"),
  from_entity_id: z.string(), to_entity_id: z.string(),
  type: z.enum(RELATIONSHIP_TYPES),
  qualifiers: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().optional(), valid_until: z.string().optional(),
  provenance: Provenance, confidence: Confidence, status: z.enum(["active", "ended", "disputed", "deleted"]),
  revision: z.number().int(),
});
export type Relationship = z.infer<typeof Relationship>;

export const Conversation = z.object({
  id: z.string(), channel: Channel, started_at: z.string(), last_message_at: z.string(),
  summary_id: z.string().optional(), task_ids: z.array(z.string()),
  provider_sessions: z.array(z.object({ adapter: z.string(), session_id: z.string() })).optional(),
  retention: Retention,
});
export type Conversation = z.infer<typeof Conversation>;

export const Message = z.object({
  id: z.string(), conversation_id: z.string(), author: z.enum(["owner", "jarvis", "system"]),
  channel: Channel, trust: z.enum(["owner_verified", "owner_unverified", "system"]),
  modality: z.enum(["text", "voice", "image", "file"]),
  content_ref: z.string(),
  transcript_confidence: z.enum(["high", "medium", "low"]).optional(),
  created_at: z.string(), redaction_state: z.enum(["none", "redacted", "purged"]),
});
export type Message = z.infer<typeof Message>;

export const UsageSummary = z.object({ cost_usd: z.number().optional(), tokens: z.number().optional(), kind: z.enum(["actual", "estimated", "unknown"]) });

export const ExperienceRecord = z.object({
  id: z.string(), schema: z.literal("jarvis.experience/1"),
  task_id: z.string(), goal_class: z.string(),
  skill_refs: z.array(z.object({ skill_id: z.string(), version: z.string() })), capability_refs: z.array(z.string()),
  environment: z.object({ node_id: z.string(), app_versions: z.record(z.string(), z.string()).optional(), site_fingerprints: z.record(z.string(), z.string()).optional(), account_ids: z.array(z.string()) }),
  outcome: z.enum(["verified_success", "partial", "failed", "cancelled", "unknown"]),
  evidence_refs: z.array(z.string()), duration_s: z.number(), cost: UsageSummary,
  failure_classes: z.array(z.string()), gap_ids: z.array(z.string()),
  owner_feedback: z.object({ rating: z.enum(["good", "bad"]).optional(), correction_ids: z.array(z.string()) }).optional(),
  lesson_candidate_ids: z.array(z.string()),
  sensitivity: Sensitivity, retention: Retention, created_at: z.string(),
});
export type ExperienceRecord = z.infer<typeof ExperienceRecord>;

export const MemoryCorrection = z.object({
  id: z.string(), schema: z.literal("jarvis.memory_correction/1"),
  target_ids: z.array(z.string()),
  kind: z.enum(["wrong_value", "wrong_scope", "outdated", "should_not_remember", "merge_duplicates", "split", "wrong_entity"]),
  owner_statement_ref: z.string(),
  before: z.array(z.object({ record_id: z.string(), revision: z.number().int() })),
  after: z.array(z.object({ record_id: z.string(), revision: z.number().int() })),
  generalization_limit: z.string(),
  invalidated_derivations: z.array(z.string()),
  propagated_to: z.object({ task_ids: z.array(z.string()), work_order_ids: z.array(z.string()) }),
  applied_at: z.string(),
});
export type MemoryCorrection = z.infer<typeof MemoryCorrection>;

export const DerivedSummary = z.object({
  id: z.string(),
  kind: z.enum(["entity_card", "project_brief", "conversation_summary", "communication_profile", "profile_digest"]),
  subject_ref: z.string(), content_ref: z.string(),
  inputs: z.array(z.object({ record_id: z.string(), revision: z.number().int() })), input_hash: z.string(),
  generator: z.object({ adapter: z.string(), prompt_version: z.string() }),
  state: z.enum(["fresh", "stale", "regenerating"]), generated_at: z.string(),
});
export type DerivedSummary = z.infer<typeof DerivedSummary>;

export const MemoryProposal = z.object({
  proposal_id: z.string(), proposed_by: z.string(),
  operation: z.enum(["create", "update", "supersede", "link", "delete"]),
  target_id: z.string().optional(), record: z.record(z.string(), z.unknown()),
  basis: z.array(SourceRef), source_trust: SourceTrust, rationale: z.string(),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

/** Default egress by sensitivity (03 §9.5 table). */
export const DEFAULT_EGRESS: Record<Sensitivity, EgressPolicy> = {
  normal: { policy: "any_approved_provider" },
  personal: { policy: "any_approved_provider" },
  sensitive: { policy: "listed_providers", providers: [] },
  restricted: { policy: "local_only" },
};
