import { z } from "zod";
import { EffectClass, Money } from "./primitives.js";
import { JSONSchemaObject, CapabilityDescriptor } from "./capability.js";
import { StructuredError } from "./errors.js";
import { ArtifactRef } from "./events.js";
import { WorkOrder } from "./worker.js";

// Workshop, release and gap resolution: docs/jarvis/08-workshop-and-release.md §13.2–13.10,
// 07-skills-and-learning.md §12.15, 12-stack-and-contracts.md §17.7.

export const DevWorkOrder = WorkOrder.extend({
  dev: z.object({
    problem: z.string(),
    target: z.object({ kind: z.enum(["tool", "connector", "skill", "skill_repair", "script", "core_change", "ui"]),
      capability_id: z.string().optional(), version_bump: z.enum(["patch", "minor", "major"]).optional() }),
    interface_contract: z.object({
      contract: z.enum(["jarvis.capability/1", "jarvis.skill/1", "jarvis.connector/1"]),
      descriptor_draft: CapabilityDescriptor.partial(),
      input_schema: JSONSchemaObject, output_schema: JSONSchemaObject,
    }),
    io_expectations: z.object({ inputs: z.string(), outputs: z.string(), examples_ref: z.string() }),
    environment_constraints: z.object({
      runtime: z.enum(["node", "python", "dotnet", "powershell"]),
      os: z.enum(["linux_wsl", "windows_sandbox"]),
      network: z.object({ build: z.enum(["none", "allowlist"]), runtime: z.enum(["none", "allowlist"]), allowlist: z.array(z.string()).optional() }),
    }),
    available_dependencies: z.object({ allowed_registries: z.array(z.string()), preapproved_packages: z.array(z.string()).optional(), license_allowlist: z.array(z.string()) }),
    permission_boundaries: z.object({
      declared_effects: z.array(EffectClass), tier: z.enum(["T1", "T2"]),
      filesystem: z.object({ inputs: z.string(), outputs: z.string() }),
    }),
    test_requirements: z.object({ fixtures_ref: z.string(), negative_cases: z.array(z.string()), holdout_ref: z.string(), live_checks: z.array(z.string()).optional() }),
    artifact_location: z.string(),
    data_policy: z.object({ synthetic_only: z.boolean(), authorized_samples: z.array(ArtifactRef).optional() }),
    review: z.object({ second_worker: z.boolean(), reviewer: z.enum(["codex", "claude_code"]).optional() }),
  }),
});
export type DevWorkOrder = z.infer<typeof DevWorkOrder>;

export const DevResult = z.object({
  package_path: z.string(), patch_ref: z.string().optional(),
  tests: z.array(z.object({ suite: z.string(), passed: z.number().int(), failed: z.number().int(), report_ref: z.string() })),
  dependencies: z.array(z.object({ name: z.string(), version: z.string(), license: z.string(), new: z.boolean() })),
  declared_permissions: z.record(z.string(), z.unknown()),
  known_limitations: z.array(z.string()), remaining_risks: z.array(z.string()),
  notes_for_reviewer: z.string(),
});
export type DevResult = z.infer<typeof DevResult>;

export const PromotionEvidence = z.object({
  release_candidate: z.string(), capability_id: z.string(), version: z.string(),
  tested: z.array(z.object({ level: z.string(), suite: z.string(), result: z.string(), environment: z.string() })),
  untested: z.array(z.string()),
  holdout: z.object({ set: z.string(), result: z.string() }),
  review: z.object({ reviewer: z.string(), findings: z.number().int(), unresolved: z.number().int() }).optional(),
  live_checks: z.array(z.object({ scope: z.string(), result: z.string(), at: z.string() })).optional(),
  confidence_limits: z.string(),
  permission_delta: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
});
export type PromotionEvidence = z.infer<typeof PromotionEvidence>;

export const ReleaseRecord = z.object({
  release_id: z.string(),
  capability_id: z.string(), from_version: z.string().optional(), to_version: z.string(), package_hash: z.string(),
  class: z.enum(["configuration", "skill", "connector", "routing", "ui", "learning_config", "core"]),
  validation_report_ref: z.string(), promotion_evidence: PromotionEvidence,
  approvals: z.array(z.object({ by: z.enum(["policy", "owner"]), at: z.string(), signature: z.string().optional() })),
  migrations: z.array(z.object({ id: z.string(), reversible: z.boolean(), backup_ref: z.string() })).optional(),
  activated_at: z.string().optional(),
  canary: z.object({ runs: z.number().int(), failures: z.number().int(), state: z.enum(["running", "passed", "failed"]) }),
  rolled_back_at: z.string().optional(), rollback_reason: z.string().optional(),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecord>;

export const ImprovementProposal = z.object({
  proposal_id: z.string(),
  kind: z.enum(["skill", "tool", "connector", "routing", "learning_config", "ui", "core", "memory_generalization"]),
  title: z.string(), rationale: z.string(), evidence_refs: z.array(z.string()),
  target: z.object({ capability_id: z.string().optional(), current_version: z.string().optional() }),
  expected_effect: z.array(z.object({ metric: z.string(), baseline: z.string(), target: z.string() })),
  risk: z.object({ class: z.enum(["R0", "R1", "R2", "R3"]), permission_delta: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }), protected_paths_touched: z.array(z.string()) }),
  budget_estimate: Money.optional(),
  status: z.enum(["proposed", "approved", "in_development", "validated", "rejected", "released", "abandoned"]),
  decided_by: z.enum(["policy", "owner"]).optional(), created_at: z.string(),
});
export type ImprovementProposal = z.infer<typeof ImprovementProposal>;

export const ResolverOption = z.object({
  id: z.string(),
  kind: z.enum(["use_existing_differently", "repair_auth", "retrieve_data", "ask_owner", "alternative_route", "repair_skill", "build_tool", "install_prerequisite", "wait", "report_blocker"]),
  description: z.string(),
  est_cost: Money.optional(), est_time: z.string().optional(),
  success_likelihood: z.enum(["high", "medium", "low"]),
  reuse_value: z.enum(["none", "low", "medium", "high"]),
  requires_authority: z.array(EffectClass).optional(),
});
export type ResolverOption = z.infer<typeof ResolverOption>;

export const GAP_CLASSES = ["knowledge", "data", "tool", "integration", "authorization", "environment", "reliability", "owner_decision", "external_restriction", "hardware"] as const;

export const GapReport = z.object({
  gap_id: z.string(),
  task_id: z.string(), step_id: z.string(),
  intended_step: z.object({ description: z.string(), capability_intent: z.string(), params_ref: z.string().optional(), effects: z.array(EffectClass) }),
  observed_failure: StructuredError,
  environment: z.object({ node_id: z.string(), os: z.string(), apps: z.record(z.string(), z.string()).optional(), site_fingerprint: z.string().optional(), account_id: z.string().optional() }),
  attempted_methods: z.array(z.object({ method: z.string(), capability: z.string().optional(), result: z.string(), evidence_ids: z.array(z.string()) })),
  evidence_ids: z.array(z.string()),
  classification: z.enum(GAP_CLASSES),
  minimum_missing_capability: z.string(),
  signature: z.string(),
  options: z.array(ResolverOption),
  decision: z.object({ option_id: z.string(), reason: z.string(), decided_by: z.enum(["resolver", "owner"]), at: z.string() }).optional(),
  status: z.enum(["open", "resolving", "resolved", "blocked", "abandoned"]),
  links: z.object({ dev_task_id: z.string().optional(), prior_gap_ids: z.array(z.string()) }),
});
export type GapReport = z.infer<typeof GapReport>;
