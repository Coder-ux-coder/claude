import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { JarvisError, SimClock } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { CoordinatorServer } from "../src/ipc/coordinator-server.js";
import { SessionBridge } from "../src/nep/session-bridge.js";
import { NdjsonRpc, pipePath } from "../src/nep/rpc.js";

// All data below is HYPOTHETICAL test data.
const SECRET = randomBytes(24).toString("hex");

const rejects = async (p: Promise<unknown>, code: string) => {
  try { await p; assert.fail("expected rejection"); } catch (e) { assert.ok(e instanceof JarvisError, String(e)); assert.equal(e.code, code, e.message); }
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jv-ipc-"));
  const fake = new FakeAdapter("fake:boss", [], () => ({ structured: { intents: [{ kind: "reply", text: "Hello from JARVIS (fake)." }] } }));
  const core = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  core.start();
  const bridge = new SessionBridge(core.ctx, core.registry, core.leases, core.broker);
  const path = pipePath(`jarvis-test-${process.pid}-${randomBytes(4).toString("hex")}`);
  const server = new CoordinatorServer(core, { path, secret: SECRET, sessionBridge: bridge });
  await server.listen();
  const clients: NdjsonRpc[] = [];
  const connect = async (component: "console" | "session" | null = "console", secret = SECRET) => {
    const c = await NdjsonRpc.connect(path); clients.push(c);
    if (component) await c.call("hello", { protocol_version: "1.0", component, secret });
    return c;
  };
  const done = async () => { for (const c of clients) c.close(); await server.close(); await core.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return { core, fake, dir, path, server, bridge, connect, done };
}

test("IPC: hello with the session secret is required; wrong secret and wrong protocol are refused", async () => {
  const h = await setup();
  try {
    const anon = await h.connect(null);
    await rejects(anon.call("task.list", {}), "auth_required");
    const bad = await h.connect(null);
    await rejects(bad.call("hello", { protocol_version: "1.0", component: "console", secret: "x".repeat(48) }), "auth_required");
    const old = await h.connect(null);
    await rejects(old.call("hello", { protocol_version: "2.0", component: "console", secret: SECRET }), "unsupported_operation");
    const ok = await h.connect(null);
    const hi = await ok.call<{ protocol_version: string; halted: boolean }>("hello", { protocol_version: "1.3", component: "console", secret: SECRET });
    assert.equal(hi.protocol_version, "1.1"); assert.equal(hi.halted, false);
    await rejects(ok.call("no.such.method", {}), "unsupported_operation");
  } finally { await h.done(); }
});

test("IPC: the Session Agent can only report session events; lock revokes desktop leases; the hotkey halts dispatch", async () => {
  const h = await setup();
  try {
    const s = await h.connect("session");
    await rejects(s.call("conversation.send", { content: "hi" }), "missing_permission");
    await rejects(s.call("credentials.list", {}), "missing_permission");
    await s.call("session.lock", {});
    assert.equal(h.bridge.state, "locked");
    s.notify("hotkey.emergency_stop", {});
    const con = await h.connect("console");
    for (let i = 0; i < 50 && !h.core.broker.isHalted(); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(h.core.broker.isHalted(), true);
    assert.equal((await con.call<{ halted: boolean }>("status.get", {})).halted, true);
    await con.call("emergency.resume", {});
    assert.equal(h.core.broker.isHalted(), false);
  } finally { await h.done(); }
});

test("IPC: conversation.send → reply; messages readable; events.subscribe replays from a cursor then streams live", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const events: { event: { seq: number; type: string } }[] = [];
    c.onNotification = (m, p) => { if (m === "event") events.push(p as never); };
    const sub = await c.call<{ subscription: string; from_seq: number }>("events.subscribe", { from_seq: 0, types: ["conversation"] });
    const r = await c.call<{ conversation_id: string; replies: string[] }>("conversation.send", { content: "Hello JARVIS", modality: "text" });
    assert.deepEqual(r.replies, ["Hello from JARVIS (fake)."]);
    const msgs = await c.call<{ author: string; text: string }[]>("conversation.messages", { conversation_id: r.conversation_id });
    assert.deepEqual(msgs.map(m => [m.author, m.text]), [["owner", "Hello JARVIS"], ["jarvis", "Hello from JARVIS (fake)."]]);
    for (let i = 0; i < 50 && events.length < 2; i++) await new Promise(res => setTimeout(res, 10));
    assert.ok(events.length >= 2 && events.every(e => e.event.type.startsWith("conversation")), JSON.stringify(events.map(e => e.event.type)));
    const seqs = events.map(e => e.event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "in order");
    // Reconnect with the last cursor: nothing is replayed twice.
    const c2 = await h.connect("console");
    const replay: number[] = [];
    c2.onNotification = (m, p) => { if (m === "event") replay.push((p as { event: { seq: number } }).event.seq); };
    await c2.call("events.subscribe", { from_seq: seqs.at(-1)! , types: ["conversation"] });
    await c.call("events.unsubscribe", { subscription: sub.subscription });
    await c2.call("conversation.send", { content: "Again", conversation_id: r.conversation_id });
    for (let i = 0; i < 50 && replay.length < 2; i++) await new Promise(res => setTimeout(res, 10));
    assert.ok(replay.length >= 2 && replay.every(s => s > seqs.at(-1)!));
    await rejects(c.call("conversation.send", { content: "" }), "invalid_input");
  } finally { await h.done(); }
});

