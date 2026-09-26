import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimClock } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { contract } from "./helpers/fixtures.js";

// M1 acceptance scenarios not covered by name elsewhere (14 §19). All data HYPOTHETICAL.

test("F17: a missing prerequisite is classified 'environment', the blocker names it exactly, the task is preserved, nothing is installed around you", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-f17-"));
  const j = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: new FakeAdapter("fake:boss", []), provider: "anthropic", model: "claude-opus-5-5", billing: "api" }],
    browser: { executablePath: join(dir, "no-such-browser") } });
  j.start();
  try {
    const t = j.tasks.create(contract("research", ["read.account"], { objective: "HYPOTHETICAL: read the venue page", scope: { resources: [], accounts: [], exclusions: [] }, success_criteria: [] }));
    j.tasks.setPlan(t.task_id, [{ step_id: "stp_f17", kind: "tool", description: "Read the venue page", capability: "tool:browser.read_page@1.0.0", params: { url: "https://example.org/" }, depends_on: [], effects: ["read.account"], resources: [] }]);
    j.tasks.transition(t.task_id, "planned");
    const after = await j.steps.run(t.task_id);
    await j.idle();
    assert.equal(after.status, "blocked", "preserved, not failed");
    const g = j.gaps.list()[0]!;
    assert.equal(g.classification, "environment");
    assert.equal(g.minimum_missing_capability, "prerequisite: Microsoft Edge or Chromium");
    assert.ok(g.options.some(o => o.kind === "install_prerequisite" && o.requires_authority?.includes("install")), "installing needs your authority");
    assert.equal(g.decision!.option_id, "o2", "reported, not installed");
    assert.ok(j.notifications.log().some(n => /Microsoft Edge or Chromium/.test(n.body)));
    assert.equal((j.ctx.db.prepare("select count(*) n from dev_orders").get() as { n: number }).n, 0, "no build for an environment gap");
  } finally { await j.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("F25: a voice request with medium transcript confidence and an external effect is confirmed before anything happens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-f25-"));
  const fake = new FakeAdapter("fake:boss", [], () => ({ structured: { intents: [{ kind: "new_task", text: "email Sam that I'm fifteen minutes late", objective: "Email Sam that I'm fifteen minutes late",
    mode: "execute", effects: ["communicate"], entity_names: ["Sam"], bounds: [{ field: "recipients", op: "in", value: ["Sam"], quote: "email Sam" }] }] } }));
  const j = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  try {
    const r = await j.conversation.handle({ text: "email Sam that I'm fifteen minutes late", channel: "console_voice", owner_verified: true, transcript_confidence: "medium" });
    const t = j.tasks.require(r.task_ids[0]!);
    assert.notEqual(t.status, "running"); assert.notEqual(t.status, "completed");
    assert.match(r.replies.join(" "), /Before I start|confirm|which|who/i, r.replies.join(" | "));
    assert.equal((j.ctx.db.prepare("select count(*) n from actions where state in ('dispatched','acknowledged','verified')").get() as { n: number }).n, 0, "nothing was sent");
  } finally { await j.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
