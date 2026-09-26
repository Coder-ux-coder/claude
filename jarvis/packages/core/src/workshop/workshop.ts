import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DevWorkOrder, JarvisError, type PromotionEvidence, type ReleaseRecord, type StructuredError, type UsageReport } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import { type SandboxRunner, wsPaths } from "./sandbox.js";
import type { CodingWorker, DevEvent } from "./worker.js";
import type { McpGateway } from "./mcp-gateway.js";
import type { ReleaseManager } from "./release-manager.js";
import { validatePackage, type HoldoutCase, type ValidationReport } from "./validation.js";

/** Holdout sets live with the Release Manager, outside the Workshop; builders never see them (08 §13.9). */
export class HoldoutStore {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  private file(capId: string) { return join(this.dir, `${capId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`); }
  put(capId: string, set: { set: string; cases: HoldoutCase[] }): void { writeFileSync(this.file(capId), JSON.stringify(set, null, 2), { mode: 0o600 }); }
  get(capId: string): { set: string; cases: HoldoutCase[] } { return existsSync(this.file(capId)) ? JSON.parse(readFileSync(this.file(capId), "utf8")) : { set: "none", cases: [] }; }
}

export interface WorkshopOutcome {
  status: "released" | "awaiting_approval" | "failed" | "cancelled";
  work_order_id: string; worker?: string;
  report?: ValidationReport; release?: ReleaseRecord;
  reasons?: string[]; error?: StructuredError; rounds: number; usage: UsageReport[];
}

export interface WorkshopDeps {
  ctx: CoreContext; runner: SandboxRunner; workers: CodingWorker[]; releases: ReleaseManager; registry: CapabilityRegistry; holdouts: HoldoutStore;
  gateway?: McpGateway;
  /** Answers a builder's question from the specification; escalates only if material. */
  askBoss?(order: DevWorkOrder, question: string): Promise<string>;
  /** Development only: allow a runner that is not an isolation boundary. */
  allowUnisolated?: boolean;
  preferredWorker?: string;
  maxFixRounds?: number;
  onEvent?(woId: string, e: DevEvent): void;
}

/**
 * Workshop Manager v1 (08 §13): provisions an isolated workspace, runs one coding worker,
 * validates the candidate itself, and hands it to the Release Manager. It never writes into
 * active directories, and a builder's claims are never evidence.
 */
export class WorkshopManager {
  constructor(private d: WorkshopDeps) {}

  get(woId: string): { status: string; order: DevWorkOrder; validation?: ValidationReport } | undefined {
    const r = this.d.ctx.db.prepare("select status, order_json, validation_json from dev_orders where work_order_id = ?").get(woId) as { status: string; order_json: string; validation_json: string | null } | undefined;
    return r ? { status: r.status, order: DevWorkOrder.parse(JSON.parse(r.order_json)), ...(r.validation_json ? { validation: JSON.parse(r.validation_json) } : {}) } : undefined;
  }

  private setStatus(woId: string, status: string, patch: { result?: unknown; validation?: unknown } = {}): void {
    this.d.ctx.db.prepare("update dev_orders set status = ?, updated_at = ?, result_json = coalesce(?, result_json), validation_json = coalesce(?, validation_json) where work_order_id = ?")
      .run(status, this.d.ctx.clock.iso(), patch.result !== undefined ? JSON.stringify(patch.result) : null, patch.validation !== undefined ? JSON.stringify(patch.validation) : null, woId);
    this.d.ctx.events.append({ type: "workshop.status", summary: `${woId}: ${status}`, data: { work_order_id: woId, status } });
  }

  async pickWorker(): Promise<CodingWorker> {
    const ordered = [...this.d.workers].sort((a, b) => (a.id === this.d.preferredWorker ? -1 : 0) - (b.id === this.d.preferredWorker ? -1 : 0));
    const reasons: string[] = [];
    for (const w of ordered) { const a = await w.available(this.d.runner); if (a.ok) return w; reasons.push(`${w.id}: ${a.reason}`); }
    throw new JarvisError("unavailable_device", `no coding worker is available (${reasons.join("; ") || "none configured"})`);
  }

