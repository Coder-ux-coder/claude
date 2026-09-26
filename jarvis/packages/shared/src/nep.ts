import { z } from "zod";

// Node Execution Protocol: docs/jarvis/12-stack-and-contracts.md §17.6

export const NEP_PROTOCOL_VERSION = "1.0";

export const NepGrant = z.object({ decision_id: z.string(), signature: z.string(), fingerprint: z.string(), expires_at: z.string() });
export const NepLease = z.object({ lease_id: z.string(), fencing_token: z.number().int() });

export const NepInvoke = z.object({
  invocation_id: z.string(),
  action_id: z.string().optional(),
  capability: z.string(),
  params: z.unknown(),
  grant: NepGrant.optional(),
  lease: NepLease.optional(),
  task_revision: z.number().int(),
  policy_revision: z.number().int(),
  idempotency_key: z.string(),
  deadline: z.string(),
  observation_ref: z.object({ id: z.string(), max_age_ms: z.number() }).optional(),
});
export type NepInvoke = z.infer<typeof NepInvoke>;

export const NepEvent = z.object({
  invocation_id: z.string(), seq: z.number().int(), kind: z.enum(["progress", "observation", "log"]), data: z.unknown(),
});
export type NepEvent = z.infer<typeof NepEvent>;

export const NepCancel = z.object({ invocation_id: z.string(), mode: z.enum(["cooperative", "kill"]) });
export type NepCancel = z.infer<typeof NepCancel>;

// JSON-RPC 2.0 framing shared by every process boundary.
export interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
