import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { SimClock } from "@jarvis/shared";
import { JarvisCore, FakeAdapter, CoordinatorServer, pipePath } from "@jarvis/core";
import { CoordinatorLink } from "../src/bridge/coordinator-link.js";
import { DevBridge } from "../src/bridge/dev-bridge.js";
import { WhisperCppAdapter, fromJson, type SpeechToText } from "../src/main/whisper.js";
import { encodeWav16k } from "../src/shared/wav.js";
import { contract } from "../../core/test/helpers/fixtures.js";

// All people and content below are HYPOTHETICAL test data.
const DIST = join(import.meta.dirname, "..", "dist", "renderer");
const CHROMIUM = process.env.JARVIS_CHROMIUM ?? "/opt/pw-browsers/chromium";

test("WAV encoder: 16 kHz mono PCM header and resampling", () => {
  const s = new Float32Array(48_000).map((_, i) => Math.sin(i / 10));
  const w = encodeWav16k(s, 48_000);
  const dv = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), "RIFF");
  assert.equal(dv.getUint32(24, true), 16_000); assert.equal(dv.getUint16(22, true), 1); assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 32_000, "1 s at 16 kHz × 2 bytes");
});

test("whisper.cpp adapter: runs the local binary, parses full JSON, maps confidence, deletes the audio", async () => {
  assert.deepEqual(fromJson(null), { text: "", confidence: "low" });
  assert.deepEqual(fromJson({ transcription: [{ text: " hello there " }] }), { text: "hello there", confidence: "medium" }, "no token probabilities → medium");
  assert.equal(fromJson({ transcription: [{ text: "hi", tokens: [{ text: "[_BEG_]", p: 0.1 }, { text: "hi", p: 0.97 }] }] }).confidence, "high", "special tokens ignored");
  assert.equal(fromJson({ transcription: [{ text: "x", tokens: [{ text: "x", p: 0.3 }] }] }).confidence, "low");
  const dir = mkdtempSync(join(tmpdir(), "jv-stt-test-"));
  const bin = join(dir, "whisper-cli"), model = join(dir, "ggml-test.bin"), seen = join(dir, "args.txt");
  writeFileSync(model, "fake");
  // A stand-in for whisper-cli: records its arguments and writes the -of <base>.json output.
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${seen}"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then out="$2"; fi; if [ "$1" = "-f" ]; then in="$2"; fi; shift; done\ntest -f "$in" || exit 3\necho '{"transcription":[{"text":" Remind me at nine","tokens":[{"text":" Remind","p":0.95},{"text":" me","p":0.93}]}]}' > "$out.json"\n`);
  chmodSync(bin, 0o755);
  const stt = new WhisperCppAdapter({ binary: bin, model });
  const r = await stt.transcribe(encodeWav16k(new Float32Array(16_000), 16_000));
  assert.deepEqual(r, { text: "Remind me at nine", confidence: "high" });
  const args = readFileSync(seen, "utf8");
  assert.match(args, /-m .*ggml-test\.bin/); assert.match(args, /-ojf/); assert.match(args, /-nt/);
  const tmpIn = /-f (\S+)/.exec(args)![1]!;
  assert.equal(existsSync(tmpIn), false, "audio deleted after transcription");
  await assert.rejects(stt.transcribe(new Uint8Array([1, 2, 3])), /WAV/);
  await assert.rejects(new WhisperCppAdapter({ binary: join(dir, "missing"), model }).transcribe(new Uint8Array(64)), /not installed/);
  rmSync(dir, { recursive: true, force: true });
});