test("IPC: an API key goes into the vault only — never echoed, logged, or stored in settings", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const KEY = "sk-ant-HYPOTHETICAL-" + randomBytes(16).toString("hex");
    const meta = await c.call<Record<string, unknown>>("credentials.store", { provider: "anthropic", secret: KEY });
    assert.equal(meta.provider, "anthropic"); assert.ok(!JSON.stringify(meta).includes(KEY));
    const list = await c.call<unknown[]>("credentials.list", {});
    assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(KEY));
    // Replacing it rotates in place (one entry).
    await c.call("credentials.store", { provider: "anthropic", secret: KEY + "2" });
    assert.equal((await c.call<unknown[]>("credentials.list", {})).length, 1);
    assert.equal((await c.call<{ anthropic_key: boolean }>("status.get", {})).anthropic_key, true);
    await rejects(c.call("settings.set", { key: "ui.note", value: KEY }), "invalid_input");
    await rejects(c.call("settings.set", { key: "internal.policy", value: 1 }), "invalid_input");
    await c.call("settings.set", { key: "voice.tts_enabled", value: true });
    assert.deepEqual(await c.call("settings.get", {}), { "voice.tts_enabled": true });
    // Pasting the key into chat: it's redacted before storage.
    await c.call("conversation.send", { content: `my key is ${KEY}` });
    await h.core.shutdown().catch(() => {});
    // Nothing on disk outside the encrypted vault contains the key in clear.
    const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(h.dir)) assert.ok(!readFileSync(f).includes(Buffer.from(KEY)), `key found in clear in ${f}`);
  } finally { await h.done().catch(() => {}); }
});

test("IPC: tasks, schedules, decisions, memory, and rules are reachable; bad input is a structured error", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const s = h.core.scheduler.create({ kind: "reminder", owner_text: "HYPOTHETICAL", tz: "UTC", start_local: "2026-09-27T09:00", policy_revision: 0, message: "Call the dentist" });
    const list = await c.call<{ schedule_id: string; interpretation: string }[]>("schedules.list", {});
    assert.equal(list[0]!.schedule_id, s.schedule_id);
    const paused = await c.call<{ status: string }>("schedules.control", { schedule_id: s.schedule_id, op: "pause" });
    assert.equal(paused.status, "paused");
    await rejects(c.call("schedules.control", { schedule_id: s.schedule_id, op: "explode" }), "invalid_input");
    assert.deepEqual(await c.call("task.list", {}), []);
    await rejects(c.call("task.get", { task_id: "tsk_missing" }), "invalid_input");
    await rejects(c.call("task.control", { task_id: "x", op: "delete" }), "invalid_input");
    assert.deepEqual(await c.call("decision.list", {}), []);
    assert.deepEqual(await c.call("memory.search", { query: "dentist" }), []);
    assert.ok(Array.isArray(await c.call("rules.list", {})));
    assert.ok(Array.isArray(await c.call("notifications.needs_you", {})));
  } finally { await h.done(); }
});

