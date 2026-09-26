import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, JarvisError, newId, ReleaseRecord, type CapabilityDescriptor, type NepInvoke, type PromotionEvidence } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";
import type { SandboxRunner } from "./sandbox.js";
import { packageHash, readManifest } from "./package.js";
import { invokeTool, type RiskClass, type ValidationReport } from "./validation.js";

export interface Pointer { capability_id: string; active_version: string; previous_version: string | null; package_dir: string; package_hash: string; release_id: string; risk_class: RiskClass }

export const CANARY_RUNS = 5;
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Release Manager v0 (08 §13.10): content-addressed immutable packages, one-transaction
 * pointer activation, canary, and exact rollback by pointer revert. The Workshop never
 * writes into active directories: activation copies the validated package.
 */
export class ReleaseManager {
  private executors = new Map<string, GeneratedToolExecutor>();
  onExecutor: ((e: Executor) => void) | null = null;

  constructor(private ctx: CoreContext, private registry: CapabilityRegistry, private runner: SandboxRunner,
    private dirs: { tools: string; runtime: string }) {
    mkdirSync(dirs.tools, { recursive: true });
    mkdirSync(dirs.runtime, { recursive: true });
  }

  pointer(capId: string): Pointer | undefined {
    return this.ctx.db.prepare("select * from capability_pointers where capability_id = ?").get(capId) as Pointer | undefined;
  }
  releases(capId?: string): ReleaseRecord[] {
    const rows = (capId ? this.ctx.db.prepare("select record from releases where capability_id = ? order by created_at").all(capId) : this.ctx.db.prepare("select record from releases order by created_at").all()) as { record: string }[];
    return rows.map(r => ReleaseRecord.parse(JSON.parse(r.record)));
  }

  /** Registers a validated package as a candidate (`under_test`): findable only by the pipeline. */
  candidate(report: ValidationReport): CapabilityDescriptor {
    if (!report.descriptor) throw new JarvisError("invalid_input", "no descriptor");
    return this.registry.register({ ...report.descriptor, lifecycle: "under_test" }, { via: "release_manager" });
  }

  /** Who must approve (07 §12.8; 08 §13.10): any permission delta, R2 and R3 need you. */
  promotionPolicy(report: ValidationReport): { automatic: boolean; notice: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (report.permission_delta.added.length && !report.first_release) reasons.push(`new permissions: ${report.permission_delta.added.join(", ")}`);
    if (report.risk_class === "R2" || report.risk_class === "R3") reasons.push(`risk class ${report.risk_class}`);
    return { automatic: reasons.length === 0, notice: report.risk_class === "R1", reasons };
  }

  /**
   * Activation: verify the hash, copy into tools/<id>/<version>/ (read-only), stage the
   * runtime copy, then flip the pointer and lifecycles in ONE transaction.
   */
  activate(input: { report: ValidationReport; sourceDir: string; approvals: ReleaseRecord["approvals"]; validation_report_ref: string; evidence: PromotionEvidence }): ReleaseRecord {
    const { report } = input;
    if (!report.ok || !report.descriptor) throw new JarvisError("precondition_changed", "only a validated package can be activated");
    const policy = this.promotionPolicy(report);
    if (!policy.automatic && !input.approvals.some(a => a.by === "owner")) throw new JarvisError("missing_permission", `needs your approval: ${policy.reasons.join("; ")}`);
    const hash = packageHash(input.sourceDir);
    if (hash !== report.package_hash) throw new JarvisError("precondition_changed", "the package changed after validation");
    const id = report.capability_id, version = report.version;
    const dest = join(this.dirs.tools, safe(id), version);
    if (existsSync(dest)) { if (packageHash(dest) !== hash) throw new JarvisError("conflict", `${id}@${version} already exists with different content`); }
    else { mkdirSync(join(dest, ".."), { recursive: true }); cpSync(input.sourceDir, dest, { recursive: true }); makeReadOnly(dest); }
    this.stageRuntime(id, version, dest, hash);
    const prev = this.pointer(id);
    const rec = ReleaseRecord.parse({
      release_id: newId("rls", this.ctx.clock.now()), capability_id: id, ...(prev ? { from_version: prev.active_version } : {}), to_version: version, package_hash: hash,
      class: report.descriptor.auth.type === "none" ? "skill" : "connector", validation_report_ref: input.validation_report_ref, promotion_evidence: input.evidence,
      approvals: policy.automatic ? [{ by: "policy", at: this.ctx.clock.iso() }, ...input.approvals] : input.approvals,
      activated_at: this.ctx.clock.iso(), canary: { runs: 0, failures: 0, state: "running" },
    });
    this.ctx.tx(() => {
      if (prev && prev.active_version !== version) this.registry.setLifecycle(id, prev.active_version, "superseded");
      this.registry.register({ ...report.descriptor!, lifecycle: "active" }, { via: "release_manager" });
      this.ctx.db.prepare(`insert into capability_pointers(capability_id, active_version, previous_version, package_dir, package_hash, release_id, risk_class, updated_at) values (?,?,?,?,?,?,?,?)
        on conflict(capability_id) do update set active_version = excluded.active_version, previous_version = excluded.previous_version, package_dir = excluded.package_dir,
        package_hash = excluded.package_hash, release_id = excluded.release_id, risk_class = excluded.risk_class, updated_at = excluded.updated_at`)
        .run(id, version, prev && prev.active_version !== version ? prev.active_version : prev?.previous_version ?? null, dest, hash, rec.release_id, report.risk_class, this.ctx.clock.iso());
      this.ctx.db.prepare("insert into releases(release_id, capability_id, version, record, created_at) values (?,?,?,?,?)").run(rec.release_id, id, version, JSON.stringify(rec), this.ctx.clock.iso());
      this.ctx.events.append({ type: "release.activated", summary: `${id} ${prev ? `${prev.active_version} → ` : ""}${version} (${report.risk_class})`, data: { release_id: rec.release_id, capability_id: id, version, package_hash: hash, notice: policy.notice } });
    });
    this.ensureExecutor(id);
    return rec;
  }

