import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { JarvisError, MINUTE } from "@jarvis/shared";
import { harness, contract, runningTask } from "./helpers/fixtures.js";
import { runRecoveryScan } from "../src/tasks/recovery.js";
import { openDatabase } from "../src/db/database.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { seal, open, MasterKeyProvider } from "../src/crypto/keys.js";

const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return e instanceof JarvisError ? e.code : `other:${(e as Error).message}`; } };

test("event store: hash chain verifies, detects tampering, survives redaction", () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.ctx.events.append({ type: "test.e", summary: `event ${i}`, data: { i }, payload: i % 5 === 0 ? `secret payload ${i}` : undefined, sensitivity: "personal" });
  assert.deepEqual(h.ctx.events.verifyChain(), { ok: true, checked: 20 });
  const ev = h.ctx.events.list({ type: "test.e" })[5]!;
  assert.ok(ev.payload_ref, "payload stored separately");
  assert.equal(h.ctx.payloads.getText(ev.payload_ref!), "secret payload 5");
  // redaction keeps the chain valid
  h.ctx.events.redact([ev.event_id], { deletePayload: true });
  const red = h.ctx.events.list({ type: "test.e" })[5]!;
  assert.equal(red.summary, "[redacted]"); assert.deepEqual(red.data, {}); assert.equal(red.redaction, "payload_deleted");
  assert.equal(code(() => h.ctx.payloads.get(ev.payload_ref!)), "expired");
  assert.equal(h.ctx.events.verifyChain().ok, true);
  // tampering with data is detected
  h.ctx.db.prepare("update events set data = '{\"i\":999}' where seq = 3").run();
  const v = h.ctx.events.verifyChain();
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 3);
});

test("event store: subscribers replay from a cursor and never see rolled-back events", () => {
  const h = harness();
  h.ctx.events.append({ type: "a", summary: "1" });
  h.ctx.events.append({ type: "a", summary: "2" });
  const seen: number[] = [];
  const off = h.ctx.events.subscribe(1, e => seen.push(e.seq));
  assert.deepEqual(seen, [2]);
  h.ctx.events.append({ type: "a", summary: "3" });
  assert.throws(() => h.ctx.tx(() => { h.ctx.events.append({ type: "a", summary: "rolled back" }); throw new Error("boom"); }));
  h.ctx.tx(() => { h.ctx.events.append({ type: "a", summary: "4" }); });
  off();
  assert.deepEqual(seen, [2, 3, 4]);
  assert.equal(h.ctx.events.list().length, 3 + 1 - 0, "rolled-back event not stored");
  assert.equal(h.ctx.events.verifyChain().ok, true);
});

test("event summaries are secret-free", () => {
  const h = harness();
  const e = h.ctx.events.append({ type: "x", summary: "login with password=hunter2 key sk-ant-abcdefghijklmnop" });
  assert.ok(!e.summary.includes("hunter2") && !e.summary.includes("abcdefghijklmnop"));
});

test("payloads are encrypted at rest and bound to their id", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const h = harness({ dataDir: dir });
    const { payload_id } = h.ctx.payloads.put("HYPOTHETICAL private transcript", "personal");
    const raw = readFileSync(join(dir, "data", "payloads", `${payload_id}.bin`));
    assert.ok(!raw.toString("utf8").includes("private transcript"), "ciphertext on disk");
    assert.equal(h.ctx.payloads.getText(payload_id), "HYPOTHETICAL private transcript");
    const k = MasterKeyProvider.ephemeral().dataKey("payloads");
    const blob = seal(k, Buffer.from("x"), "pld_a");
    assert.throws(() => open(k, blob, "pld_b"), /authentication/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task contract: ceilings enforced at creation and in plans (F29)", () => {
  const h = harness();
  assert.equal(code(() => h.tasks.create(contract("plan", ["read.local", "write.local", "spend"]))), "invalid_input");
  assert.equal(code(() => h.tasks.create(contract("prepare", ["write.account", "communicate"]))), "invalid_input");
  const t = h.tasks.create(contract("plan", ["read.local", "write.local"]));
  assert.equal(code(() => h.tasks.setPlan(t.task_id, [{ step_id: "stp_x", kind: "tool", description: "move photos", depends_on: [], effects: ["delete.local"], resources: [] }])), "missing_permission");
  assert.equal(code(() => h.tasks.setPlan(t.task_id, [
    { step_id: "stp_a", kind: "reason", description: "a", depends_on: ["stp_b"], effects: [], resources: [] },
    { step_id: "stp_b", kind: "reason", description: "b", depends_on: ["stp_a"], effects: [], resources: [] }])), "invalid_input");
});