  /** Writes CONTEXT.md, spec/ and synthetic fixtures. Nothing personal goes in (08 §13.5). */
  provision(order: DevWorkOrder, fixtures: Record<string, string> = {}): ReturnType<typeof wsPaths> {
    const ws = wsPaths(this.d.runner.hostRoot, order.work_order_id);
    if (existsSync(ws.base)) throw new JarvisError("conflict", `workspace ${order.work_order_id} already exists`);
    for (const p of [ws.repo, ws.spec, ws.fixtures, ws.out]) mkdirSync(p, { recursive: true });
    const dev = order.dev;
    writeFileSync(ws.context, [
      `# ${order.objective}`, "", "## Problem", dev.problem, "",
      "## What to build", `A ${dev.target.kind} with capability id \`${dev.target.capability_id ?? "(see spec)"}\`, contract \`${dev.interface_contract.contract}\`.`,
      `Runtime: ${dev.environment_constraints.runtime} on ${dev.environment_constraints.os}. Network at run time: ${dev.environment_constraints.network.runtime}.`,
      `Declared effects (the only ones allowed): ${dev.permission_boundaries.declared_effects.join(", ") || "none"}. Tier ${dev.permission_boundaries.tier}.`, "",
      "## Package layout (jarvis.capability/1)",
      "- `out/jarvis-package.json`: {\"schema\":\"jarvis.package/1\",\"id\",\"version\",\"runtime\":\"node\",\"entry\",\"tests\":\"test\",\"descriptor\":{…}}",
      "- `out/<entry>`: reads the params as JSON on stdin; writes ONE line of JSON on stdout: {\"status\":\"ok\",\"output\":…} or {\"status\":\"error\",\"error\":{\"code\",\"message\"}}.",
      "  Error codes must come from the shared vocabulary: invalid_input, unsupported_operation, timeout, internal_error, …",
      "- `out/test/*.test.mjs`: node:test tests, including every negative case below.", "",
      "## Inputs and outputs", `Inputs: ${dev.io_expectations.inputs}`, `Outputs: ${dev.io_expectations.outputs}`, "",
      "## Negative cases that must be handled", ...dev.test_requirements.negative_cases.map(n => `- ${n}`), "",
      "## Dependencies", dev.available_dependencies.preapproved_packages?.length ? `Preapproved: ${dev.available_dependencies.preapproved_packages.join(", ")}` : "Prefer none (Node built-ins only).",
      `Licenses allowed: ${dev.available_dependencies.license_allowlist.join(", ")}.`, "",
      "## Constraints", ...order.constraints.map(c => `- ${c}`), "- Synthetic data only. Never read or write outside this workspace.",
    ].join("\n"));
    writeFileSync(join(ws.spec, "descriptor.draft.json"), JSON.stringify(dev.interface_contract.descriptor_draft, null, 2));
    writeFileSync(join(ws.spec, "input.schema.json"), JSON.stringify(dev.interface_contract.input_schema, null, 2));
    writeFileSync(join(ws.spec, "output.schema.json"), JSON.stringify(dev.interface_contract.output_schema, null, 2));
    for (const [name, content] of Object.entries(fixtures)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new JarvisError("invalid_input", `bad fixture name ${name}`);
      writeFileSync(join(ws.fixtures, name), content);
    }
    return ws;
  }