  /** The execution copy inside the sandbox; re-created whenever its hash drifts from the immutable package. */
  private stageRuntime(id: string, version: string, source: string, hash: string): string {
    const dir = join(this.dirs.runtime, safe(id), version);
    if (existsSync(dir) && packageHash(dir) === hash) return dir;
    if (existsSync(dir)) { makeWritable(dir); rmSync(dir, { recursive: true, force: true }); }
    mkdirSync(join(dir, ".."), { recursive: true });
    cpSync(source, dir, { recursive: true });
    makeReadOnly(dir);
    return dir;
  }

  /** The directory to run a version from, after checking the immutable package and its runtime copy. */
  runtimeDirFor(id: string, version: string): { dir: string; entry: string; descriptor: CapabilityDescriptor } {
    const p = this.pointer(id);
    const rel = this.releases(id).find(r => r.to_version === version);
    if (!p || !rel) throw new JarvisError("unsupported_operation", `${id}@${version} is not released`);
    const pkg = join(this.dirs.tools, safe(id), version);
    if (!existsSync(pkg) || packageHash(pkg) !== rel.package_hash) {
      this.quarantine(id, version, "the installed package no longer matches its release hash");
      throw new JarvisError("unsupported_operation", `${id}@${version} failed its integrity check and was quarantined`);
    }
    const dir = this.stageRuntime(id, version, pkg, rel.package_hash);
    const d = this.registry.resolve(`${id}@${version}`, { includeAll: true });
    if (!d) throw new JarvisError("unsupported_operation", `${id}@${version} is not registered`);
    return { dir, entry: readManifest(dir).entry, descriptor: d };
  }

  /** Canary (08 §13.10 step 5): the first uses under tighter thresholds; R2/R3 roll back on any failure. */
  recordUse(id: string, version: string, ok: boolean, why?: string): void {
    const p = this.pointer(id);
    if (!p || p.active_version !== version) return;
    const rows = this.ctx.db.prepare("select record from releases where release_id = ?").get(p.release_id) as { record: string } | undefined;
    if (!rows) return;
    const rec = ReleaseRecord.parse(JSON.parse(rows.record));
    this.registry.recordOutcome(id, ok);
    if (rec.canary.state !== "running") return;
    rec.canary.runs++; if (!ok) rec.canary.failures++;
    const strict = p.risk_class === "R2" || p.risk_class === "R3";
    const fail = strict ? rec.canary.failures >= 1 : rec.canary.failures >= 2;
    if (!fail && rec.canary.runs >= CANARY_RUNS) rec.canary.state = "passed";
    if (fail) rec.canary.state = "failed";
    this.ctx.db.prepare("update releases set record = ? where release_id = ?").run(JSON.stringify(rec), rec.release_id);
    if (fail) this.rollback(id, `canary: ${rec.canary.failures} failure(s) in ${rec.canary.runs} run(s)${why ? ` (${why})` : ""}`);
  }

