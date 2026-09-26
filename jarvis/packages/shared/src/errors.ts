import { z } from "zod";
import { EffectState, ErrorCode } from "./primitives.js";

// Shared error vocabulary: docs/jarvis/05-capabilities-and-execution.md §11.6

export const StructuredError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  retry_after_s: z.number().optional(),
  effect_state: EffectState,
  details: z.record(z.string(), z.unknown()).optional(),
  cause_ref: z.string().optional(),
  source: z.object({ capability_id: z.string(), executor: z.string(), node_id: z.string() }),
});
export type StructuredError = z.infer<typeof StructuredError>;

/** Default retryability and typical effect_state per code (05 §11.6 table). */
export const ERROR_DEFAULTS: Record<ErrorCode, { retryable: boolean; effect_state: EffectState }> = {
  invalid_input: { retryable: false, effect_state: "none" },
  missing_permission: { retryable: false, effect_state: "none" },
  missing_credential: { retryable: false, effect_state: "none" },
  auth_required: { retryable: false, effect_state: "none" },
  unavailable_device: { retryable: true, effect_state: "none" },
  unsupported_operation: { retryable: false, effect_state: "none" },
  transient_service_error: { retryable: true, effect_state: "none" },
  rate_limited: { retryable: true, effect_state: "none" },
  uncertain_external_effect: { retryable: false, effect_state: "unknown" },
  verification_failed: { retryable: false, effect_state: "complete" },
  precondition_changed: { retryable: false, effect_state: "none" },
  conflict: { retryable: true, effect_state: "none" },
  timeout: { retryable: false, effect_state: "unknown" },
  budget_exhausted: { retryable: false, effect_state: "none" },
  policy_unavailable: { retryable: false, effect_state: "none" },
  expired: { retryable: false, effect_state: "none" },
  external_refusal: { retryable: false, effect_state: "none" },
  cancelled: { retryable: false, effect_state: "none" },
  internal_error: { retryable: true, effect_state: "unknown" },
};

/** Retry policy by error class (02 §8.8). max_attempts counts retries after the first attempt. */
export interface RetryRule {
  retry: "no" | "wait" | "if_safe" | "after_hint" | "reconcile_first" | "other_method" | "reacquire" | "once" | "classify";
  max_retries: number;
  backoff?: { initial_ms: number; max_ms: number; jitter: boolean };
  then: string;
}
export const RETRY_POLICY: Record<ErrorCode, RetryRule> = {
  invalid_input: { retry: "no", max_retries: 0, then: "replan once; ask if the bad input came from the owner" },
  missing_permission: { retry: "no", max_retries: 0, then: "decision request, or report the rule that denied it" },
  missing_credential: { retry: "wait", max_retries: 0, then: "waiting_for_auth and a sign-in card" },
  auth_required: { retry: "wait", max_retries: 0, then: "waiting_for_auth and a sign-in card" },
  unavailable_device: { retry: "wait", max_retries: 0, then: "wait for availability; notify if deadline at risk" },
  unsupported_operation: { retry: "no", max_retries: 0, then: "Gap Resolver" },
  transient_service_error: { retry: "if_safe", max_retries: 3, backoff: { initial_ms: 2000, max_ms: 60000, jitter: true }, then: "reroute or wait" },
  rate_limited: { retry: "after_hint", max_retries: 3, then: "waiting_for_quota" },
  uncertain_external_effect: { retry: "reconcile_first", max_retries: 0, then: "reconcile at 1, 5, 20 minutes, then ask the owner" },
  verification_failed: { retry: "other_method", max_retries: 2, then: "partially_completed or failed" },
  precondition_changed: { retry: "no", max_retries: 0, then: "re-evaluate against bounds; decision if out of bounds" },
  conflict: { retry: "reacquire", max_retries: 3, backoff: { initial_ms: 200, max_ms: 2000, jitter: true }, then: "report" },
  timeout: { retry: "classify", max_retries: 3, then: "transient if read-only; uncertain_external_effect if effectful" },
  budget_exhausted: { retry: "no", max_retries: 0, then: "owner choice" },
  policy_unavailable: { retry: "wait", max_retries: 0, then: "fail closed until the store recovers" },
  expired: { retry: "no", max_retries: 0, then: "re-prepare or re-observe" },
  external_refusal: { retry: "no", max_retries: 0, then: "blocker report" },
  cancelled: { retry: "no", max_retries: 0, then: "stop" },
  internal_error: { retry: "once", max_retries: 1, then: "fail safe with diagnostics" },
};

/** Exponential backoff with full jitter, bounded. attempt starts at 1. */
export function backoffMs(rule: RetryRule, attempt: number, rand: () => number = Math.random): number {
  const b = rule.backoff;
  if (!b) return 0;
  const cap = Math.min(b.max_ms, b.initial_ms * 2 ** Math.max(0, attempt - 1));
  return b.jitter ? Math.round(b.initial_ms / 2 + rand() * (cap - b.initial_ms / 2)) : cap;
}

/** Thrown inside the core; always carries a StructuredError. */
export class JarvisError extends Error {
  readonly structured: StructuredError;
  constructor(code: ErrorCode, message: string, opts: Partial<Omit<StructuredError, "code" | "message">> = {}) {
    super(message);
    this.name = "JarvisError";
    const d = ERROR_DEFAULTS[code];
    this.structured = {
      code, message,
      retryable: opts.retryable ?? d.retryable,
      effect_state: opts.effect_state ?? d.effect_state,
      source: opts.source ?? { capability_id: "core", executor: "core", node_id: "local" },
      ...(opts.retry_after_s !== undefined ? { retry_after_s: opts.retry_after_s } : {}),
      ...(opts.details ? { details: opts.details } : {}),
      ...(opts.cause_ref ? { cause_ref: opts.cause_ref } : {}),
    };
  }
  get code(): ErrorCode { return this.structured.code; }
}

export function toStructured(err: unknown, source?: StructuredError["source"]): StructuredError {
  if (err instanceof JarvisError) return err.structured;
  const message = err instanceof Error ? err.message : String(err);
  return new JarvisError("internal_error", redactMessage(message), source ? { source } : {}).structured;
}

/** Messages leave the core secret-free: strip things that look like keys or tokens. */
export function redactMessage(m: string): string {
  return m
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\b(?:bearer|token|password|passwd|secret)\s*[:=]\s*\S+/gi, "[redacted-secret]")
    .replace(/\b\d{13,19}\b/g, "[redacted-number]");
}
