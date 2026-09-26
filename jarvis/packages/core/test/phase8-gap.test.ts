import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimClock, type EffectClass } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { LocalProcessRunner } from "../src/workshop/sandbox.js";
import { makeWritable } from "../src/workshop/release-manager.js";
import { classifyFailure } from "../src/gap/gap-resolver.js";
import { parseWslList } from "../src/main.js";
import { contract } from "./helpers/fixtures.js";
import { ScriptedWorker, writePackage } from "./helpers/workshop-fixtures.js";
import type { ReasoningRequest } from "@jarvis/shared";

// All content HYPOTHETICAL and synthetic.
const SPEC = { name: "word_count", title: "Word count", purpose: "Count words and lines in a text", problem: "Count words and lines.",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, output_schema: { type: "object" },
  inputs: "{ text }", outputs: "{ words, lines }", negative_cases: ["text is not a string"], fixtures: [{ name: "sample.txt", content: "a b c" }], goal_patterns: ["count words"] };
const HOLD = { cases: [
  { name: "basic", input: { text: "a b" }, expect: { status: "ok", output_contains: { words: 2 } } },
  { name: "lines", input: { text: "a\nb" }, expect: { status: "ok", output_contains: { lines: 2 } } },
  { name: "bad", input: { text: 1 }, expect: { status: "error", error_code: "invalid_input" } },
] };

function boss(plan: unknown, over: { spec?: unknown } = {}) {
  const calls: string[] = [];
  const fake = new FakeAdapter("fake:boss", [], (req: ReasoningRequest) => {
    const sys = req.system.map(s => s.text).join("\n");
    if (/specification for a small, sandboxed Node\.js tool/.test(sys)) { calls.push("spec"); return { structured: over.spec ?? SPEC }; }
    if (/hidden acceptance tests/.test(sys)) { calls.push("holdout"); return { structured: HOLD }; }
    if (/You are the planner of JARVIS/.test(sys)) { calls.push("plan"); return { structured: plan }; }
    calls.push("other"); return { text: "" };
  });
  return { fake, calls };
}

function core(fake: FakeAdapter, worker?: ScriptedWorker) {
  const dir = mkdtempSync(join(tmpdir(), "jv-gap-"));
  const wsRoot = join(dir, "workshop"); mkdirSync(wsRoot, { recursive: true });
  const j = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }],
    ...(worker ? { workshop: { runner: new LocalProcessRunner(wsRoot), workers: [worker], allowUnisolated: true } } : {}) });
  j.start();
  return { j, dir, done: async () => { await j.shutdown(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); } };
}

const GAP_PLAN = { steps: [{ id: "s1", kind: "tool", description: "Count the words in the text", capability: "gap", params: { text: "the quick brown fox\njumps" },
  missing_capability: { intent: "count words and lines in a text", inputs: "{ text: string }", outputs: "{ words: number, lines: number }", effects: [] as EffectClass[] }, depends_on: [], criteria_ids: ["c1"] }] };

function researchTask(j: JarvisCore) {
  return j.tasks.create(contract("research", ["read.local"], { objective: "HYPOTHETICAL: count the words in a text", scope: { resources: [], accounts: [], exclusions: [] },
    success_criteria: [{ id: "c1", description: "Word and line counts produced", check: { kind: "postcondition", spec: {} }, acceptable_evidence: ["process_exit"], required: true }] }));
}

test("classification is deterministic and never routes authorization to engineering", () => {
  assert.equal(classifyFailure({ code: "missing_permission", message: "x" }), "authorization");
  assert.equal(classifyFailure({ code: "auth_required", message: "x" }), "authorization");
  assert.equal(classifyFailure({ code: "external_refusal", message: "x" }), "external_restriction");
  assert.equal(classifyFailure({ code: "unsupported_operation", message: "x" }), "tool");
  assert.equal(classifyFailure({ code: "invalid_input", message: 'no capability "tool:x"; did you mean' }), "tool");
  assert.equal(classifyFailure({ code: "unsupported_operation", message: "x", details: { missing_prerequisite: "ffmpeg ≥ 6" } }), "environment");
  assert.deepEqual(parseWslList(Buffer.from("Ubuntu\r\njarvis-workshop\r\n", "utf16le")), ["Ubuntu", "jarvis-workshop"]);
});

