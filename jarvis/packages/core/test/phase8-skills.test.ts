import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimClock } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { renderTemplate } from "../src/skills/skill-runtime.js";
import { makeWritable } from "../src/workshop/release-manager.js";
import { contract } from "./helpers/fixtures.js";

// All content HYPOTHETICAL.
test("templates: whole-string keeps type, embedded interpolates, missing params fail", () => {
  const env = { params: { n: 3, who: "Sam" }, steps: { s1: { out: { total: 7 } } } };
  assert.equal(renderTemplate("{{params.n}}", env), 3);
  assert.equal(renderTemplate("Hi {{params.who}}, total {{steps.s1.output.out.total}}", env), "Hi Sam, total 7");
  assert.deepEqual(renderTemplate({ a: ["{{params.who}}", "{{mem:mem_X#value}}"] }, env), { a: ["Sam", "{{mem:mem_X#value}}"] });
  assert.throws(() => renderTemplate("{{params.missing}}", env), /missing skill parameter/);
});

test("\"save this as a skill\": a verified task's steps become an immutable parameterized skill; running it authorizes each step again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-skill-"));
  const j = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: new FakeAdapter("fake:boss", []), provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  try {
    const work = join(dir, "work"); mkdirSync(work, { recursive: true });
    const first = join(work, "greeting-alpha.md");
    const task = j.tasks.create(contract("execute", ["write.local"], { objective: "HYPOTHETICAL: write a greeting file", scope: { resources: [{ path_prefix: work }], accounts: [], exclusions: [] },
      authorization: { basis: ["explicit_instruction"], grant_ids: [], policy_revision: 0 },
      success_criteria: [{ id: "c1", description: "file exists", check: { kind: "file_exists", spec: { path: first } }, acceptable_evidence: ["file_check"], required: true }] }));
    j.tasks.setPlan(task.task_id, [{ step_id: "stp_1", kind: "tool", description: "Write the greeting", capability: `tool:files.write@${j.registry.resolve("tool:files.write")!.version}`, params: { path: first, content: "Hello Alpha, welcome." }, depends_on: [], effects: ["write.local"], resources: [] }]);
    j.tasks.transition(task.task_id, "planned");
    const done = await j.steps.run(task.task_id);
    assert.equal(done.status, "completed", done.status_detail);
    const saved = j.skills.saveFromTask(task.task_id, { slug: "write_greeting", name: "Write greeting", description: "Write a greeting file for someone",
      parameters: [{ name: "path", value: first }, { name: "who", value: "Alpha" }] });
    assert.equal(saved.manifest.id, "skill:write_greeting"); assert.equal(saved.manifest.lifecycle.state, "active"); assert.equal(saved.manifest.risk_class, "R1");
    assert.deepEqual(saved.remaining_literals, []);
    const pkg = join(dir, "skills", "write_greeting", "1.0.0");
    const wf = readFileSync(join(pkg, "procedure", "workflow.yaml"), "utf8");
    assert.match(wf, /\{\{params\.path\}\}/); assert.match(wf, /Hello \{\{params\.who\}\}, welcome\./); assert.match(wf, /tool:files\.write@\^\d/);
    assert.ok(!wf.includes("greeting-alpha"), "the literal became a parameter");
    assert.equal(statSync(join(pkg, "skill.yaml")).mode & 0o222, 0, "immutable");
    assert.ok(existsSync(join(pkg, "SKILL.md")));
    // Run it as a capability in another task.
    const t2 = j.tasks.create(contract("execute", ["write.local"], { objective: "HYPOTHETICAL: greet Beta", scope: { resources: [{ path_prefix: work }], accounts: [], exclusions: [] },
      authorization: { basis: ["explicit_instruction"], grant_ids: [], policy_revision: 0 } }));
    j.tasks.transition(t2.task_id, "planned"); j.tasks.transition(t2.task_id, "running");
    const second = join(work, "greeting-beta.md");
    const r = await j.broker.execute({ task_id: t2.task_id, capability: "skill:write_greeting", params: { path: second, who: "Beta" }, requested_by: { kind: "boss", ref: "t" } });
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.equal(readFileSync(second, "utf8"), "Hello Beta, welcome.");
    // A step outside the task's scope is not authorized by the skill: it needs a decision, and nothing is written.
    const outside = join(dir, "elsewhere.md");
    const r2 = await j.broker.execute({ task_id: t2.task_id, capability: "skill:write_greeting", params: { path: outside, who: "Gamma" }, requested_by: { kind: "boss", ref: "t" } });
    assert.notEqual(r2.status, "done");
    assert.match((r2 as { result: { error?: { message: string } } }).result.error!.message, /needs your decision|isn't allowed/);
    assert.ok(!existsSync(outside));
    assert.equal(j.tasks.require(t2.task_id).status, "running", "no dangling decision leaves the task stuck");
    assert.deepEqual(j.policy.openDecisionRequests(t2.task_id), []);
    const bad = await j.broker.execute({ task_id: t2.task_id, capability: "skill:write_greeting", params: { path: second, who: 5 }, requested_by: { kind: "boss", ref: "t" } });
    assert.equal((bad as { result: { error?: { code: string } } }).result.error?.code, "invalid_input");
    // Saving again makes a new minor version; a disabled skill doesn't run.
    const again = j.skills.saveFromTask(task.task_id, { slug: "write_greeting", name: "Write greeting", description: "v2", parameters: [{ name: "path", value: first }, { name: "who", value: "Alpha" }] });
    assert.equal(again.manifest.version, "1.1.0");
    j.registry.setAdminState("skill:write_greeting", "disabled", "test");
    const off = await j.broker.execute({ task_id: t2.task_id, capability: "skill:write_greeting", params: { path: second, who: "Beta" }, requested_by: { kind: "boss", ref: "t" } });
    assert.notEqual(off.status, "done");
  } finally { await j.shutdown(); makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
});
