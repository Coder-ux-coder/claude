import { z } from "zod";
import { EffectClass, EvidenceType, Money } from "./primitives.js";
import { StructuredError } from "./errors.js";
import { ArtifactRef, Correlation, UsageReport } from "./events.js";
import { JSONSchemaObject } from "./capability.js";

// Work orders, worker results, reasoning adapter contract: docs/jarvis/02-boss-and-tasks.md §7.2, §7.5

export const WorkOrder = z.object({
  work_order_id: z.string(),
  task_id: z.string(), step_id: z.string(), task_revision: z.number().int(),
  parent_work_order_id: z.string().optional(),
  worker_type: z.enum(["agent", "codex", "claude_code"]),
  objective: z.string(),
  context_package_id: z.string(),
  inputs: z.array(ArtifactRef),
  allowed_capabilities: z.array(z.string()),
  allowed_effects: z.array(EffectClass),
  leases: z.array(z.string()),
  workspace: z.object({ kind: z.enum(["git_worktree", "scratch", "wsl_workspace", "windows_sandbox"]), path: z.string(), isolation: z.enum(["T1", "T2"]) }).optional(),
  budget: z.object({
    max_cost: Money.optional(), max_wall_time: z.string(), max_tool_calls: z.number().int().optional(),
    subscription_allowed: z.boolean(), paid_fallback: z.enum(["never", "within_cap", "ask"]),
  }),
  deadline: z.string().optional(),
  output_schema: JSONSchemaObject,
  verification: z.object({ required_evidence: z.array(EvidenceType), tests: z.array(z.string()).optional(), holdout_ref: z.string().optional() }),
  policy_revision: z.number().int(),
  constraints: z.array(z.string()),
  report: z.object({ progress: z.boolean(), questions: z.enum(["allowed", "forbidden"]), heartbeat_s: z.number() }),
  capability_token_ref: z.string(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

export const MemoryProposalRef = z.object({
  kind: z.string(), content: z.record(z.string(), z.unknown()), rationale: z.string(), evidence_ids: z.array(z.string()),
});

export const WorkerResult = z.object({
  work_order_id: z.string(),
  status: z.enum(["succeeded", "partial", "failed", "blocked", "cancelled"]),
  output: z.unknown().optional(),
  claims: z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) })),
  artifacts: z.array(ArtifactRef),
  proposed_memory_updates: z.array(MemoryProposalRef),
  proposed_skill_updates: z.array(z.string()).optional(),
  failures: z.array(StructuredError),
  questions: z.array(z.object({ question: z.string(), why: z.string() })).optional(),
  usage: UsageReport,
  remaining_risks: z.array(z.string()),
});
export type WorkerResult = z.infer<typeof WorkerResult>;

// ---- Reasoning adapter (provider-neutral) ----
export type ModelRole = "boss.reasoning" | "boss.fast" | "agent.worker" | "vision.interpret" | "vision.act";

export type NeutralContent =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data_base64: string }
  | { type: "tool_call"; call_id: string; tool: string; input: unknown }
  | { type: "tool_result"; call_id: string; output: unknown; is_error?: boolean };

/**
 * Provider-neutral transcript turn. `native` is a disposable provider cache (e.g. the
 * exact assistant content blocks, including thinking blocks bound to the conversation);
 * an adapter uses it only when it produced it, so a model switch simply ignores it.
 */
export interface NeutralMessage { role: "user" | "assistant"; content: NeutralContent[]; native?: { adapter: string; content: unknown } }
export interface SystemBlock { kind: "persona" | "policy" | "instructions" | "context"; text: string; cacheable?: boolean }
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }

export interface ReasoningRequest {
  role: ModelRole;
  system: SystemBlock[];
  context_package_id: string;
  transcript: NeutralMessage[];
  tools?: ToolSpec[];
  output_schema?: Record<string, unknown>;
  limits: { max_output_tokens: number; timeout_s: number; budget_id: string };
  correlation: Correlation;
}

export type ReasoningEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call_id: string; tool: string; input: unknown }
  | { type: "structured_output"; value: unknown }
  | { type: "usage"; usage: UsageReport }
  | { type: "stop"; reason: "end" | "tool_use" | "max_tokens" | "refusal" | "error"; error?: StructuredError }
  // Extension to 02 §7.2: the provider's exact assistant content, stored as NeutralMessage.native (a disposable cache).
  | { type: "native"; native: { adapter: string; content: unknown } };

export interface ReasoningAdapter {
  id: string;
  capabilities(): { tools: boolean; vision: boolean; structured_output: boolean; max_context_tokens: number; streaming: boolean; prompt_caching: boolean };
  run(req: ReasoningRequest, signal: AbortSignal): AsyncIterable<ReasoningEvent>;
}
