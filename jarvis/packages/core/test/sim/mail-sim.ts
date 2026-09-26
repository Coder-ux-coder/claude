import { JarvisError, type NepInvoke, type CapabilityDescriptor } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult, ReconcileOutcome } from "../../src/broker/types.js";

/** Simulated mail service (14 §19.2). Sends are keyed by a JARVIS-set Message-ID for reconciliation. */
export class MailSim implements Executor {
  id = "sim:mail"; version = "1.0.0"; capabilities = ["tool:mail.send"];
  sent: { message_id: string; to: string[]; subject: string; body: string }[] = [];
  /** "commit_then_timeout": the service accepts the mail, then the response is lost (F13). */
  mode: "normal" | "commit_then_timeout" | "reject" | "hang" = "normal";
  hideFromSearch = false;

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const p = ectx.resolvePlaceholders(nep.params) as { to: string[]; subject: string; body: string };
    const message_id = `<${nep.idempotency_key}@jarvis.local>`;
    if (this.mode === "reject") throw new JarvisError("external_refusal", "recipient rejected", { effect_state: "none" });
    if (this.mode === "hang") await new Promise((_, rej) => ectx.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    if (!this.sent.some(m => m.message_id === message_id)) this.sent.push({ message_id, ...p });   // provider-side dedupe by Message-ID
    if (this.mode === "commit_then_timeout") throw new JarvisError("timeout", "no response from the mail service", { effect_state: "unknown" });
    const read = this.sent.find(m => m.message_id === message_id)!;
    const e = ectx.evidence.add({ type: "service_readback", claim: `sent mail ${message_id} found in Sent`, task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
      source: { capability_id: "tool:mail.send", executor: this.id }, data: { message_id } });
    return { status: "ok", effect_state: "complete", output: { message_id }, evidence: [ectx.evidence.ref(e)], observed_fields: { to: read.to, subject: read.subject, body: read.body } };
  }

  async reconcile(input: { idempotency_key: string }, ectx: ExecutorContext): Promise<ReconcileOutcome> {
    if (this.hideFromSearch) return { outcome: "inconclusive", checked: "searched Sent by Message-ID: search index not updated yet" };
    const mid = `<${input.idempotency_key}@jarvis.local>`;
    const found = this.sent.find(m => m.message_id === mid);
    if (!found) return { outcome: "no_effect", evidence: [] };
    const e = ectx.evidence.add({ type: "service_readback", claim: `reconciliation found ${mid} in Sent`, task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
      source: { capability_id: "tool:mail.send", executor: this.id }, data: { message_id: mid } });
    return { outcome: "effect_found", evidence: [ectx.evidence.ref(e)] };
  }
}

export const MAIL_DESCRIPTOR: CapabilityDescriptor = {
  id: "tool:mail.send", kind: "tool", version: "1.0.0", package: { id: "sim.mail", version: "1.0.0", hash: "sim", provenance_ref: "builtin" },
  title: "Send an email (simulated)", purpose: "Send an email with a JARVIS-generated Message-ID.", goal_patterns: ["send an email", "email someone"],
  input_schema: { type: "object" }, output_schema: { type: "object" }, prerequisites: {},
  environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: false, requires_unlocked_desktop: false, network: "internet" },
  auth: { type: "oauth2", account_binding: "required" }, side_effects: { effect_classes: ["communicate"], reversibility: "irreversible", idempotency: "key_supported", reconciliation: "Search Sent by Message-ID" },
  policy_scopes: ["mail.send"], cost: { kind: "free" }, cancellation: "not_supported", timeouts: { default_s: 5, max_s: 30 },
  verification: { method: "service_readback", describe: "fetch the sent message by Message-ID" }, evidence_emitted: ["service_readback"], known_limitations: [], isolation_tier: "T1",
  lifecycle: "active", admin_state: "enabled",
};
