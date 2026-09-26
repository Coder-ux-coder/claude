import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreHarness } from "./helpers/core-fixtures.js";
import { LocalProcessRunner } from "../src/workshop/sandbox.js";
import { ReleaseManager, makeWritable } from "../src/workshop/release-manager.js";
import { HoldoutStore, WorkshopManager } from "../src/workshop/workshop.js";
import { McpGateway } from "../src/workshop/mcp-gateway.js";
import { ClaudeCodeWorker } from "../src/workshop/worker.js";
import { riskClass } from "../src/workshop/validation.js";
import { devOrder, writePackage, ScriptedWorker, HOLDOUT, GOOD_ENTRY } from "./helpers/workshop-fixtures.js";

function setup(workers: ConstructorParameters<typeof ScriptedWorker>[0][] | ScriptedWorker[] = []) {
  const h = coreHarness();
  const root = mkdtempSync(join(tmpdir(), "jv-ws-"));
  const runner = new LocalProcessRunner(join(root, "ws"));
  (require_mkdir)(runner.hostRoot);
  const releases = new ReleaseManager(h.ctx, h.registry, runner, { tools: join(root, "tools"), runtime: join(runner.hostRoot, "_runtime") });
  releases.onExecutor = e => h.broker.registerExecutor(e);
  const holdouts = new HoldoutStore(join(root, "holdouts"));
  holdouts.put("tool:text.wordcount", HOLDOUT);
  const ws = workers.map(w => w instanceof ScriptedWorker ? w : new ScriptedWorker(w as never));
  const workshop = new WorkshopManager({ ctx: h.ctx, runner, workers: ws, releases, registry: h.registry, holdouts, allowUnisolated: true, maxFixRounds: 2 });
  const done = () => { makeWritable(root); rmSync(root, { recursive: true, force: true }); };
  return { h, root, runner, releases, holdouts, workshop, workers: ws, done };
}
import { mkdirSync } from "node:fs";
const require_mkdir = (p: string) => mkdirSync(p, { recursive: true });

test("risk classes follow 07 §12.8", () => {
  assert.equal(riskClass(["read.local"]), "R0");
  assert.equal(riskClass(["write.local"]), "R1");
  assert.equal(riskClass(["communicate"]), "R2");
  assert.equal(riskClass(["delete.local"]), "R2");
  assert.equal(riskClass(["spend"]), "R3");
});

test("workshop: build → JARVIS reruns tests + hidden holdout → R0 auto-release → runs through the Broker as T2 with evidence", async () => {
  const s = setup([[out => writePackage(out)]]);
  try {
    const r = await s.workshop.run(devOrder("wo_ok"));
    assert.equal(r.status, "released", JSON.stringify(r.report?.stages.filter(x => !x.ok)));
    assert.equal(r.report!.holdout.passed, 3); assert.equal(r.report!.risk_class, "R0");
    assert.deepEqual(r.report!.tests, [{ suite: "package tests (rerun by JARVIS)", passed: 2, failed: 0 }], "the builder's claimed 99 passes are ignored");
    assert.ok(r.report!.untested.some(u => /local development runner/.test(u)), "honest about isolation");
    // Immutable, content-addressed package; registry active.
    const p = s.releases.pointer("tool:text.wordcount")!;
    assert.equal(p.active_version, "1.0.0");
    assert.equal(statSync(join(p.package_dir, "index.mjs")).mode & 0o222, 0, "installed package files are read-only");
    assert.equal(statSync(p.package_dir).mode & 0o222, 0, "and so is its directory");
    assert.equal(s.h.registry.resolve("tool:text.wordcount")!.lifecycle, "active");
    // The builder never saw the holdout set.
    const ctxMd = readFileSync(join(s.runner.hostRoot, "wo_ok", "CONTEXT.md"), "utf8");
    assert.ok(!ctxMd.includes("one two  three"), "holdout inputs never reach the workspace");
    // Execute through the Broker.
    const { task } = s.h.task("research", ["read.local"]);
    const out = await s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text: "hello brave new\nworld" }, requested_by: { kind: "boss", ref: task.task_id } });
    assert.equal(out.status, "done");
    assert.deepEqual((out as { result: { output: unknown } }).result.output, { words: 4, lines: 2 });
    const bad = await s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text: 7 }, requested_by: { kind: "boss", ref: task.task_id } });
    assert.equal((bad as { result: { error?: { code: string } } }).result.error?.code, "invalid_input");
  } finally { s.done(); }
});