test("M1 headline: a missing capability is built by the Workshop (holdouts hidden from the builder), released, and the original task resumes and completes", async () => {
  const { fake, calls } = boss(GAP_PLAN);
  const worker = new ScriptedWorker([out => writePackage(out, { id: "tool:gen.word_count", effects: [] })]);
  const c = core(fake, worker);
  try {
    const task = researchTask(c.j);
    const after = await c.j.conversation.planAndRun(task);
    assert.equal(after.status, "waiting"); assert.equal(after.wait_reason, "subtask");
    await c.j.idle();
    assert.deepEqual(calls.slice(0, 3), ["plan", "spec", "holdout"]);
    const t = c.j.tasks.require(task.task_id);
    assert.equal(t.status, "completed", t.status_detail);
    const step = c.j.tasks.steps(task.task_id)[0]!;
    assert.equal(step.capability, "tool:gen.word_count@1.0.0"); assert.equal(step.status, "done");
    const g = c.j.gaps.list()[0]!;
    assert.equal(g.status, "resolved"); assert.equal(g.classification, "tool");
    const dev = c.j.tasks.require(g.links.dev_task_id!);
    assert.equal(dev.parent_task_id, task.task_id); assert.equal(dev.mode, "build"); assert.equal(dev.status, "completed");
    // The builder's workspace never contained the holdout cases.
    const wsInput = worker.calls[0]!;
    assert.ok(!JSON.stringify(wsInput.order).includes("output_contains"), "holdouts are not in the work order");
    // Same gap later: reuses the tool, no rebuild.
    const t2 = researchTask(c.j);
    const r2 = await c.j.conversation.planAndRun(t2);
    await c.j.idle();
    assert.equal(c.j.tasks.require(t2.task_id).status, "completed", r2.status_detail);
    assert.equal(worker.calls.length, 1, "not rebuilt");
    assert.equal(calls.filter(x => x === "spec").length, 1);
  } finally { await c.done(); }
});

test("a failed build preserves the task as blocked with the remaining requirement; nothing is reported as done", async () => {
  const { fake } = boss(GAP_PLAN);
  const worker = new ScriptedWorker([out => writePackage(out, { id: "tool:gen.word_count", effects: [], entry: 'console.log("nope")' })]);
  const c = core(fake, worker);
  try {
    const task = researchTask(c.j);
    await c.j.conversation.planAndRun(task);
    await c.j.idle();
    const t = c.j.tasks.require(task.task_id);
    assert.equal(t.status, "blocked");
    assert.match(t.status_detail!, /Still missing: count words and lines/);
    assert.equal(worker.calls.length, 3, "initial build plus two fix rounds");
    assert.equal(c.j.gaps.list()[0]!.status, "blocked");
    assert.equal(c.j.tasks.require(c.j.gaps.list()[0]!.links.dev_task_id!).status, "failed");
    assert.ok(c.j.notifications.log().some(n => /blocked on a missing capability/.test(n.title)));
  } finally { await c.done(); }
});

test("without a Workshop, a tool gap is reported with the reason, never faked", async () => {
  const { fake } = boss(GAP_PLAN);
  const c = core(fake);
  try {
    const task = researchTask(c.j);
    const r = await c.j.conversation.planAndRun(task);
    assert.equal(r.status, "blocked");
    assert.equal(c.j.gaps.list()[0]!.decision!.reason, "the Workshop isn't set up on this PC");
  } finally { await c.done(); }
});

test("a gap whose tool would exceed the task's effects is rejected at planning, not built", async () => {
  const plan = { steps: [{ ...GAP_PLAN.steps[0]!, missing_capability: { ...GAP_PLAN.steps[0]!.missing_capability, effects: ["communicate"] } }] };
  const { fake, calls } = boss(plan);
  const worker = new ScriptedWorker([out => writePackage(out, { id: "tool:gen.word_count" })]);
  const c = core(fake, worker);
  try {
    const r = await c.j.conversation.planAndRun(researchTask(c.j));
    assert.notEqual(r.status, "completed");
    assert.equal(calls.filter(x => x === "spec").length, 0);
    assert.equal(worker.calls.length, 0);
  } finally { await c.done(); }
});

test("an R2 build waits for your approval; approving it resumes the task", async () => {
  const plan = { steps: [{ ...GAP_PLAN.steps[0]!, missing_capability: { ...GAP_PLAN.steps[0]!.missing_capability, effects: ["read.local", "delete.local"] } }] };
  const { fake } = boss(plan);
  const worker = new ScriptedWorker([out => writePackage(out, { id: "tool:gen.word_count", effects: ["read.local", "delete.local"], verification: "file_check" })]);
  const c = core(fake, worker);
  try {
    const task = c.j.tasks.create(contract("execute", ["read.local", "delete.local"], { objective: "HYPOTHETICAL: count words", success_criteria: [], scope: { resources: [], accounts: [], exclusions: [] },
      authorization: { basis: ["explicit_instruction"], grant_ids: [], policy_revision: 0 } }));
    await c.j.conversation.planAndRun(task);
    await c.j.idle();
    assert.equal(c.j.tasks.require(task.task_id).status, "waiting");
    const wo = c.j.ctx.db.prepare("select work_order_id, status from dev_orders").get() as { work_order_id: string; status: string };
    assert.equal(wo.status, "awaiting_approval");
    assert.ok(c.j.notifications.needsYou().some(n => /needs your approval/.test(n.title)));
    const r = c.j.approveBuild(wo.work_order_id);
    assert.deepEqual(r.resumed, [task.task_id]);
    await c.j.idle();
    assert.equal(c.j.tasks.steps(task.task_id)[0]!.capability, "tool:gen.word_count@1.0.0");
    const after = c.j.tasks.require(task.task_id);
    assert.notEqual(after.wait_reason, "subtask", "no longer waiting on the build");
    assert.ok(after.status === "completed" || (after.status === "waiting" && after.wait_reason === "owner"), "continues; a tool that can delete still needs your decision to run");
  } finally { await c.done(); }
});
