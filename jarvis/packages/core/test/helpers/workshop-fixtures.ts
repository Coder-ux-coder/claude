import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevWorkOrder, EffectClass } from "@jarvis/shared";
import type { CodingWorker, WorkerBuildInput, BuildOutcome } from "../../src/workshop/worker.js";
import { wsPaths } from "../../src/workshop/sandbox.js";

// All data HYPOTHETICAL and synthetic.
export function devOrder(woId: string, over: { capability_id?: string; effects?: EffectClass[]; negative_cases?: string[] } = {}): DevWorkOrder {
  return {
    work_order_id: woId, task_id: "tsk_dev", step_id: "s1", task_revision: 1, worker_type: "claude_code",
    objective: "Build a tool that counts words and lines in a text", context_package_id: "ctx_x", inputs: [], allowed_capabilities: [], allowed_effects: over.effects ?? [],
    leases: [], budget: { max_wall_time: "PT1H", subscription_allowed: true, paid_fallback: "never" }, output_schema: {}, verification: { required_evidence: ["test_result"] },
    policy_revision: 0, constraints: ["No network."], report: { progress: true, questions: "allowed", heartbeat_s: 60 }, capability_token_ref: "tok",
    dev: {
      problem: "The task needs word and line counts of a text; no capability does that.",
      target: { kind: "tool", capability_id: over.capability_id ?? "tool:text.wordcount", version_bump: "minor" },
      interface_contract: { contract: "jarvis.capability/1", descriptor_draft: { title: "Word count", purpose: "Count words and lines in a text", goal_patterns: ["count words"] },
        input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, output_schema: { type: "object", properties: { words: { type: "integer" }, lines: { type: "integer" } } } },
      io_expectations: { inputs: "{ text: string }", outputs: "{ words, lines }", examples_ref: "fixtures/" },
      environment_constraints: { runtime: "node", os: "linux_wsl", network: { build: "none", runtime: "none" } },
      available_dependencies: { allowed_registries: ["https://registry.npmjs.org/"], license_allowlist: ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"] },
      permission_boundaries: { declared_effects: over.effects ?? ["read.local"], tier: "T2", filesystem: { inputs: "fixtures/", outputs: "out/" } },
      test_requirements: { fixtures_ref: "fixtures/", negative_cases: over.negative_cases ?? ["text is not a string"], holdout_ref: "holdout" },
      artifact_location: "out/", data_policy: { synthetic_only: true }, review: { second_worker: false },
    },
  };
}

export const GOOD_ENTRY = `import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(0, "utf8") || "{}");
if (typeof p.text !== "string") { console.log(JSON.stringify({ status: "error", error: { code: "invalid_input", message: "text must be a string" } })); process.exit(0); }
const words = p.text.split(/\\s+/).filter(Boolean).length;
const lines = p.text === "" ? 0 : p.text.split("\\n").length;
console.log(JSON.stringify({ status: "ok", output: { words, lines } }));
`;
export const GOOD_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const run = p => JSON.parse(execFileSync(process.execPath, ["index.mjs"], { input: JSON.stringify(p) }).toString());
test("counts", () => assert.deepEqual(run({ text: "a b\\nc" }).output, { words: 3, lines: 2 }));
test("rejects non-strings", () => assert.equal(run({ text: 5 }).error.code, "invalid_input"));
`;

export function writePackage(out: string, o: { id?: string; version?: string; entry?: string; test?: string; effects?: EffectClass[]; extraFiles?: Record<string, string>; verification?: string } = {}): void {
  mkdirSync(join(out, "test"), { recursive: true });
  writeFileSync(join(out, "jarvis-package.json"), JSON.stringify({ schema: "jarvis.package/1", id: o.id ?? "tool:text.wordcount", version: o.version ?? "1.0.0", runtime: "node", entry: "index.mjs", tests: "test",
    descriptor: { side_effects: { effect_classes: o.effects ?? ["read.local"], reversibility: "none", idempotency: "natural" }, verification: { method: (o.verification ?? "none") as "none", describe: "pure function" } } }, null, 2));
  writeFileSync(join(out, "index.mjs"), o.entry ?? GOOD_ENTRY);
  writeFileSync(join(out, "test", "index.test.mjs"), o.test ?? GOOD_TEST);
  for (const [f, c] of Object.entries(o.extraFiles ?? {})) { mkdirSync(join(out, f, ".."), { recursive: true }); writeFileSync(join(out, f), c); }
}

/** A scripted builder: round n writes rounds[n-1] into out/. */
export class ScriptedWorker implements CodingWorker {
  readonly id: string; calls: WorkerBuildInput[] = [];
  constructor(private rounds: ((out: string) => void)[], id = "scripted") { this.id = id; }
  async available() { return { ok: true }; }
  async build(i: WorkerBuildInput): Promise<BuildOutcome> {
    this.calls.push(i);
    const ws = wsPaths(i.root, i.order.work_order_id);
    const step = this.rounds[Math.min(this.calls.length, this.rounds.length) - 1]!;
    step(ws.out);
    i.onEvent({ kind: "progress", phase: "packaging", note: "done" });
    return { usage: { duration_ms: 1 }, result: { package_path: "out/", tests: [{ suite: "self", passed: 99, failed: 0, report_ref: "x" }], dependencies: [], declared_permissions: {}, known_limitations: ["ASCII whitespace only"], remaining_risks: [], notes_for_reviewer: "" } };
  }
}

export const HOLDOUT = { set: "wordcount-v1", cases: [
  { name: "empty", input: { text: "" }, expect: { status: "ok" as const, output_equals: { words: 0, lines: 0 } } },
  { name: "multi", input: { text: "one two  three\nfour" }, expect: { status: "ok" as const, output_contains: { words: 4 } } },
  { name: "missing text", input: {}, expect: { status: "error" as const, error_code: "invalid_input" } },
] };
