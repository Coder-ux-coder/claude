import type { EffectClass, EffectState, EvidenceRef, NepInvoke, ResourceSelector, StructuredError, UsageReport } from "@jarvis/shared";
import type { CredentialVault, SecretRedactor } from "../vault/vault.js";
import type { EvidenceStore } from "../verifier/verifier.js";

export interface ExecResult {
  status: "ok" | "error" | "partial";
  effect_state: EffectState;
  output?: unknown;
  error?: StructuredError;
  evidence: EvidenceRef[];
  /** Fields read back from the world, compared with the authorized parameters. */
  observed_fields?: Record<string, unknown>;
  usage?: UsageReport;
}

export interface ExecutorContext {
  task_id: string;
  action_id?: string;
  signal: AbortSignal;
  evidence: EvidenceStore;
  vault: CredentialVault;
  redactor: SecretRedactor;
  /** Late binding of {{mem:…}} placeholders inside the executor boundary (03 §9.9). */
  resolvePlaceholders(params: unknown): unknown;
  /** Pre-commit re-read (04 §10.6 moment 3): throws precondition_changed when out of bounds. */
  preCommit(live: Record<string, unknown>): void;
  node_id: string;
}

export type ReconcileOutcome = { outcome: "effect_found"; evidence: EvidenceRef[]; observed_fields?: Record<string, unknown> } | { outcome: "no_effect"; evidence: EvidenceRef[] } | { outcome: "inconclusive"; checked: string };

export interface Executor {
  id: string;
  version: string;
  /** Capability ids (without version) this executor serves. */
  capabilities: string[];
  invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult>;
  /** Effect classes for these params beyond the descriptor's (e.g. a command catalog). */
  classify?(capability: string, params: Record<string, unknown>): EffectClass[];
  /** The real targets of these params (resolved paths, hosts). The Broker uses these, never only the caller's claim. */
  targets?(capability: string, params: Record<string, unknown>): ResourceSelector[];
  /** Policy-relevant fields derived from the params (program, cwd, host); these override the caller's values. */
  fields?(capability: string, params: Record<string, unknown>): Record<string, unknown>;
  reconcile?(input: { capability: string; params: unknown; reconciliation_key: string | null; idempotency_key: string }, ectx: ExecutorContext): Promise<ReconcileOutcome>;
}
