import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JarvisError, MINUTE, type AuthorizationEnvelope } from "@jarvis/shared";
import { coreHarness } from "./helpers/core-fixtures.js";
import { classifyCommand } from "../src/executors/shell.js";
import { CredentialVault } from "../src/vault/vault.js";
import { MasterKeyProvider } from "../src/crypto/keys.js";

const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return e instanceof JarvisError ? e.code : `other:${(e as Error).message}`; } };
const ownerRule = { type: "owner_statement" as const, channel_verified: true };
const base = { enforcement: "broker" as const, conflict: "deny_wins" as const, compile: { status: "compiled" as const, interpretation: "HYPOTHETICAL" } };

test("rule authoring: validation, protected process, overlaps, revisions (04 §10.4-10.5, 10.8)", () => {
  const h = coreHarness();
  const bad = h.policy.propose({ ...base, kind: "constraint", text: "x", source: ownerRule, applies_to: { effects: ["communicate"] }, decision: "allow", protection: "normal",
    conditions: { field: "local_time", op: "within", value: { from: "8pm" } } });
  assert.ok(bad.errors.length >= 2, bad.errors.join("; "));
  assert.equal(code(() => h.policy.confirm(bad.rule.rule_id, { channel: "console", owner_verified: true })), "invalid_input");
  const r0 = h.policy.currentRevision();
  const archive = h.policy.propose({ ...base, kind: "constraint", text: "Never delete anything in D:\\Archive.", source: ownerRule, applies_to: { effects: ["delete.local", "write.local"], resources: [{ path_prefix: join(h.dir, "archive") }] }, decision: "deny", protection: "protected" });
  assert.equal(code(() => h.policy.confirm(archive.rule.rule_id, { channel: "push_to_talk", owner_verified: true })), "missing_permission", "protected only from the Console");
  assert.equal(code(() => h.policy.confirm(archive.rule.rule_id, { channel: "console", owner_verified: true, typed_confirmation: "yes" })), "missing_permission", "typed confirmation names the rule");
  h.policy.confirm(archive.rule.rule_id, { channel: "console", owner_verified: true, typed_confirmation: archive.rule.text });
  assert.equal(h.policy.currentRevision(), r0 + 1);
  const conflicting = h.policy.propose({ ...base, kind: "standing_permission", text: "Clean up the archive freely.", source: ownerRule, applies_to: { effects: ["delete.local"], resources: [{ path_prefix: join(h.dir, "archive", "old") }] }, decision: "allow", protection: "normal" });
  assert.deepEqual(conflicting.conflicts_with_protected, [archive.rule.rule_id]);
  assert.equal(conflicting.rule.compile.status, "needs_clarification");
  assert.equal(code(() => h.policy.revoke(archive.rule.rule_id, { channel: "console", owner_verified: true })), "missing_permission", "protected revocation needs typed confirmation");
});

