import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarvisError, SimClock } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { restoreBackup } from "../src/backup/backup.js";

// All data HYPOTHETICAL.
const PASS = "correct horse battery staple (HYPOTHETICAL)";
const SECRET_TEXT = "HYPOTHETICAL: my blood type is AB negative";

function core(dir: string, clock = new SimClock("2026-09-26T12:00:00Z")) {
  const j = new JarvisCore({ dataDir: dir, clock, adapters: [{ adapter: new FakeAdapter("fake:boss", []), provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  return j;
}

test("backups: encrypted with the passphrase key, restore-tested, and restorable on a new PC with only the passphrase", async () => {
  const a = mkdtempSync(join(tmpdir(), "jv-bk-a-")), b = mkdtempSync(join(tmpdir(), "jv-bk-b-"));
  try {
    const j = core(a);
    j.memory.entities.ensureOwner("HYPOTHETICAL Owner");
    const w = j.memory.remember({ type: "fact", text: SECRET_TEXT, content: { predicate: "blood_type", value: "AB-" }, scope: { level: "global" }, sensitivity: "sensitive", message_id: "msg_1" });
    assert.ok("record" in w);
    const id = (w as { record: { id: string } }).record.id;
    j.vault.put({ kind: "api_key", provider: "anthropic", label: "k" }, "sk-ant-HYPOTHETICAL-0123456789abcdef");
    await assert.rejects(j.backups!.run(), /recovery passphrase/);
    await assert.rejects(j.backups!.setPassphrase("short"), /at least 12/);
    await j.backups!.setPassphrase(PASS);
    const rec = await j.backups!.run("manual");
    const blob = readFileSync(rec.path);
    assert.ok(!blob.includes(Buffer.from("AB negative")) && !blob.includes(Buffer.from("SQLite format")), "nothing readable in the backup file");
    assert.ok(!blob.includes(Buffer.from("sk-ant-HYPOTHETICAL")), "the vault is excluded by default");
    const v = await j.backups!.verify();
    assert.equal(v.ok, true, v.checks.join("\n"));
    assert.ok(v.checks.includes("integrity_check ok") && v.checks.some(c => /row counts match/.test(c)));
    assert.equal(j.backups!.list()[0]!.verify_result, "passed");
    // Tampering is detected.
    const bad = Buffer.from(blob); bad[bad.length - 5] ^= 0xff; writeFileSync(rec.path, bad);
    const v2 = await j.backups!.verify();
    assert.equal(v2.ok, false);
    writeFileSync(rec.path, blob);
    await j.shutdown();
    // Restore on a "new PC": wrong passphrase fails; the right one restores everything but the vault.
    await assert.rejects(restoreBackup({ file: rec.path, passphrase: "wrong passphrase entirely", targetDir: b, wrapMasterKey: k => k }), (e: unknown) => e instanceof JarvisError && e.code === "auth_required");
    const r = await restoreBackup({ file: rec.path, passphrase: PASS, targetDir: b, wrapMasterKey: k => k });
    assert.ok(r.files >= 3, "database, manifest and key escrow at least");
    const j2 = core(b);
    try {
      assert.equal(j2.memory.get(id)!.text, SECRET_TEXT, "sealed sensitive memory opens with the escrowed master key");
      assert.equal(j2.vault.findByProvider("anthropic"), undefined, "connectors need sign-in again after a restore");
      assert.equal(j2.backups!.configured(), true, "the backup key came along (sealed under the same master key)");
    } finally { await j2.shutdown(); }
    await assert.rejects(restoreBackup({ file: rec.path, passphrase: PASS, targetDir: b, wrapMasterKey: k => k }), /new, empty data directory/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("backups: nightly and weekly maintenance, 30-day retention that keeps the newest tested backup, purge on request", async () => {
  const a = mkdtempSync(join(tmpdir(), "jv-bk-m-"));
  const clock = new SimClock("2026-09-01T02:00:00Z");
  try {
    const j = core(a, clock);
    assert.deepEqual(await j.backups!.maintenance(), {}, "nothing until a passphrase is set");
    await j.backups!.setPassphrase(PASS);
    const m1 = await j.backups!.maintenance();
    assert.ok(m1.backed_up); assert.equal(m1.tested, true);
    clock.advance(3_600_000);
    assert.deepEqual(await j.backups!.maintenance(), {}, "one backup a night");
    for (let d = 1; d <= 35; d++) { clock.advance(86_400_000); await j.backups!.maintenance(); }
    const list = j.backups!.list();
    assert.ok(list.every(b => Date.parse(b.at) >= clock.now() - 31 * 86_400_000), "older than 30 days are gone");
    assert.ok(list.length >= 29 && list.length <= 32);
    assert.equal(readdirSync(j.backups!.destination).filter(f => f.endsWith(".jvbak")).length, list.length, "files match records");
    assert.ok(list.filter(b => b.verify_result === "passed").length >= 4, "weekly restore tests ran");
    assert.equal(j.backups!.purgeAll(), list.length);
    assert.equal(readdirSync(j.backups!.destination).filter(f => f.endsWith(".jvbak")).length, 0);
    await j.shutdown();
  } finally { rmSync(a, { recursive: true, force: true }); }
});
