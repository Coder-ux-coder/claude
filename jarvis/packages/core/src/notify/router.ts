import { newId, type Channel, type WeeklyHours } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { evalCondition } from "../policy/match.js";
import { toLocal } from "../scheduler/tz.js";

export interface NotificationInput {
  kind: "alarm" | "reminder" | "task_report" | "decision" | "missed" | "clarification" | "sign_in" | "info" | "digest";
  title: string;
  body: string;
  urgency: "high" | "normal" | "low";
  channels?: Channel[];
  respect_quiet_hours?: boolean;          // alarms default to false: they override quiet hours (10 §15.1)
  task_id?: string; schedule_id?: string; decision_request_id?: string;
  dedupe_key?: string;                    // same key within 10 minutes is delivered once
  sound?: string;
}

export interface NotificationRecord extends NotificationInput {
  id: string; status: "pending" | "delivering" | "delivered" | "held_quiet_hours" | "needs_you" | "deduplicated" | "dismissed";
  delivered_channels: Channel[]; created_at: string; delivered_at?: string; attempts?: number;
}

export type ChannelSink = (n: NotificationRecord) => Promise<boolean> | boolean;

const NEEDS_YOU = new Set(["decision", "clarification", "sign_in", "missed"]);

/**
 * Notification Router v1 (09 §14.5, 10 §15.4): Console and toast, quiet hours, dedupe,
 * and the "Needs you" list. Alarms override quiet hours; everything else respects them
 * by default and waits in the attention view. Every delivery is logged.
 */
export class NotificationRouter {
  private sinks = new Map<Channel, ChannelSink>();
  constructor(private ctx: CoreContext, private quietHours: () => { hours: WeeklyHours | null; tz: string }) {}

  private closed = false;
  registerSink(channel: Channel, sink: ChannelSink): void { this.sinks.set(channel, sink); }
  /** After close, pending rows stay pending for the next start. */
  close(): void { this.closed = true; }