test("main.js: starts from the Launcher's stdin secret, serves the pipe, answers without an API key, exits when stdin closes", async () => {
  const main = join(import.meta.dirname, "..", "dist", "main.js");
  assert.ok(existsSync(main), "build first");
  const dir = mkdtempSync(join(tmpdir(), "jv-main-"));
  const user = `jt${process.pid}${randomBytes(3).toString("hex")}`;
  const secret = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [main, "--data-dir", dir], { env: { ...process.env, USER: user, USERNAME: user, JARVIS_DEV_SESSION_SECRET: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", d => { stderr += d; });
  child.stdin.write(secret + "\n");
  const path = pipePath(`jarvis-core-${user}`);
  let rpc: NdjsonRpc | null = null;
  for (let i = 0; i < 100 && !rpc; i++) { try { rpc = await NdjsonRpc.connect(path, 200); } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(rpc, `core did not start: ${stderr}`);
  await rpc.call("hello", { protocol_version: "1.0", component: "console", secret });
  const st = await rpc.call<{ anthropic_key: boolean; safe_mode: boolean }>("status.get", {});
  assert.equal(st.anthropic_key, false); assert.equal(st.safe_mode, false);
  const r = await rpc.call<{ replies: string[] }>("conversation.send", { content: "What's on today?" });
  assert.match(r.replies[0]!, /API key is missing/);
  rpc.close();
  const code = await new Promise<number | null>(res => { child.once("exit", c => res(c)); child.stdin.end(); });
  assert.equal(code, 0, stderr);
  assert.ok(existsSync(join(dir, "data", "jarvis.db")));
  rmSync(dir, { recursive: true, force: true });
});

test("IPC: attachments — images reach the model as image blocks, files are saved safely, bad content is refused", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(32)]).toString("base64");
    const r = await c.call<{ replies: string[]; message_id: string }>("conversation.send", { content: "What's in this picture?", attachments: [
      { name: "photo.png", media_type: "image/png", data_base64: png },
      { name: "..\\..\\evil<>name.txt", media_type: "text/plain", data_base64: Buffer.from("HYPOTHETICAL notes").toString("base64") }] });
    assert.deepEqual(r.replies, ["Hello from JARVIS (fake)."]);
    const req = h.fake.requests.at(-1)!;
    const last = req.transcript.at(-1)!;
    assert.equal(last.content[0]!.type, "image", "the image is sent to the model");
    const text = last.content.find(x => x.type === "text") as { text: string };
    assert.match(text.text, /<untrusted>[\s\S]*photo\.png[\s\S]*evil__name\.txt[\s\S]*<\/untrusted>/, "attachment note is fenced as data; names sanitized");
    const inbox = join(h.dir, "artifacts", "inbox", r.message_id);
    assert.equal(readFileSync(join(inbox, "evil__name.txt"), "utf8"), "HYPOTHETICAL notes");
    assert.ok(!existsSync(join(h.dir, "evil<>name.txt")));
    const fakePng = await c.call<{ replies: string[] }>("conversation.send", { content: "look", attachments: [{ name: "x.png", media_type: "image/png", data_base64: Buffer.from("not an image").toString("base64") }] });
    assert.match(fakePng.replies[0]!, /not a valid image\/png image/);
    await rejects(c.call("conversation.send", { content: "x", attachments: "nope" }), "invalid_input");
  } finally { await h.done(); }
});

test("IPC: onboarding profile, timezone change moves floating schedules, usage summary", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    assert.equal(await c.call("profile.get", {}), null);
    const p = await c.call<{ timezone: string; display_name: string; revision: number }>("profile.set", { display_name: "HYPOTHETICAL Owner", timezone: "Europe/London" });
    assert.equal(p.timezone, "Europe/London"); assert.equal(p.revision, 1);
    const s = h.core.scheduler.create({ kind: "alarm", owner_text: "x", tz: "Europe/London", start_local: "2026-09-28T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
    await c.call("profile.set", { timezone: "Asia/Karachi" });
    assert.equal(h.core.scheduler.get(s.schedule_id)!.time.tz, "Asia/Karachi");
    await rejects(c.call("profile.set", { timezone: "Nowhere/Land" }), "invalid_input");
    await rejects(c.call("profile.set", { units: "cubits" }), "invalid_input");
    await c.call("conversation.send", { content: "hi" });
    const u = await c.call<{ calls: number; by_model: Record<string, { calls: number }> }>("usage.summary", {});
    assert.ok(u.calls >= 1); assert.ok(u.by_model["fake:boss"]!.calls >= 1);
  } finally { await h.done(); }
});

