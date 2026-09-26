import {
  newId, hashObject, JarvisError, MemoryRecord, MemoryCorrection, DerivedSummary, DEFAULT_EGRESS,
  type MemoryScope, type MemoryStatus, type Provenance, type Sensitivity, type EgressPolicy, type Retention,
  type FactContent, type PreferenceContent, type LessonContent, type MemoryProposal, type Confidence,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { EntityStore, OWNER_ENTITY } from "./entities.js";
import { seal, open } from "../crypto/keys.js";

export interface MemoryWriteInput {
  type: MemoryRecord["type"];
  text: string;
  content: FactContent | PreferenceContent | LessonContent;
  scope: MemoryScope;
  subject_entity_ids?: string[];
  provenance: Provenance;
  confidence?: Confidence;
  sensitivity?: Sensitivity;
  egress?: EgressPolicy;
  valid_from?: string;
  expires_at?: string;
  retention?: Retention;
  evidence_refs?: string[];
  /** Set only by the Verifier: a worker claim whose evidence passed. */
  evidence_verified?: boolean;
}

export type WriteOutcome =
  | { outcome: "created" | "merged" | "superseded" | "disputed" | "pending_review"; record: MemoryRecord; superseded?: string[] }
  | { outcome: "rejected"; reason: string }
  | { outcome: "held_for_review"; reason: string };

export interface ResolvedPreference { domain: string; winner: MemoryRecord; specificity: number; others: MemoryRecord[] }

const VALIDITY_OPEN = "9999-12-31T23:59:59.999Z";

function domainOf(r: { type: string; content: unknown }): string {
  const c = r.content as Record<string, unknown>;
  if (r.type === "fact") return String(c.predicate ?? "");
  if (r.type === "preference") return String(c.domain ?? "");
  return `lesson:${hashObject((c as { applies_to?: unknown }).applies_to ?? {}).slice(0, 12)}`;
}

const normText = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/^hypothetical /, "").trim();
const isNote = (r: { type: string; content: unknown }) => r.type === "fact" && (r.content as { predicate?: string }).predicate === "note";

function canonicalKey(r: { type: string; text?: string; content: unknown; scope: MemoryScope; subject_entity_ids: string[] }): string {
  const s = r.scope;
  // Text-only notes have no predicate of their own: their identity is their normalized text,
  // so the same note said twice merges and different notes never supersede each other.
  const noteKey = isNote(r) ? hashObject(normText(r.text ?? "")) : "";
  return [r.type, [...r.subject_entity_ids].sort().join(","), domainOf(r), s.level, [...(s.entity_ids ?? [])].sort().join(","), s.project_id ?? "", s.task_id ?? "",
    s.condition ? hashObject(s.condition) : "", r.type === "lesson" ? hashObject((r.content as LessonContent).statement) : "", noteKey].join("|");
}

function valueOf(r: { type: string; text?: string; content: unknown }): unknown {
  if (isNote(r)) return normText(r.text ?? "");
  const c = r.content as Record<string, unknown>;
  return r.type === "lesson" ? c.statement : c.value;
}

const TRUST_RANK: Record<string, number> = { owner_verified: 5, trusted_service: 3, owner_unverified: 2, worker_claim: 1, external_content: 0, system: 4 };
const ORIGIN_RANK: Record<string, number> = { stated: 4, observed: 3, imported: 3, derived: 2, inferred: 1 };

/**
 * Memory Service (03 §9): typed records with scope, time, provenance; the write
 * pipeline with deterministic trust rules and dedup; corrections; deletion;
 * scoped resolution with precedence; summaries and their invalidation.
 */
export class MemoryService {
  readonly entities: EntityStore;
  constructor(private ctx: CoreContext) { this.entities = new EntityStore(ctx); }

