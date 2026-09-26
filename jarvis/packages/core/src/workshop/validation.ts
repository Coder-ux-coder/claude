import { readFileSync, existsSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactMessage, type CapabilityDescriptor, type DevWorkOrder, type EffectClass } from "@jarvis/shared";
import type { SandboxRunner } from "./sandbox.js";
import { MANIFEST_FILE, candidateDescriptor, isText, listFiles, packageHash, readManifest } from "./package.js";

export type RiskClass = "R0" | "R1" | "R2" | "R3";
/** Promotion risk class from effects (07 §12.8). */
export function riskClass(effects: readonly EffectClass[]): RiskClass {
  if (effects.some(e => ["spend", "commit", "publish", "access_control", "admin", "install"].includes(e))) return "R3";
  if (effects.some(e => e === "communicate" || e.startsWith("delete."))) return "R2";
  if (effects.some(e => e.startsWith("write."))) return "R1";
  return "R0";
}

export interface Finding { severity: "error" | "warning" | "info"; message: string; file?: string }
export interface StageResult { stage: number; name: string; ok: boolean; findings: Finding[] }
export interface HoldoutCase { name: string; input: unknown; expect: { status: "ok" | "error"; output_equals?: unknown; output_contains?: Record<string, unknown>; error_code?: string } }
export interface ValidationReport {
  ok: boolean; capability_id: string; version: string; package_hash: string; risk_class: RiskClass;
  descriptor?: CapabilityDescriptor;
  stages: StageResult[];
  tests: { suite: string; passed: number; failed: number }[];
  holdout: { set: string; passed: number; failed: number; failures: string[] };
  permission_delta: { added: string[]; removed: string[] };
  /** No earlier version: the delta is the whole permission set and promotion follows the risk class (07 §12.8). */
  first_release?: boolean;
  untested: string[];
  environment: { runner: string; isolated: boolean; node: string };
  confidence_limits: string;
}