test("workshop: validation catches what the builder hides; hidden holdout failures drive a fix round without revealing the cases", async () => {
  const buggy = GOOD_ENTRY.replace('p.text === "" ? 0 : ', "");          // empty text → 1 line (holdout catches it)
  const s = setup([[out => writePackage(out, { entry: buggy }), out => writePackage(out)]]);
  try {
    const r = await s.workshop.run(devOrder("wo_fix"));
    assert.equal(r.status, "released"); assert.equal(r.rounds, 2);
    const fb = readFileSync(join(s.runner.hostRoot, "wo_fix", "VALIDATION.md"), "utf8").toString() ?? "";
    assert.fail("VALIDATION.md is written by the Claude Code adapter, not the scripted worker: " + fb.length);
  } catch (e) {
    if ((e as Error).message.startsWith("VALIDATION.md is written")) throw e;
    const feedback = s.workers[0]!.calls[1]!.feedback!;
    assert.match(feedback, /Holdout: 1 hidden case\(s\) failed/);
    assert.ok(!feedback.includes('"text": ""') && !feedback.includes("empty"), "the failing case itself is not revealed");
  } finally { s.done(); }
});

test("workshop: static and audit stages refuse network use, undeclared effects, secrets, install scripts, and missing tests", async () => {
  const cases: [string, (out: string) => void, RegExp][] = [
    ["net", out => writePackage(out, { entry: `import https from "node:https";\n${GOOD_ENTRY}` }), /network module "https"/],
    ["fetch", out => writePackage(out, { entry: `await fetch("http://x");\n${GOOD_ENTRY}` }), /network call/],
    ["spawn", out => writePackage(out, { entry: `import { exec } from "node:child_process";\n${GOOD_ENTRY}` }), /spawns code/],
    ["effects", out => writePackage(out, { effects: ["communicate"], verification: "postcondition" }), /effects outside the work order: communicate/],
    ["secret", out => writePackage(out, { extraFiles: { "config.json": JSON.stringify({ key: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX" }) } }), /looks like a credential/],
    ["install", out => writePackage(out, { extraFiles: { "package.json": JSON.stringify({ name: "x", scripts: { postinstall: "curl evil" } }) } }), /"postinstall" script/],
    ["deps", out => writePackage(out, { extraFiles: { "package.json": JSON.stringify({ name: "x", dependencies: { leftpad: "1.0.0" } }) } }), /without a pinned package-lock/],
    ["tests", out => { writePackage(out); rmSync(join(out, "test"), { recursive: true }); }, /no tests/],
    ["writes", out => writePackage(out, { entry: `import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");\n${GOOD_ENTRY}` }), /writes files without a declared write effect/],
  ];
  for (const [name, build, expect] of cases) {
    const s = setup([[build]]);
    try {
      const r = await s.workshop.run(devOrder(`wo_${name}`));
      assert.equal(r.status, "failed", name);
      const msgs = r.report!.stages.flatMap(st => st.findings.map(f => f.message)).join(" | ");
      assert.match(msgs, expect, name);
      assert.equal(s.releases.pointer("tool:text.wordcount"), undefined, `${name}: nothing released`);
    } finally { s.done(); }
  }
});

test("workshop: an R2 tool waits for your approval; activation needs it; a new version supersedes and canary failure rolls back exactly", async () => {
  const s = setup([[out => writePackage(out, { effects: ["read.local", "delete.local"], verification: "file_check" })]]);
  try {
    s.holdouts.put("tool:text.wordcount", HOLDOUT);
    const r = await s.workshop.run(devOrder("wo_r2", { effects: ["read.local", "delete.local"] }));
    assert.equal(r.status, "awaiting_approval");
    assert.ok(r.reasons!.some(x => /risk class R2/.test(x)));
    assert.equal(s.releases.pointer("tool:text.wordcount"), undefined);
    assert.equal(s.h.registry.resolve("tool:text.wordcount", { includeAll: true })!.lifecycle, "under_test");
    const rec = s.workshop.approve("wo_r2");
    assert.deepEqual(rec.approvals.map(a => a.by), ["owner"]);
    assert.throws(() => s.workshop.approve("wo_r2"), /not waiting/);
    // Version 1.1.0 (still R2): same permissions, still needs your approval.
    const v2 = new ScriptedWorker([out => writePackage(out, { version: "1.1.0", effects: ["read.local", "delete.local"], verification: "file_check" })]);
    const w2 = new WorkshopManager({ ctx: s.h.ctx, runner: s.runner, workers: [v2], releases: s.releases, registry: s.h.registry, holdouts: s.holdouts, allowUnisolated: true });
    const r2 = await w2.run(devOrder("wo_v2", { effects: ["read.local", "delete.local"] }));
    assert.equal(r2.status, "awaiting_approval", "R2 always needs your one-tap approval");
    assert.deepEqual(r2.report!.permission_delta, { added: [], removed: [] }, "same permissions as 1.0.0");
    assert.deepEqual(r2.reasons, ["risk class R2"]);
    w2.approve("wo_v2");
    assert.equal(s.releases.pointer("tool:text.wordcount")!.active_version, "1.1.0");
    assert.equal(s.h.registry.resolve("tool:text.wordcount@1.0.0", { includeAll: true })!.lifecycle, "superseded");
    // The Broker still applies policy to a released tool: a research task can't use a tool that deletes.
    const { task } = s.h.task("research", ["read.local"]);
    const denied = await s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text: "x" }, requested_by: { kind: "boss", ref: "t" } });
    assert.equal(denied.status, "denied");
  } finally { s.done(); }
});

test("canary: a new R0 version that fails twice in its first runs is rolled back exactly to the previous version", async () => {
  const s = setup([[out => writePackage(out)]]);
  try {
    assert.equal((await s.workshop.run(devOrder("wo_c1"))).status, "released");
    const flaky = GOOD_ENTRY.replace('if (typeof p.text !== "string")', 'if (p.text === "boom") { console.log("garbage"); process.exit(0); }\nif (typeof p.text !== "string")');
    const w2 = new WorkshopManager({ ctx: s.h.ctx, runner: s.runner, workers: [new ScriptedWorker([out => writePackage(out, { version: "1.1.0", entry: flaky })])], releases: s.releases, registry: s.h.registry, holdouts: s.holdouts, allowUnisolated: true });
    const r2 = await w2.run(devOrder("wo_c2"));
    assert.equal(r2.status, "released"); assert.equal(r2.report!.first_release, false);
    const { task } = s.h.task("research", ["read.local"]);
    const run = (text: string) => s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text }, requested_by: { kind: "boss", ref: "t" } });
    assert.equal((await run("fine")).status, "done");
    await run("boom");
    assert.equal(s.releases.pointer("tool:text.wordcount")!.active_version, "1.1.0", "one failure is within the R0 canary threshold");
    await run("boom");
    assert.equal(s.releases.pointer("tool:text.wordcount")!.active_version, "1.0.0", "rolled back");
    assert.equal(s.h.registry.resolve("tool:text.wordcount@1.1.0", { includeAll: true })!.lifecycle, "quarantined");
    assert.equal(s.h.registry.resolve("tool:text.wordcount@1.0.0", { includeAll: true })!.lifecycle, "active");
    assert.match(s.releases.releases("tool:text.wordcount").at(-1)!.rollback_reason!, /canary: 2 failure/);
    const again = await run("x y");
    assert.deepEqual((again as { result: { output: unknown } }).result.output, { words: 2, lines: 1 });
  } finally { s.done(); }
});