async function stack(sttImpl: SpeechToText | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "jv-console-"));
  const fake = new FakeAdapter("fake:boss", [], req => {
    const last = JSON.stringify(req.transcript.at(-1) ?? "");
    return { structured: { intents: [{ kind: "reply", text: /remind me/i.test(last) ? "Got it (voice)." : "Hello from JARVIS (fake)." }] } };
  });
  const core = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  core.start();
  const secret = randomBytes(24).toString("hex");
  const path = pipePath(`jarvis-ctest-${process.pid}-${randomBytes(3).toString("hex")}`);
  const server = new CoordinatorServer(core, { path, secret });
  await server.listen();
  const link = new CoordinatorLink(path, secret);
  await link.start();
  const bridge = new DevBridge({ link, staticDir: DIST, stt: sttImpl });
  await bridge.listen();
  return {
    core, dir, bridge, link,
    done: async () => { await bridge.close(); link.stop(); await server.close(); await core.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers: opts.headers ?? {} }, res => {
      let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

test("dev bridge: loopback host only, token required, no path traversal, CSP on every response", { skip: !existsSync(join(DIST, "index.html")) && "build the console first" }, async () => {
  const s = await stack();
  try {
    const base = s.bridge.url.split("#")[0]!;
    const port = new URL(base).port;
    const page = await raw(base, {});
    assert.equal(page.status, 200); assert.match(page.body, /<div id="root">/);
    assert.equal((await raw(base, { headers: { host: `evil.example:${port}` } })).status, 421, "DNS rebinding refused");
    assert.equal((await raw(`${base}rpc`, { method: "POST", body: JSON.stringify({ method: "status.get" }) })).status, 401);
    assert.equal((await raw(`${base}rpc`, { method: "POST", headers: { "x-jarvis-token": "wrong" }, body: "{}" })).status, 401);
    const ok = await raw(`${base}rpc`, { method: "POST", headers: { "x-jarvis-token": s.bridge.token, "content-type": "application/json" }, body: JSON.stringify({ method: "status.get" }) });
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).result.halted, false);
    const cross = await raw(`${base}rpc`, { method: "POST", headers: { "x-jarvis-token": s.bridge.token, origin: "http://evil.example" }, body: "{}" });
    assert.equal(cross.status, 403);
    assert.equal((await raw(`${base}..%2F..%2Fpackage.json`, {})).status, 404);
    assert.equal((await raw(`${base}events`, {})).status, 401);
    const hello = await raw(`${base}rpc`, { method: "POST", headers: { "x-jarvis-token": s.bridge.token }, body: JSON.stringify({ method: "hello", params: {} }) });
    assert.equal(JSON.parse(hello.body).error.code, "missing_permission", "the page can't re-handshake or hijack the event stream");
  } finally { await s.done(); }
});

