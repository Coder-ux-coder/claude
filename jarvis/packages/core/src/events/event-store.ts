import { EventEmitter } from "node:events";
import {
  newId, hashObject, sha256, canonicalJson, redactMessage,
  type Clock, type Correlation, type JarvisEvent, type Sensitivity,
} from "@jarvis/shared";
import type { Db } from "../db/database.js";
import type { PayloadStore } from "./payloads.js";

export interface AppendInput {
  type: string;
  correlation?: Correlation;
  sensitivity?: Sensitivity;
  summary: string;                   // human-readable; must not quote sensitive content
  data?: Record<string, unknown>;    // redacted structured metadata
  payload?: string | Buffer;         // raw content, stored encrypted in the payload store
  occurred_at?: string;
  component?: string;
}

interface Row {
  seq: number; event_id: string; type: string; occurred_at: string; recorded_at: string; node_id: string;
  source: string; correlation: string; sensitivity: string; summary: string; data: string; data_hash: string;
  payload_ref: string | null; payload_hash: string | null; prev_hash: string; hash: string; redaction: string;
}

const GENESIS = "0".repeat(64);
const REDACTED = "[redacted]";

/**
 * Append-only Event Store with a hash chain (12 §17.7, 14 §19.4). The chain covers
 * ids, type, times, correlation, data_hash and payload_hash, not the content, so
 * content can be redacted or deleted later and the chain still verifies.
 */
