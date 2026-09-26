import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SimClock } from "@jarvis/shared";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";
import { safeFileName } from "../src/executors/browser.js";
import { contract } from "./helpers/fixtures.js";

const CHROMIUM = process.env.JARVIS_CHROMIUM ?? "/opt/pw-browsers/chromium";
const BIN = Buffer.from("HYPOTHETICAL report %PDF-1.4 ".repeat(100));

async function fixtureServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>HYPOTHETICAL Venue</title><body><p id="x">static</p>
      <a href="/about">About</a><a href="http://10.0.0.5/admin">router</a><img src="http://192.168.1.1/pixel.png">
      <script>document.getElementById("x").textContent = "Rendered by JavaScript: opens 09:00";</script></body>`); return; }
    if (req.url === "/to-private") { res.writeHead(302, { location: "http://10.0.0.5/secret" }); res.end(); return; }
    if (req.url === "/file.pdf") { res.writeHead(200, { "content-type": "application/pdf", "content-length": BIN.length }); res.end(BIN); return; }
    if (req.url === "/moved") { res.writeHead(301, { location: "/file.pdf" }); res.end(); return; }
    if (req.url === "/gone") { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<title>other</title>ok");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("safe download names", () => {
  assert.equal(safeFileName("../../etc/passwd"), "_.._etc_passwd", "no path separators or leading dots");
  assert.equal(safeFileName("CON"), "file_CON");
  assert.equal(safeFileName("report:2026?.pdf"), "report_2026_.pdf");
});

test("Browser Runtime v0: headless read with JavaScript, private hosts refused (links, redirects), downloads with file evidence, through the Broker", { skip: !existsSync(CHROMIUM) && "no Chromium" }, async () => {
  const { server, base } = await fixtureServer();
  const dir = mkdtempSync(join(tmpdir(), "jv-br-"));
  const j = new JarvisCore({ dataDir: dir, clock: new SimClock("2026-09-26T12:00:00Z"), adapters: [{ adapter: new FakeAdapter("fake:boss", []), provider: "anthropic", model: "claude-opus-5-5", billing: "api" }],
    browser: { executablePath: CHROMIUM, allowPrivate: h => h === "127.0.0.1", maxDownloadBytes: 1_000_000 } });
  j.start();
  try {
    const task = j.tasks.create(contract("research", ["read.account", "write.local"], { objective: "HYPOTHETICAL: research the venue", scope: { resources: [], accounts: [], exclusions: [] } }));
    j.tasks.transition(task.task_id, "planned"); j.tasks.transition(task.task_id, "running");
    const run = (capability: string, params: Record<string, unknown>) => j.broker.execute({ task_id: task.task_id, capability, params, requested_by: { kind: "boss", ref: "t" } });
    const r = await run("tool:browser.read_page", { url: `${base}/page` });
    assert.equal(r.status, "done", JSON.stringify(r));
    const out = (r as { result: { output: { title: string; content: string; links: { href: string }[] } } }).result.output;
    assert.equal(out.title, "HYPOTHETICAL Venue");
    assert.match(out.content, /^<untrusted source=/); assert.match(out.content, /Rendered by JavaScript: opens 09:00/);
    assert.deepEqual(out.links.map(l => l.href), [`${base}/about`], "the private-network link is dropped");
    const red = await run("tool:browser.read_page", { url: `${base}/to-private` });
    assert.equal((red as { result: { error?: { code: string } } }).result.error?.code, "missing_permission");
    const direct = await run("tool:browser.read_page", { url: "http://192.168.1.10/" });
    assert.equal((direct as { result: { error?: { code: string } } }).result.error?.code, "missing_permission");
    const file = await run("tool:browser.download", { url: `${base}/moved`, filename: "report.pdf" });
    assert.equal(file.status, "done", JSON.stringify(file));
    const fo = (file as { result: { output: { path: string; sha256: string; bytes: number } } }).result.output;
    assert.equal(fo.bytes, BIN.length); assert.equal(fo.sha256, createHash("sha256").update(BIN).digest("hex"));
    assert.ok(fo.path.startsWith(join(dir, "artifacts", "downloads")), "downloads stay in the artifacts area");
    assert.deepEqual(readFileSync(fo.path), BIN);
    assert.ok(j.evidence.forTask(task.task_id).some(e => e.type === "file_check" && e.data.sha256 === fo.sha256));
    const gone = await run("tool:browser.download", { url: `${base}/gone` });
    assert.equal((gone as { result: { error?: { code: string } } }).result.error?.code, "external_refusal");
    // Size limit.
    const dir2 = mkdtempSync(join(tmpdir(), "jv-br2-"));
    const small = new JarvisCore({ dataDir: dir2, adapters: [{ adapter: new FakeAdapter("f2", []), provider: "anthropic", model: "claude-opus-5-5", billing: "api" }], browser: { executablePath: CHROMIUM, allowPrivate: h => h === "127.0.0.1", maxDownloadBytes: 10 } });
    small.start();
    try {
      const t2 = small.tasks.create(contract("research", ["read.account", "write.local"], { objective: "HYPOTHETICAL", scope: { resources: [], accounts: [], exclusions: [] } }));
      small.tasks.transition(t2.task_id, "planned"); small.tasks.transition(t2.task_id, "running");
      const r2 = await small.broker.execute({ task_id: t2.task_id, capability: "tool:browser.download", params: { url: `${base}/file.pdf` }, requested_by: { kind: "boss", ref: "t" } });
      assert.equal((r2 as { result: { error?: { code: string; message: string } } }).result.error?.code, "invalid_input");
    } finally { await small.shutdown(); rmSync(dir2, { recursive: true, force: true }); }
  } finally { await j.shutdown(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});
