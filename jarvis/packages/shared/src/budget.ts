import { z } from "zod";
import { Money } from "./primitives.js";

// Budgets and the usage ledger: docs/jarvis/06-connectors-providers-budgets.md §11.20

export const FallbackPolicy = z.object({
  chain: z.array(z.union([
    z.object({ adapter: z.string() }).strict(),
    z.object({ worker: z.string() }).strict(),
    z.object({ wait_for_reset: z.object({ max_wait: z.string(), show_reset_time_if_reported: z.boolean() }) }).strict(),
    z.object({ ask_owner: z.object({ offer: z.string(), cap: Money.optional() }) }).strict(),
  ])),
  never: z.array(z.enum(["unbounded_paid_retry", "silent_subscription_to_api_switch"])),
});
export type FallbackPolicy = z.infer<typeof FallbackPolicy>;

export const Budget = z.object({
  budget_id: z.string(),
  scope: z.object({ level: z.enum(["owner", "provider", "task", "work_order", "dev_project", "monitor", "category"]), ref: z.string().optional() }),
  period: z.enum(["day", "month", "task"]).optional(),
  limit: Money, kind: z.enum(["hard", "soft"]),
  alert_at: z.array(z.number()),
  fallback: FallbackPolicy,
});
export type Budget = z.infer<typeof Budget>;

export const UsageLedgerEntry = z.object({
  use_id: z.string(),
  provider: z.string(), account: z.string().optional(), adapter: z.string(), role: z.string(),
  task_id: z.string().optional(), work_order_id: z.string().optional(),
  tokens: z.object({ input: z.number(), output: z.number(), cache_read: z.number().optional(), cache_write: z.number().optional() }).optional(),
  amount: Money.optional(),
  kind: z.enum(["actual", "estimated", "unknown"]),
  basis: z.string(),
  at: z.string(),
});
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntry>;