test("precedence: protected deny beats everything; ceiling; normal constraint needs decision; task override skips normal but never protected", () => {
  const h = coreHarness();
  const late = h.policy.propose({ ...base, kind: "constraint", text: "No emails to clients after 8 pm without asking.", source: ownerRule,
    applies_to: { effects: ["communicate"], capabilities: ["tool:mail.send"] },
    conditions: { all: [{ field: "recipient.relationship", op: "in", value: ["client_of"] }, { field: "local_time", op: "within", value: { from: "20:00", to: "07:00" } }] }, decision: "require_decision", protection: "normal" });
  h.policy.confirm(late.rule.rule_id, { channel: "console", owner_verified: true });
  const { task } = h.task("execute", ["communicate"]);
  const req = (fields: Record<string, unknown>, t = task) => h.policy.evaluate({ task: t, action_id: "act_x", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp", targets: [], fields });
  assert.equal(req({ recipient: { relationship: ["client_of"] }, local_time: "21:15" }).decision.decision, "require_decision");
  assert.equal(req({ recipient: { relationship: ["client_of"] }, local_time: "21:15" }).decision.matched_rules[0]!.rule_id, late.rule.rule_id);
  assert.match(req({ recipient: { relationship: ["client_of"] }, local_time: "21:15" }).decision.reason_for_owner, /No emails to clients after 8 pm/);
  // a missing field fails closed for a constraint
  assert.equal(req({ local_time: "21:15" }).decision.decision, "require_decision");
  // explicit acknowledgement → task override of that normal rule
  const t2 = h.tasks.require(task.task_id);
  const over = { ...t2, overrides: [{ id: "ov1", target: { kind: "rule" as const, ref: late.rule.rule_id }, replacement: "override once", source_message_id: "msg_x" }] };
  const withOverride = h.policy.evaluate({ task: over, action_id: "act_y", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp", targets: [], fields: { recipient: { relationship: ["client_of"] }, local_time: "21:15" } });
  assert.ok(!withOverride.decision.matched_rules.some(m => m.rule_id === late.rule.rule_id));
  // ceiling: a research task can never communicate, whatever the page says (F15, F29)
  const { task: research } = h.task("research", ["read.local", "read.account", "write.local"]);
  const e = h.policy.evaluate({ task: research, action_id: "act_z", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp", targets: [], fields: {},
    value_sources: { recipient: [{ kind: "untrusted", ref: "evd_page" }] } });
  assert.equal(e.decision.decision, "deny");
  assert.match(e.decision.reason_for_owner, /research task may not communicate/);
  assert.ok(h.ctx.events.list({ type: "policy.injection_suspected" }).length >= 1, "logged as injection_suspected");
  // protected deny is not overridable
  const prot = h.policy.propose({ ...base, kind: "constraint", text: "Never email the press.", source: ownerRule, applies_to: { effects: ["communicate"] }, conditions: { field: "recipient.domain", op: "==", value: "press.example" }, decision: "deny", protection: "protected" });
  h.policy.confirm(prot.rule.rule_id, { channel: "console", owner_verified: true, typed_confirmation: prot.rule.rule_id });
  const overP = { ...t2, overrides: [{ id: "ov2", target: { kind: "rule" as const, ref: prot.rule.rule_id }, replacement: "x", source_message_id: "m" }] };
  assert.equal(h.policy.evaluate({ task: overP, action_id: "a", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp", targets: [], fields: { recipient: { domain: "press.example" } } }).decision.decision, "deny");
});

test("standing permission: bounds, per-period usage, validated skills only (04 §10.3 rail example)", () => {
  const h = coreHarness();
  const rail = h.policy.propose({ ...base, kind: "standing_permission", text: "You may book standard-class UK train tickets for my own trips, up to £80 each, £300 a month.", source: ownerRule,
    applies_to: { effects: ["commit", "spend"], capabilities: ["skill:travel.book_rail@^1"] },
    conditions: { all: [{ field: "traveler", op: "==", value: "owner" }, { field: "fare.class", op: "==", value: "standard" }, { field: "route.country", op: "==", value: "GB" }] },
    decision: "allow", bounds: { max_amount: { amount: 80, currency: "GBP" }, per_period: { period: "month", max_total: { amount: 300, currency: "GBP" } }, require_skill_lifecycle: "active" }, protection: "normal" });
  h.policy.confirm(rail.rule.rule_id, { channel: "console", owner_verified: true });
  const { task, message_id } = h.task("execute", ["commit", "spend"]);
  const ev = (amount: number, lifecycle = "active", extra: Record<string, unknown> = {}) => h.policy.evaluate({ task, action_id: `act_${amount}`, capability: "skill:travel.book_rail@1.2.0", capability_lifecycle: lifecycle,
    effects: ["commit", "spend"], tier: "T1", fingerprint: `fp${amount}`, targets: [], fields: { traveler: "owner", fare: { class: "standard" }, route: { country: "GB" }, amount: { amount, currency: "GBP" }, ...extra },
    value_sources: { amount: [{ kind: "rule", ref: rail.rule.rule_id }] } });
  const ok = ev(64);
  assert.equal(ok.decision.decision, "allow"); assert.equal(ok.decision.basis.kind, "standing_permission");
  assert.ok(ok.decision.single_use);
  assert.equal(ev(95).decision.decision, "require_decision");
  assert.match(ev(95).decision.reason_for_owner, /above 80/);
  assert.equal(ev(64, "under_test").decision.decision, "require_decision", "draft skills cannot use the permission");
  assert.equal(ev(64, "active", { fare: { class: "first" } }).decision.decision, "require_decision");
  for (const amt of [70, 75, 79]) h.policy.recordUsage(ev(amt).decision, { amount: amt, currency: "GBP" });
  assert.equal(h.policy.usageSummary(rail.rule.rule_id), "used 3 time(s) this month, 224 of 300 GBP");
  assert.equal(ev(78).decision.decision, "require_decision", "monthly cap");
  void message_id;
});

test("envelope grounding and value grounding (04 §10.6, §10.11)", () => {
  const h = coreHarness();
  const { task, message_id } = h.task("execute", ["commit", "spend"], {}, "Book the Hotel A room, up to €180 a night, 14–17 Oct (HYPOTHETICAL)");
  const env: AuthorizationEnvelope = { effects: ["commit", "spend"], substitution: "exact_target",
    bounds: [{ id: "b1", field: "amount.amount", op: "<=", value: 180, source: { kind: "owner_message", ref: message_id }, hard: true }],
    grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: message_id } }], derived_by: { adapter: "test", at: h.clock.iso() }, validated_at: h.clock.iso() };
  assert.equal(h.policy.validateEnvelope(env, task).ok, true);
  const foreign = h.ownerSays("unrelated");
  assert.equal(h.policy.validateEnvelope({ ...env, grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: foreign.id } }] }, task).ok, false);
  const worker = h.episodic.addMessage({ conversation_id: h.conv.id, author: "system", channel: "console", trust: "system", modality: "text", text: "worker says ok" });
  const t2 = h.tasks.require(task.task_id);
  const tWorker = { ...t2, origin: { ...t2.origin, message_ids: [...t2.origin.message_ids, worker.id] } };
  assert.equal(h.policy.validateEnvelope({ ...env, grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: worker.id } }] }, tWorker).ok, false, "only owner-verified messages ground authority");
  assert.equal(h.policy.validateEnvelope({ ...env, effects: ["communicate"] }, { ...task, mode: "research", intended_effects: ["read.local"] }).ok, false, "intent class mismatch");
  const withEnv = { ...task, authorization: { ...task.authorization, envelope: env } };
  const a = (amount: number, vs?: Record<string, { kind: "owner_message" | "untrusted"; ref: string }[]>) => h.policy.evaluate({ task: withEnv, action_id: "act_b", capability: "tool:booking.book@1.0.0", effects: ["commit", "spend"], tier: "T1", fingerprint: "f", targets: [],
    fields: { amount: { amount, currency: "EUR" } }, ...(vs ? { value_sources: vs } : {}) });
  assert.equal(a(172).decision.decision, "allow"); assert.equal(a(172).decision.basis.kind, "explicit_instruction");
  assert.equal(a(186).decision.decision, "require_decision", "out of the instruction's bounds");
  // Value grounding: a destination appearing only in untrusted content forces a decision, even within bounds.
  assert.equal(a(172, { destination_account: [{ kind: "untrusted", ref: "evd_email" }] }).decision.decision, "require_decision");
  assert.equal(a(172, { amount: [{ kind: "owner_message", ref: message_id }] }).decision.decision, "allow");
});

