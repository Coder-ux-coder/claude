import { JarvisError, type NepInvoke, type CapabilityDescriptor } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult, ReconcileOutcome } from "../../src/broker/types.js";

/** Simulated booking site (14 §19.2): the price can drift between preparation and submission (F14). */
export class BookingSim implements Executor {
  id = "sim:booking"; version = "1.0.0"; capabilities = ["tool:booking.book"];
  bookings: { key: string; hotel: string; nights: number; price: number; ref: string }[] = [];
  livePrice = 172;
  refundable = true;

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const p = nep.params as { hotel: string; checkin: string; nights: number; guest: string };
    // Pre-commit re-read of the live page (04 §10.6 moment 3).
    ectx.preCommit({ amount: { amount: this.livePrice, currency: "EUR" }, refundable: this.refundable, account: "acc_personal" });
    const key = `${p.hotel}|${p.checkin}|${p.guest}`;
    if (this.bookings.some(b => b.key === key)) throw new JarvisError("conflict", "already booked", { effect_state: "complete" });
    const ref = `EX-${48213 + this.bookings.length}`;
    this.bookings.push({ key, hotel: p.hotel, nights: p.nights, price: this.livePrice, ref });
    const e = ectx.evidence.add({ type: "service_readback", claim: `booking ${ref} found in My Trips`, task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
      source: { capability_id: "tool:booking.book", executor: this.id }, data: { ref, price: this.livePrice } });
    return { status: "ok", effect_state: "complete", output: { ref, price: this.livePrice }, evidence: [ectx.evidence.ref(e)], observed_fields: { hotel: p.hotel, nights: p.nights } };
  }

  async reconcile(input: { params: unknown }, _ectx: ExecutorContext): Promise<ReconcileOutcome> {
    const p = input.params as { hotel: string; checkin: string; guest: string };
    return this.bookings.some(b => b.key === `${p.hotel}|${p.checkin}|${p.guest}`) ? { outcome: "effect_found", evidence: [] } : { outcome: "no_effect", evidence: [] };
  }
}

export const BOOKING_DESCRIPTOR: CapabilityDescriptor = {
  id: "tool:booking.book", kind: "tool", version: "1.0.0", package: { id: "sim.booking", version: "1.0.0", hash: "sim", provenance_ref: "builtin" },
  title: "Book a hotel room (simulated)", purpose: "Book a hotel room on the simulated booking site.", goal_patterns: ["book a hotel"],
  input_schema: { type: "object" }, output_schema: { type: "object" }, prerequisites: {},
  environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: true, requires_unlocked_desktop: false, network: "internet" },
  auth: { type: "browser_session", account_binding: "required" }, side_effects: { effect_classes: ["commit", "spend"], reversibility: "compensable", idempotency: "none", reconciliation: "check My Trips for property + dates + guest" },
  policy_scopes: ["booking.book", "ui_automation"], cost: { kind: "free" }, cancellation: "not_supported", timeouts: { default_s: 5, max_s: 30 },
  verification: { method: "service_readback", describe: "find the booking in My Trips" }, evidence_emitted: ["service_readback"], known_limitations: ["Cancellation terms can change"], isolation_tier: "T1",
  lifecycle: "active", admin_state: "enabled",
};
