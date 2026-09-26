import {
  newId, sha256, parseDuration, JarvisError, ScheduledJob,
  type Channel, type AuthorizationEnvelope,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { LeaseManager } from "../tasks/leases.js";
import { formatLocal, isValidZone, localToUtc, parseLocal, toLocal } from "./tz.js";
import { occurrences, parseRRule } from "./rrule.js";

export interface ScheduleInput {
  kind: ScheduledJob["kind"];
  owner_text: string;                              // what you said (stored as an encrypted payload)
  tz: string;
  semantics?: "floating_local" | "fixed_instant";
  start_local?: string;                            // "2026-09-28T08:30"
  at_instant?: string;
  rrule?: string;
  message?: string;
  channels?: Channel[];
  target?: ScheduledJob["target"];
  envelope?: AuthorizationEnvelope;
  policy_revision: number;
  wake_system?: boolean;
  missed_run?: ScheduledJob["missed_run"];
  has_external_effect?: boolean;                   // one-shot task whose time is part of the intent
  created_from_task_id?: string;
}

/** What a fire produces; created by the caller in the SAME transaction as the fire record (10 §15.2). */
export interface FireOutcome { schedule: ScheduledJob; fire_id: string; scheduled_local: string; scheduled_utc: string; lateness_ms: number;
  action: "fire" | "fire_late" | "notify_missed" | "ask" | "skip"; coalesced: number }

export type FireHandler = (f: FireOutcome) => string;   // returns a short outcome description

const DEFAULT_MISSED: Record<ScheduledJob["kind"], ScheduledJob["missed_run"]> = {
  alarm: { policy: "fire_if_within", grace: "PT10M" },
  reminder: { policy: "fire_if_within", grace: "PT24H" },
  scheduled_task: { policy: "coalesce_once", grace: "PT4H" },
  monitor_run: { policy: "coalesce_once", grace: "P7D" },
};
const ON_TIME_MS = 60_000;

/**
 * Scheduler v1 (10 §15.2–15.3): durable, deterministic, event-driven. Floating schedules
 * keep their wall-clock time across DST; the DST rules come from tz.ts; missed runs follow
 * the kind's policy (never a loud alarm hours late, never a burst); each occurrence fires at
 * most once through a unique fire_id committed with what it creates; one active scheduler
 * holds a lease.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private alarmCache: { schedule_id: string; at: number; message: string }[] = [];
  private leaseId: string | null = null;
  /** Called after each tick's fires have committed (run created tasks, deliver notifications). */
  afterTick: ((fires: FireOutcome[]) => void) | null = null;
  constructor(private ctx: CoreContext, private leases: LeaseManager, private onFire: FireHandler, private instance = `sch_${process.pid}`) {}

  // ---------- CRUD ----------
  get(id: string): ScheduledJob | undefined {
    const r = this.ctx.db.prepare("select job from schedules where schedule_id = ?").get(id) as { job: string } | undefined;
    return r ? ScheduledJob.parse(JSON.parse(r.job)) : undefined;
  }
  list(status?: ScheduledJob["status"][]): ScheduledJob[] {
    const rows = (status?.length ? this.ctx.db.prepare(`select job from schedules where status in (${status.map(() => "?").join(",")}) order by next_fire_utc`).all(...status)
      : this.ctx.db.prepare("select job from schedules order by next_fire_utc").all()) as { job: string }[];
    return rows.map(r => ScheduledJob.parse(JSON.parse(r.job)));
  }
  /** `resetFloor`: occurrences at or before now can never be "missed" for this revision (create, revise, resume, move). */
  private save(j: ScheduledJob, resetFloor = false): void {
    const job = ScheduledJob.parse(j);
    const floor = resetFloor ? this.ctx.clock.now() - 1 : null;
    this.ctx.db.prepare(`insert into schedules(schedule_id, kind, status, next_fire_utc, search_from_utc, job) values (?,?,?,?,?,?)
      on conflict(schedule_id) do update set status = excluded.status, next_fire_utc = excluded.next_fire_utc, job = excluded.job,
        search_from_utc = case when ? is null then schedules.search_from_utc else excluded.search_from_utc end`)
      .run(job.schedule_id, job.kind, job.status, job.next_fire_utc ?? null, floor ?? 0, JSON.stringify(job), floor);
  }

  /** The exact interpretation shown to you, e.g. "Weekdays at 08:30 Europe/London, starting Mon 28 Sep 2026". */
  static interpret(i: Pick<ScheduleInput, "rrule" | "start_local" | "at_instant" | "tz" | "kind">, firstLocal?: string): string {
    // A fixed instant is shown in your zone (its occurrences are computed in UTC).
    const when = i.at_instant ? formatLocal(toLocal(Date.parse(i.at_instant), i.tz)) : firstLocal ?? i.start_local ?? "";
    const d = when ? new Date(`${when.slice(0, 16)}:00Z`) : null;
    // Formatted by hand: ICU date text differs between Node builds ("Sep" vs "Sept", commas).
    const dateStr = d && !Number.isNaN(d.getTime()) ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
    const time = when.slice(11, 16);
    if (!i.rrule) return `${i.kind === "alarm" ? "Alarm" : i.kind === "reminder" ? "Reminder" : "Once"} at ${time} ${i.tz} on ${dateStr}`;
    const r = parseRRule(i.rrule, i.tz);
    const days = r.byday?.map(b => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b.wd]).join(", ");
    const hm = r.byhour ? `${String(r.byhour[0]).padStart(2, "0")}:${String(r.byminute?.[0] ?? 0).padStart(2, "0")}` : time;
    const freq = r.freq === "DAILY" ? (r.interval > 1 ? `Every ${r.interval} days` : "Every day")
      : r.freq === "WEEKLY" ? (days === "Mon, Tue, Wed, Thu, Fri" ? "Weekdays" : `Every week on ${days ?? "the same day"}`) : r.freq === "MONTHLY" ? "Every month" : "Every year";
    return `${freq} at ${hm} ${i.tz}, starting ${dateStr}${r.count ? `, ${r.count} times` : ""}${r.until ? `, until ${r.until.slice(0, 10)}` : ""}`;
  }

  create(i: ScheduleInput): ScheduledJob {
    if (!isValidZone(i.tz)) throw new JarvisError("invalid_input", `unknown timezone ${i.tz}`);
    if (i.rrule) parseRRule(i.rrule, i.tz);          // reject unsupported rules now
    const semantics = i.semantics ?? (i.at_instant ? "fixed_instant" : "floating_local");
    if (semantics === "floating_local" && !i.start_local) throw new JarvisError("invalid_input", "a floating schedule needs a local start time");
    if (semantics === "fixed_instant" && !i.at_instant) throw new JarvisError("invalid_input", "a fixed schedule needs an instant");
    if (i.kind === "alarm" || i.kind === "reminder") {
      if (i.envelope?.effects.some(e => e !== "notify_owner")) throw new JarvisError("invalid_input", "alarms and reminders only notify you");
    }
    const { payload_id } = this.ctx.payloads.put(i.owner_text, "personal");
    const missed = i.missed_run ?? (i.kind === "scheduled_task" && !i.rrule && i.has_external_effect ? { policy: "fire_if_within" as const, grace: "PT15M" } : DEFAULT_MISSED[i.kind]);
    const job: ScheduledJob = {
      schedule_id: newId("sch", this.ctx.clock.now()), schema: "jarvis.schedule/1", kind: i.kind, owner_intent_text_ref: payload_id, interpretation: "",
      time: { semantics, tz: i.tz, follow_owner_tz: semantics === "floating_local", ...(i.start_local ? { start_local: i.start_local.slice(0, 16) } : {}),
        ...(i.at_instant ? { at_instant: i.at_instant } : {}), ...(i.rrule ? { rrule: i.rrule } : {}) },
      dst_policy: { nonexistent: "shift_forward", ambiguous: "first" }, missed_run: missed,
      delivery: { channels: i.channels ?? (i.kind === "alarm" ? ["sound", "toast", "console"] : ["console", "toast"]), respect_quiet_hours: i.kind !== "alarm" },
      target: { ...(i.target ?? {}), ...(i.message ? { message: i.message } : {}), ...(i.has_external_effect ? { params: { has_external_effect: true } } : {}) },
      authorization: { ...(i.envelope ? { envelope: i.envelope } : {}), grant_ids: [], policy_revision_at_creation: i.policy_revision, re_evaluate_on_fire: true },
      wake_system: i.wake_system ?? i.kind === "alarm", status: "active", revision: 1,
      ...(i.created_from_task_id ? { created_from_task_id: i.created_from_task_id } : {}), created_at: this.ctx.clock.iso(),
    };
    const next = this.computeNext(job, this.ctx.clock.now() - 1);
    job.interpretation = Scheduler.interpret({ ...i }, next?.local);
    if (!next) throw new JarvisError("invalid_input", "that time is already past and does not repeat");
    job.next_fire_utc = new Date(next.utc).toISOString();
    this.ctx.tx(() => { this.save(job, true); this.ctx.events.append({ type: "schedule.created", summary: job.interpretation, data: { schedule_id: job.schedule_id, kind: job.kind, next_fire_utc: job.next_fire_utc } }); });
    this.arm();
    return job;
  }

  /** Edits by stable id ("make that 8 instead"): a revision of the same schedule, never a second one. */
  revise(id: string, patch: { start_local?: string; rrule?: string | null; tz?: string; message?: string }): ScheduledJob {
    return this.ctx.tx(() => {
      const j = this.require(id);
      if (patch.tz && !isValidZone(patch.tz)) throw new JarvisError("invalid_input", `unknown timezone ${patch.tz}`);
      if (patch.start_local) parseLocal(patch.start_local);
      if (j.time.semantics === "fixed_instant" && patch.start_local) {
        // "Make that 8 instead" on a fixed instant: the new wall time in the schedule's zone becomes the new instant.
        const r = localToUtc(parseLocal(patch.start_local), patch.tz ?? j.time.tz, j.dst_policy);
        if (r.utc === null) throw new JarvisError("invalid_input", `${patch.start_local} does not exist in ${patch.tz ?? j.time.tz}`);
        j.time = { ...j.time, at_instant: new Date(r.utc).toISOString() };
        delete patch.start_local;
      }
      if (patch.rrule) parseRRule(patch.rrule, patch.tz ?? j.time.tz);
      const next: ScheduledJob = { ...j, revision: j.revision + 1, time: { ...j.time, ...(patch.start_local ? { start_local: patch.start_local.slice(0, 16) } : {}), ...(patch.tz ? { tz: patch.tz } : {}) },
        target: { ...j.target, ...(patch.message ? { message: patch.message } : {}) } };
      if (patch.rrule === null) delete next.time.rrule; else if (patch.rrule) next.time.rrule = patch.rrule;
      const n = this.computeNext(next, this.ctx.clock.now() - 1);
      next.next_fire_utc = n ? new Date(n.utc).toISOString() : undefined;
      if (!n) next.status = "completed";
      next.interpretation = Scheduler.interpret({ kind: next.kind, tz: next.time.tz, ...(next.time.rrule ? { rrule: next.time.rrule } : {}), ...(next.time.start_local ? { start_local: next.time.start_local } : {}),
        ...(next.time.semantics === "fixed_instant" && next.time.at_instant ? { at_instant: next.time.at_instant } : {}) }, n?.local);
      this.save(next, true);
      this.ctx.events.append({ type: "schedule.revised", summary: next.interpretation, data: { schedule_id: id, revision: next.revision } });
      this.arm();
      return next;
    });
  }

  setStatus(id: string, status: "paused" | "active" | "cancelled"): ScheduledJob {
    return this.ctx.tx(() => {
      const j = this.require(id);
      const next: ScheduledJob = { ...j, status, revision: j.revision + 1 };
      if (status === "active") { const n = this.computeNext(next, this.ctx.clock.now() - 1); next.next_fire_utc = n ? new Date(n.utc).toISOString() : undefined; if (!n) next.status = "completed"; }
      this.save(next, status === "active");
      this.ctx.events.append({ type: `schedule.${status === "active" ? "resumed" : status}`, summary: j.interpretation, data: { schedule_id: id } });
      this.arm();
      return next;
    });
  }

  private require(id: string): ScheduledJob {
    const j = this.get(id);
    if (!j) throw new JarvisError("invalid_input", `unknown schedule ${id}`);
    return j;
  }

  // ---------- time math ----------
  /** The next occurrence strictly after `afterUtcMs`, resolved under the DST policy. */
  computeNext(j: ScheduledJob, afterUtcMs: number): { local: string; utc: number } | null {
    return this.occurrencesBetween(j, afterUtcMs, Number.MAX_SAFE_INTEGER, 1)[0] ?? null;
  }

  /** Occurrences with UTC in (fromUtc, toUtc], at most `limit`. */
  occurrencesBetween(j: ScheduledJob, fromUtc: number, toUtc: number, limit = 1000): { local: string; utc: number }[] {
    const tz = j.time.semantics === "fixed_instant" ? "UTC" : j.time.tz;
    const startLocal = j.time.semantics === "fixed_instant" ? formatLocal(toLocal(Date.parse(j.time.at_instant!), "UTC")) : j.time.start_local!;
    const out: { local: string; utc: number }[] = [];
    if (!j.time.rrule) {
      const r = localToUtc(parseLocal(startLocal), tz, j.dst_policy);
      if (r.utc !== null && r.utc > fromUtc && r.utc <= toUtc) out.push({ local: startLocal, utc: r.utc });
      return out;
    }
    const rule = parseRRule(j.time.rrule, tz);
    // Start a day before the window in local terms, then filter by resolved UTC.
    const fromLocal = fromUtc < 0 ? null : formatLocal(toLocal(Math.max(0, fromUtc - 86_400_000 * 2), tz));
    let cursor = fromLocal;
    for (let guard = 0; guard < 50 && out.length < limit; guard++) {
      const batch = occurrences(rule, parseLocal(startLocal), cursor, 200);
      if (!batch.length) break;
      for (const local of batch) {
        const r = localToUtc(parseLocal(local), tz, j.dst_policy);
        if (r.utc === null) continue;
        if (r.utc > toUtc) return out;
        if (r.utc > fromUtc && !out.some(o => o.utc === r.utc)) out.push({ local, utc: r.utc });
        if (out.length >= limit) return out;
      }
      cursor = batch[batch.length - 1]!;
    }
    return out;
  }

  // ---------- firing ----------
  static fireId(scheduleId: string, local: string, revision: number): string {
    return `fire_${sha256(`${scheduleId}|${local}|${revision}`).slice(0, 26)}`;
  }

  /** Single active scheduler (F34): a lease with a fencing token; a second instance does not fire. */
  holdsLease(): boolean {
    if (this.leaseId) {
      try { this.leases.heartbeat(this.leaseId, 120_000); return true; } catch { this.leaseId = null; }
    }
    const r = this.leases.acquire("scheduler:singleton", "exclusive", { task_id: this.instance }, 120_000);
    if (r.granted) { this.leaseId = r.lease.lease_id; return true; }
    return false;
  }

  /**
   * Fires everything due. Missed occurrences follow the kind's policy; several missed
   * occurrences of one schedule produce at most one run (coalesced), never a burst.
   */
  tick(): FireOutcome[] {
    if (!this.holdsLease()) return [];
    const now = this.ctx.clock.now();
    const out: FireOutcome[] = [];
    const due = this.ctx.db.prepare("select job from schedules where status = 'active' and next_fire_utc is not null and next_fire_utc <= ?").all(new Date(now).toISOString()) as { job: string }[];
    for (const row of due) {
      const j = ScheduledJob.parse(JSON.parse(row.job));
      const firstDue = Date.parse(j.next_fire_utc!);
      const missed = this.occurrencesBetween(j, firstDue - 1, now, 10_000);
      if (!missed.length) { this.advance(j, now); continue; }
      const latest = missed[missed.length - 1]!;
      const lateness = now - latest.utc;
      const grace = j.missed_run.grace ? parseDuration(j.missed_run.grace) : 0;
      let action: FireOutcome["action"];
      if (lateness <= ON_TIME_MS) action = "fire";
      else switch (j.missed_run.policy) {
        case "fire_if_within": action = lateness <= grace ? "fire_late" : (j.kind === "scheduled_task" && (j.target.params as { has_external_effect?: boolean } | undefined)?.has_external_effect) ? "ask" : "notify_missed"; break;
        case "coalesce_once": action = lateness <= grace ? "fire_late" : "skip"; break;
        case "notify_missed": action = "notify_missed"; break;
        case "skip": action = "skip"; break;
      }
      const fire: FireOutcome = { schedule: j, fire_id: Schedule_fireId(j, latest.local), scheduled_local: latest.local, scheduled_utc: new Date(latest.utc).toISOString(), lateness_ms: lateness, action, coalesced: missed.length - 1 };
      try {
        this.ctx.tx(() => {
          // The unique fire_id makes a second fire of the same occurrence impossible, even with two schedulers.
          this.ctx.db.prepare("insert into schedule_fires(fire_id, schedule_id, scheduled_local, scheduled_utc, fired_at, outcome, missed) values (?,?,?,?,?,?,?)")
            .run(fire.fire_id, j.schedule_id, latest.local, fire.scheduled_utc, new Date(now).toISOString(), action, action === "fire" ? 0 : 1);
          for (const m of missed.slice(0, -1))
            this.ctx.db.prepare("insert or ignore into schedule_fires(fire_id, schedule_id, scheduled_local, scheduled_utc, fired_at, outcome, missed) values (?,?,?,?,?,?,1)")
              .run(Schedule_fireId(j, m.local), j.schedule_id, m.local, new Date(m.utc).toISOString(), new Date(now).toISOString(), "coalesced");
          const outcome = this.onFire(fire);
          j.last_fire = { fire_id: fire.fire_id, at: new Date(now).toISOString(), outcome };
          this.advance(j, now);
          this.ctx.events.append({ type: "schedule.fired", summary: `${j.interpretation}: ${action}`, data: { schedule_id: j.schedule_id, fire_id: fire.fire_id, scheduled_for: fire.scheduled_utc, fired_at: new Date(now).toISOString(), missed: action !== "fire", policy_applied: j.missed_run.policy, coalesced: fire.coalesced } });
        });
        out.push(fire);
      } catch (e) {
        if (!/UNIQUE constraint failed/.test(String((e as Error).message))) throw e;
        this.advance(j, now);             // already fired by another instance or before a crash
      }
    }
    this.refreshAlarmCache();
    this.arm();
    if (out.length) this.afterTick?.(out);
    return out;
  }

  private advance(j: ScheduledJob, now: number): void {
    const n = this.computeNext(j, now);
    const next: ScheduledJob = { ...j, next_fire_utc: n ? new Date(n.utc).toISOString() : undefined, status: n ? j.status : "completed" };
    this.save(next);
  }

  /**
   * Clock or timezone-database change (F33): recompute every next fire. The search starts
   * from the last fire (or a little before the stored next fire, for DST-rule shifts), not
   * from "now", so occurrences skipped by a forward clock jump still go through the
   * missed-run policy in tick(), and a backward jump can't re-fire an occurrence (the
   * unique fire_id also guarantees that).
   */
  recomputeAll(): number {
    let n = 0;
    const SHIFT_TOLERANCE = 3 * 3_600_000;
    this.ctx.tx(() => {
      for (const j of this.list(["active"])) {
        const lastScheduled = this.lastScheduledUtc(j) ?? -1;
        const floor = (this.ctx.db.prepare("select search_from_utc f from schedules where schedule_id = ?").get(j.schedule_id) as { f: number }).f;
        const stored = j.next_fire_utc ? Date.parse(j.next_fire_utc) - 1 - SHIFT_TOLERANCE : this.ctx.clock.now() - 1;
        const from = Math.max(lastScheduled, floor, stored);
        const next = this.computeNext(j, from);
        this.save({ ...j, next_fire_utc: next ? new Date(next.utc).toISOString() : undefined, status: next ? "active" : "completed" }); n++;
      }
    });
    this.arm();
    return n;
  }

  private lastScheduledUtc(j: ScheduledJob): number | null {
    const r = this.ctx.db.prepare("select max(scheduled_utc) t from schedule_fires where schedule_id = ?").get(j.schedule_id) as { t: string | null };
    return r.t ? Date.parse(r.t) : null;
  }

  /**
   * Your profile timezone changed (F49): floating schedules that follow you move to the
   * new zone; fixed instants are unchanged. Returns the schedules to confirm once.
   */
  onOwnerTimezoneChanged(oldTz: string, newTz: string): { moved: string[]; confirm: string[] } {
    const moved: string[] = [], confirm: string[] = [];
    this.ctx.tx(() => {
      for (const j of this.list(["active", "paused"])) {
        if (j.time.semantics !== "floating_local" || !j.time.follow_owner_tz || j.time.tz !== oldTz) continue;
        const next: ScheduledJob = { ...j, time: { ...j.time, tz: newTz }, revision: j.revision + 1 };
        const n = this.computeNext(next, this.ctx.clock.now() - 1);
        next.next_fire_utc = n ? new Date(n.utc).toISOString() : undefined;
        next.interpretation = j.interpretation.replace(oldTz, newTz);
        this.save(next, true);
        moved.push(j.schedule_id);
        if (j.kind === "alarm" || j.kind === "scheduled_task") confirm.push(j.schedule_id);
      }
      if (moved.length) this.ctx.events.append({ type: "schedule.timezone_changed", summary: `${moved.length} schedule(s) moved to ${newTz}`, data: { moved, confirm, from: oldTz, to: newTz } });
    });
    this.arm();
    return { moved, confirm };
  }

  // ---------- timer and outage cache ----------
  /** Event-driven: one timer to the earliest fire, with a one-minute watchdog. */
  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const r = this.ctx.db.prepare("select min(next_fire_utc) t from schedules where status = 'active'").get() as { t: string | null };
    const wait = r.t ? Math.max(0, Math.min(60_000, Date.parse(r.t) - this.ctx.clock.now())) : 60_000;
    this.timer = setTimeout(() => { try { this.tick(); } catch (e) { this.ctx.events.append({ type: "scheduler.error", summary: String((e as Error).message).slice(0, 200), data: {} }); this.arm(); } }, wait);
    this.timer.unref?.();
  }
  private running = false;
  start(): void { this.running = true; this.recomputeAll(); this.tick(); }
  /** Stops the timer and hands the singleton lease back so a standby instance can take over at once. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.leaseId) { try { this.leases.release(this.leaseId); } catch { /* database already closed */ } this.leaseId = null; }
  }

  /** The next 24 hours of alarms, kept in memory so alarms still sound if the database is unavailable (03 §9.9, F22). */
  refreshAlarmCache(): void {
    const now = this.ctx.clock.now();
    this.alarmCache = this.list(["active"]).filter(j => j.kind === "alarm").flatMap(j => this.occurrencesBetween(j, now - 1, now + 86_400_000, 50)
      .map(o => ({ schedule_id: j.schedule_id, at: o.utc, message: j.target.message ?? j.interpretation })));
  }
  cachedAlarmsDue(nowMs: number, sinceMs: number): { schedule_id: string; at: number; message: string }[] {
    return this.alarmCache.filter(a => a.at > sinceMs && a.at <= nowMs);
  }
}

function Schedule_fireId(j: ScheduledJob, local: string): string { return Scheduler.fireId(j.schedule_id, local, j.revision); }