test("grants: signature, expiry, single use, fingerprint; F03 rule change between preparation and dispatch", async () => {
  const h = coreHarness();
  const { task } = h.task("execute", ["communicate"]);
  const perm = h.policy.propose({ ...base, kind: "standing_permission", text: "You may email Sam.", source: ownerRule, applies_to: { effects: ["communicate"], capabilities: ["tool:mail.send"] }, decision: "allow", bounds: { recipients: ["sam@example.com"] }, protection: "normal" });
  h.policy.confirm(perm.rule.rule_id, { channel: "console", owner_verified: true });
  const g = h.policy.evaluate({ task, action_id: "act_1", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp1", targets: [], fields: { recipients: ["sam@example.com"] }, value_sources: { recipient: [{ kind: "rule", ref: perm.rule.rule_id }] } }).decision;
  assert.equal(g.decision, "allow");
  assert.deepEqual(h.policy.verifyGrant(g, { task_revision: task.revision, fingerprint: "fp1" }), { ok: true });
  assert.equal((h.policy.verifyGrant({ ...g, action_fingerprint: "other" }, { task_revision: task.revision, fingerprint: "other" }) as { code: string }).code, "missing_permission", "tampered grant");
  assert.equal((h.policy.verifyGrant(g, { task_revision: task.revision, fingerprint: "fp2" }) as { code: string }).code, "precondition_changed");
  h.policy.markGrantUsed(g.decision_id);
  assert.equal((h.policy.verifyGrant(g, { task_revision: task.revision, fingerprint: "fp1" }) as { code: string }).code, "conflict", "single use");
  h.clock.advance(16 * MINUTE);
  const g2 = h.policy.evaluate({ task, action_id: "act_2", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp", targets: [], fields: { recipients: ["sam@example.com"] }, value_sources: { recipient: [{ kind: "rule", ref: perm.rule.rule_id }] } }).decision;
  h.clock.advance(16 * MINUTE);
  assert.equal((h.policy.verifyGrant(g2, { task_revision: task.revision, fingerprint: "fp" }) as { code: string }).code, "expired");
  // F03 end to end through the Broker: authorize, then revoke before dispatch → invalidated, nothing sent.
  const g3 = h.policy.evaluate({ task, action_id: "act_3", capability: "tool:mail.send@1.0.0", effects: ["communicate"], tier: "T1", fingerprint: "fp3", targets: [], fields: { recipients: ["sam@example.com"] } }).decision;
  h.policy.revoke(perm.rule.rule_id, { channel: "console", owner_verified: true });
  const v = h.policy.verifyGrant(g3, { task_revision: task.revision, fingerprint: "fp3" });
  assert.equal(v.ok, false); assert.equal((v as { reevaluate?: boolean }).reevaluate, true);
});

test("broker: in-scope writes allowed with evidence and recovery bin; outside scope needs a decision; symlink cannot escape (05 §11.11)", async () => {
  const h = coreHarness();
  mkdirSync(join(h.dir, "work"), { recursive: true });
  const { task } = h.task("execute", ["read.local", "write.local", "delete.local"]);
  const target = join(h.dir, "work", "notes.md");
  const w1 = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: target, content: "v1" }, requested_by: { kind: "boss", ref: "t" }, verify_fields: ["path"] });
  assert.equal(w1.status, "done");
  assert.equal(readFileSync(target, "utf8"), "v1");
  assert.equal(h.actions.get(w1.action_id!).state, "verified");
  const w2 = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: target, content: "v2" }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(w2.status, "done");
  assert.ok((w2 as { result: { output: { recovery_snapshot: string } } }).result.output.recovery_snapshot, "overwrite snapshotted");
  // outside the scope → decision, not a silent write
  const out = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: join(h.dir, "elsewhere.txt"), content: "x" }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(out.status, "waiting_decision");
  assert.equal(h.tasks.require(task.task_id).status, "waiting");
  assert.ok(!existsSync(join(h.dir, "elsewhere.txt")));
  if (out.status === "waiting_decision") {
    const r = await h.broker.onDecision(out.decision_request.decision_request_id, "approve", out.decision_request.proposal_fingerprint, true);
    assert.equal(r.status, "done");
    assert.ok(existsSync(join(h.dir, "elsewhere.txt")));
  }
  // a symlink inside the scope pointing outside it is resolved first
  mkdirSync(join(h.dir, "secret"), { recursive: true });
  writeFileSync(join(h.dir, "secret", "s.txt"), "s");
  symlinkSync(join(h.dir, "secret"), join(h.dir, "work", "link"));
  const sneaky = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: join(h.dir, "work", "link", "s.txt"), content: "pwned" }, requested_by: { kind: "worker", ref: "wo" } });
  assert.equal(sneaky.status, "waiting_decision", "resolved target is outside the scope: " + JSON.stringify(sneaky).slice(0, 400));
  assert.equal(readFileSync(join(h.dir, "secret", "s.txt"), "utf8"), "s");
  if (sneaky.status === "waiting_decision") {
    const d = await h.broker.onDecision(sneaky.decision_request.decision_request_id, "decline", sneaky.decision_request.proposal_fingerprint, true);
    assert.equal(d.status, "declined");
    assert.equal(h.tasks.require(task.task_id).status, "running");
  }
  // recoverable delete
  const del = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.delete", params: { path: target }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(del.status, "waiting_decision", "delete.local without an explicit envelope needs a decision");
  rmSync(h.dir, { recursive: true, force: true });
});

test("broker: F38 unknown capability suggests; disabled refuses; emergency stop halts; F54 placeholders", async () => {
  const h = coreHarness();
  mkdirSync(join(h.dir, "work"), { recursive: true });
  const { task } = h.task("execute", ["read.local", "write.local"]);
  const unk = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.writ", params: {}, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(unk.status, "error");
  if (unk.status !== "waiting_decision") assert.match(unk.result.error!.message, /did you mean .*tool:files/);
  h.registry.setAdminState("tool:files.write", "disabled", "test");
  const dis = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: join(h.dir, "work", "a"), content: "x" }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(dis.status !== "waiting_decision" && dis.result.error!.code, "unsupported_operation");
  h.registry.setAdminState("tool:files.write", "enabled", "test");
  h.broker.halt("hotkey");
  const halted = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: join(h.dir, "work", "a"), content: "x" }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(halted.status !== "waiting_decision" && halted.result.error!.code, "cancelled");
  assert.throws(() => h.broker.resumeAfterHalt(false));
  h.broker.resumeAfterHalt(true);
  const rec = h.memory.remember({ type: "fact", text: "HYPOTHETICAL home address", content: { predicate: "home.address", value: "1 Example Road" }, scope: { level: "global" }, subject_entity_ids: ["owner"], sensitivity: "restricted", message_id: "m" });
  const id = "record" in rec ? rec.record.id : "";
  const f = join(h.dir, "work", "label.txt");
  const w = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: f, content: `Ship to {{mem:${id}#value}}` }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(w.status, "done");
  assert.equal(readFileSync(f, "utf8"), "Ship to 1 Example Road", "late-bound inside the executor");
  const params = JSON.stringify(h.actions.resolvedParams(w.status === "done" ? w.action_id! : ""));
  assert.ok(!params.includes("1 Example Road"), "stored parameters keep the placeholder");
  h.memory.delete([id], "owner");
  const w2 = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.write", params: { path: f, content: `Ship to {{mem:${id}#value}}` }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(w2.status, "error"); assert.match(w2.status === "error" ? w2.result.error!.message : "", /placeholder/);
  rmSync(h.dir, { recursive: true, force: true });
});