test("review 2: idempotency keys make retried commands safe; expired deadlines are refused", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const a = await c.call<{ message_id: string; conversation_id: string }>("conversation.send", { content: "Only once please", idempotency_key: "idk_test_000001" });
    const b = await c.call<{ message_id: string }>("conversation.send", { content: "Only once please", idempotency_key: "idk_test_000001" });
    assert.equal(b.message_id, a.message_id, "the retry returns the first result");
    const msgs = await c.call<{ author: string }[]>("conversation.messages", { conversation_id: a.conversation_id });
    assert.equal(msgs.filter(m => m.author === "owner").length, 1, "the message was stored once");
    await rejects(c.call("conversation.send", { content: "different", idempotency_key: "idk_test_000001" }), "conflict");
    await rejects(c.call("settings.set", { key: "ui.x", value: 1, idempotency_key: "bad key!" }), "invalid_input");
    // Concurrent duplicates join the same run.
    const [x, y] = await Promise.all([c.call<{ message_id: string }>("conversation.send", { content: "twin", idempotency_key: "idk_test_000002" }), c.call<{ message_id: string }>("conversation.send", { content: "twin", idempotency_key: "idk_test_000002" })]);
    assert.equal(x.message_id, y.message_id);
    await rejects(c.call("task.list", { deadline: "2026-09-26T11:59:00Z" }), "timeout");
    assert.deepEqual(await c.call("task.list", { deadline: "2026-09-26T12:05:00Z" }), []);
  } finally { await h.done(); }
});

test("review 2: memory edit via Markdown (preview then apply, diff recomputed server-side), correct, export and import; rules.propose → confirm", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const m1 = h.core.memory.remember({ type: "preference", text: "HYPOTHETICAL: I prefer aisle seats.", content: { domain: "travel.seat", value: "aisle", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "msg_x" });
    const id = "record" in m1 ? m1.record.id : assert.fail("not stored");
    const view = await c.call<{ markdown: string; exported_ids: string[] }>("memory.markdown", { type: "preference" });
    assert.deepEqual(view.exported_ids, [id]);
    const edited = view.markdown.replace("I prefer aisle seats.", "I prefer window seats.");
    const diff = await c.call<{ edits: { record_id: string; new_text: string }[] }>("memory.markdown_preview", { markdown: edited, exported_ids: view.exported_ids });
    assert.equal(diff.edits.length, 1); assert.match(diff.edits[0]!.new_text, /window seats/);
    await rejects(c.call("memory.markdown_apply", { markdown: edited, exported_ids: ["mem_FORGED"] }), "invalid_input");
    const applied = await c.call<{ corrected: string[] }>("memory.markdown_apply", { markdown: edited, exported_ids: view.exported_ids });
    assert.deepEqual(applied.corrected, [id]);
    const now = await c.call<{ id: string; text: string }[]>("memory.search", { query: "window seats" });
    assert.equal(now.length, 1); assert.notEqual(now[0]!.id, id, "a new revision record; the old one is superseded");
    const corr = await c.call<{ kind: string }>("memory.correct", { target_ids: [now[0]!.id], kind: "should_not_remember" });
    assert.equal(corr.kind, "should_not_remember");
    assert.deepEqual(await c.call("memory.search", { query: "window seats" }), []);
    await rejects(c.call("memory.correct", { target_ids: [id], kind: "wrong_value" }), "invalid_input");
    const exp = await c.call<{ path: string; files: number }>("memory.export", {});
    assert.ok(existsSync(exp.path) && exp.path.endsWith(".jarvis-archive"));
    const imp = await c.call<{ imported: Record<string, number> }>("memory.import", { path: exp.path });
    assert.ok(imp.imported);
    await rejects(c.call("memory.import", { path: "/etc/passwd" }), "invalid_input");
    // A rule from the Console editor is a draft until confirmed.
    const prop = await c.call<{ rule: { rule_id: string; status: string }; errors: string[]; needs_confirmation: boolean }>("rules.propose", { draft: {
      kind: "constraint", text: "HYPOTHETICAL: never delete anything in the Archive folder", applies_to: { effects: ["delete.local"], resources: [{ path_prefix: join(h.dir, "Archive") }] },
      decision: "deny", enforcement: "broker", protection: "normal", conflict: "deny_wins", compile: { status: "compiled", interpretation: "Deny deletes under Archive" } } });
    assert.deepEqual(prop.errors, []); assert.equal(prop.rule.status, "draft"); assert.equal(prop.needs_confirmation, true);
    const conf = await c.call<{ status: string }>("rules.confirm", { rule_id: prop.rule.rule_id });
    assert.equal(conf.status, "active");
    await rejects(c.call("rules.propose", { draft: { kind: "constraint" } }), "invalid_input");
  } finally { await h.done(); }
});