test("task state machine: invalid transitions rejected; completion only via settle with evidence", () => {
  const h = harness();
  const t = h.tasks.create(contract());
  assert.equal(code(() => h.tasks.transition(t.task_id, "running")), "conflict");
  assert.equal(code(() => h.tasks.transition(t.task_id, "completed" as never)), "invalid_input");
  assert.equal(code(() => h.tasks.transition(t.task_id, "waiting" as never)), "invalid_input");
  const r = runningTask(h);
  h.tasks.transition(r.task_id, "verifying");
  // a verdict without evidence does not count
  const s1 = h.tasks.settle(r.task_id, [{ criterion_id: "c1", status: "verified", evidence_ids: ["evd_1"] }, { criterion_id: "c2", status: "verified", evidence_ids: [] }]);
  assert.equal(s1.status, "partially_completed");
  assert.match(s1.status_detail!, /Email sent to Sam/);
  const r2 = runningTask(h);
  h.tasks.transition(r2.task_id, "verifying");
  assert.equal(h.tasks.settle(r2.task_id, [{ criterion_id: "c1", status: "verified", evidence_ids: ["evd_1"] }, { criterion_id: "c2", status: "verified", evidence_ids: ["evd_2"] }]).status, "completed");
  assert.equal(code(() => h.tasks.settle(r2.task_id, [])), "conflict");
});

test("actions: write-ahead dispatch; uncertain can never be blindly re-dispatched (F13)", () => {
  const h = harness();
  const t = runningTask(h);
  const a = h.actions.propose({ task_id: t.task_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: { to: "sam@example.com" }, requested_by: "boss" });
  assert.equal(code(() => h.actions.dispatch(a.action_id)), "conflict", "cannot dispatch unauthorized");
  h.actions.prepare(a.action_id, { resolved_params: { to: "sam@example.com" }, preview: "Email Sam", fingerprint: "fp1" });
  h.actions.authorize(a.action_id, "grt_x", 1);
  const att = h.actions.dispatch(a.action_id);
  assert.equal(att.n, 1);
  assert.equal(h.actions.get(a.action_id).state, "dispatched", "state committed before sending");
  h.actions.markUncertain(a.action_id, "timeout");
  assert.equal(code(() => h.actions.dispatch(a.action_id)), "conflict", "no blind retry from uncertain");
  h.actions.observeEffect(a.action_id, ["evd_readback"]);
  h.actions.verify(a.action_id, true, "sent message found by Message-ID");
  assert.equal(h.actions.attempts(a.action_id).length, 1, "exactly one attempt");
  assert.equal(code(() => h.actions.observeEffect(a.action_id, [])), "invalid_input");
});