test("F13: commit-then-timeout → uncertain → reconciliation finds it; never re-sent; inconclusive → owner decision", async () => {
  const h = coreHarness();
  const { task, message_id } = h.task("execute", ["communicate"], {}, "Email Sam that I'm 10 minutes late (HYPOTHETICAL)");
  const env: AuthorizationEnvelope = { effects: ["communicate"], substitution: "exact_target",
    bounds: [{ id: "b1", field: "recipients", op: "in", value: ["sam@example.com"], source: { kind: "owner_message", ref: message_id }, hard: true }],
    grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: message_id } }], derived_by: { adapter: "test", at: h.clock.iso() }, validated_at: h.clock.iso() };
  h.tasks.revise(task.task_id, [{ op: "add", path: "/authorization/envelope", value: env }], "envelope");
  h.mail.mode = "commit_then_timeout";
  const send = () => h.broker.execute({ task_id: task.task_id, capability: "tool:mail.send", params: { to: ["sam@example.com"], subject: "Late", body: "10 min" }, requested_by: { kind: "boss", ref: "t" },
    fields: { recipients: ["sam@example.com"] }, value_sources: { recipient: [{ kind: "owner_message", ref: message_id }] }, verify_fields: ["to", "subject"] });
  const r = await send();
  assert.equal(r.status, "uncertain");
  const id = r.status === "uncertain" ? r.action_id! : "";
  assert.equal(h.actions.get(id).state, "uncertain");
  assert.equal(h.mail.sent.length, 1, "the service did commit");
  assert.equal(code(() => h.actions.dispatch(id)), "conflict", "no blind retry");
  h.clock.advance(61_000);
  const rec = await h.broker.reconcileDue();
  assert.deepEqual(rec.map(x => x.outcome), ["effect_found"]);
  assert.equal(h.actions.get(id).state, "verified");
  assert.equal(h.mail.sent.length, 1, "exactly one email");
  // Inconclusive through the whole window → an owner decision, not a retry.
  h.mail.mode = "commit_then_timeout"; h.mail.hideFromSearch = true;
  const r2 = await h.broker.execute({ task_id: task.task_id, capability: "tool:mail.send", params: { to: ["sam@example.com"], subject: "Second", body: "x" }, requested_by: { kind: "boss", ref: "t" },
    fields: { recipients: ["sam@example.com"] }, value_sources: { recipient: [{ kind: "owner_message", ref: message_id }] } });
  assert.equal(r2.status, "uncertain");
  for (const step of [61_000, 5 * MINUTE, 21 * MINUTE]) { h.clock.advance(step); await h.broker.reconcileDue(); }
  const open = h.policy.openDecisionRequests(task.task_id);
  assert.equal(open.length, 1);
  assert.match(open[0]!.why.text, /Retrying could do it twice/);
  assert.equal(h.tasks.require(task.task_id).status, "waiting");
  assert.equal(h.mail.sent.length, 2);
});

test("F14: pre-commit re-read — drift within bounds proceeds, beyond bounds stops with no booking", async () => {
  const h = coreHarness();
  const { task, message_id } = h.task("execute", ["commit", "spend"], {}, "Book Hotel A, up to €180 a night (HYPOTHETICAL)");
  const env: AuthorizationEnvelope = { effects: ["commit", "spend"], substitution: "exact_target",
    bounds: [{ id: "b1", field: "amount.amount", op: "<=", value: 180, source: { kind: "owner_message", ref: message_id }, hard: true }],
    grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: message_id } }], derived_by: { adapter: "test", at: h.clock.iso() }, validated_at: h.clock.iso() };
  h.tasks.revise(task.task_id, [{ op: "add", path: "/authorization/envelope", value: env }], "envelope");
  const book = (guest: string) => h.broker.execute({ task_id: task.task_id, capability: "tool:booking.book", params: { hotel: "Hotel A", checkin: "2026-10-14", nights: 3, guest }, requested_by: { kind: "boss", ref: "t" },
    fields: { amount: { amount: 172, currency: "EUR" } }, value_sources: { amount: [{ kind: "owner_message", ref: message_id }] }, verify_fields: ["hotel", "nights"] });
  h.booking.livePrice = 178;
  const ok = await book("HYPOTHETICAL Guest 1");
  assert.equal(ok.status, "done", JSON.stringify(ok).slice(0, 500));
  assert.equal(h.booking.bookings.length, 1);
  assert.ok(h.ctx.events.list({ type: "action.precommit_checked" }).length === 1);
  h.booking.livePrice = 186;
  const stop = await book("HYPOTHETICAL Guest 2");
  assert.equal(stop.status, "error");
  assert.equal(stop.status === "error" ? stop.result.error!.code : "", "precondition_changed");
  assert.match(stop.status === "error" ? stop.result.error!.message : "", /186/);
  assert.equal(h.booking.bookings.length, 1, "no booking above the bound");
  assert.equal(h.actions.get(stop.status === "error" ? stop.action_id! : "").state, "failed_no_effect");
});