test("F22: status.get shows the unavailable database instead of failing", async () => {
  const h = await setup();
  try {
    const c = await h.connect("console");
    const realPrepare = h.core.ctx.db.prepare.bind(h.core.ctx.db);
    (h.core.ctx.db as { prepare: unknown }).prepare = () => { throw new Error("SQLITE_CORRUPT: database disk image is malformed"); };
    const st = await c.call<{ database: string; safe_mode: boolean }>("status.get", {});
    (h.core.ctx.db as { prepare: unknown }).prepare = realPrepare;
    assert.equal(st.database, "unavailable"); assert.equal(st.safe_mode, true);
    assert.equal((await c.call<{ database: string }>("status.get", {})).database, "ok");
  } finally { await h.done(); }
});

test("review 3: mutual handshake — the secret never crosses the pipe; a squatting server learns nothing; forged proofs fail", async () => {
  const { coordinatorHandshake } = await import("../src/nep/rpc.js");
  const { handshakeProof } = await import("../src/ipc/coordinator-server.js");
  const { createServer } = await import("node:net");
  const h = await setup();
  try {
    // Real server: admitted.
    const ok = await h.connect(null);
    const hi = await coordinatorHandshake(ok, SECRET, "console");
    assert.equal(hi.protocol_version, "1.1");
    assert.equal((await ok.call<{ halted: boolean }>("status.get", {})).halted, false);
    // Client with the wrong secret: refuses the server's proof and never sends one.
    const wrong = await h.connect(null);
    await rejects(coordinatorHandshake(wrong, "f".repeat(48), "console"), "auth_required");
    // Forged client proof and finish-without-challenge are refused.
    const forged = await h.connect(null);
    const r = await forged.call<{ server_nonce: string }>("hello", { protocol_version: "1.1", component: "console", client_nonce: "a".repeat(48) });
    assert.ok(r.server_nonce);
    await rejects(forged.call("hello.finish", { client_proof: handshakeProof("not-the-secret", "client", "a".repeat(48), r.server_nonce) }), "auth_required");
    const noChallenge = await h.connect(null);
    await rejects(noChallenge.call("hello.finish", { client_proof: "0".repeat(64) }), "auth_required");
    // A process squatting a pipe name: records everything the client sends.
    const squatPath = pipePath(`jarvis-squat-${process.pid}-${randomBytes(3).toString("hex")}`);
    let seen = "";
    const squat = createServer(sock => { sock.setEncoding("utf8"); sock.on("data", (d: string) => { seen += d;
      for (const line of d.split("\n").filter(Boolean)) { const m = JSON.parse(line); if (m.method === "hello") sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { server_nonce: "b".repeat(48), server_proof: "c".repeat(64) } }) + "\n"); } }); });
    await new Promise<void>(res => squat.listen(squatPath, () => res()));
    const victim = await NdjsonRpc.connect(squatPath);
    await rejects(coordinatorHandshake(victim, SECRET, "console"), "auth_required");
    squat.close();
    assert.ok(!seen.includes(SECRET), "the squatter never saw the secret");
    assert.ok(!seen.includes("hello.finish"), "no client proof was offered to an unproven server");
  } finally { await h.done(); }
});

test("review 3: attachments up to the documented limit travel over the pipe; over it, a clear error", async () => {
  const h = await setup();
  try {
    const c = await NdjsonRpc.connect(h.path, 5000, { maxLine: 48 * 1024 * 1024 });
    await c.call("hello", { protocol_version: "1.1", component: "console", secret: SECRET });
    const big = randomBytes(20 * 1024 * 1024).toString("base64");
    const r = await c.call<{ replies: string[] }>("conversation.send", { content: "big file", attachments: [{ name: "data.bin", media_type: "application/octet-stream", data_base64: big }] });
    assert.deepEqual(r.replies, ["Hello from JARVIS (fake)."]);
    const two = await c.call<{ replies: string[] }>("conversation.send", { content: "too much", attachments: [
      { name: "a.bin", media_type: "application/octet-stream", data_base64: randomBytes(17 * 1024 * 1024).toString("base64") },
      { name: "b.bin", media_type: "application/octet-stream", data_base64: randomBytes(17 * 1024 * 1024).toString("base64") }] });
    assert.match(two.replies[0]!, /total under 32 MB/);
    c.close();
  } finally { await h.done(); }
});