test("Console in Chromium: chat, API key into the vault, emergency stop, a decision approved end to end, push-to-talk", { skip: (!existsSync(join(DIST, "index.html")) && "build the console first") || (!existsSync(CHROMIUM) && "no Chromium") }, async () => {
  const stt: SpeechToText = { id: "stt:test", transcribe: async () => ({ text: "Remind me to stretch", confidence: "high" }) };
  const s = await stack(stt);
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const ctx = await browser.newContext();
    // Record speech output instead of playing it.
    await ctx.addInitScript(() => {
      const w = window as unknown as { __spoken: string[]; __cancels: number };
      w.__spoken = []; w.__cancels = 0;
      if ("speechSynthesis" in window) {
        window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { w.__spoken.push(u.text); };
        window.speechSynthesis.cancel = () => { w.__cancels++; };
      }
    });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", e => consoleErrors.push(e.message));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(s.bridge.url);
    assert.equal(new URL(page.url()).hash, "", "the token is removed from the address bar");
    await page.getByTestId("key-banner").waitFor();

    // Onboarding (first run): name, time zone, quiet hours
    await page.getByTestId("onboarding").waitFor();
    await page.getByTestId("ob-name").fill("HYPOTHETICAL Owner");
    await page.getByTestId("ob-tz").fill("Europe/London");
    await page.getByTestId("ob-save").click();
    await page.getByTestId("onboarding").waitFor({ state: "detached" });
    assert.equal(s.core.episodic.getProfile()?.timezone, "Europe/London");
    assert.equal(s.core.episodic.getProfile()?.display_name, "HYPOTHETICAL Owner");

    // Attach a file and send it
    await page.getByTestId("file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("HYPOTHETICAL notes") });
    await page.getByTestId("attachments").getByText("notes.txt").waitFor();
    await page.getByTestId("composer").fill("Here are my notes");
    await page.getByTestId("send").click();
    await page.getByTestId("attachments").waitFor({ state: "detached" });
    const inbox = join(s.dir, "artifacts", "inbox");
    const saved = (await import("node:fs")).readdirSync(inbox).map(d => join(inbox, d, "notes.txt")).find(f => existsSync(f));
    assert.ok(saved && readFileSync(saved, "utf8") === "HYPOTHETICAL notes");

    // Chat
    await page.getByTestId("composer").fill("Hello JARVIS");
    await page.getByTestId("send").click();
    await page.getByText("Hello JARVIS", { exact: true }).waitFor();
    await page.getByTestId("msg-jarvis").nth(1).waitFor();
    assert.equal(await page.getByTestId("msg-jarvis").nth(1).locator("p").textContent(), "Hello from JARVIS (fake).");

    // Push-to-talk (fake microphone) → local STT → voice message
    const ptt = page.getByTestId("ptt");
    await ptt.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.getByText("Got it (voice).").waitFor({ timeout: 10_000 });
    assert.ok(await page.getByText("You (voice)").count() >= 1);
    const speech = await page.evaluate(() => { const w = window as unknown as { __spoken: string[]; __cancels: number }; return { spoken: [...w.__spoken], cancels: w.__cancels }; });
    assert.deepEqual(speech.spoken, ["Got it (voice)."], "a reply to voice input is spoken; earlier text replies were not");
    assert.ok(speech.cancels >= 1, "pressing push-to-talk silenced speech first (barge-in)");

    // API key → vault; never shown again
    const KEY = "sk-ant-HYPOTHETICAL-" + randomBytes(12).toString("hex");
    await page.getByTestId("tab-settings").click();
    await page.getByTestId("api-key").fill(KEY);
    await page.getByTestId("save-key").click();
    await page.getByTestId("key-saved").waitFor();
    assert.equal(await page.getByTestId("key-state").textContent(), "A key is stored.");
    assert.equal(await page.getByTestId("api-key").inputValue(), "");
    assert.ok(!(await page.content()).includes(KEY));
    assert.equal(s.core.vault.findByProvider("anthropic")?.provider, "anthropic");

    // Emergency stop and resume
    await page.getByTestId("emergency-stop").click();
    await page.getByTestId("resume").waitFor();
    assert.equal(s.core.broker.isHalted(), true);
    await page.getByTestId("resume").click();
    await page.getByTestId("emergency-stop").waitFor();
    assert.equal(s.core.broker.isHalted(), false);

    // A task that writes outside its scope waits for you; approving in "Needs you" completes it.
    const work = join(s.dir, "work"); mkdirSync(work, { recursive: true });
    const target = join(s.dir, "outside.txt");
    const t = s.core.tasks.create(contract("execute", ["write.local"], {
      objective: "HYPOTHETICAL: write a note", scope: { resources: [{ path_prefix: work }], accounts: [], exclusions: [] },
      success_criteria: [{ id: "c1", description: "note exists", check: { kind: "file_exists", spec: { path: target } }, acceptable_evidence: ["file_check"], required: true }],
    }));
    s.core.tasks.setPlan(t.task_id, [{ step_id: "s1", kind: "tool", description: "Write the note", capability: "tool:files.write", params: { path: target, content: "hello" }, depends_on: [], effects: ["write.local"], resources: [] }]);
    s.core.tasks.transition(t.task_id, "planned");
    const waiting = await s.core.steps.run(t.task_id);
    assert.equal(waiting.status, "waiting");
    await page.getByTestId("tab-needs").click();
    await page.getByTestId("decision").waitFor();
    assert.ok(await page.getByTestId("needs-badge").isVisible());
    await page.getByTestId("opt-approve").click();
    for (let i = 0; i < 100 && s.core.tasks.require(t.task_id).status !== "completed"; i++) await new Promise(r => setTimeout(r, 50));
    await s.core.idle();
    assert.equal(s.core.tasks.require(t.task_id).status, "completed");
    assert.equal(readFileSync(target, "utf8"), "hello");
    await page.getByTestId("tab-tasks").click();
    await page.getByText("HYPOTHETICAL: write a note").click();
    await page.getByTestId("task-detail").getByText("completed", { exact: true }).waitFor();

    // Usage
    await page.getByTestId("tab-usage").click();
    assert.ok(Number(await page.getByTestId("usage-calls").textContent()) >= 3);

    assert.deepEqual(consoleErrors, [], "no page errors");
  } finally { await browser?.close(); await s.done(); }
});
