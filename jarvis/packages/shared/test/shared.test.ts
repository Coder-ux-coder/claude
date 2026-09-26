import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newId, isId, idPrefix, canonicalJson, hashObject, SimClock, parseDuration, HOUR,
  JarvisError, toStructured, redactMessage, RETRY_POLICY, backoffMs, ERROR_DEFAULTS, ErrorCode,
  TASK_TRANSITIONS, canTransitionTask, TERMINAL_TASK_STATUSES, ACTION_TRANSITIONS, canTransitionAction,
  MODE_CEILINGS, MODE_FORBIDDEN, TaskContract, CapabilityDescriptor, PolicyCondition, TaskStatus, ActionState,
} from "../src/index.js";

test("ids are prefixed, sortable and unique", () => {
  const a = newId("tsk", 1000), b = newId("tsk", 1000), c = newId("tsk", 2000);
  assert.ok(isId(a, "tsk")); assert.equal(idPrefix(a), "tsk");
  assert.ok(a < b, "monotonic within the same ms"); assert.ok(b < c, "sortable by time");
  const many = new Set(Array.from({ length: 5000 }, () => newId("evd")));
  assert.equal(many.size, 5000);
  assert.ok(!isId(a, "act"));
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  assert.equal(hashObject({ x: 1, y: 2 }), hashObject({ y: 2, x: 1 }));
  assert.notEqual(hashObject({ x: 1 }), hashObject({ x: 2 }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test("sim clock and durations", () => {
  const c = new SimClock("2026-03-29T00:30:00Z");
  c.advance(HOUR);
  assert.equal(c.iso(), "2026-03-29T01:30:00.000Z");
  assert.equal(parseDuration("PT2H30M"), 2.5 * HOUR);
  assert.equal(parseDuration("P1DT1S"), 24 * HOUR + 1000);
  assert.throws(() => parseDuration("P"));
  assert.throws(() => parseDuration("PT"));
  assert.throws(() => parseDuration("2 hours"));
});

test("every error code has defaults and a retry rule", () => {
  for (const code of ErrorCode.options) {
    assert.ok(ERROR_DEFAULTS[code], code);
    assert.ok(RETRY_POLICY[code], code);
  }
  assert.equal(RETRY_POLICY.uncertain_external_effect.retry, "reconcile_first");
  assert.equal(ERROR_DEFAULTS.uncertain_external_effect.effect_state, "unknown");
  const r = RETRY_POLICY.transient_service_error;
  for (let a = 1; a <= 10; a++) {
    const ms = backoffMs(r, a, () => 0.999);
    assert.ok(ms <= 60000 && ms >= 1000, `attempt ${a}: ${ms}`);
  }
});

test("errors are structured and secret-free", () => {
  const e = new JarvisError("rate_limited", "slow down", { retry_after_s: 30 });
  assert.equal(e.structured.retryable, true);
  assert.equal(e.structured.retry_after_s, 30);
  const s = toStructured(new Error("failed with key sk-ant-api03-abcdefghijklmnop and password=hunter2"));
  assert.equal(s.code, "internal_error");
  assert.ok(!s.message.includes("abcdefghijklmnop") && !s.message.includes("hunter2"), s.message);
  assert.ok(!redactMessage("card 4111111111111111").includes("4111111111111111"));
});

test("task state machine matches 02 §8.5", () => {
  const edges: [TaskStatus, TaskStatus][] = [
    ["accepted", "needs_clarification"], ["needs_clarification", "accepted"], ["accepted", "planned"], ["planned", "running"],
    ["running", "waiting"], ["waiting", "running"], ["running", "paused"], ["waiting", "paused"], ["paused", "running"],
    ["running", "verifying"], ["verifying", "running"], ["verifying", "completed"], ["verifying", "partially_completed"],
    ["running", "failed"], ["running", "blocked"], ["blocked", "running"], ["partially_completed", "planned"], ["failed", "planned"],
    ["accepted", "cancelled"], ["planned", "cancelled"], ["running", "cancelled"], ["waiting", "cancelled"], ["paused", "cancelled"], ["blocked", "cancelled"],
    ["needs_clarification", "cancelled"], ["verifying", "cancelled"], // table: "* → cancelled"
  ];
  const count = Object.values(TASK_TRANSITIONS).reduce((n, v) => n + v.length, 0);
  assert.equal(count, edges.length, "no extra edges");
  for (const [a, b] of edges) assert.ok(canTransitionTask(a, b), `${a} -> ${b}`);
  assert.ok(!canTransitionTask("running", "completed"), "completion only through verifying");
  assert.ok(!canTransitionTask("completed", "running"));
  for (const t of TERMINAL_TASK_STATUSES) if (t === "completed" || t === "cancelled") assert.equal(TASK_TRANSITIONS[t].length, 0);
});

test("action lifecycle matches 02 §8.7 (plus documented edges)", () => {
  const diagram: [ActionState, ActionState][] = [
    ["proposed", "prepared"], ["prepared", "awaiting_decision"], ["awaiting_decision", "authorized"], ["awaiting_decision", "denied"],
    ["prepared", "authorized"], ["prepared", "denied"], ["prepared", "cancelled"], ["awaiting_decision", "cancelled"],
    ["authorized", "cancelled"], ["authorized", "invalidated"], ["authorized", "expired"], ["authorized", "dispatched"],
    ["dispatched", "acknowledged"], ["dispatched", "uncertain"], ["dispatched", "failed_no_effect"], ["acknowledged", "effect_observed"],
    ["uncertain", "effect_observed"], ["uncertain", "failed_no_effect"], ["effect_observed", "verified"], ["effect_observed", "verification_failed"],
    ["verification_failed", "compensating"], ["verified", "compensating"], ["compensating", "compensated"], ["compensating", "compensation_failed"],
  ];
  const extra: [ActionState, ActionState][] = [["prepared", "invalidated"], ["awaiting_decision", "invalidated"], ["awaiting_decision", "expired"],
    ["proposed", "cancelled"], ["proposed", "invalidated"]];
  const count = Object.values(ACTION_TRANSITIONS).reduce((n, v) => n + v.length, 0);
  assert.equal(count, diagram.length + extra.length);
  for (const [a, b] of [...diagram, ...extra]) assert.ok(canTransitionAction(a, b), `${a} -> ${b}`);
  assert.ok(!canTransitionAction("uncertain", "dispatched"), "no blind retry from uncertain");
});

test("mode ceilings match 02 §8.3", () => {
  assert.deepEqual([...MODE_CEILINGS.advise], ["read.local", "read.account"]);
  assert.ok(!MODE_CEILINGS.prepare.includes("communicate"));
  assert.ok(MODE_FORBIDDEN.prepare!.includes("spend"));
  assert.deepEqual([...MODE_CEILINGS.execute], []);
});

test("schemas accept valid and reject invalid documents", () => {
  const cond = { all: [{ field: "recipient.relationship", op: "in", value: ["client_of"] }, { not: { field: "x", op: "==", value: 1 } }] };
  assert.ok(PolicyCondition.safeParse(cond).success);
  assert.ok(!PolicyCondition.safeParse({ field: "x", op: "~=", value: 1 }).success);
  const cap = {
    id: "tool:files.read", kind: "tool", version: "1.0.0", package: { id: "core", version: "1.0.0", hash: "x", provenance_ref: "builtin" },
    title: "Read file", purpose: "Read a local file", input_schema: {}, output_schema: {}, prerequisites: {},
    environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: false, requires_unlocked_desktop: false, network: "none" },
    auth: { type: "os_user", account_binding: "none" },
    side_effects: { effect_classes: ["read.local"], reversibility: "none", idempotency: "natural" },
    policy_scopes: ["files.read"], cost: { kind: "free" }, cancellation: "immediate", timeouts: { default_s: 10, max_s: 60 },
    verification: { method: "none", describe: "" }, evidence_emitted: [], known_limitations: [], isolation_tier: "T1",
    lifecycle: "active", admin_state: "enabled",
  };
  assert.ok(CapabilityDescriptor.safeParse(cap).success, JSON.stringify(CapabilityDescriptor.safeParse(cap).error));
  assert.ok(!CapabilityDescriptor.safeParse({ ...cap, version: "1.0" }).success);
  assert.ok(!TaskContract.safeParse({ task_id: "x" }).success);
});