  async run(order: DevWorkOrder, opts: { fixtures?: Record<string, string>; signal?: AbortSignal } = {}): Promise<WorkshopOutcome> {
    const parsed = DevWorkOrder.parse(order);
    if (!this.d.runner.isolated && !this.d.allowUnisolated) throw new JarvisError("missing_permission", "the Workshop needs its isolated sandbox (W1); the local runner is for development only");
    const woId = parsed.work_order_id;
    const capId = parsed.dev.target.capability_id;
    if (!capId || !/^tool:[a-z0-9_.-]+$/i.test(capId)) throw new JarvisError("invalid_input", "a tool work order must name its target capability id (tool:…)");
    const now = this.d.ctx.clock.iso();
    this.d.ctx.db.prepare("insert into dev_orders(work_order_id, task_id, status, worker, order_json, created_at, updated_at) values (?,?,?,?,?,?,?)")
      .run(woId, parsed.task_id, "provisioning", "?", JSON.stringify(parsed), now, now);
    const out: WorkshopOutcome = { status: "failed", work_order_id: woId, rounds: 0, usage: [] };
    const signal = opts.signal ?? new AbortController().signal;
    let revoke = () => {};
    try {
      const ws = this.provision(parsed, opts.fixtures);
      const worker = await this.pickWorker();
      out.worker = worker.id;
      this.d.ctx.db.prepare("update dev_orders set worker = ? where work_order_id = ?").run(worker.id, woId);
      let mcp: { url: string; token: string } | undefined;
      if (this.d.gateway) {
        const g = this.d.gateway.issue(woId, [
          { name: "ask_boss", description: "Ask JARVIS a question about the specification. Returns the answer.", inputSchema: { type: "object", properties: { question: { type: "string" }, why: { type: "string" } }, required: ["question"] },
            call: async a => { this.emit(woId, { kind: "question", question: String(a.question), why: String(a.why ?? ""), blocking: false }); return this.d.askBoss ? this.d.askBoss(parsed, String(a.question)) : "Not specified. Choose the simplest option consistent with CONTEXT.md and record it in notes_for_reviewer."; } },
          { name: "report_progress", description: "Report progress (analyzing, implementing, testing, packaging).", inputSchema: { type: "object", properties: { phase: { type: "string" }, note: { type: "string" } }, required: ["note"] },
            call: async a => { this.emit(woId, { kind: "progress", phase: (["analyzing", "implementing", "testing", "packaging"].includes(String(a.phase)) ? a.phase : "implementing") as "implementing", note: String(a.note).slice(0, 300) }); return "ok"; } },
        ]);
        mcp = { url: g.url, token: g.token }; revoke = g.revoke;
      }
      const ptr = this.d.releases.pointer(capId);
      const previous = ptr ? this.d.registry.resolve(`${capId}@${ptr.active_version}`, { includeAll: true }) : undefined;
      let feedback: string | undefined;
      const maxRounds = 1 + (this.d.maxFixRounds ?? 2);
      for (let round = 1; round <= maxRounds; round++) {
        out.rounds = round;
        this.setStatus(woId, round === 1 ? "building" : `fixing (round ${round})`);
        const b = await worker.build({ order: parsed, root: this.d.runner.hostRoot, runner: this.d.runner, onEvent: e => this.emit(woId, e), signal, ...(mcp ? { mcp } : {}), ...(feedback ? { feedback } : {}) });
        out.usage.push(b.usage);
        if (signal.aborted) { out.status = "cancelled"; this.setStatus(woId, "cancelled"); return out; }
        if (!b.result) { out.error = b.error ?? new JarvisError("internal_error", "no result").structured; this.setStatus(woId, "failed", { result: { error: out.error } }); return out; }
        this.setStatus(woId, "validating", { result: b.result });
        // Freeze a copy: validation and activation use this, not the builder's live folder.
        const cand = join(this.d.runner.hostRoot, "_candidates", `${woId}-r${round}`);
        rmSync(cand, { recursive: true, force: true }); mkdirSync(cand, { recursive: true });
        cpSync(ws.out, cand, { recursive: true });
        const scratch = join(this.d.runner.hostRoot, "_validation", woId);
        mkdirSync(scratch, { recursive: true });
        const report = await validatePackage({ dir: cand, order: parsed, runner: this.d.runner, scratchDir: scratch, holdout: this.d.holdouts.get(capId), ...(previous ? { previous } : {}) });
        out.report = report;
        this.setStatus(woId, report.ok ? "validated" : "validation_failed", { validation: report });
        if (report.ok) return this.promote(woId, cand, report, out, b.result.known_limitations);
        feedback = ["# Validation failed", "", ...report.stages.filter(s => !s.ok).flatMap(s => [`## Stage ${s.stage}: ${s.name}`, ...s.findings.filter(f => f.severity === "error").map(f => `- ${f.file ? `${f.file}: ` : ""}${f.message}`)]),
          ...(report.holdout.failed ? ["", `Holdout: ${report.holdout.failed} hidden case(s) failed. Re-read the specification and negative cases; the hidden cases are not shown.`] : [])].join("\n");
      }
      out.reasons = ["validation still failing after the fix rounds"];
      this.setStatus(woId, "failed");
      return out;
    } catch (e) {
      out.error = (e instanceof JarvisError ? e : new JarvisError("internal_error", (e as Error).message)).structured;
      this.setStatus(woId, "failed", { result: { error: out.error } });
      return out;
    } finally { revoke(); }
  }