test("release integrity: a drifted runtime copy is re-staged; a tampered installed package is quarantined", async () => {
  const s = setup([[out => writePackage(out)]]);
  try {
    assert.equal((await s.workshop.run(devOrder("wo_int"))).status, "released");
    const { task } = s.h.task("research", ["read.local"]);
    const runtime = join(s.runner.hostRoot, "_runtime", "tool_text.wordcount", "1.0.0");
    makeWritable(runtime); writeFileSync(join(runtime, "index.mjs"), 'console.log(JSON.stringify({status:"ok",output:"tampered"}))');
    const r = await s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text: "a" }, requested_by: { kind: "boss", ref: "t" } });
    assert.deepEqual((r as { result: { output: unknown } }).result.output, { words: 1, lines: 1 }, "the runtime copy was restored from the immutable package");
    const pkg = s.releases.pointer("tool:text.wordcount")!.package_dir;
    chmodSync(pkg, 0o755); chmodSync(join(pkg, "index.mjs"), 0o644); writeFileSync(join(pkg, "index.mjs"), "tampered");
    const r2 = await s.h.broker.execute({ task_id: task.task_id, capability: "tool:text.wordcount", params: { text: "a" }, requested_by: { kind: "boss", ref: "t" } });
    assert.notEqual(r2.status, "done");
    assert.equal(s.h.registry.resolve("tool:text.wordcount@1.0.0", { includeAll: true })!.lifecycle, "quarantined");
    assert.equal(s.releases.pointer("tool:text.wordcount"), undefined);
  } finally { s.done(); }
});