const NET_MODULES = ["net", "http", "https", "http2", "dgram", "tls", "dns", "undici", "ws"];
const PROC_MODULES = ["child_process", "worker_threads", "cluster", "vm", "inspector"];
const importRe = (mods: string[]) => new RegExp(`(?:require\\(\\s*|from\\s+|import\\(\\s*|import\\s+)["'](?:node:)?(${mods.join("|")})(?:/[^"']*)?["']`, "g");
const SECRET_RES = [/\bsk-[A-Za-z0-9_-]{16,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{20,}\b/, /\bAIza[0-9A-Za-z_-]{20,}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/];

/**
 * Validation pipeline (08 §13.8), M1 stages 1–5, 7 and 9, run by JARVIS on the candidate —
 * never trusting the builder's own test results. Holdout cases come from the Release
 * Manager and reach the tool only on stdin inside a separate copy, never the builder's workspace.
 */
export async function validatePackage(input: {
  dir: string; order: DevWorkOrder; runner: SandboxRunner; scratchDir: string;
  holdout: { set: string; cases: HoldoutCase[] }; previous?: CapabilityDescriptor;
}): Promise<ValidationReport> {
  const { dir, order, runner } = input;
  const stages: StageResult[] = [];
  const stage = (n: number, name: string, findings: Finding[]) => { const r = { stage: n, name, ok: !findings.some(f => f.severity === "error"), findings }; stages.push(r); return r; };
  const report: ValidationReport = {
    ok: false, capability_id: order.dev.target.capability_id ?? "?", version: "?", package_hash: "", risk_class: "R0", stages, tests: [],
    holdout: { set: input.holdout.set, passed: 0, failed: 0, failures: [] }, permission_delta: { added: [], removed: [] },
    untested: ["egress and filesystem observation during tests (stage 6, not in M1)", "integration through the Broker against simulators (stage 8, not in M1)"],
    environment: { runner: runner.id, isolated: runner.isolated, node: process.version },
    confidence_limits: "",
  };

  // 1. Structure and contract
  const f1: Finding[] = [];
  let files: string[] = [];
  let descriptor: CapabilityDescriptor | undefined;
  try {
    files = listFiles(dir);
    const m = readManifest(dir);
    report.capability_id = m.id; report.version = m.version;
    if (order.dev.target.capability_id && m.id !== order.dev.target.capability_id) f1.push({ severity: "error", message: `package id ${m.id} is not the target ${order.dev.target.capability_id}` });
    if (!files.includes(m.entry)) f1.push({ severity: "error", message: `entry ${m.entry} is missing` });
    const testFiles = files.filter(f => f.startsWith(`${m.tests}/`) && /\.test\.(m?js|cjs)$/.test(f));
    if (!testFiles.length) f1.push({ severity: "error", message: `no tests under ${m.tests}/ (*.test.mjs)` });
    report.package_hash = packageHash(dir);
    descriptor = candidateDescriptor(m, order, report.package_hash);
    const extra = descriptor.side_effects.effect_classes.filter(e => !order.dev.permission_boundaries.declared_effects.includes(e));
    if (extra.length) f1.push({ severity: "error", message: `declares effects outside the work order: ${extra.join(", ")}` });
    if (descriptor.side_effects.effect_classes.some(e => !e.startsWith("read.") && e !== "notify_owner") && descriptor.verification.method === "none") f1.push({ severity: "error", message: "an effectful tool must declare a verification method" });
    report.risk_class = riskClass(descriptor.side_effects.effect_classes);
    report.descriptor = descriptor;
  } catch (e) { f1.push({ severity: "error", message: (e as Error).message }); }
  if (!stage(1, "structure and contract", f1).ok || !descriptor) return finish(report);

  // 2. Static checks: syntax, and forbidden APIs relative to the declarations
  const f2: Finding[] = [];
  const code = files.filter(f => /\.(m?js|cjs)$/.test(f) && !f.startsWith("node_modules/"));
  const effects = descriptor.side_effects.effect_classes;
  const writes = effects.some(e => e.startsWith("write.") || e.startsWith("delete."));
  for (const f of code) {
    const src = readFileSync(join(dir, f), "utf8");
    const isTest = f.startsWith(`${readManifest(dir).tests}/`);
    const chk = await runner.run(["node", "--check", f], { cwd: dir, timeoutMs: 30_000, network: "none" });
    if (chk.code !== 0) f2.push({ severity: "error", file: f, message: `syntax: ${chk.stderr.split("\n").find(l => l.trim()) ?? "invalid"}` });
    if (descriptor.environment.network === "none") {
      for (const m of src.matchAll(importRe(NET_MODULES))) f2.push({ severity: "error", file: f, message: `uses the network module "${m[1]}" but network is none` });
      if (/\b(fetch|WebSocket|EventSource)\s*\(/.test(src)) f2.push({ severity: "error", file: f, message: "network call while network is none" });
    }
    if (!isTest) for (const m of src.matchAll(importRe(PROC_MODULES))) f2.push({ severity: "error", file: f, message: `spawns code ("${m[1]}"), which a T2 tool may not do` });
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) f2.push({ severity: "error", file: f, message: "dynamic code evaluation" });
    if (!isTest && !writes && /\b(writeFile|appendFile|rm|rmdir|unlink|rename|mkdir|copyFile|createWriteStream)(Sync)?\s*\(/.test(src)) f2.push({ severity: "error", file: f, message: "writes files without a declared write effect" });
    if (/process\.env\b/.test(src)) f2.push({ severity: "warning", file: f, message: "reads environment variables (the sandbox provides almost none)" });
  }
  stage(2, "static checks", f2);

  // 3. Dependency audit
  const f3: Finding[] = [];
  const pkgJson = files.includes("package.json") ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; scripts?: Record<string, string> } : {};
  const deps = Object.keys(pkgJson.dependencies ?? {});
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) if (pkgJson.scripts?.[s]) f3.push({ severity: "error", message: `package defines a "${s}" script` });
  if (deps.length) {
    if (!files.includes("package-lock.json")) f3.push({ severity: "error", message: "dependencies without a pinned package-lock.json" });
    else {
      const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string; resolved?: string; integrity?: string; license?: string; hasInstallScript?: boolean }> };
      for (const [path, p] of Object.entries(lock.packages ?? {})) {
        if (!path) continue;
        const name = path.replace(/^.*node_modules\//, "");
        if (!p.integrity || !p.version) f3.push({ severity: "error", message: `${name}: not pinned with integrity` });
        if (p.resolved && !order.dev.available_dependencies.allowed_registries.some(r => p.resolved!.startsWith(r))) f3.push({ severity: "error", message: `${name}: from a registry that is not allowed` });
        if (!p.license || !order.dev.available_dependencies.license_allowlist.includes(p.license)) f3.push({ severity: "error", message: `${name}: license ${p.license ?? "unknown"} is not on the allowlist` });
        if (p.hasInstallScript) f3.push({ severity: "error", message: `${name}: has an install script` });
      }
    }
    const pre = order.dev.available_dependencies.preapproved_packages;
    if (pre) for (const d of deps) if (!pre.includes(d)) f3.push({ severity: "warning", message: `${d} is not preapproved` });
  }
  stage(3, "dependency audit", f3);

  // 4. Secret scan
  const f4: Finding[] = [];
  for (const f of files.filter(isText)) {
    const t = readFileSync(join(dir, f), "utf8");
    if (SECRET_RES.some(re => re.test(t)) || redactMessage(t) !== t && /password|secret|token|api[_-]?key/i.test(t) && /[:=]\s*["'][^"']{12,}["']/.test(t)) f4.push({ severity: "error", file: f, message: "looks like a credential" });
  }
  stage(4, "secret scan", f4);

  // 5. Behavior: the package's own tests, rerun here; then the holdout set
  const f5: Finding[] = [];
  if (stages.every(s => s.ok)) {
    const m = readManifest(dir);
    const testFiles = files.filter(f => f.startsWith(`${m.tests}/`) && /\.test\.(m?js|cjs)$/.test(f));
    const t = await runner.run(["node", "--test", "--test-reporter=tap", ...testFiles], { cwd: dir, timeoutMs: 5 * 60_000, network: "none" });
    const passed = Number(/^# pass (\d+)/m.exec(t.stdout)?.[1] ?? 0), failed = Number(/^# fail (\d+)/m.exec(t.stdout)?.[1] ?? (t.code === 0 ? 0 : 1));
    report.tests.push({ suite: "package tests (rerun by JARVIS)", passed, failed });
    if (t.timed_out) f5.push({ severity: "error", message: "tests timed out" });
    else if (failed || t.code !== 0 || passed === 0) f5.push({ severity: "error", message: `package tests: ${passed} passed, ${failed} failed` });
    // Holdout in a separate copy, outside the builder's workspace view of the results.
    const copy = join(input.scratchDir, `holdout-${Date.now().toString(36)}`);
    mkdirSync(copy, { recursive: true });
    try {
      cpSync(dir, copy, { recursive: true });
      for (const c of input.holdout.cases) {
        const r = await invokeTool(runner, copy, m.entry, c.input, descriptor.timeouts.default_s * 1000);
        const why = checkExpectation(r, c.expect);
        if (why) { report.holdout.failed++; report.holdout.failures.push(`${c.name}: ${why}`); } else report.holdout.passed++;
      }
    } finally { rmSync(copy, { recursive: true, force: true }); }
    if (!input.holdout.cases.length) f5.push({ severity: report.risk_class === "R0" ? "warning" : "error", message: "no holdout cases" });
    if (report.holdout.failed) f5.push({ severity: "error", message: `holdout: ${report.holdout.failed} of ${input.holdout.cases.length} failed` });
    const negatives = input.holdout.cases.filter(c => c.expect.status === "error").length;
    if (order.dev.test_requirements.negative_cases.length && !negatives) f5.push({ severity: "error", message: "no negative holdout cases" });
  } else f5.push({ severity: "error", message: "not run: earlier stages failed" });
  stage(5, "behavior tests", f5);

  // 7. Permission delta against the active version
  const prevEff = new Set(input.previous?.side_effects.effect_classes ?? []);
  const nowEff = new Set(descriptor.side_effects.effect_classes);
  // Permissions are what a version may do: effects, network reach beyond none, and a tier weaker than T2.
  const perms = (d: CapabilityDescriptor | undefined, eff: Set<string>) => [...[...eff].map(e => `effect:${e}`), ...(d && d.environment.network !== "none" ? [`network:${d.environment.network}`] : []),
    ...(d && (d.isolation_tier === "T0" || d.isolation_tier === "T1") ? [`tier:${d.isolation_tier}`] : [])];
  report.first_release = !input.previous;
  const before = new Set(perms(input.previous, prevEff)), after = new Set(perms(descriptor, nowEff));
  report.permission_delta = { added: [...after].filter(x => !before.has(x)), removed: [...before].filter(x => !after.has(x)) };
  stage(7, "permission delta", report.permission_delta.added.length ? [{ severity: "info", message: report.first_release ? `first release with ${report.permission_delta.added.join(", ")}: promotion follows the risk class` : `adds ${report.permission_delta.added.join(", ")}: needs your review` }] : []);
  return finish(report);
}

