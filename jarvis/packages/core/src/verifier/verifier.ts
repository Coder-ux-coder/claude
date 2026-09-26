import { existsSync, readFileSync, statSync } from "node:fs";
import {
  newId, sha256, JarvisError, EvidenceRecord, EVIDENCE_STRENGTH,
  type EvidenceRef, type EvidenceType, type Retention, type TaskContract, type WorkOrder, type WorkerResult,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { CriterionVerdict } from "../tasks/task-engine.js";

const STRENGTH_ORDER = { weak: 0, moderate: 1, strong: 2 } as const;

/** Evidence records (12 §17.7, 14 §19.4). Strength defaults by type and can only be downgraded. */
export class EvidenceStore {
  constructor(private ctx: CoreContext) {}

  add(input: Omit<EvidenceRecord, "evidence_id" | "strength" | "observed_at" | "retention" | "artifact_refs"> & { strength?: EvidenceRecord["strength"]; retention?: Retention; artifact_refs?: string[] }): EvidenceRecord {
    const dflt = EVIDENCE_STRENGTH[input.type];
    const strength = input.strength && STRENGTH_ORDER[input.strength] < STRENGTH_ORDER[dflt] ? input.strength : dflt;
    const rec = EvidenceRecord.parse({ ...input, evidence_id: newId("evd", this.ctx.clock.now()), strength, observed_at: this.ctx.clock.iso(),
      retention: input.retention ?? { policy: "days", value: 90 }, artifact_refs: input.artifact_refs ?? [] });
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into evidence(evidence_id, task_id, action_id, criterion_id, type, strength, record) values (?,?,?,?,?,?,?)")
        .run(rec.evidence_id, rec.task_id, rec.action_id ?? null, rec.criterion_id ?? null, rec.type, rec.strength, JSON.stringify(rec));
      this.ctx.events.append({ type: "evidence.recorded", correlation: { task_id: rec.task_id, ...(rec.action_id ? { action_id: rec.action_id } : {}) },
        summary: `${rec.type} (${rec.strength}): ${rec.claim.slice(0, 120)}`, data: { evidence_id: rec.evidence_id, type: rec.type, strength: rec.strength } });
    });
    return rec;
  }

  get(id: string): EvidenceRecord | undefined {
    const r = this.ctx.db.prepare("select record from evidence where evidence_id = ?").get(id) as { record: string } | undefined;
    return r ? EvidenceRecord.parse(JSON.parse(r.record)) : undefined;
  }
  forTask(taskId: string): EvidenceRecord[] {
    return (this.ctx.db.prepare("select record from evidence where task_id = ? order by rowid").all(taskId) as { record: string }[]).map(r => EvidenceRecord.parse(JSON.parse(r.record)));
  }
  ref(e: EvidenceRecord): EvidenceRef { return { evidence_id: e.evidence_id, type: e.type, strength: e.strength }; }
}

/**
 * Verifier (14 §19.4, 02 §7.7): turns evidence into verdicts. File criteria are
 * re-observed by the verifier itself; everything else needs recorded evidence of an
 * acceptable type. Model judgement never satisfies a criterion that does not list it.
 */
export class Verifier {
  constructor(private ctx: CoreContext, private evidence: EvidenceStore) {}