  inQuietHours(atMs: number = this.ctx.clock.now()): boolean {
    const { hours, tz } = this.quietHours();
    if (!hours) return false;
    const l = toLocal(atMs, hours.tz || tz);
    const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay()]!;
    const hm = `${String(l.h).padStart(2, "0")}:${String(l.mi).padStart(2, "0")}`;
    return hours.windows.some(w => {
      // A window that wraps midnight belongs to the day it starts on; its early-morning part to the next day.
      const wraps = w.from > w.to;
      const prevDay = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(day) + 6) % 7]!;
      if (!wraps) return (w.days as string[]).includes(day) && evalCondition({ field: "t", op: "within", value: { from: w.from, to: w.to } }, { t: hm }) === true;
      return ((w.days as string[]).includes(day) && hm >= w.from) || ((w.days as string[]).includes(prevDay) && hm < w.to);
    });
  }

  /**
   * Records a notification synchronously (usable inside a transaction, e.g. a schedule fire),
   * with status "pending"; `flush()` delivers it after commit. A crash between the two leaves
   * a pending row that the next `flush()` delivers, so a fire never loses its notification.
   */
  enqueue(input: NotificationInput): NotificationRecord {
    const rec: NotificationRecord = { ...input, id: newId("ntf", this.ctx.clock.now()), status: "pending", delivered_channels: [], created_at: this.ctx.clock.iso() };
    if (input.dedupe_key) {
      const since = new Date(this.ctx.clock.now() - 10 * 60_000).toISOString();
      const dup = this.ctx.db.prepare("select id from notifications where dedupe_key = ? and created_at > ? and status not in ('dismissed', 'deduplicated')").get(input.dedupe_key, since);
      if (dup) rec.status = "deduplicated";
    }
    this.save(rec);
    return rec;
  }

  async notify(input: NotificationInput): Promise<NotificationRecord> {
    const rec = this.enqueue(input);
    return rec.status === "pending" ? this.deliverRecord(rec) : rec;
  }

  /** At startup: anything claimed but not finished before a crash is delivered again (at least once). */
  async resumeAfterRestart(): Promise<NotificationRecord[]> {
    if (this.closed || !this.ctx.db.open) return [];
    this.ctx.db.prepare("update notifications set status = 'pending' where status = 'delivering'").run();
    return this.flush();
  }

  /** Delivers every pending notification (after a fire commits, and at startup). */
  async flush(): Promise<NotificationRecord[]> {
    if (this.closed || !this.ctx.db.open) return [];
    const pending = (this.ctx.db.prepare("select record from notifications where status = 'pending' order by created_at").all() as { record: string }[]).map(r => JSON.parse(r.record) as NotificationRecord);
    const out: NotificationRecord[] = [];
    for (const p of pending) out.push(await this.deliverRecord(p));
    return out;
  }

  private async deliverRecord(rec: NotificationRecord): Promise<NotificationRecord> {
    if (this.closed || !this.ctx.db.open) return rec;
    // Claim the row first so a concurrent flush can't deliver it twice.
    const claimed = this.ctx.db.prepare("update notifications set status = 'delivering' where id = ? and status = 'pending'").run(rec.id);
    if (claimed.changes !== 1) return rec;
    const respect = rec.respect_quiet_hours ?? rec.kind !== "alarm";
    const quiet = respect && this.inQuietHours();
    const channels: Channel[] = rec.channels ?? (rec.kind === "alarm" ? ["sound", "toast", "console", "speech"] : ["console", "toast"]);
    if (quiet) {
      rec.status = NEEDS_YOU.has(rec.kind) ? "needs_you" : "held_quiet_hours";
      // Quiet hours: the Console record still appears; nothing interrupts.
      if (channels.includes("console")) await this.deliver(rec, "console");
      if (this.closed || !this.ctx.db.open) return rec;
    } else {
      for (const ch of channels) await this.deliver(rec, ch);
      if (this.closed || !this.ctx.db.open) return rec;       // closed mid-delivery: re-delivered at next start
      if (!rec.delivered_channels.length && !NEEDS_YOU.has(rec.kind)) {
        // Nobody to show it to yet (no Console or tray connected): keep it pending; the next
        // flush — when a client connects — delivers it. Never marked delivered to no one.
        rec.status = "pending"; rec.attempts = (rec.attempts ?? 0) + 1;
        this.save(rec);
        return rec;
      }
      rec.status = NEEDS_YOU.has(rec.kind) ? "needs_you" : "delivered";
      rec.delivered_at = this.ctx.clock.iso();
    }
    this.save(rec);
    this.ctx.events.append({ type: "notification", summary: `${rec.kind}: ${rec.title}`.slice(0, 200), data: { id: rec.id, kind: rec.kind, status: rec.status, channels: rec.delivered_channels } });
    return rec;
  }

  private async deliver(rec: NotificationRecord, ch: Channel): Promise<void> {
    const sink = this.sinks.get(ch);
    if (!sink) return;
    try { if (await sink(rec)) rec.delivered_channels.push(ch); } catch { /* a failed channel never blocks the others */ }
  }

  private save(rec: NotificationRecord): void {
    this.ctx.db.prepare("insert or replace into notifications(id, kind, status, dedupe_key, created_at, delivered_at, record) values (?,?,?,?,?,?,?)")
      .run(rec.id, rec.kind, rec.status, rec.dedupe_key ?? null, rec.created_at, rec.delivered_at ?? null, JSON.stringify(rec));
  }

  /** Items waiting on you, plus anything held during quiet hours. */
  needsYou(): NotificationRecord[] {
    return (this.ctx.db.prepare("select record from notifications where status in ('needs_you', 'held_quiet_hours') order by created_at").all() as { record: string }[]).map(r => JSON.parse(r.record));
  }
  dismiss(id: string): void {
    const r = this.ctx.db.prepare("select record from notifications where id = ?").get(id) as { record: string } | undefined;
    if (!r) return;
    this.ctx.db.prepare("update notifications set status = 'dismissed', record = ? where id = ?").run(JSON.stringify({ ...JSON.parse(r.record), status: "dismissed" }), id);
  }
  /** After quiet hours end, held items are delivered once. */
  async releaseHeld(): Promise<number> {
    if (this.inQuietHours()) return 0;
    const held = (this.ctx.db.prepare("select record from notifications where status = 'held_quiet_hours'").all() as { record: string }[]).map(r => JSON.parse(r.record) as NotificationRecord);
    for (const h of held) {
      h.status = "delivered";
      for (const ch of (h.channels ?? ["console", "toast"]).filter(c => c !== "console")) await this.deliver(h, ch);
      h.delivered_at = this.ctx.clock.iso(); this.save(h);
    }
    return held.length;
  }
  log(limit = 100): NotificationRecord[] {
    return (this.ctx.db.prepare("select record from notifications order by created_at desc limit ?").all(limit) as { record: string }[]).map(r => JSON.parse(r.record));
  }
}