test("vault: encrypted at rest, secrets only inside use(), exact-match redaction, expiry", async () => {
  const h = coreHarness();
  const path = join(h.dir, "vault", "vault.bin");
  const keys = MasterKeyProvider.ephemeral();
  const v = new CredentialVault(path, keys, h.clock);
  const m = v.put({ kind: "api_key", provider: "anthropic", label: "Anthropic API key" }, "sk-ant-HYPOTHETICAL-0123456789abcdef");
  assert.ok(!readFileSync(path).toString("latin1").includes("0123456789abcdef"), "ciphertext on disk");
  assert.ok(!JSON.stringify(v.list()).includes("0123456789abcdef"), "listing shows metadata only");
  const len = await v.use(m.credential_ref, "model call", s => s.length);
  assert.equal(len, "sk-ant-HYPOTHETICAL-0123456789abcdef".length);
  assert.equal(v.redactor.redact("error: bad key sk-ant-HYPOTHETICAL-0123456789abcdef"), "error: bad key [redacted-secret]");
  const v2 = new CredentialVault(path, keys, h.clock);
  assert.equal(v2.list().length, 1, "reloads from disk");
  const t = v.put({ kind: "oauth_token", provider: "google", label: "Google", expires_at: "2026-10-01T10:00:00Z" }, "ya29.HYPOTHETICAL");
  h.clock.set("2026-10-01T11:00:00Z");
  await assert.rejects(v.use(t.credential_ref, "x", () => 1), (e: unknown) => e instanceof JarvisError && e.code === "auth_required");
  await assert.rejects(v.use("cred_missing", "x", () => 1), (e: unknown) => e instanceof JarvisError && e.code === "missing_credential");
  assert.ok(v.delete(m.credential_ref));
  assert.throws(() => new CredentialVault(path, MasterKeyProvider.ephemeral(), h.clock), /authentication/, "wrong key cannot open the vault");
});

