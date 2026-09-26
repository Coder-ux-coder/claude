import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coreHarness } from "./helpers/core-fixtures.js";
import { ExecHostClient, RemoteExecHostExecutor, nepSignature } from "../src/nep/exec-host.js";
import { pipePath } from "../src/nep/rpc.js";
import { SessionBridge } from "../src/nep/session-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const DLL = resolve(here, "../../../native/Jarvis.ExecHost/bin/Debug/net8.0/jarvis-exec.dll");
const canRun = existsSync(DLL) && process.platform !== "win32";

async function startExecHost(): Promise<{ proc: ChildProcess; client: ExecHostClient; secret: string; nepKey: Buffer; name: string }> {
  const name = `jarvis-exec-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const proc = spawn("dotnet", [DLL, "--pipe", name], { stdio: ["pipe", "ignore", "inherit"] });
  proc.stdin!.write(secret + "\n");
  for (let i = 0; i < 100 && !existsSync(pipePath(name)); i++) await new Promise(r => setTimeout(r, 100));
  const nepKey = randomBytes(32);
  const client = await ExecHostClient.connect(pipePath(name), secret, nepKey);
  return { proc, client, secret, nepKey, name };
}

test("native Exec Host: signed shell runs, forged signatures refused, secrets injected and redacted, emergency stop kills", { skip: !canRun && "jarvis-exec not built (run dotnet build in jarvis/native)" }, async () => {
  const eh = await startExecHost();
  try {
    assert.equal(eh.client.info.host, "jarvis-exec");
    const h = coreHarness();
    mkdirSync(join(h.dir, "work"), { recursive: true });
    h.broker.registerExecutor(new RemoteExecHostExecutor(eh.client, eh.nepKey));
    const { task } = h.task("execute", ["read.local", "execute_code"]);
    const m = h.tasks.require(task.task_id).origin.message_ids[0]!;
    h.tasks.revise(task.task_id, [{ op: "add", path: "/authorization/envelope", value: { effects: ["execute_code"], substitution: "exact_target",
      bounds: [{ id: "b1", field: "program", op: "in", value: ["/bin/sh"], source: { kind: "owner_message", ref: m }, hard: true }],
      grounding: [{ constraint_id: "b1", source: { kind: "owner_message", ref: m } }], derived_by: { adapter: "t", at: h.clock.iso() }, validated_at: h.clock.iso() } }], "envelope");
    const run = (args: string[], extra: Record<string, unknown> = {}) => h.broker.execute({ task_id: task.task_id, capability: "tool:shell.run",
      params: { program: "/bin/sh", args, cwd: join(h.dir, "work"), env_allowlist: ["PATH"], timeout_s: 20, max_output_bytes: 10_000, tier: "T1", job_limits: {}, ...extra }, requested_by: { kind: "boss", ref: "t" } });
    const ok = await run(["-c", "echo from-native-exec-host"]);
    assert.equal(ok.status, "done", JSON.stringify(ok).slice(0, 400));
    assert.match(String((ok as { result: { output: { output: string } } }).result.output.output), /from-native-exec-host/);
    assert.equal((ok as { result: { evidence: { type: string }[] } }).result.evidence[0]!.type, "process_exit");
    // A forged signature (wrong key) is refused by the native side before anything runs.
    const forged = new RemoteExecHostExecutor(eh.client, randomBytes(32));
    h.broker.registerExecutor(forged);
    const marker = join(h.dir, "work", "forged-ran");
    const bad = await run(["-c", `touch ${marker}`]);
    assert.equal(bad.status, "error");
    assert.match(JSON.stringify(bad), /grant rejected/);
    assert.ok(!existsSync(marker), "nothing ran");
    h.broker.registerExecutor(new RemoteExecHostExecutor(eh.client, eh.nepKey));
    // Secrets: vault → environment of that one process; never in argv; redacted from output.
    const cred = h.vault.put({ kind: "api_key", provider: "example", label: "HYPOTHETICAL token" }, "tok-HYPOTHETICAL-9f8e7d6c5b");
    const sec = await run(["-c", "echo token=$EXAMPLE_TOKEN"], { env_inject: [{ name: "EXAMPLE_TOKEN", secret_ref: cred.credential_ref }] });
    assert.equal(sec.status, "done");
    const out = String((sec as { result: { output: { output: string } } }).result.output.output);
    assert.ok(!out.includes("9f8e7d6c5b") && out.includes("[redacted-secret]"), out);
    // Emergency stop during a long run: cancelled, and the process tree is gone.
    const long = run(["-c", `sleep 30; touch ${join(h.dir, "work", "survived")}`]);
    await new Promise(r => setTimeout(r, 700));
    h.broker.halt("test");
    const stopped = await long;
    assert.notEqual(stopped.status, "done");
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!existsSync(join(h.dir, "work", "survived")));
    h.broker.resumeAfterHalt(true);
    // Recoverable delete through the native side.
    const f = join(h.dir, "work", "old.txt"); writeFileSync(f, "x");
    const env2 = h.tasks.require(task.task_id).authorization.envelope!;
    h.tasks.revise(task.task_id, [{ op: "replace", path: "/intended_effects", value: ["read.local", "execute_code", "delete.local"] },
      { op: "replace", path: "/authorization/envelope", value: { ...env2, effects: ["execute_code", "delete.local"], bounds: [...env2.bounds, { id: "b2", field: "path", op: "==", value: f, source: { kind: "owner_message", ref: m }, hard: true }],
        grounding: [...env2.grounding, { constraint_id: "b2", source: { kind: "owner_message", ref: m } }] } }], "allow delete");
    const del = await h.broker.execute({ task_id: task.task_id, capability: "tool:files.delete", params: { path: f }, requested_by: { kind: "boss", ref: "t" } });
    assert.equal(del.status, "done", JSON.stringify(del).slice(0, 400));
    assert.ok(!existsSync(f));
  } finally {
    eh.client.close(); eh.proc.kill();
  }
});

test("NEP signature is byte-exact and covers every field", () => {
  const key = randomBytes(32);
  const nep = { invocation_id: "inv_1", capability: "tool:shell.run@1.0.0", params: {}, grant: { decision_id: "g", signature: "", fingerprint: "f", expires_at: "2026-10-01T10:00:00.000Z" },
    task_revision: 2, policy_revision: 5, idempotency_key: "idk", deadline: "2026-10-01T10:00:00.000Z" };
  const a = nepSignature(key, nep, '{"a":1}');
  assert.notEqual(a, nepSignature(key, nep, '{"a":2}'));
  assert.notEqual(a, nepSignature(key, { ...nep, task_revision: 3 }, '{"a":1}'));
  assert.notEqual(a, nepSignature(key, { ...nep, capability: "tool:x@1.0.0" }, '{"a":1}'));
  assert.equal(a, nepSignature(key, nep, '{"a":1}'));
});

test("session bridge: lock revokes desktop leases and pauses desktop capabilities; hotkey halts; resume hooks run", () => {
  const h = coreHarness();
  let resumed = 0, ptt: boolean[] = [];
  const bridge = new SessionBridge(h.ctx, h.registry, h.leases, h.broker, { onResume: () => resumed++, onPushToTalk: d => ptt.push(d) });
  h.registry.register({ ...h.registry.resolve("tool:files.read")!, id: "tool:desktop.click", environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: true, requires_unlocked_desktop: true, network: "none" } }, { via: "builtin" });
  const { task } = h.task("execute", ["read.local"]);
  const l = h.leases.acquire("desktop:input", "exclusive", { task_id: task.task_id });
  assert.ok(l.granted);
  bridge.handle("session.lock", {});
  assert.equal(h.leases.heldBy(task.task_id).length, 0, "desktop lease revoked on lock");
  assert.equal(h.registry.health("tool:desktop.click").state, "unavailable_now");
  assert.equal(h.registry.health("tool:files.read").state, "available", "background work continues");
  bridge.handle("session.unlock", {});
  assert.equal(h.registry.health("tool:desktop.click").state, "available");
  bridge.handle("power.suspend", {}); bridge.handle("power.resume", {});
  assert.equal(resumed, 1); assert.equal(bridge.state, "locked");
  bridge.handle("hotkey.ptt_down", {}); bridge.handle("hotkey.ptt_up", {});
  assert.deepEqual(ptt, [true, false]);
  bridge.handle("hotkey.emergency_stop", {});
  assert.equal(h.broker.isHalted(), true);
});