  /** Exact rollback: the pointer goes back to the previous immutable version; the failed one is quarantined. */
  rollback(id: string, reason: string): { to: string | null } {
    const p = this.pointer(id);
    if (!p) throw new JarvisError("invalid_input", `${id} has no release`);
    this.ctx.tx(() => {
      const recRow = this.ctx.db.prepare("select record from releases where release_id = ?").get(p.release_id) as { record: string };
      const rec = ReleaseRecord.parse(JSON.parse(recRow.record));
      rec.rolled_back_at = this.ctx.clock.iso(); rec.rollback_reason = reason;
      this.ctx.db.prepare("update releases set record = ? where release_id = ?").run(JSON.stringify(rec), rec.release_id);
      this.registry.setLifecycle(id, p.active_version, "quarantined");
      if (p.previous_version) {
        const prevRel = this.releases(id).filter(r => r.to_version === p.previous_version).pop();
        this.registry.setLifecycle(id, p.previous_version, "active");
        this.ctx.db.prepare("update capability_pointers set active_version = ?, previous_version = null, package_dir = ?, package_hash = ?, release_id = ?, updated_at = ? where capability_id = ?")
          .run(p.previous_version, join(this.dirs.tools, safe(id), p.previous_version), prevRel?.package_hash ?? "", prevRel?.release_id ?? p.release_id, this.ctx.clock.iso(), id);
      } else this.ctx.db.prepare("delete from capability_pointers where capability_id = ?").run(id);
      this.ctx.events.append({ type: "release.rolled_back", summary: `${id} ${p.active_version} → ${p.previous_version ?? "none"}: ${reason}`.slice(0, 200), data: { capability_id: id, from: p.active_version, to: p.previous_version, reason } });
    });
    return { to: p.previous_version };
  }

  quarantine(id: string, version: string, reason: string): void {
    this.registry.setLifecycle(id, version, "quarantined");
    this.ctx.events.append({ type: "capability.quarantined", summary: `${id}@${version}: ${reason}`.slice(0, 200), data: { capability_id: id, version, reason } });
    const p = this.pointer(id);
    if (p && p.active_version === version) this.rollback(id, reason);
  }

  /** At startup: an executor for every released capability. */
  restoreExecutors(): void {
    for (const r of this.ctx.db.prepare("select capability_id from capability_pointers").all() as { capability_id: string }[]) this.ensureExecutor(r.capability_id);
  }

  private ensureExecutor(id: string): void {
    if (this.executors.has(id)) return;
    const e = new GeneratedToolExecutor(id, this, this.runner);
    this.executors.set(id, e);
    this.onExecutor?.(e);
  }
}

/** Undo makeReadOnly (re-staging a drifted runtime copy, or cleaning up). */
export function makeWritable(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) makeWritable(p); else chmodSync(p, 0o644);
  }
}

function makeReadOnly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { makeReadOnly(p); chmodSync(p, 0o555); } else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

/**
 * Runs a released T2 tool (05 §11.9 T2): inside the sandbox, network none, from the
 * pinned version's verified runtime copy. Every use feeds the canary.
 */
export class GeneratedToolExecutor implements Executor {
  readonly id: string; readonly version = "0.1.0"; readonly capabilities: string[];
  constructor(private capId: string, private rm: ReleaseManager, private runner: SandboxRunner) {
    this.id = `exec:t2:${capId}`; this.capabilities = [capId];
  }

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const pinned = nep.capability.includes("@") ? nep.capability.split("@")[1]! : this.rm.pointer(this.capId)?.active_version;
    if (!pinned) throw new JarvisError("unsupported_operation", `${this.capId} has no active version`);
    const { dir, entry, descriptor } = this.rm.runtimeDirFor(this.capId, pinned);
    const effectful = descriptor.side_effects.effect_classes.some(e => !e.startsWith("read.") && e !== "notify_owner");
    const params = ectx.resolvePlaceholders(nep.params);
    const r = await invokeTool(this.runner, dir, entry, params, Math.min(descriptor.timeouts.max_s, descriptor.timeouts.default_s) * 1000, ectx.signal);
    this.rm.recordUse(this.capId, pinned, r.status === "ok", r.error?.code);
    const ev = ectx.evidence.add({ type: "process_exit", claim: `${this.capId}@${pinned} ${r.status === "ok" ? "returned a result" : `failed: ${r.error?.code}`}`, task_id: ectx.task_id,
      ...(ectx.action_id ? { action_id: ectx.action_id } : {}), source: { capability_id: this.capId, executor: this.id }, data: { version: pinned, exit_code: r.raw.code, timed_out: r.raw.timed_out } });
    if (r.status === "ok") return { status: "ok", effect_state: effectful ? "complete" : "none", output: r.output, evidence: [ectx.evidence.ref(ev)] };
    const code = ErrorCode.safeParse(r.error?.code).success ? r.error!.code as ErrorCode : "internal_error";
    throw new JarvisError(code, ectx.redactor.redact(r.error?.message ?? "tool failed").slice(0, 500), { effect_state: effectful ? "unknown" : "none" });
  }
}