  // ---------- storage encoding (03 §9.14) ----------
  /** Sensitive and restricted records keep text and content sealed (AES-256-GCM, bound to the record id). */
  private encode(r: MemoryRecord): string {
    if ((r.sensitivity !== "sensitive" && r.sensitivity !== "restricted") || r.status === "deleted") return JSON.stringify(r);
    const sealed = seal(this.ctx.keys.dataKey("memory_sensitive"), Buffer.from(JSON.stringify({ text: r.text, content: r.content })), r.id).toString("base64");
    return JSON.stringify({ ...r, text: "", content: {}, sealed });
  }
  private decode(json: string): MemoryRecord {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.sealed === "string") {
      const inner = JSON.parse(open(this.ctx.keys.dataKey("memory_sensitive"), Buffer.from(raw.sealed, "base64"), String(raw.id)).toString("utf8")) as { text: string; content: unknown };
      raw.text = inner.text; raw.content = inner.content;
      delete raw.sealed;
    }
    return MemoryRecord.parse(raw);
  }
  /** Sealed records are indexed by their topic words only, never by value. */
  private ftsText(r: MemoryRecord): string {
    if (r.sensitivity === "sensitive" || r.sensitivity === "restricted") return `${domainOf(r).replace(/[._:]/g, " ")} ${r.type}`;
    return r.text;
  }

  /** Archive import: inserts a record with its original id and revision if absent (03 §9.18). */
  importRecord(raw: unknown): boolean {
    const r = MemoryRecord.parse(raw);
    if (this.get(r.id)) return false;
    this.ctx.tx(() => { this.insert(r, r.status === "deleted" ? `deleted:${r.id}` : canonicalKey(r)); if (r.status === "deleted") this.ctx.db.prepare("delete from memory_fts where record_id = ?").run(r.id); });
    return true;
  }

  /** "Things I've inferred": you can accept, edit or reject each one. */
  inferred(): MemoryRecord[] {
    return this.list({ status: ["active", "disputed", "pending_review"], limit: 100000 }).filter(r => r.provenance.origin === "inferred");
  }

  // ---------- reads ----------
  get(id: string): MemoryRecord | undefined {
    const r = this.ctx.db.prepare("select record from memory_records where id = ?").get(id) as { record: string } | undefined;
    return r ? this.decode(r.record) : undefined;
  }
  require(id: string): MemoryRecord {
    const r = this.get(id);
    if (!r) throw new JarvisError("invalid_input", `unknown memory record ${id}`);
    return r;
  }

  list(filter: { status?: MemoryStatus[]; type?: MemoryRecord["type"]; domain?: string; limit?: number } = {}): MemoryRecord[] {
    const where: string[] = [], args: unknown[] = [];
    if (filter.status?.length) { where.push(`status in (${filter.status.map(() => "?").join(",")})`); args.push(...filter.status); }
    if (filter.type) { where.push("type = ?"); args.push(filter.type); }
    if (filter.domain) { where.push("domain = ?"); args.push(filter.domain); }
    return (this.ctx.db.prepare(`select record from memory_records ${where.length ? "where " + where.join(" and ") : ""} order by updated_at desc limit ?`).all(...args, filter.limit ?? 500) as { record: string }[])
      .map(r => this.decode(r.record));
  }

  /** Full-text search over active (and optionally disputed) records. */
  search(query: string, opts: { includeDisputed?: boolean; limit?: number; at?: string } = {}): MemoryRecord[] {
    const terms = query.normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(t => t.length > 1).map(t => `"${t}"*`);
    if (!terms.length) return [];
    const statuses = opts.includeDisputed ? ["active", "disputed"] : ["active"];
    const at = opts.at ?? this.ctx.clock.iso();
    const rows = this.ctx.db.prepare(`select m.record from memory_fts f join memory_records m on m.id = f.record_id
      where memory_fts match ? and m.status in (${statuses.map(() => "?").join(",")})
      and coalesce(m.valid_from, '') <= ? and coalesce(m.valid_until, '${VALIDITY_OPEN}') > ? order by rank limit ?`)
      .all(terms.join(" OR "), ...statuses, at, at, opts.limit ?? 20) as { record: string }[];
    return rows.map(r => this.decode(r.record));
  }

  /** "When did I use to prefer …?": every record for a domain, including superseded ones, with validity. */
  history(domain: string): MemoryRecord[] {
    return (this.ctx.db.prepare("select record from memory_records where domain = ? and status != 'deleted' order by coalesce(valid_from, '')").all(domain) as { record: string }[])
      .map(r => this.decode(r.record));
  }

  // ---------- write pipeline (03 §9.11) ----------
  write(input: MemoryWriteInput): WriteOutcome {
    const now = this.ctx.clock.iso();
    const subjects = input.subject_entity_ids ?? (input.type === "preference" ? [OWNER_ENTITY] : []);
    const trust = input.provenance.source_trust;
    const aboutOwner = subjects.includes(OWNER_ENTITY) || input.type === "preference";
    // Deterministic trust rules.
    if (trust === "external_content") {
      if (input.type === "preference" || aboutOwner) return { outcome: "rejected", reason: "external content cannot create a preference or fact about the owner" };
      if (input.scope.level !== "task" && input.scope.level !== "project") return { outcome: "rejected", reason: "facts from external content must be scoped to a task or project" };
    }
    if (input.type === "lesson" && trust === "external_content") return { outcome: "rejected", reason: "external content cannot create lessons" };
    let status: MemoryStatus = "active";
    let origin = input.provenance.origin;
    if (trust === "worker_claim") {
      if (input.evidence_verified && (input.evidence_refs?.length ?? 0) > 0) origin = "observed"; else status = "pending_review";
    }
    if (trust === "owner_unverified" && input.type === "preference") status = "pending_review";
    if (input.type === "lesson" && status === "active") status = "pending_review";   // lessons start as candidates (03 §9.13)
    const sensitivity = input.sensitivity ?? "personal";
    const confidence: Confidence = input.confidence ?? (origin === "stated" && trust === "owner_verified" ? { level: "confirmed", basis: "stated directly" }
      : origin === "inferred" ? { level: "medium", basis: "inferred from behaviour" } : { level: "high", basis: origin });
    if (origin === "inferred" && confidence.level === "confirmed") throw new JarvisError("invalid_input", "an inference cannot be confirmed");
    const draft = MemoryRecord.parse({
      id: newId("mem", this.ctx.clock.now()), schema: `jarvis.memory.${input.type}/1`, type: input.type, text: input.text, content: input.content,
      scope: input.scope, subject_entity_ids: subjects, provenance: { ...input.provenance, origin }, confidence, sensitivity,
      egress: input.egress ?? DEFAULT_EGRESS[sensitivity],
      times: { created_at: now, observed_at: now, ...(input.valid_from ? { valid_from: input.valid_from } : { valid_from: now }), ...(input.expires_at ? { expires_at: input.expires_at } : {}) },
      status, supersedes: [], contradicts: [], evidence_refs: input.evidence_refs ?? [],
      retention: input.retention ?? (sensitivity === "sensitive" ? { policy: "keep", review_at: new Date(this.ctx.clock.now() + 365 * 86_400_000).toISOString() } : { policy: "keep" }),
      revision: 1, updated_at: now,
    });
    const key = canonicalKey(draft);
    return this.ctx.tx(() => {
      const existing = (this.ctx.db.prepare("select record from memory_records where canonical_key = ? and status in ('active', 'disputed', 'pending_review')").all(key) as { record: string }[])
        .map(r => this.decode(r.record));
      const current = existing.find(r => r.status === "active") ?? existing[0];
      if (current && JSON.stringify(valueOf(current)) === JSON.stringify(valueOf(draft)) && current.status === draft.status) {
        // Merge: add the source, bump last_verified_at (ten repetitions → one record with ten sources).
        const merged = { ...current, provenance: { ...current.provenance, source_refs: dedupeRefs([...current.provenance.source_refs, ...draft.provenance.source_refs]) },
          times: { ...current.times, last_verified_at: now }, revision: current.revision + 1, updated_at: now };
        this.save(merged, key);
        this.changed([merged.id], "merged");
        return { outcome: "merged", record: merged };
      }
      if (current && current.status === "active" && draft.status === "active") {
        const newRank = TRUST_RANK[trust]! * 10 + ORIGIN_RANK[origin]!;
        const oldRank = TRUST_RANK[current.provenance.source_trust]! * 10 + ORIGIN_RANK[current.provenance.origin]!;
        if (newRank >= oldRank && (origin === "stated" || origin === "observed" || origin === "imported")) {
          // Clear change: supersede, closing the old validity interval.
          const created = { ...draft, supersedes: [current.id] };
          const closed = { ...current, status: "superseded" as const, superseded_by: created.id, times: { ...current.times, valid_until: created.times.valid_from ?? now }, revision: current.revision + 1, updated_at: now };
          this.save(closed, key); this.insert(created, key);
          this.invalidateSummariesFor([current.id]);
          this.changed([current.id, created.id], "superseded");
          return { outcome: "superseded", record: created, superseded: [current.id] };
        }
        // Lower trust or inferred and different: never outranks what you said; recorded as disputed.
        const disputed = { ...draft, status: "disputed" as const, contradicts: [current.id] };
        this.insert(disputed, key);
        this.changed([disputed.id], "disputed");
        return { outcome: "disputed", record: disputed };
      }
      this.insert(draft, key);
      this.changed([draft.id], draft.status === "pending_review" ? "pending_review" : "created");
      return { outcome: draft.status === "pending_review" ? "pending_review" : "created", record: draft };
    });
  }

  /** The explicit path: "Remember that …" from a verified owner channel. The caller echoes only after this returns (after commit). */
  remember(input: Omit<MemoryWriteInput, "provenance"> & { message_id: string }): WriteOutcome {
    return this.write({ ...input, provenance: { origin: "stated", source_refs: [{ kind: "message", ref: input.message_id }], source_trust: "owner_verified", recorded_by: "conversation" } });
  }

  private insert(r: MemoryRecord, key: string): void {
    this.ctx.db.prepare(`insert into memory_records(id, type, status, canonical_key, domain, scope_level, project_id, task_id, sensitivity, valid_from, valid_until, expires_at, revision, updated_at, record)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.type, r.status, key, domainOf(r), r.scope.level, r.scope.project_id ?? null, r.scope.task_id ?? null,
      r.sensitivity, r.times.valid_from ?? null, r.times.valid_until ?? null, r.times.expires_at ?? null, r.revision, r.updated_at, this.encode(r));
    for (const e of r.scope.entity_ids ?? []) this.ctx.db.prepare("insert or ignore into memory_scope_entities(record_id, entity_id) values (?,?)").run(r.id, e);
    for (const e of r.subject_entity_ids) this.ctx.db.prepare("insert or ignore into memory_subjects(record_id, entity_id) values (?,?)").run(r.id, e);
    this.ctx.db.prepare("insert into memory_fts(text, record_id) values (?, ?)").run(this.ftsText(r), r.id);
  }

  private save(r: MemoryRecord, key?: string): void {
    const rec = MemoryRecord.parse(r);
    this.ctx.db.prepare(`update memory_records set status = ?, ${key ? "canonical_key = @key," : ""} valid_from = ?, valid_until = ?, expires_at = ?, revision = ?, updated_at = ?, record = ? where id = ?`
      .replace("@key", "?"))
      .run(...[rec.status, ...(key ? [key] : []), rec.times.valid_from ?? null, rec.times.valid_until ?? null, rec.times.expires_at ?? null, rec.revision, rec.updated_at, this.encode(rec), rec.id]);
    this.ctx.db.prepare("delete from memory_fts where record_id = ?").run(rec.id);
    if (rec.status !== "deleted") this.ctx.db.prepare("insert into memory_fts(text, record_id) values (?, ?)").run(this.ftsText(rec), rec.id);
  }

  private changed(ids: string[], why: string): void {
    const revisions = Object.fromEntries(ids.map(id => [id, this.get(id)?.revision ?? 0]));
    this.ctx.events.append({ type: "memory.changed", summary: `Memory ${why} (${ids.length} record(s))`, data: { ids, revisions, why } });
  }

  /** Accepts a pending_review record (owner confirmation, or the Verifier attaching evidence to a worker claim). */
  accept(id: string, opts: { evidence_refs?: string[]; by: "owner" | "verifier" }): MemoryRecord {
    return this.ctx.tx(() => {
      const r = this.require(id);
      if (r.status !== "pending_review" && r.status !== "disputed") throw new JarvisError("conflict", `record ${id} is ${r.status}`);
      if (opts.by === "verifier" && !(opts.evidence_refs?.length || r.evidence_refs.length)) throw new JarvisError("invalid_input", "the verifier can accept only with evidence");
      if (r.provenance.source_trust === "external_content" && r.type === "preference") throw new JarvisError("missing_permission", "external content can never become an owner preference");
      const next: MemoryRecord = { ...r, status: "active", evidence_refs: [...new Set([...r.evidence_refs, ...(opts.evidence_refs ?? [])])],
        provenance: { ...r.provenance, origin: opts.by === "verifier" ? "observed" : r.provenance.origin },
        confidence: opts.by === "owner" ? { level: "confirmed", basis: "accepted by owner" } : r.confidence, revision: r.revision + 1, updated_at: this.ctx.clock.iso() };
      // Accepting a disputed record over an active one supersedes the active one.
      for (const c of r.contradicts) {
        const old = this.get(c);
        if (old?.status === "active") this.save({ ...old, status: "superseded", superseded_by: id, times: { ...old.times, valid_until: this.ctx.clock.iso() }, revision: old.revision + 1, updated_at: this.ctx.clock.iso() });
      }
      this.save(next);
      this.changed([id, ...r.contradicts], "accepted");
      return next;
    });
  }

  /** MemoryProposal (the only way workers and components suggest memory) → the same trust guard. */
  propose(p: MemoryProposal): WriteOutcome {
    return this.ctx.tx(() => {
      let out: WriteOutcome;
      if (p.operation === "delete" || p.operation === "update" || p.operation === "link") {
        // Changes to existing memory from a component or worker always wait for the owner.
        out = { outcome: "held_for_review", reason: `${p.operation} proposals need owner confirmation` };
      } else {
        try {
          const rec = p.record as unknown as MemoryWriteInput;
          out = this.write({ ...rec, provenance: { origin: p.source_trust === "worker_claim" ? "derived" : (rec.provenance?.origin ?? "derived"), source_refs: p.basis, source_trust: p.source_trust, recorded_by: p.proposed_by } });
        } catch (e) {
          // 03 §9.11: a proposal that fails validation is kept as pending_review with the error.
          out = { outcome: "held_for_review", reason: `could not save: ${(e as Error).message}` };
        }
      }
      this.ctx.db.prepare("insert or replace into memory_proposals(proposal_id, status, error, created_at, proposal) values (?,?,?,?,?)")
        .run(p.proposal_id, out.outcome, "reason" in out ? out.reason : null, this.ctx.clock.iso(), JSON.stringify(p));
      return out;
    });
  }

  // ---------- resolution with precedence (03 §9.7, 04 §10.5 rank 6) ----------
  /**
   * Applicable preferences for a descriptor. Precedence: task scope > entity chain
   * (person > org unit > organization, by hop depth) > project > global; then stated
   * over inferred; then newer over older. Only records valid at `at`.
   */
  resolvePreferences(d: { entity_ids?: string[]; project_id?: string; task_id?: string; domains?: string[]; at?: string }): ResolvedPreference[] {
    const at = d.at ?? this.ctx.clock.iso();
    const chain = new Map<string, number>();   // entity id → specificity
    for (const e of d.entity_ids ?? []) {
      for (const a of this.entities.ancestry(e)) {
        const spec = 90 - a.depth * 10 - EntityStore.kindRank(a.kind);
        if ((chain.get(a.entity_id) ?? -1) < spec) chain.set(a.entity_id, spec);
      }
    }
    // For a past `at`, records superseded or expired since then were the valid ones at that time.
    const past = at < this.ctx.clock.iso();
    const statuses: MemoryStatus[] = past ? ["active", "disputed", "superseded", "expired"] : ["active", "disputed"];
    const candidates = this.list({ status: statuses, type: "preference", limit: 100000 })
      .filter(r => (r.times.valid_from ?? "") <= at && (r.times.valid_until ?? VALIDITY_OPEN) > at && (!r.times.expires_at || r.times.expires_at > at))
      .filter(r => !d.domains || d.domains.includes(domainOf(r)));
    const scored: { r: MemoryRecord; specificity: number }[] = [];
    for (const r of candidates) {
      let specificity = -1;
      switch (r.scope.level) {
        case "global": specificity = 10; break;
        case "project": if (d.project_id && r.scope.project_id === d.project_id) specificity = 20; break;
        case "task": if (d.task_id && r.scope.task_id === d.task_id) specificity = 100; break;
        case "entity": {
          const s = Math.max(-1, ...(r.scope.entity_ids ?? []).map(e => chain.get(e) ?? -1));
          if (s >= 0) specificity = s;
          break;
        }
      }
      if (specificity >= 0) scored.push({ r, specificity });
    }
    const byDomain = new Map<string, { r: MemoryRecord; specificity: number }[]>();
    for (const s of scored) { const k = domainOf(s.r); byDomain.set(k, [...(byDomain.get(k) ?? []), s]); }
    const out: ResolvedPreference[] = [];
    for (const [domain, list] of byDomain) {
      list.sort((a, b) => b.specificity - a.specificity
        || (a.r.status === "active" ? 0 : 1) - (b.r.status === "active" ? 0 : 1)
        || ORIGIN_RANK[b.r.provenance.origin]! - ORIGIN_RANK[a.r.provenance.origin]!
        || b.r.times.created_at.localeCompare(a.r.times.created_at));
      out.push({ domain, winner: list[0]!.r, specificity: list[0]!.specificity, others: list.slice(1).map(x => x.r) });
    }
    return out.sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /** Requirements (kind: requirement) applicable to the descriptor become hard planning constraints. */
  requirements(d: Parameters<MemoryService["resolvePreferences"]>[0]): MemoryRecord[] {
    return this.resolvePreferences(d).map(p => p.winner).filter(r => (r.content as PreferenceContent).kind === "requirement" && r.status === "active");
  }

  // ---------- corrections (03 §9.12) ----------
  correct(input: {
    kind: MemoryCorrection["kind"]; target_ids: string[]; owner_statement_ref: string; generalization_limit: string;
    replacements?: Omit<MemoryWriteInput, "provenance">[];
    propagate?: (changedIds: string[]) => { task_ids: string[]; work_order_ids: string[] };
  }): MemoryCorrection {
    if (!input.generalization_limit.trim()) throw new JarvisError("invalid_input", "a correction must state what it does not imply");
    return this.ctx.tx(() => {
      const now = this.ctx.clock.iso();
      const targets = input.target_ids.map(id => this.require(id));
      const before = targets.map(t => ({ record_id: t.id, revision: t.revision }));
      const after: { record_id: string; revision: number }[] = [];
      const newIds: string[] = [];
      for (const rep of input.replacements ?? []) {
        const created = MemoryRecord.parse({
          id: newId("mem", this.ctx.clock.now()), schema: `jarvis.memory.${rep.type}/1`, type: rep.type, text: rep.text, content: rep.content, scope: rep.scope,
          subject_entity_ids: rep.subject_entity_ids ?? (rep.type === "preference" ? [OWNER_ENTITY] : []),
          provenance: { origin: "stated", source_refs: [{ kind: input.owner_statement_ref.startsWith("msg_") ? "message" : "owner_edit", ref: input.owner_statement_ref }], source_trust: "owner_verified", recorded_by: "correction" },
          confidence: { level: "confirmed", basis: "owner correction" }, sensitivity: rep.sensitivity ?? targets[0]?.sensitivity ?? "personal",
          egress: rep.egress ?? DEFAULT_EGRESS[rep.sensitivity ?? targets[0]?.sensitivity ?? "personal"],
          times: { created_at: now, observed_at: now, valid_from: now }, status: "active", supersedes: input.target_ids, contradicts: [], evidence_refs: [],
          retention: rep.retention ?? { policy: "keep" }, revision: 1, updated_at: now,
        });
        // A replacement with the same canonical key as another active record supersedes it too.
        const ck = canonicalKey(created);
        for (const other of (this.ctx.db.prepare("select id from memory_records where canonical_key = ? and status = 'active'").all(ck) as { id: string }[])) {
          if (input.target_ids.includes(other.id)) continue;
          const o = this.require(other.id);
          this.save({ ...o, status: "superseded", superseded_by: created.id, times: { ...o.times, valid_until: now }, revision: o.revision + 1, updated_at: now });
          after.push({ record_id: o.id, revision: o.revision + 1 });
        }
        this.insert(created, ck);
        newIds.push(created.id); after.push({ record_id: created.id, revision: 1 });
      }
      for (const t of targets) {
        if (input.kind === "should_not_remember") { this.delete([t.id], "owner_correction"); continue; }
        const closed: MemoryRecord = { ...t, status: "superseded", ...(newIds[0] ? { superseded_by: newIds[0] } : {}), times: { ...t.times, valid_until: now }, revision: t.revision + 1, updated_at: now };
        this.save(closed);
        after.push({ record_id: t.id, revision: closed.revision });
      }
      const invalidated = this.invalidateSummariesFor(input.target_ids);
      const propagated = input.propagate?.([...input.target_ids, ...newIds]) ?? { task_ids: [], work_order_ids: [] };
      const cor = MemoryCorrection.parse({
        id: newId("cor", this.ctx.clock.now()), schema: "jarvis.memory_correction/1", target_ids: input.target_ids, kind: input.kind,
        owner_statement_ref: input.owner_statement_ref, before, after, generalization_limit: input.generalization_limit,
        invalidated_derivations: invalidated, propagated_to: propagated, applied_at: now,
      });
      this.ctx.db.prepare("insert into memory_corrections(id, applied_at, correction) values (?,?,?)").run(cor.id, now, JSON.stringify(cor));
      this.changed([...input.target_ids, ...newIds], `corrected (${input.kind})`);
      return cor;
    });
  }

  // ---------- deletion (03 §9.15) ----------
  /** Tombstone with content purged; FTS rows removed; summaries using it made stale and purged; caches flushed via memory.changed. */
  delete(ids: string[], reason: string): { deleted: string[]; summaries_invalidated: string[] } {
    return this.ctx.tx(() => {
      const deleted: string[] = [];
      for (const id of ids) {
        const r = this.get(id);
        if (!r || r.status === "deleted") continue;
        const tomb: MemoryRecord = { ...r, text: "", content: {}, status: "deleted", evidence_refs: [], provenance: { ...r.provenance, source_refs: [] },
          times: { created_at: r.times.created_at, observed_at: r.times.observed_at }, revision: r.revision + 1, updated_at: this.ctx.clock.iso() };
        this.save(tomb);
        this.ctx.db.prepare("update memory_records set canonical_key = ?, domain = null where id = ?").run(`deleted:${id}`, id);
        this.ctx.db.prepare("delete from memory_scope_entities where record_id = ?").run(id);
        this.ctx.db.prepare("delete from memory_subjects where record_id = ?").run(id);
        deleted.push(id);
      }
      const summaries = this.invalidateSummariesFor(deleted, { purge: true });
      if (deleted.length) this.ctx.events.append({ type: "memory.deleted", summary: `${deleted.length} memory record(s) deleted`, data: { ids: deleted, reason } });
      if (deleted.length) this.changed(deleted, "deleted");
      return { deleted, summaries_invalidated: summaries };
    });
  }

  /** active → expired when validity or expiry has passed. */
  expireSweep(): string[] {
    const now = this.ctx.clock.iso();
    return this.ctx.tx(() => {
      const rows = this.ctx.db.prepare("select id from memory_records where status in ('active','disputed') and ((expires_at is not null and expires_at <= ?) or (valid_until is not null and valid_until <= ?))").all(now, now) as { id: string }[];
      for (const { id } of rows) { const r = this.require(id); this.save({ ...r, status: "expired", revision: r.revision + 1, updated_at: now }); }
      if (rows.length) this.changed(rows.map(r => r.id), "expired");
      return rows.map(r => r.id);
    });
  }

  // ---------- placeholders (04 §10.12, F54) ----------
  /** Resolves {{mem:ID#field}} inside the executor boundary. A deleted or inactive record fails safely. */
  resolvePlaceholder(token: string): unknown {
    const m = /^\{\{mem:(mem_[0-9A-Z]{26})#([a-z_]+)\}\}$/.exec(token);
    if (!m) throw new JarvisError("invalid_input", `not a memory placeholder: ${token}`);
    const r = this.get(m[1]!);
    if (!r || r.status !== "active") throw new JarvisError("invalid_input", `placeholder ${m[1]} refers to a ${r ? r.status : "missing"} record; ask the owner`);
    const c = r.content as Record<string, unknown>;
    if (!(m[2]! in c)) throw new JarvisError("invalid_input", `record ${m[1]} has no field ${m[2]}`);
    return c[m[2]!];
  }

  // ---------- derived summaries ----------
  registerSummary(input: { kind: DerivedSummary["kind"]; subject_ref: string; content: string; input_ids: string[]; generator: DerivedSummary["generator"] }): DerivedSummary {
    return this.ctx.tx(() => {
      const inputs = input.input_ids.map(id => ({ record_id: id, revision: this.require(id).revision }));
      const { payload_id } = this.ctx.payloads.put(input.content, "personal");
      const s = DerivedSummary.parse({ id: newId("sum", this.ctx.clock.now()), kind: input.kind, subject_ref: input.subject_ref, content_ref: payload_id,
        inputs, input_hash: hashObject(inputs), generator: input.generator, state: "fresh", generated_at: this.ctx.clock.iso() });
      this.ctx.db.prepare("insert into derived_summaries(id, kind, subject_ref, state, summary) values (?,?,?,?,?)").run(s.id, s.kind, s.subject_ref, s.state, JSON.stringify(s));
      for (const i of inputs) this.ctx.db.prepare("insert into summary_inputs(summary_id, record_id, revision) values (?,?,?)").run(s.id, i.record_id, i.revision);
      return s;
    });
  }

  /** Only fresh summaries are ever served. */
  getSummary(subjectRef: string, kind: DerivedSummary["kind"]): { summary: DerivedSummary; text: string } | undefined {
    const r = this.ctx.db.prepare("select summary from derived_summaries where subject_ref = ? and kind = ? and state = 'fresh' order by rowid desc limit 1").get(subjectRef, kind) as { summary: string } | undefined;
    if (!r) return undefined;
    const s = DerivedSummary.parse(JSON.parse(r.summary));
    return { summary: s, text: this.ctx.payloads.getText(s.content_ref) };
  }

  private invalidateSummariesFor(recordIds: string[], opts: { purge?: boolean } = {}): string[] {
    const out = new Set<string>();
    for (const id of recordIds) for (const r of this.ctx.db.prepare("select summary_id from summary_inputs where record_id = ?").all(id) as { summary_id: string }[]) out.add(r.summary_id);
    for (const sid of out) {
      const row = this.ctx.db.prepare("select summary from derived_summaries where id = ?").get(sid) as { summary: string };
      const s = DerivedSummary.parse(JSON.parse(row.summary));
      if (opts.purge) this.ctx.payloads.delete(s.content_ref);
      const next = { ...s, state: "stale" as const };
      this.ctx.db.prepare("update derived_summaries set state = 'stale', summary = ? where id = ?").run(JSON.stringify(next), sid);
    }
    return [...out];
  }
}

function dedupeRefs<T extends { kind: string; ref: string }>(refs: T[]): T[] {
  const seen = new Set<string>();
  return refs.filter(r => { const k = `${r.kind}:${r.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