  checkCriteria(task: TaskContract): CriterionVerdict[] {
    const all = this.evidence.forTask(task.task_id);
    return task.success_criteria.map(c => {
      const spec = c.check.spec as Record<string, unknown>;
      if (c.check.kind === "file_exists" || c.check.kind === "file_content") {
        const path = String(spec.path ?? "");
        const exists = !!path && existsSync(path) && statSync(path).isFile();
        let ok = exists, detail = exists ? "file exists" : "file not found";
        const data: Record<string, unknown> = { path_hash: sha256(path), exists };
        if (exists && c.check.kind === "file_content") {
          const buf = readFileSync(path);
          data.sha256 = sha256(buf);
          if (typeof spec.sha256 === "string") { ok = data.sha256 === spec.sha256; detail = ok ? "content hash matches" : "content hash differs"; }
          if (typeof spec.contains === "string") { ok = ok && buf.toString("utf8").includes(spec.contains); detail = ok ? "content contains the expected text" : "expected text missing"; }
          if (typeof spec.min_bytes === "number") { ok = ok && buf.length >= spec.min_bytes; }
        }
        const ev = this.evidence.add({ type: "file_check", claim: `${c.description}: ${detail}`, criterion_id: c.id, task_id: task.task_id,
          source: { capability_id: "core:verifier", executor: "verifier" }, data: { ...data, matches: ok } });
        return { criterion_id: c.id, status: ok ? "verified" : "unmet", evidence_ids: ok ? [ev.evidence_id] : [], note: detail };
      }
      // Evidence counts for a criterion only if it names it (criterion_id, or data.criteria for an action's evidence).
      const names = (e: EvidenceRecord) => e.criterion_id === c.id || (Array.isArray(e.data.criteria) && (e.data.criteria as string[]).includes(c.id));
      const relevant = all.filter(e => names(e) && c.acceptable_evidence.includes(e.type));
      const negative = relevant.filter(e => e.data.matches === false);
      const positive = relevant.filter(e => e.data.matches !== false);
      if (negative.length && !positive.length) return { criterion_id: c.id, status: "unmet", evidence_ids: [], note: negative[0]!.claim };
      if (positive.length) return { criterion_id: c.id, status: "verified", evidence_ids: positive.map(e => e.evidence_id) };
      return { criterion_id: c.id, status: "unverified", evidence_ids: [], note: `no ${c.acceptable_evidence.join(" or ")} evidence` };
    });
  }

  /** Compares the observed effect with the authorized parameters, field by field. */
  verifyAction(authorized: Record<string, unknown>, observed: Record<string, unknown>, fields: string[]): { matches: boolean; mismatches: string[] } {
    const mismatches = fields.filter(f => JSON.stringify(authorized[f]) !== JSON.stringify(observed[f]));
    return { matches: mismatches.length === 0, mismatches };
  }

  /**
   * A worker's result is input, not a conclusion (02 §7.7). Each claim needs evidence
   * that exists, belongs to the task, and has a required type; a "succeeded" result
   * whose evidence fails is rejected with worker.claim_rejected (F07).
   */
  checkWorkerResult(wo: WorkOrder, r: WorkerResult): { accepted: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const required = new Set<EvidenceType>(wo.verification.required_evidence);
    const evs = r.claims.flatMap(c => c.evidence_ids.map(id => ({ claim: c.text, e: this.evidence.get(id), id })));
    for (const x of evs) {
      if (!x.e) reasons.push(`claim "${x.claim}" cites missing evidence ${x.id}`);
      else if (x.e.task_id !== wo.task_id) reasons.push(`evidence ${x.id} belongs to another task`);
      else if (x.e.data.matches === false || x.e.data.passed === false) reasons.push(`evidence ${x.id} shows failure: ${x.e.claim}`);
    }
    const haveTypes = new Set(evs.filter(x => x.e && x.e.data.matches !== false && x.e.data.passed !== false).map(x => x.e!.type));
    for (const t of required) if (!haveTypes.has(t)) reasons.push(`missing required ${t} evidence`);
    if (r.status === "succeeded" && r.claims.length === 0) reasons.push("success claimed without any claims or evidence");
    const accepted = r.status === "succeeded" && reasons.length === 0;
    if (r.status === "succeeded" && !accepted)
      this.ctx.events.append({ type: "worker.claim_rejected", correlation: { task_id: wo.task_id, work_order_id: wo.work_order_id, step_id: wo.step_id }, summary: `Worker claimed success; evidence failed (${reasons.length} problem(s))`, data: { reasons } });
    return { accepted, reasons };
  }

  static requireEvidence(ids: string[]): void { if (!ids.length) throw new JarvisError("verification_failed", "no evidence"); }
}