test("workshop refuses a non-isolated runner unless explicitly in development; a work order must name its tool id", async () => {
  const s = setup([[out => writePackage(out)]]);
  try {
    const strict = new WorkshopManager({ ctx: s.h.ctx, runner: s.runner, workers: s.workers, releases: s.releases, registry: s.h.registry, holdouts: s.holdouts });
    await assert.rejects(strict.run(devOrder("wo_strict")), /isolated sandbox/);
    const o = devOrder("wo_noid"); delete (o.dev.target as { capability_id?: string }).capability_id;
    await assert.rejects(s.workshop.run(o), /must name its target capability/);
  } finally { s.done(); }
});

test("MCP gateway: per-order bearer token, tools/list and tools/call, expiry and revocation", async () => {
  let now = 1_000_000;
  const g = new McpGateway("127.0.0.1", () => now);
  await g.listen();
  try {
    const asked: string[] = [];
    const grant = g.issue("wo_1", [{ name: "ask_boss", description: "ask", inputSchema: { type: "object" }, call: async a => { asked.push(String(a.question)); return "Use UTF-8."; } }], 60_000);
    const post = (body: unknown, token = grant.token) => fetch(grant.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json() as { result: { serverInfo: { name: string } } };
    assert.equal(init.result.serverInfo.name, "jarvis-workshop");
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map(t => t.name), ["ask_boss"]);
    const call = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_boss", arguments: { question: "Which encoding?" } } })).json() as { result: { content: { text: string }[] } };
    assert.equal(call.result.content[0]!.text, "Use UTF-8."); assert.deepEqual(asked, ["Which encoding?"]);
    assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "wrong")).status, 401);
    now += 120_000;
    assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 401, "expired");
    const g2 = g.issue("wo_2", []);
    g2.revoke();
    assert.equal((await post({ jsonrpc: "2.0", id: 6, method: "tools/list" }, g2.token)).status, 401, "revoked");
  } finally { await g.close(); }
});