export class EventStore {
  private emitter = new EventEmitter();
  private extraRedact: ((s: string) => string) | null = null;
  /** Adds exact-match scrubbing of released secrets (04 §10.13 layer 1) to summaries and data strings. */
  setRedactor(fn: (s: string) => string): void { this.extraRedact = fn; }
  private scrub<T>(v: T): T {
    const f = (s: string) => redactMessage(this.extraRedact ? this.extraRedact(s) : s);
    if (typeof v === "string") return f(v) as T;
    if (Array.isArray(v)) return v.map(x => this.scrub(x)) as T;
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.scrub(x)])) as T;
    return v;
  }
  constructor(
    private db: Db, private payloads: PayloadStore, private clock: Clock,
    private node = { node_id: "node_local", version: "0.1.0", process_instance: `pi_${process.pid}` },
  ) { this.emitter.setMaxListeners(0); }

  static chainHash(e: Pick<JarvisEvent, "event_id" | "seq" | "type" | "occurred_at" | "recorded_at" | "node_id" | "correlation" | "data_hash" | "payload_hash"> & { prev_hash: string }): string {
    return sha256(canonicalJson({
      prev_hash: e.prev_hash, event_id: e.event_id, seq: e.seq, type: e.type, occurred_at: e.occurred_at,
      recorded_at: e.recorded_at, node_id: e.node_id, correlation: e.correlation, data_hash: e.data_hash,
      payload_hash: e.payload_hash ?? null,
    }));
  }

  /** Appends one event. Call inside the caller's transaction to commit it atomically with state changes. */
  append(input: AppendInput): JarvisEvent {
    const recorded_at = this.clock.iso();
    const data = this.scrub(input.data ?? {});
    const last = this.db.prepare("select seq, hash from events order by seq desc limit 1").get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    let payload_ref: string | undefined, payload_hash: string | undefined;
    if (input.payload !== undefined) {
      const p = this.payloads.put(input.payload, input.sensitivity ?? "personal");
      payload_ref = p.payload_id; payload_hash = p.content_hash;
    }
    const ev: JarvisEvent = {
      event_id: newId("ev", this.clock.now()),
      schema: "jarvis.event/1",
      type: input.type,
      occurred_at: input.occurred_at ?? recorded_at, recorded_at,
      node_id: this.node.node_id, seq,
      source: { component: input.component ?? "core", version: this.node.version, process_instance: this.node.process_instance },
      correlation: input.correlation ?? {},
      sensitivity: input.sensitivity ?? "normal",
      summary: this.scrub(input.summary),
      data,
      data_hash: hashObject(data),
      ...(payload_ref ? { payload_ref, payload_hash } : {}),
      chain: { prev_hash: last?.hash ?? GENESIS, hash: "" },
      redaction: "none",
    };
    ev.chain.hash = EventStore.chainHash({ ...ev, prev_hash: ev.chain.prev_hash });
    this.db.prepare(`insert into events(seq, event_id, type, occurred_at, recorded_at, node_id, source, correlation, task_id, action_id,
      sensitivity, summary, data, data_hash, payload_ref, payload_hash, prev_hash, hash, redaction)
      values (@seq, @event_id, @type, @occurred_at, @recorded_at, @node_id, @source, @correlation, @task_id, @action_id,
      @sensitivity, @summary, @data, @data_hash, @payload_ref, @payload_hash, @prev_hash, @hash, @redaction)`).run({
      seq, event_id: ev.event_id, type: ev.type, occurred_at: ev.occurred_at, recorded_at, node_id: ev.node_id,
      source: JSON.stringify(ev.source), correlation: JSON.stringify(ev.correlation),
      task_id: ev.correlation.task_id ?? null, action_id: ev.correlation.action_id ?? null,
      sensitivity: ev.sensitivity, summary: ev.summary, data: JSON.stringify(data), data_hash: ev.data_hash,
      payload_ref: payload_ref ?? null, payload_hash: payload_hash ?? null, prev_hash: ev.chain.prev_hash, hash: ev.chain.hash, redaction: "none",
    });
    // Deliver after the surrounding transaction commits, so subscribers never see rolled-back events.
    const deliver = () => this.emitter.emit("event", ev);
    if (this.db.inTransaction) this.pending.push(deliver); else deliver();
    return ev;
  }

  private pending: (() => void)[] = [];
  /** Call after the outer transaction commits (the UnitOfWork does this). */
  flush(): void { const p = this.pending; this.pending = []; for (const f of p) f(); }
  /** Call if the outer transaction rolled back. */
  discardPending(): void { this.pending = []; }
  pendingMark(): number { return this.pending.length; }
  truncatePending(mark: number): void { this.pending.length = Math.min(this.pending.length, mark); }

  private toEvent(r: Row): JarvisEvent {
    return {
      event_id: r.event_id, schema: "jarvis.event/1", type: r.type, occurred_at: r.occurred_at, recorded_at: r.recorded_at,
      node_id: r.node_id, seq: r.seq, source: JSON.parse(r.source), correlation: JSON.parse(r.correlation),
      sensitivity: r.sensitivity as Sensitivity, summary: r.summary, data: JSON.parse(r.data), data_hash: r.data_hash,
      ...(r.payload_ref ? { payload_ref: r.payload_ref } : {}), ...(r.payload_hash ? { payload_hash: r.payload_hash } : {}),
      chain: { prev_hash: r.prev_hash, hash: r.hash }, redaction: r.redaction as JarvisEvent["redaction"],
    };
  }

  list(opts: { fromSeq?: number; taskId?: string; type?: string; limit?: number } = {}): JarvisEvent[] {
    const where: string[] = ["seq > @fromSeq"];
    if (opts.taskId) where.push("task_id = @taskId");
    if (opts.type) where.push("type = @type");
    const rows = this.db.prepare(`select * from events where ${where.join(" and ")} order by seq limit @limit`)
      .all({ fromSeq: opts.fromSeq ?? 0, taskId: opts.taskId ?? null, type: opts.type ?? null, limit: opts.limit ?? 1000 }) as Row[];
    return rows.map(r => this.toEvent(r));
  }

  lastSeq(): number {
    return (this.db.prepare("select coalesce(max(seq), 0) s from events").get() as { s: number }).s;
  }

  /** Replays from `fromSeq` and then streams live events (12 §17.6 reconnection). Returns an unsubscribe function. */
  subscribe(fromSeq: number, listener: (e: JarvisEvent) => void, filter: (e: JarvisEvent) => boolean = () => true): () => void {
    let cursor = fromSeq;
    for (;;) {
      const batch = this.list({ fromSeq: cursor, limit: 500 });
      for (const e of batch) { if (filter(e)) listener(e); cursor = e.seq; }
      if (batch.length < 500) break;
    }
    const live = (e: JarvisEvent) => { if (e.seq > cursor) { cursor = e.seq; if (filter(e)) listener(e); } };
    this.emitter.on("event", live);
    return () => this.emitter.off("event", live);
  }

  /** Owner-initiated deletion (03 §9.15): summary and data replaced, payload deleted, hashes kept. */
  redact(eventIds: string[], opts: { deletePayload: boolean }): number {
    let n = 0;
    for (const id of eventIds) {
      const r = this.db.prepare("select payload_ref from events where event_id = ?").get(id) as { payload_ref: string | null } | undefined;
      if (!r) continue;
      if (opts.deletePayload && r.payload_ref) this.payloads.delete(r.payload_ref);
      n += this.db.prepare(`update events set summary = ?, data = '{}', redaction = ? where event_id = ?`)
        .run(REDACTED, opts.deletePayload && r.payload_ref ? "payload_deleted" : "data_redacted", id).changes;
    }
    return n;
  }

  /** Verifies the whole chain. Unredacted events must also match their data_hash. */
  verifyChain(): { ok: boolean; checked: number; brokenAt?: number; reason?: string } {
    let prev = GENESIS, checked = 0;
    const it = this.db.prepare("select * from events order by seq").iterate() as IterableIterator<Row>;
    for (const r of it) {
      const e = this.toEvent(r);
      if (e.chain.prev_hash !== prev) return { ok: false, checked, brokenAt: e.seq, reason: "prev_hash mismatch" };
      if (EventStore.chainHash({ ...e, prev_hash: prev }) !== e.chain.hash) return { ok: false, checked, brokenAt: e.seq, reason: "hash mismatch" };
      if (e.redaction === "none" && hashObject(e.data) !== e.data_hash) return { ok: false, checked, brokenAt: e.seq, reason: "data does not match data_hash" };
      prev = e.chain.hash; checked++;
    }
    return { ok: true, checked };
  }
}