test("registry: search with hard filters and cards; passive degradation; F11 node lock; service policy", async () => {
  const h = coreHarness();
  const cards = h.registry.search("send an email", { mode: "research", intended_effects: ["read.local"] });
  assert.equal(cards[0]!.id, "tool:mail.send");
  assert.equal(cards[0]!.needs_scope_expansion, true, "flagged, not hidden");
  assert.ok(cards.every(c => c.purpose.length <= 200));
  for (let i = 0; i < 3; i++) h.registry.recordOutcome("tool:web.fetch", false, { error_code: "transient_service_error" });
  assert.equal(h.registry.health("tool:web.fetch").state, "degraded");
  h.registry.recordOutcome("tool:web.fetch", true);
  assert.equal(h.registry.health("tool:web.fetch").state, "available");
  h.registry.register({ ...h.registry.resolve("tool:files.read")!, id: "tool:desktop.click", title: "Click", purpose: "click a desktop element", environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: true, requires_unlocked_desktop: true, network: "none" } }, { via: "builtin" });
  const changed = h.registry.onNodeAvailability("locked");
  assert.ok(changed.includes("tool:desktop.click") && !changed.includes("tool:files.read"), "background capabilities continue while locked");
  const { task } = h.task("execute", ["read.local"]);
  const r = await h.broker.execute({ task_id: task.task_id, capability: "tool:desktop.click", params: { path: h.dir }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(r.status !== "waiting_decision" && r.result.error!.code, "unavailable_device");
  h.registry.onNodeAvailability("unlocked");
  assert.equal(h.registry.health("tool:desktop.click").state, "available");
  h.registry.setServicePolicy({ service: "upwork.com", ui_automation: "prohibited", api: "approval_required", notes: "HYPOTHETICAL citation", sources: [{ url: "https://support.upwork.com/", checked_at: "2026-09-25", status: "V-S" }] });
  assert.equal(h.registry.servicePolicy("www.upwork.com").ui_automation, "prohibited");
  assert.equal(h.registry.servicePolicy("unknown.example").ui_automation, "unknown");
  assert.equal(code(() => h.registry.register({ ...h.registry.resolve("tool:files.read")!, id: "tool:evil", package: { id: "x", version: "1", hash: "h", provenance_ref: "download" } }, { via: "builtin" })), "missing_permission");
});

test("verifier: F07 worker success claim rejected when evidence fails; criteria need acceptable evidence", () => {
  const h = coreHarness();
  const { task } = h.task("build", ["read.local", "write.local", "execute_code"]);
  const failing = h.evidence.add({ type: "test_result", claim: "3 of 12 tests failed", task_id: task.task_id, source: { capability_id: "tool:shell.run", executor: "test" }, data: { passed: false } });
  const wo = { work_order_id: "wo_1", task_id: task.task_id, step_id: "stp_1", task_revision: 1, worker_type: "claude_code" as const, objective: "x", context_package_id: "ctx", inputs: [], allowed_capabilities: [], allowed_effects: [],
    leases: [], budget: { max_wall_time: "PT1H", subscription_allowed: true, paid_fallback: "never" as const }, output_schema: {}, verification: { required_evidence: ["test_result" as const] }, policy_revision: 1, constraints: [],
    report: { progress: true, questions: "allowed" as const, heartbeat_s: 30 }, capability_token_ref: "tok" };
  const res = { work_order_id: "wo_1", status: "succeeded" as const, claims: [{ text: "All tests pass, done!", evidence_ids: [failing.evidence_id] }], artifacts: [], proposed_memory_updates: [], failures: [], usage: { duration_ms: 1 }, remaining_risks: [] };
  const v = h.verifier.checkWorkerResult(wo, res);
  assert.equal(v.accepted, false);
  assert.ok(h.ctx.events.list({ type: "worker.claim_rejected" }).length === 1);
  const passing = h.evidence.add({ type: "test_result", claim: "12 of 12 passed", task_id: task.task_id, source: { capability_id: "tool:shell.run", executor: "test" }, data: { passed: true } });
  assert.equal(h.verifier.checkWorkerResult(wo, { ...res, claims: [{ text: "tests pass", evidence_ids: [passing.evidence_id] }] }).accepted, true);
  assert.equal(h.verifier.checkWorkerResult(wo, { ...res, claims: [] }).accepted, false, "no claims, no success");
  // criteria
  const f = join(h.dir, "out.txt"); writeFileSync(f, "hello world");
  const t2 = { ...task, success_criteria: [
    { id: "c1", description: "report exists", check: { kind: "file_content" as const, spec: { path: f, contains: "hello" } }, acceptable_evidence: ["file_check" as const], required: true },
    { id: "c2", description: "judged good", check: { kind: "model_judgement" as const, spec: {} }, acceptable_evidence: ["owner_confirmation" as const], required: true } ] };
  h.evidence.add({ type: "model_judgement", claim: "looks great", criterion_id: "c2", task_id: task.task_id, source: { capability_id: "boss", executor: "model" }, data: {} });
  const verdicts = h.verifier.checkCriteria(t2);
  assert.equal(verdicts[0]!.status, "verified");
  assert.equal(verdicts[1]!.status, "unverified", "a model's judgement cannot satisfy a criterion that needs your confirmation");
  rmSync(h.dir, { recursive: true, force: true });
});

test("shell: catalog classification, structured argv, timeout kills the tree, output bounded and redacted", async () => {
  assert.deepEqual(classifyCommand("C:\\Program Files\\Git\\cmd\\git.exe", ["status"]), ["read.local"]);
  assert.deepEqual(classifyCommand("/usr/bin/git", ["push"]), ["communicate", "publish"]);
  assert.deepEqual(classifyCommand("/usr/bin/npm", ["install"]), ["install", "execute_code"]);
  assert.deepEqual(classifyCommand("/opt/x/unknown-tool", []), ["execute_code"]);
  const h = coreHarness();
  mkdirSync(join(h.dir, "work"), { recursive: true });
  const { task } = h.task("execute", ["read.local", "execute_code"]);
  const m = h.tasks.require(task.task_id).origin.message_ids[0]!;
  const unbounded = { effects: ["execute_code" as const], substitution: "exact_target" as const, bounds: [], grounding: [], derived_by: { adapter: "t", at: h.clock.iso() }, validated_at: h.clock.iso() };
  assert.equal(h.policy.validateEnvelope(unbounded, task).ok, false, "an instruction authorizing code must bound it");
  const env = { ...unbounded, bounds: [{ id: "b1", field: "program", op: "in" as const, value: ["/bin/sh", "/bin/ls"], source: { kind: "owner_message" as const, ref: m }, hard: true }],
    grounding: [{ constraint_id: "b1", source: { kind: "owner_message" as const, ref: m } }] };
  h.tasks.revise(task.task_id, [{ op: "add", path: "/authorization/envelope", value: env }], "envelope");
  const other = await h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run", params: { program: "/usr/bin/env", args: ["true"], cwd: join(h.dir, "work"), env_allowlist: [], timeout_s: 5, max_output_bytes: 100, tier: "T1", job_limits: {} }, requested_by: { kind: "boss", ref: "t" }, fields: { program: "/bin/sh" } });
  assert.equal(other.status, "waiting_decision", "a program outside the bound needs a decision; the caller cannot claim a different program");
  if (other.status === "waiting_decision") await h.broker.onDecision(other.decision_request.decision_request_id, "decline", other.decision_request.proposal_fingerprint, true);
  const ls = await h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run", params: { program: "/bin/ls", args: ["-1"], cwd: join(h.dir, "work"), env_allowlist: [], timeout_s: 10, max_output_bytes: 10_000, tier: "T1", job_limits: {} }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(ls.status, "done", "read-only command in scope needs no action lifecycle");
  const sh = await h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run", params: { program: "/bin/sh", args: ["-c", "echo token=sk-ant-HYPOTHETICAL-abcdefghijkl; head -c 50000 /dev/zero | tr '\\0' x"], cwd: join(h.dir, "work"), env_allowlist: [], timeout_s: 10, max_output_bytes: 2000, tier: "T1", job_limits: {} }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(sh.status, "done");
  const out = (sh as { result: { output: { output: string; truncated: boolean } } }).result.output;
  assert.ok(out.truncated && out.output.length < 2300);
  assert.ok(!out.output.includes("abcdefghijkl"), "redacted");
  const t0 = Date.now();
  const slow = await h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run", params: { program: "/bin/sh", args: ["-c", "sleep 30 & sleep 30"], cwd: join(h.dir, "work"), env_allowlist: [], timeout_s: 1, max_output_bytes: 1000, tier: "T1", job_limits: {} }, requested_by: { kind: "boss", ref: "t" } });
  assert.ok(Date.now() - t0 < 10_000, "killed at the timeout");
  assert.equal(slow.status === "waiting_decision" ? "" : slow.result.error?.code, "uncertain_external_effect", "an effectful command that timed out is uncertain");
  const rel = await h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run", params: { program: "ls", args: [], cwd: join(h.dir, "work"), env_allowlist: [], timeout_s: 5, max_output_bytes: 100, tier: "T1", job_limits: {} }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(rel.status === "waiting_decision" ? "" : rel.result.error?.code, "invalid_input");
  rmSync(h.dir, { recursive: true, force: true });
});

test("review fixes: conflict semantics, refundable bound, suspension on degrade/disable, out-of-scope read asks, unvalidated blocked, accounts, redaction", async () => {
  const h = coreHarness();
  mkdirSync(join(h.dir, "work"), { recursive: true });
  // most_specific_wins: a narrower standing permission beats a broad deny; "ask" turns a deny into a decision.
  const broad = h.policy.propose({ ...base, kind: "constraint", text: "No purchases.", source: ownerRule, applies_to: { effects: ["spend"] }, decision: "deny", protection: "normal" });
  h.policy.confirm(broad.rule.rule_id, { channel: "console", owner_verified: true });
  const narrow = h.policy.propose({ ...base, kind: "standing_permission", text: "Except printer ink up to $40.", source: ownerRule, applies_to: { effects: ["spend"], capabilities: ["tool:shop.buy"] }, conditions: { field: "item", op: "==", value: "ink" }, decision: "allow", bounds: { max_amount: { amount: 40, currency: "USD" } }, protection: "normal" });
  h.policy.confirm(narrow.rule.rule_id, { channel: "console", owner_verified: true });
  const { task } = h.task("execute", ["spend"]);
  const buy = () => h.policy.evaluate({ task, action_id: "a", capability: "tool:shop.buy@1.0.0", effects: ["spend"], tier: "T1", fingerprint: "f", targets: [], fields: { item: "ink", amount: { amount: 30, currency: "USD" } }, value_sources: { amount: [{ kind: "rule", ref: narrow.rule.rule_id }] } }).decision.decision;
  assert.equal(buy(), "deny", "deny_wins by default");
  h.ctx.db.prepare("update rules set rule = json_set(rule, '$.conflict', 'most_specific_wins') where rule_id = ?").run(broad.rule.rule_id);
  h.ctx.db.prepare("insert into policy_revisions(revision, at, source, change) values (?, ?, 'test', '{}')").run(h.policy.currentRevision() + 1, h.clock.iso());
  assert.equal(buy(), "allow");
  h.ctx.db.prepare("update rules set rule = json_set(rule, '$.conflict', 'ask') where rule_id = ?").run(broad.rule.rule_id);
  h.ctx.db.prepare("insert into policy_revisions(revision, at, source, change) values (?, ?, 'test', '{}')").run(h.policy.currentRevision() + 1, h.clock.iso());
  assert.equal(buy(), "require_decision");
  h.policy.revoke(broad.rule.rule_id, { channel: "console", owner_verified: true });
  // refundable bound travels in the grant and is re-checked before commit
  const hotel = h.policy.propose({ ...base, kind: "standing_permission", text: "Book refundable hotels up to €200.", source: ownerRule, applies_to: { effects: ["commit", "spend"], capabilities: ["tool:booking.book"] }, decision: "allow", bounds: { max_amount: { amount: 200, currency: "EUR" }, require_refundable: true }, protection: "normal" });
  h.policy.confirm(hotel.rule.rule_id, { channel: "console", owner_verified: true });
  const { task: bt } = h.task("execute", ["commit", "spend"]);
  h.booking.refundable = false;
  const r = await h.broker.execute({ task_id: bt.task_id, capability: "tool:booking.book", params: { hotel: "Hotel B", checkin: "2026-11-01", nights: 1, guest: "HYPOTHETICAL" }, requested_by: { kind: "boss", ref: "t" },
    fields: { amount: { amount: 150, currency: "EUR" }, refundable: true }, value_sources: { amount: [{ kind: "rule", ref: hotel.rule.rule_id }] } });
  assert.equal(r.status === "error" ? r.result.error!.code : r.status, "precondition_changed", "terms changed to non-refundable before commit");
  assert.equal(h.booking.bookings.length, 0);
  // degradation suspends the linked permission; recovery resumes it; disabling suspends too
  for (let i = 0; i < 3; i++) { h.booking.refundable = false; await h.broker.execute({ task_id: bt.task_id, capability: "tool:booking.book", params: { hotel: `H${i}`, checkin: "2026-11-01", nights: 1, guest: "G" }, requested_by: { kind: "boss", ref: "t" }, fields: { amount: { amount: 150, currency: "EUR" }, refundable: true }, value_sources: { amount: [{ kind: "rule", ref: hotel.rule.rule_id }] } }); }
  assert.equal(h.registry.health("tool:booking.book").state, "degraded");
  assert.equal(h.policy.getRule(hotel.rule.rule_id)!.status, "suspended");
  const dis = h.broker.disableCapability("tool:mail.send", "owner request");
  assert.deepEqual(dis.stopped, []);
  // a read outside the task's scope asks instead of failing
  const { task: rt } = h.task("research", ["read.local", "read.account", "write.local"]);
  writeFileSync(join(h.dir, "outside.txt"), "x");
  const rd = await h.broker.execute({ task_id: rt.task_id, capability: "tool:files.read", params: { path: join(h.dir, "outside.txt") }, requested_by: { kind: "boss", ref: "t" } });
  assert.equal(rd.status, "waiting_decision");
  // draft capabilities are not dispatchable outside validation
  h.registry.register({ ...h.registry.resolve("tool:files.read")!, id: "tool:new.thing", version: "0.1.0", lifecycle: "draft" }, { via: "builtin" });
  assert.equal(code(() => h.registry.require("tool:new.thing")), "unsupported_operation");
  assert.equal(h.registry.require("tool:new.thing", { allowUnvalidated: true }).lifecycle, "draft");
  // accounts: revoking deletes the credential and fires listeners
  const { AccountStore } = await import("../src/vault/accounts.js");
  const accounts = new AccountStore(h.ctx, h.vault);
  const cred = h.vault.put({ kind: "oauth_token", provider: "google", label: "Google" }, "ya29.HYPOTHETICAL-TOKEN-123");
  const acc = accounts.connect({ connector: "google", identity: "owner@example.com", scopes: ["drive.file"], credential_ref: cred.credential_ref, revocation_instructions: "Google Account → Security → Third-party access" });
  const revoked: string[] = [];
  accounts.onRevoked(id => revoked.push(...h.broker.onAccountRevoked(id), id));
  accounts.revoke(acc.account_id, true);
  assert.equal(h.vault.meta(cred.credential_ref), undefined);
  assert.ok(revoked.includes(acc.account_id));
  // released secrets are scrubbed from event summaries and data
  await h.vault.use(cred.credential_ref === "" ? "" : h.vault.put({ kind: "api_key", provider: "x", label: "x" }, "SECRET-VALUE-9876").credential_ref, "t", () => 0);
  h.ctx.events.setRedactor(s => h.vault.redactor.redact(s));
  const ev = h.ctx.events.append({ type: "t", summary: "failed with SECRET-VALUE-9876", data: { note: "SECRET-VALUE-9876" } });
  assert.ok(!JSON.stringify(ev).includes("SECRET-VALUE-9876"));
  rmSync(h.dir, { recursive: true, force: true });
});

test("review fixes: your approval answers an 'ask me' rule; a pending decision survives a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { SimClock } = await import("@jarvis/shared");
  const { createContext } = await import("../src/context.js");
  const { TaskEngine } = await import("../src/tasks/task-engine.js");
  const { ActionService } = await import("../src/tasks/actions.js");
  const { LeaseManager } = await import("../src/tasks/leases.js");
  const { MemoryService } = await import("../src/memory/memory-service.js");
  const { EpisodicStore } = await import("../src/memory/episodic.js");
  const { PolicyEngine } = await import("../src/policy/policy-engine.js");
  const { CapabilityRegistry } = await import("../src/registry/registry.js");
  const { EvidenceStore, Verifier } = await import("../src/verifier/verifier.js");
  const { Broker } = await import("../src/broker/broker.js");
  const { MailSim, MAIL_DESCRIPTOR } = await import("./sim/mail-sim.js");
  const { contract } = await import("./helpers/fixtures.js");
  const dir = mkdtempSync(join(tmpdir(), "jv-restart-"));
  const clock = new SimClock("2026-10-01T21:15:00Z");
  const boot = () => {
    const ctx = createContext({ dataDir: dir, clock });
    const tasks = new TaskEngine(ctx), actions = new ActionService(ctx), leases = new LeaseManager(ctx);
    tasks.actions = actions; tasks.leases = leases;
    const memory = new MemoryService(ctx), episodic = new EpisodicStore(ctx);
    const policy = new PolicyEngine(ctx, { messageTrust: id => episodic.getMessage(id)?.trust as "owner_verified" | undefined, memoryRecordTrusted: () => false });
    const registry = new CapabilityRegistry(ctx);
    const vault = new CredentialVault(null, ctx.keys, clock);
    const evidence = new EvidenceStore(ctx);
    const broker = new Broker(ctx, tasks, actions, leases, policy, registry, memory, vault, evidence, new Verifier(ctx, evidence));
    const mail = new MailSim(); broker.registerExecutor(mail);
    registry.register(MAIL_DESCRIPTOR, { via: "builtin" });
    return { ctx, tasks, actions, policy, broker, episodic, mail };
  };
  const a = boot();
  const late = a.policy.propose({ ...base, kind: "constraint", text: "No emails to clients after 8 pm without asking.", source: ownerRule, applies_to: { effects: ["communicate"] },
    conditions: { field: "local_time", op: "within", value: { from: "20:00", to: "07:00" } }, decision: "require_decision", protection: "normal" });
  a.policy.confirm(late.rule.rule_id, { channel: "console", owner_verified: true });
  const conv = a.episodic.startConversation("console");
  const m = a.episodic.addMessage({ conversation_id: conv.id, author: "owner", channel: "console", trust: "owner_verified", modality: "text", text: "Email Dana the invoice (HYPOTHETICAL)" });
  const t = a.tasks.create(contract("execute", ["communicate"], { origin: { channel: "console_text", conversation_id: conv.id, message_ids: [m.id], owner_verified: true },
    authorization: { basis: ["explicit_instruction"], grant_ids: [], policy_revision: 1, envelope: { effects: ["communicate"], substitution: "exact_target",
      bounds: [{ id: "b1", field: "recipients", op: "in", value: ["dana@example.com"], source: { kind: "owner_message", ref: m.id }, hard: true }],
      grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: m.id } }], derived_by: { adapter: "t", at: clock.iso() }, validated_at: clock.iso() } } }));
  a.tasks.transition(t.task_id, "planned"); a.tasks.transition(t.task_id, "running");
  const r = await a.broker.execute({ task_id: t.task_id, capability: "tool:mail.send", params: { to: ["dana@example.com"], subject: "Invoice", body: "attached" }, requested_by: { kind: "boss", ref: "t" },
    fields: { recipients: ["dana@example.com"], local_time: "21:15" }, value_sources: { recipient: [{ kind: "owner_message", ref: m.id }] } });
  assert.equal(r.status, "waiting_decision");
  const dec = r.status === "waiting_decision" ? r.decision_request : undefined;
  assert.match(dec!.why.text, /No emails to clients after 8 pm/);
  a.ctx.db.close();
  // ---- restart before you answer ----
  const b = boot();
  const out = await b.broker.onDecision(dec!.decision_request_id, "approve", dec!.proposal_fingerprint, true);
  assert.equal(out.status, "done", JSON.stringify(out).slice(0, 300));
  assert.equal(b.mail.sent.length, 1);
  assert.equal(b.actions.get((out as { action_id: string }).action_id).state, "verified");
  b.ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("review fix: envelope bounds apply to the actions they describe; a bounded effect never passes on a missing field", () => {
  const h = coreHarness();
  const { task, message_id } = h.task("execute", ["communicate", "execute_code"], {}, "Run the report script and email it to sam@example.com (HYPOTHETICAL)");
  const env: AuthorizationEnvelope = { effects: ["communicate", "execute_code"], substitution: "exact_target",
    bounds: [{ id: "b1", field: "program", op: "in", value: ["/bin/sh"], source: { kind: "owner_message", ref: message_id }, hard: true },
      { id: "b2", field: "recipients", op: "in", value: ["sam@example.com"], source: { kind: "owner_message", ref: message_id }, hard: true }],
    grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: message_id } }, { constraint_id: "b2", source: { kind: "owner_message", ref: message_id } }],
    derived_by: { adapter: "t", at: h.clock.iso() }, validated_at: h.clock.iso() };
  const t = { ...task, authorization: { ...task.authorization, envelope: env } };
  const ev = (effects: ("communicate" | "execute_code")[], fields: Record<string, unknown>) => h.policy.evaluate({ task: t, action_id: "a", capability: "tool:x@1.0.0", effects, tier: "T1", fingerprint: "f", targets: [], fields,
    value_sources: effects.includes("communicate") ? { recipient: [{ kind: "owner_message", ref: message_id }] } : {} }).decision.decision;
  assert.equal(ev(["execute_code"], { program: "/bin/sh" }), "allow");
  assert.equal(ev(["communicate"], { recipients: ["sam@example.com"] }), "allow");
  assert.equal(ev(["communicate"], { recipients: ["eve@example.com"] }), "require_decision");
  assert.equal(ev(["communicate"], {}), "require_decision", "no recipients field: nothing bounds this send");
  assert.equal(ev(["execute_code"], { program: "/usr/bin/python3" }), "require_decision");
});