test("Claude Code worker: invocation hygiene, stream-json parsing, estimated cost, error mapping (with a stand-in binary)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jv-cc-"));
  try {
    const runner = new LocalProcessRunner(root);
    const ws = join(root, "wo_cc"); mkdirSync(join(ws, "out"), { recursive: true });
    const bin = join(root, "claude"), argsFile = join(root, "args.json");
    const result = { package_path: "out/", tests: [], dependencies: [], declared_permissions: {}, known_limitations: [], remaining_risks: [], notes_for_reviewer: "ok" };
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME, secret: process.env.ANTHROPIC_API_KEY ?? null }));
if (process.argv.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
const mode = fs.existsSync(${JSON.stringify(join(root, "MODE"))}) ? fs.readFileSync(${JSON.stringify(join(root, "MODE"))}, "utf8") : "ok";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "ses_1", capabilities: [] }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }] } }));
if (mode === "limit") { console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Claude usage limit reached", session_id: "ses_1" })); process.exit(1); }
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "ses_1", total_cost_usd: 0.42, duration_ms: 1234, usage: { input_tokens: 1000, output_tokens: 200 }, structured_output: ${JSON.stringify(result)} }));
`);
    chmodSync(bin, 0o755);
    const w = new ClaudeCodeWorker({ binary: bin, configDir: "/home/worker/.claude-jarvis" });
    assert.deepEqual(await w.available(runner), { ok: true });
    const events: string[] = [];
    const out = await w.build({ order: devOrder("wo_cc"), root, runner, onEvent: e => events.push(e.kind === "progress" ? `${e.phase}` : e.kind), signal: new AbortController().signal, mcp: { url: "http://127.0.0.1:1/mcp", token: "t0k" } });
    assert.deepEqual(out.result, result); assert.equal(out.session_ref, "ses_1");
    assert.deepEqual(out.usage.cost, { amount: { amount: 0.42, currency: "USD" }, kind: "estimated", basis: "claude -p total_cost_usd (client-side estimate)" });
    assert.deepEqual(out.usage.tokens, { input: 1000, output: 200 });
    assert.ok(events.includes("implementing"));
    const seen = JSON.parse(readFileSync(argsFile, "utf8")) as { argv: string[]; config: string; secret: string | null };
    const a = seen.argv;
    const val = (f: string) => a[a.indexOf(f) + 1];
    assert.equal(val("--setting-sources"), "user");
    assert.deepEqual(JSON.parse(val("--settings")!).disableAllHooks, true);
    assert.equal(JSON.parse(val("--settings")!).sandbox.allowUnsandboxedCommands, false);
    assert.equal(val("--permission-mode"), "dontAsk"); assert.equal(val("--permission-prompts"), "none");
    assert.equal(val("--output-format"), "stream-json");
    assert.ok(a.includes("--json-schema") && a.includes("--append-system-prompt"));
    assert.equal(seen.config, "/home/worker/.claude-jarvis");
    assert.equal(seen.secret, null, "no host secrets leak into the worker's environment");
    const mcp = JSON.parse(readFileSync(val("--mcp-config")!, "utf8"));
    assert.equal(mcp.mcpServers.jarvis.headers.Authorization, "Bearer t0k");
    writeFileSync(join(root, "MODE"), "limit");
    const lim = await w.build({ order: devOrder("wo_cc"), root, runner, onEvent: () => {}, signal: new AbortController().signal });
    assert.equal(lim.result, null); assert.equal(lim.error!.code, "rate_limited");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void existsSync;

test("WSL runner: UNC ↔ distro paths, worker user, clean env, network namespace for 'none', no escape", async () => {
  const { WslRunner } = await import("../src/workshop/sandbox.js");
  const dir = mkdtempSync(join(tmpdir(), "jv-wsl-"));
  try {
    const fake = join(dir, "wsl.exe");
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`); chmodSync(fake, 0o755);
    const r = new WslRunner("jarvis-workshop", "/home/worker/ws", "worker", fake);
    assert.equal(r.hostRoot, "\\\\wsl.localhost\\jarvis-workshop\\home\\worker\\ws");
    assert.equal(r.toSandboxPath("\\\\wsl.localhost\\jarvis-workshop\\home\\worker\\ws\\wo_1\\out"), "/home/worker/ws/wo_1/out");
    assert.throws(() => r.toSandboxPath("\\\\wsl.localhost\\jarvis-workshop\\home\\worker\\.ssh"), /outside the workshop/);
    assert.throws(() => r.toSandboxPath("C:\\Users\\owner\\Documents"), /outside the workshop/);
    const out = await r.run(["node", "--test"], { cwd: "\\\\wsl.localhost\\jarvis-workshop\\home\\worker\\ws\\wo_1", timeoutMs: 10_000, network: "none" });
    const argv = JSON.parse(out.stdout) as string[];
    assert.deepEqual(argv.slice(0, 7), ["-d", "jarvis-workshop", "-u", "worker", "--cd", "/home/worker/ws/wo_1", "--"]);
    assert.equal(argv[7], "env"); assert.equal(argv[8], "-i", "a clean environment");
    const u = argv.indexOf("unshare");
    assert.ok(u > 0 && argv.slice(u, u + 4).join(" ") === "unshare --map-root-user --net --", "no network");
    assert.deepEqual(argv.slice(-2), ["node", "--test"]);
    const net = JSON.parse((await r.run(["curl", "x"], { cwd: r.hostRoot, timeoutMs: 10_000, network: "allowed" })).stdout) as string[];
    assert.ok(!net.includes("unshare"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