function finish(r: ValidationReport): ValidationReport {
  // 9. Validation report
  r.ok = r.stages.length >= 6 && r.stages.every(s => s.ok);
  if (!r.environment.isolated) r.untested.push("isolation: tests ran in the local development runner, not the Workshop sandbox");
  r.confidence_limits = r.ok
    ? `Passed ${r.tests.reduce((a, t) => a + t.passed, 0)} package tests and ${r.holdout.passed} holdout cases on synthetic data. Real inputs may differ; nothing listed under "untested" was checked.`
    : "Not validated.";
  r.stages.push({ stage: 9, name: "validation report", ok: r.ok, findings: [] });
  return r;
}

export interface ToolRun { status: "ok" | "error"; output?: unknown; error?: { code: string; message: string }; raw: { code: number | null; stderr: string; timed_out: boolean } }

/** Runs a T2 tool once: params on stdin, one JSON line on stdout. Network none. */
export async function invokeTool(runner: SandboxRunner, dir: string, entry: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<ToolRun> {
  const r = await runner.run(["node", entry], { cwd: dir, stdin: JSON.stringify(params ?? {}), timeoutMs, network: "none", maxOutputBytes: 4 * 1024 * 1024, ...(signal ? { signal } : {}) });
  const raw = { code: r.code, stderr: r.stderr.slice(-2000), timed_out: r.timed_out };
  if (r.timed_out) return { status: "error", error: { code: "timeout", message: "the tool timed out" }, raw };
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  try {
    const j = JSON.parse(line ?? "") as { status?: string; output?: unknown; error?: { code?: string; message?: string } };
    if (j.status === "ok") return { status: "ok", output: j.output, raw };
    if (j.status === "error") return { status: "error", error: { code: String(j.error?.code ?? "internal_error"), message: String(j.error?.message ?? "error") }, raw };
  } catch { /* fall through */ }
  return { status: "error", error: { code: "internal_error", message: `the tool did not return the protocol JSON (exit ${r.code})` }, raw };
}

function checkExpectation(r: ToolRun, e: HoldoutCase["expect"]): string | null {
  if (r.status !== e.status) return `expected ${e.status}, got ${r.status}${r.error ? ` (${r.error.code}: ${r.error.message})` : ""}`;
  if (e.error_code && r.error?.code !== e.error_code) return `expected error ${e.error_code}, got ${r.error?.code}`;
  if (e.output_equals !== undefined && JSON.stringify(r.output) !== JSON.stringify(e.output_equals)) return "output differs";
  if (e.output_contains) for (const [k, v] of Object.entries(e.output_contains)) if (JSON.stringify((r.output as Record<string, unknown> | undefined)?.[k]) !== JSON.stringify(v)) return `output.${k} differs`;
  return null;
}

export const MANIFEST = MANIFEST_FILE;
export const hasManifest = (dir: string) => existsSync(join(dir, MANIFEST_FILE));