test("actions: a stale task revision invalidates at dispatch; revisions invalidate pending actions (F03-style)", () => {
  const h = harness();
  const t = runningTask(h);
  const mk = () => {
    const a = h.actions.propose({ task_id: t.task_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: {}, requested_by: "boss" });
    h.actions.prepare(a.action_id, { resolved_params: {}, preview: "", fingerprint: "f" });
    return a;
  };
  const a1 = mk(); h.actions.authorize(a1.action_id, "grt_1", 1);
  // A revision that removes communicate invalidates the pending send.
  const impact = h.tasks.revise(t.task_id, [{ op: "replace", path: "/intended_effects", value: ["read.local", "write.local"] }], "Don't send it, just draft", "msg_2");
  assert.deepEqual(impact.invalidated_actions, [a1.action_id]);
  assert.equal(h.actions.get(a1.action_id).state, "invalidated");
  assert.equal(impact.revision, 2);
  // A pending step with the removed effect is replanned.
  assert.ok(impact.replanned_steps.length >= 1);
  assert.equal(code(() => h.tasks.revise(t.task_id, [{ op: "replace", path: "/status", value: "completed" }], "sneaky")), "invalid_input");
  // Stale revision at dispatch
  const t2 = runningTask(h);
  const b = h.actions.propose({ task_id: t2.task_id, capability: "tool:files.write@1.0.0", effects: ["write.local"], params: {}, requested_by: "boss" });
  h.actions.prepare(b.action_id, { resolved_params: {}, preview: "", fingerprint: "f" });
  h.actions.authorize(b.action_id, "grt_2", 1);
  h.ctx.db.prepare("update tasks set revision = revision + 1 where task_id = ?").run(t2.task_id);
  assert.equal(code(() => h.actions.dispatch(b.action_id)), "conflict");
  assert.equal(h.actions.get(b.action_id).state, "invalidated");
});

test("paused tasks dispatch nothing; cancel reports completed effects and cascades", () => {
  const h = harness();
  const t = runningTask(h);
  const child = h.tasks.create({ ...contract("build", ["read.local", "write.local", "execute_code"]), parent_task_id: t.task_id, root_task_id: t.task_id });
  const done = h.actions.propose({ task_id: t.task_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: {}, requested_by: "boss" });
  h.actions.prepare(done.action_id, { resolved_params: {}, preview: "", fingerprint: "f" }); h.actions.authorize(done.action_id, "g", 1);
  h.actions.dispatch(done.action_id); h.actions.acknowledge(done.action_id, { id: "m1" }); h.actions.observeEffect(done.action_id, ["evd_1"]); h.actions.verify(done.action_id, true, "ok");
  const pending = h.actions.propose({ task_id: t.task_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: {}, requested_by: "boss" });
  h.actions.prepare(pending.action_id, { resolved_params: {}, preview: "", fingerprint: "f2" }); h.actions.authorize(pending.action_id, "g2", 1);
  h.tasks.pause(t.task_id);
  assert.equal(code(() => h.actions.dispatch(pending.action_id)), "conflict", "paused task dispatches nothing");
  const rep = h.tasks.cancel(t.task_id);
  assert.deepEqual(rep.completed_effects.map(e => e.action_id), [done.action_id]);
  assert.deepEqual(rep.cancelled_actions, [pending.action_id]);
  assert.deepEqual(rep.children_cancelled, [child.task_id]);
  assert.equal(h.tasks.get(child.task_id)!.status, "cancelled");
  assert.equal(h.tasks.get(t.task_id)!.status, "cancelled");
});

test("leases: exclusive queueing, fencing tokens monotonic, stale tokens rejected (F40, 02 §7.8)", () => {
  const h = harness();
  const a = h.tasks.create(contract()), b = h.tasks.create(contract());
  const la = h.leases.acquire("desktop:input", "exclusive", { task_id: a.task_id }, 60_000);
  assert.ok(la.granted);
  const lb = h.leases.acquire("desktop:input", "exclusive", { task_id: b.task_id });
  assert.deepEqual(lb, { granted: false, queue_position: 1, holders: [a.task_id] });
  if (!la.granted) throw new Error();
  h.leases.validateFencing("desktop:input", la.lease.fencing_token);
  h.leases.release(la.lease.lease_id);
  assert.equal(code(() => h.leases.validateFencing("desktop:input", la.lease.fencing_token)), "conflict");
  const lb2 = h.leases.acquire("desktop:input", "exclusive", { task_id: b.task_id });
  assert.ok(lb2.granted && lb2.lease.fencing_token > la.lease.fencing_token);
  // shared readers coexist; a writer waits
  const r1 = h.leases.acquire("fs:D:\\K", "shared_read", { task_id: a.task_id });
  const r2 = h.leases.acquire("fs:D:\\K", "shared_read", { task_id: b.task_id });
  assert.ok(r1.granted && r2.granted);
  const c = h.tasks.create(contract());
  assert.equal(h.leases.acquire("fs:D:\\K", "exclusive", { task_id: c.task_id }).granted, false);
  // expiry
  h.clock.advance(10 * MINUTE);
  if (!lb2.granted) throw new Error();
  assert.equal(code(() => h.leases.validateFencing("desktop:input", lb2.lease.fencing_token)), "conflict");
});