  private promote(woId: string, cand: string, report: ValidationReport, out: WorkshopOutcome, limitations: string[]): WorkshopOutcome {
    this.d.releases.candidate(report);
    const policy = this.d.releases.promotionPolicy(report);
    if (!policy.automatic) {
      out.status = "awaiting_approval"; out.reasons = policy.reasons;
      this.d.ctx.db.prepare("update dev_orders set result_json = json_set(coalesce(result_json, '{}'), '$.candidate_dir', ?) where work_order_id = ?").run(cand, woId);
      this.setStatus(woId, "awaiting_approval");
      return out;
    }
    out.release = this.activate(woId, cand, report, [], limitations);
    out.status = "released";
    return out;
  }

  /** Your approval of a candidate that needed it (R2/R3 or a permission delta). */
  approve(woId: string): ReleaseRecord {
    const row = this.d.ctx.db.prepare("select status, result_json, validation_json from dev_orders where work_order_id = ?").get(woId) as { status: string; result_json: string; validation_json: string } | undefined;
    if (!row || row.status !== "awaiting_approval") throw new JarvisError("invalid_input", `${woId} is not waiting for approval`);
    const report = JSON.parse(row.validation_json) as ValidationReport;
    const result = JSON.parse(row.result_json) as { candidate_dir: string; known_limitations?: string[] };
    return this.activate(woId, result.candidate_dir, report, [{ by: "owner", at: this.d.ctx.clock.iso() }], result.known_limitations ?? []);
  }

  private activate(woId: string, cand: string, report: ValidationReport, approvals: ReleaseRecord["approvals"], limitations: string[]): ReleaseRecord {
    const { payload_id } = this.d.ctx.payloads.put(JSON.stringify(report), "normal");
    const evidence: PromotionEvidence = {
      release_candidate: `${report.capability_id}@${report.version}`, capability_id: report.capability_id, version: report.version,
      tested: [...report.tests.map(t => ({ level: "unit/fixture", suite: t.suite, result: `${t.passed} passed, ${t.failed} failed`, environment: report.environment.runner })),
        ...report.stages.filter(s => [1, 2, 3, 4].includes(s.stage)).map(s => ({ level: s.name, suite: `stage ${s.stage}`, result: s.ok ? "pass" : "fail", environment: report.environment.runner }))],
      untested: [...report.untested, ...limitations], holdout: { set: report.holdout.set, result: `${report.holdout.passed} passed, ${report.holdout.failed} failed` },
      confidence_limits: report.confidence_limits, permission_delta: report.permission_delta,
    };
    const rec = this.d.releases.activate({ report, sourceDir: cand, approvals, validation_report_ref: payload_id, evidence });
    this.setStatus(woId, "released");
    return rec;
  }

  private emit(woId: string, e: DevEvent): void {
    this.d.ctx.events.append({ type: `workshop.${e.kind}`, summary: ("note" in e ? e.note : "question" in e ? e.question : e.kind).slice(0, 200), data: { work_order_id: woId, ...e } });
    this.d.onEvent?.(woId, e);
  }
}