test("F01: crash after write-ahead, restart, recovery marks uncertain; completed steps are not repeated", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const clock = (harness().clock);
    const h1 = harness({ dataDir: dir, clock });
    const t = runningTask(h1);
    const [s1, s2] = h1.tasks.steps(t.task_id);
    h1.tasks.updateStep(s1!.step_id, { status: "done", outputs: ["art_1"] });
    h1.tasks.checkpoint(t.task_id);
    h1.tasks.updateStep(s2!.step_id, { status: "running" });
    const a = h1.actions.propose({ task_id: t.task_id, step_id: s2!.step_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: { to: "sam@example.com" }, requested_by: "boss" });
    h1.actions.prepare(a.action_id, { resolved_params: {}, preview: "", fingerprint: "f" }); h1.actions.authorize(a.action_id, "g", 1);
    h1.leases.acquire("account:mail:acc_1:send", "exclusive", { task_id: t.task_id });
    h1.actions.dispatch(a.action_id);
    // ---- crash: the process dies before the send is acknowledged ----
    h1.ctx.db.close();
    const h2 = harness({ dataDir: dir, clock });
    const queued: string[] = [];
    const sum = runRecoveryScan(h2.ctx, h2.tasks, h2.actions, h2.leases, { policyLoaded: () => true, enqueueReconciliation: id => queued.push(id), processAlive: () => false });
    assert.equal(sum.safe_mode, false);
    assert.deepEqual(sum.uncertain_actions, [a.action_id]);
    assert.deepEqual(queued, [a.action_id]);
    assert.equal(h2.actions.get(a.action_id).state, "uncertain");
    assert.equal(sum.expired_leases.length, 1, "lease of the dead process expired");
    const steps = h2.tasks.steps(t.task_id);
    assert.equal(steps[0]!.status, "done", "completed step not repeated");
    assert.equal(steps[1]!.status, "waiting", "step with a possible effect waits for reconciliation");
    assert.match(sum.message, /1 task\(s\) resumed, 1 action outcome\(s\) being checked/);
    assert.equal(h2.ctx.events.verifyChain().ok, true);
    h2.ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F22/F36: unreadable or corrupt database → safe mode, nothing dispatched", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const f = join(dir, "bad.db");
    writeFileSync(f, Buffer.alloc(4096, 7));
    assert.throws(() => openDatabase({ path: f }), (e: unknown) => e instanceof JarvisError && e.code === "policy_unavailable");
    const h = harness();
    const s = runRecoveryScan(h.ctx, h.tasks, h.actions, h.leases, { policyLoaded: () => false });
    assert.equal(s.safe_mode, true);
    assert.match(s.message, /Safe mode/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("migrations are recorded and idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const p = join(dir, "j.db");
    const latest = Math.max(...MIGRATIONS.map(m => m.version));
    const a = openDatabase({ path: p }); assert.equal(a.schemaVersion, latest); assert.equal(a.integrity, "ok"); a.db.close();
    const b = openDatabase({ path: p }); assert.equal(b.pendingMigrations, 0);
    assert.equal(String(b.db.pragma("journal_mode", { simple: true })), "wal");
    b.db.close();
    const raw = new Database(p); assert.equal((raw.prepare("select count(*) c from schema_migrations").get() as { c: number }).c, MIGRATIONS.length); raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review fixes: savepoints, wait-reason change, retry after proven no effect, long pause, params by reference", () => {
  const h = harness();
  // nested failure rolls back only the inner work and its events
  const before = h.ctx.events.lastSeq();
  const seen: string[] = [];
  const off = h.ctx.events.subscribe(before, e => seen.push(e.summary));
  h.ctx.tx(() => {
    h.ctx.events.append({ type: "t", summary: "outer" });
    try { h.ctx.tx(() => { h.ctx.events.append({ type: "t", summary: "inner" }); throw new Error("inner fails"); }); } catch { /* handled */ }
  });
  off();
  assert.deepEqual(seen, ["outer"]);
  assert.deepEqual(h.ctx.events.list({ fromSeq: before }).map(e => e.summary), ["outer"]);
  assert.equal(h.ctx.events.verifyChain().ok, true);

  const t = runningTask(h);
  h.tasks.transition(t.task_id, "waiting", { wait_reason: "auth", initiator: "broker" });
  assert.equal(h.tasks.transition(t.task_id, "waiting", { wait_reason: "quota", initiator: "broker" }).wait_reason, "quota");

  const a = h.actions.propose({ task_id: t.task_id, capability: "tool:mail.send@1.0.0", effects: ["communicate"], params: { to: "HYPOTHETICAL-dana@example.com" }, requested_by: "boss" });
  const proposedEv = h.ctx.events.list({ type: "action.proposed" }).at(-1)!;
  assert.ok(!JSON.stringify(proposedEv).includes("dana@example.com"), "params never copied into events");
  h.actions.prepare(a.action_id, { resolved_params: { to: "HYPOTHETICAL-dana@example.com" }, preview: "Email Dana", fingerprint: "f", reconciliation_key: "msgid:1" });
  const row = h.ctx.db.prepare("select resolved_params from actions where action_id = ?").get(a.action_id) as { resolved_params: string };
  assert.match(row.resolved_params, /^pld_/, "column holds a reference only");
  assert.deepEqual(h.actions.resolvedParams(a.action_id), { to: "HYPOTHETICAL-dana@example.com" });
  assert.equal(code(() => h.actions.retryAfterNoEffect(a.action_id, "boss")), "conflict");
  h.tasks.transition(t.task_id, "running", { initiator: "broker" });
  h.actions.authorize(a.action_id, "g", 1); h.actions.dispatch(a.action_id); h.actions.markUncertain(a.action_id, "timeout");
  h.actions.failNoEffect(a.action_id, "reconciliation: no message with that Message-ID after 20 minutes");
  const retry = h.actions.retryAfterNoEffect(a.action_id, "boss");
  assert.equal(retry.state, "proposed");
  assert.equal(retry.reconciliation_key, "msgid:1");
  assert.notEqual(retry.idempotency_key, a.idempotency_key);

  const p = runningTask(h);
  h.leases.acquire("fs:C:\\x", "exclusive", { task_id: p.task_id }, 24 * 60 * MINUTE);
  h.leases.acquire("desktop:input", "exclusive", { task_id: p.task_id }, 24 * 60 * MINUTE);
  h.tasks.pause(p.task_id);
  assert.deepEqual(h.leases.heldBy(p.task_id).map(l => l.resource), ["fs:C:\\x"], "desktop lease released at pause");
  h.clock.advance(31 * MINUTE);
  assert.deepEqual(h.tasks.releaseLongPausedLeases(30 * MINUTE), [p.task_id]);
  assert.equal(h.leases.heldBy(p.task_id).length, 0);
});

test("payload files orphaned by a rolled-back transaction are collected", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const h = harness({ dataDir: dir });
    const keep = h.ctx.payloads.put("kept", "personal");
    assert.throws(() => h.ctx.tx(() => { h.ctx.payloads.put("orphan", "personal"); throw new Error("rollback"); }));
    assert.equal(h.ctx.payloads.gcOrphans(), 1);
    assert.equal(h.ctx.payloads.getText(keep.payload_id), "kept");
    h.ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
