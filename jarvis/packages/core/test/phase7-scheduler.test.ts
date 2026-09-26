import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimClock, JarvisError, type OwnerProfile } from "@jarvis/shared";
import { createContext } from "../src/context.js";
import { LeaseManager } from "../src/tasks/leases.js";
import { Scheduler, type FireOutcome } from "../src/scheduler/scheduler.js";
import { localToUtc, parseLocal } from "../src/scheduler/tz.js";
import { parseRRule } from "../src/scheduler/rrule.js";
import { NotificationRouter, type NotificationRecord } from "../src/notify/router.js";
import { JarvisCore } from "../src/runtime.js";
import { FakeAdapter } from "../src/models/fake-adapter.js";

// All times and people below are HYPOTHETICAL test data.

function harness(start = "2026-09-26T12:00:00Z") {
  const clock = new SimClock(start);
  const ctx = createContext({ clock });
  const leases = new LeaseManager(ctx);
  const fires: FireOutcome[] = [];
  const s = new Scheduler(ctx, leases, f => { fires.push(f); return f.action; }, "sch_a");
  return { clock, ctx, leases, s, fires };
}
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test("DST: London spring-forward gap shifts forward, autumn overlap fires once at the first occurrence", () => {
  const gap = localToUtc(parseLocal("2026-03-29T01:30"), "Europe/London", { nonexistent: "shift_forward", ambiguous: "first" });
  assert.equal(gap.kind, "shifted_forward"); assert.equal(iso(gap.utc!), "2026-03-29T01:00:00.000Z");
  const skip = localToUtc(parseLocal("2026-03-29T01:30"), "Europe/London", { nonexistent: "skip", ambiguous: "first" });
  assert.equal(skip.utc, null);
  const amb = localToUtc(parseLocal("2026-10-25T01:30"), "Europe/London", { nonexistent: "shift_forward", ambiguous: "first" });
  assert.equal(iso(amb.utc!), "2026-10-25T00:30:00.000Z");
  const amb2 = localToUtc(parseLocal("2026-10-25T01:30"), "Europe/London", { nonexistent: "shift_forward", ambiguous: "second" });
  assert.equal(iso(amb2.utc!), "2026-10-25T01:30:00.000Z");

  // A daily 01:30 alarm across the autumn change fires exactly once that night.
  const h = harness("2026-10-24T12:00:00Z");
  const j = h.s.create({ kind: "alarm", owner_text: "wake me 1:30 daily", tz: "Europe/London", start_local: "2026-10-24T01:30", rrule: "FREQ=DAILY", policy_revision: 0 });
  const occ = h.s.occurrencesBetween(j, Date.parse("2026-10-24T12:00:00Z"), Date.parse("2026-10-26T12:00:00Z"));
  assert.deepEqual(occ.map(o => iso(o.utc)), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
});

test("floating local time keeps 08:30 wall-clock across DST; fixed instant keeps its UTC", () => {
  const h = harness("2026-10-20T12:00:00Z");
  const float = h.s.create({ kind: "reminder", owner_text: "standup", tz: "Europe/London", start_local: "2026-10-21T08:30", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", policy_revision: 0, message: "Standup" });
  const occ = h.s.occurrencesBetween(float, Date.parse("2026-10-23T00:00:00Z"), Date.parse("2026-10-27T00:00:00Z"));
  assert.deepEqual(occ.map(o => iso(o.utc)), ["2026-10-23T07:30:00.000Z", "2026-10-26T08:30:00.000Z"], "Fri BST, Mon GMT, both 08:30 local");
  assert.match(float.interpretation, /^Weekdays at 08:30 Europe\/London, starting Wed 21 Oct 2026$/);
  const fixed = h.s.create({ kind: "reminder", owner_text: "call", tz: "Europe/London", at_instant: "2026-10-26T09:00:00Z", policy_revision: 0 });
  assert.equal(fixed.next_fire_utc, "2026-10-26T09:00:00.000Z");
});

test("RRULE: unsupported parts are rejected, not guessed", () => {
  assert.throws(() => parseRRule("FREQ=HOURLY"), JarvisError);
  assert.throws(() => parseRRule("FREQ=DAILY;BYSETPOS=1"), JarvisError);
  const h = harness();
  assert.throws(() => h.s.create({ kind: "alarm", owner_text: "x", tz: "Mars/Olympus", start_local: "2026-09-27T07:00", policy_revision: 0 }), /unknown timezone/);
  assert.throws(() => h.s.create({ kind: "alarm", owner_text: "x", tz: "UTC", start_local: "2026-09-25T07:00", policy_revision: 0 }), /already past/);
  assert.throws(() => h.s.create({ kind: "alarm", owner_text: "x", tz: "UTC", start_local: "2026-09-27T07:00", policy_revision: 0,
    envelope: { effects: ["communicate"], bounds: [], substitution: "exact_target", grounding: [] } as never }), /only notify you/);
});

test("on-time fire, one-shot completes, revision is the same schedule (never a second one)", () => {
  const h = harness("2026-09-26T06:00:00Z");
  const j = h.s.create({ kind: "alarm", owner_text: "alarm 7", tz: "UTC", start_local: "2026-09-26T07:00", policy_revision: 0 });
  assert.equal(h.s.tick().length, 0);
  const r = h.s.revise(j.schedule_id, { start_local: "2026-09-26T08:00" });
  assert.equal(r.schedule_id, j.schedule_id); assert.equal(r.revision, 2); assert.equal(h.s.list().length, 1);
  h.clock.set(Date.parse("2026-09-26T08:00:20Z"));
  const f = h.s.tick();
  assert.equal(f.length, 1); assert.equal(f[0]!.action, "fire"); assert.equal(f[0]!.scheduled_local, "2026-09-26T08:00");
  assert.equal(h.s.get(j.schedule_id)!.status, "completed");
  h.clock.advance(HOUR); assert.equal(h.s.tick().length, 0);
});

test("F18: missed-run policies after the PC was off — alarm, reminder, recurring task, one-shot external task", () => {
  const h = harness("2026-09-26T06:00:00Z");
  const alarm = h.s.create({ kind: "alarm", owner_text: "alarm", tz: "UTC", start_local: "2026-09-26T07:00", policy_revision: 0 });
  const alarmSoon = h.s.create({ kind: "alarm", owner_text: "alarm2", tz: "UTC", start_local: "2026-09-26T10:55", policy_revision: 0 });
  const rem = h.s.create({ kind: "reminder", owner_text: "rem", tz: "UTC", start_local: "2026-09-26T08:00", policy_revision: 0 });
  const daily = h.s.create({ kind: "scheduled_task", owner_text: "daily", tz: "UTC", start_local: "2026-09-24T09:00", rrule: "FREQ=DAILY;BYHOUR=9,10;BYMINUTE=0", policy_revision: 0 });
  const oneShot = h.s.create({ kind: "scheduled_task", owner_text: "send at 9", tz: "UTC", start_local: "2026-09-26T09:00", policy_revision: 0, has_external_effect: true });
  // The PC is off 06:00 → 11:00.
  h.clock.set(Date.parse("2026-09-26T11:00:00Z"));
  const f = h.s.tick();
  const by = (id: string) => f.filter(x => x.schedule.schedule_id === id);
  assert.equal(by(alarm.schedule_id)[0]!.action, "notify_missed", "a 4-hour-late alarm never rings");
  assert.equal(by(alarmSoon.schedule_id)[0]!.action, "fire_late", "5 minutes late is within the alarm's 10-minute grace");
  assert.equal(by(rem.schedule_id)[0]!.action, "fire_late", "a reminder delivers late within 24 h");
  const d = by(daily.schedule_id);
  assert.equal(d.length, 1, "several missed occurrences → at most one run (no burst)");
  assert.equal(d[0]!.action, "fire_late"); assert.equal(d[0]!.coalesced, 1); assert.equal(d[0]!.scheduled_local, "2026-09-26T10:00");
  assert.equal(by(oneShot.schedule_id)[0]!.action, "ask", "a one-shot with an external effect, 2 h late, asks you");
  const coalesced = h.ctx.db.prepare("select count(*) n from schedule_fires where schedule_id = ? and outcome = 'coalesced'").get(daily.schedule_id) as { n: number };
  assert.equal(coalesced.n, 1);
  // A recurring task off beyond its grace is skipped, and its next run is still scheduled.
  h.clock.set(Date.parse("2026-09-27T16:00:00Z"));
  const g = h.s.tick().filter(x => x.schedule.schedule_id === daily.schedule_id);
  assert.equal(g[0]!.action, "skip");
  assert.equal(h.s.get(daily.schedule_id)!.next_fire_utc, "2026-09-28T09:00:00.000Z");
});

test("F33: clock jumps — backward never re-fires, forward goes through the missed-run policy", () => {
  const h = harness("2026-09-26T06:59:00Z");
  const j = h.s.create({ kind: "reminder", owner_text: "daily", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
  h.clock.set(Date.parse("2026-09-26T07:00:10Z"));
  assert.equal(h.s.tick().length, 1);
  // Clock goes back 30 minutes (NTP correction), then a recompute: 07:00 must not fire again.
  h.clock.set(Date.parse("2026-09-26T06:30:00Z"));
  h.s.recomputeAll();
  assert.equal(h.s.get(j.schedule_id)!.next_fire_utc, "2026-09-27T07:00:00.000Z");
  h.clock.set(Date.parse("2026-09-26T07:00:30Z"));
  assert.equal(h.s.tick().length, 0, "no double fire");
  // Forward jump of two days: one coalesced late delivery, not three.
  h.clock.set(Date.parse("2026-09-28T07:30:00Z"));
  h.s.recomputeAll();
  const f = h.s.tick();
  assert.equal(f.length, 1); assert.equal(f[0]!.action, "fire_late"); assert.equal(f[0]!.coalesced, 1);
  const fires = h.ctx.db.prepare("select count(*) n from schedule_fires where schedule_id = ?").get(j.schedule_id) as { n: number };
  assert.equal(fires.n, 3, "07:00 on the 26th, plus 27th (coalesced) and 28th");
});

test("F33: the same occurrence can't fire twice even if state is rolled back after a crash", () => {
  const h = harness("2026-09-26T06:59:00Z");
  const j = h.s.create({ kind: "alarm", owner_text: "a", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
  h.clock.set(Date.parse("2026-09-26T07:00:05Z"));
  assert.equal(h.s.tick().length, 1);
  // Simulate a crash that lost the schedule update but not the fire record.
  h.ctx.db.prepare("update schedules set next_fire_utc = ? where schedule_id = ?").run("2026-09-26T07:00:00.000Z", j.schedule_id);
  assert.equal(h.s.tick().length, 0);
  assert.equal(h.fires.length, 1);
  assert.equal(h.s.get(j.schedule_id)!.next_fire_utc, "2026-09-27T07:00:00.000Z", "advanced past the already-fired occurrence");
});

test("F34: two scheduler instances, one fire; the standby takes over when the lease expires", () => {
  const h = harness("2026-09-26T06:59:00Z");
  const other: FireOutcome[] = [];
  const b = new Scheduler(h.ctx, h.leases, f => { other.push(f); return f.action; }, "sch_b");
  h.s.create({ kind: "reminder", owner_text: "r", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
  assert.equal(h.s.holdsLease(), true);
  h.clock.set(Date.parse("2026-09-26T07:00:05Z"));
  assert.equal(b.tick().length, 0, "the standby does not fire");
  assert.equal(h.s.tick().length, 1);
  assert.equal(other.length, 0);
  // The active instance dies; its lease expires; the standby fires the next occurrence.
  h.clock.set(Date.parse("2026-09-27T07:00:05Z"));
  assert.equal(b.tick().length, 1);
  assert.equal(h.fires.length, 1); assert.equal(other.length, 1);
});

test("F49: a timezone change moves floating schedules (with confirmation for alarms and tasks), fixed instants stay", () => {
  const h = harness("2026-09-26T12:00:00Z");
  const alarm = h.s.create({ kind: "alarm", owner_text: "a", tz: "Europe/London", start_local: "2026-09-28T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
  const rem = h.s.create({ kind: "reminder", owner_text: "r", tz: "Europe/London", start_local: "2026-09-28T09:00", policy_revision: 0 });
  const fixed = h.s.create({ kind: "reminder", owner_text: "call", tz: "Europe/London", at_instant: "2026-09-28T15:00:00Z", policy_revision: 0 });
  const r = h.s.onOwnerTimezoneChanged("Europe/London", "Asia/Karachi");
  assert.deepEqual(r.moved.sort(), [alarm.schedule_id, rem.schedule_id].sort());
  assert.deepEqual(r.confirm, [alarm.schedule_id]);
  assert.equal(h.s.get(alarm.schedule_id)!.next_fire_utc, "2026-09-28T02:00:00.000Z", "07:00 in Karachi");
  assert.match(h.s.get(alarm.schedule_id)!.interpretation, /Asia\/Karachi/);
  assert.equal(h.s.get(fixed.schedule_id)!.next_fire_utc, "2026-09-28T15:00:00.000Z");
});

test("paused schedules don't fire; resuming never replays what was missed while paused", () => {
  const h = harness("2026-09-26T06:00:00Z");
  const j = h.s.create({ kind: "reminder", owner_text: "r", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0 });
  h.s.setStatus(j.schedule_id, "paused");
  h.clock.set(Date.parse("2026-09-27T12:00:00Z"));
  assert.equal(h.s.tick().length, 0);
  h.s.setStatus(j.schedule_id, "active");
  h.s.recomputeAll();
  assert.equal(h.s.tick().length, 0);
  assert.equal(h.s.get(j.schedule_id)!.next_fire_utc, "2026-09-28T07:00:00.000Z");
});

test("outage cache: the next 24 h of alarms are in memory", () => {
  const h = harness("2026-09-26T06:00:00Z");
  const j = h.s.create({ kind: "alarm", owner_text: "a", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0, message: "Wake up" });
  h.s.create({ kind: "reminder", owner_text: "r", tz: "UTC", start_local: "2026-09-26T07:00", policy_revision: 0 });
  h.s.refreshAlarmCache();
  const due = h.s.cachedAlarmsDue(Date.parse("2026-09-26T07:00:30Z"), Date.parse("2026-09-26T06:59:00Z"));
  assert.deepEqual(due.map(d => [d.schedule_id, d.message]), [[j.schedule_id, "Wake up"]]);
});

function profile(quiet: { from: string; to: string }[]): Omit<OwnerProfile, "owner_id" | "schema" | "revision" | "updated_at"> {
  return { display_name: "HYPOTHETICAL Owner", timezone: "Europe/London", locale: "en-GB", languages: ["en"], units: "metric",
    working_hours: { tz: "Europe/London", windows: [] }, quiet_hours: { tz: "Europe/London", windows: quiet.map(q => ({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], ...q })) },
    assistant: { name: "JARVIS", tone: "calm", verbosity: "brief", humor: "light" }, notification_defaults: { channels: ["console"] },
    privacy: { default_egress_by_sensitivity: { normal: { policy: "any_approved_provider" }, personal: { policy: "any_approved_provider" }, sensitive: { policy: "listed_providers", providers: [] }, restricted: { policy: "local_only" } }, audio_retention: "none", screenshot_retention_days: 7 },
    home_node_id: "node_local" };
}

test("notifications: quiet hours hold non-alarms (Console only), alarms override, dedupe, Needs-you, release", async () => {
  const clock = new SimClock("2026-09-26T22:30:00Z");       // 23:30 London (BST)
  const ctx = createContext({ clock });
  let quiet: { hours: { tz: string; windows: { days: ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[]; from: string; to: string }[] } | null; tz: string } =
    { hours: { tz: "Europe/London", windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], from: "22:00", to: "07:00" }] }, tz: "Europe/London" };
  const r = new NotificationRouter(ctx, () => quiet);
  const got: Record<string, NotificationRecord[]> = { console: [], toast: [], sound: [] };
  for (const ch of ["console", "toast", "sound"] as const) r.registerSink(ch, n => { got[ch]!.push(n); return true; });
  assert.equal(r.inQuietHours(), true);
  assert.equal(r.inQuietHours(Date.parse("2026-09-27T05:30:00Z")), true, "06:30 next morning is still inside the wrapped window");
  assert.equal(r.inQuietHours(Date.parse("2026-09-27T06:30:00Z")), false, "07:30");
  const info = await r.notify({ kind: "task_report", title: "Done", body: "Report ready", urgency: "normal" });
  assert.equal(info.status, "held_quiet_hours"); assert.equal(got.toast!.length, 0); assert.equal(got.console!.length, 1);
  const alarm = await r.notify({ kind: "alarm", title: "Alarm", body: "Wake", urgency: "high", channels: ["sound", "toast", "console"] });
  assert.equal(alarm.status, "delivered"); assert.deepEqual(alarm.delivered_channels, ["sound", "toast", "console"]);
  const dec = await r.notify({ kind: "decision", title: "Approve?", body: "x", urgency: "normal", dedupe_key: "d1" });
  assert.equal(dec.status, "needs_you");
  const dup = await r.notify({ kind: "decision", title: "Approve?", body: "x", urgency: "normal", dedupe_key: "d1" });
  assert.equal(dup.status, "deduplicated");
  assert.deepEqual(r.needsYou().map(n => n.id).sort(), [info.id, dec.id].sort());
  // Morning: held items go out once on their interrupting channels.
  clock.set(Date.parse("2026-09-27T06:30:00Z"));
  assert.equal(await r.releaseHeld(), 1);
  assert.equal(got.toast!.filter(n => n.id === info.id).length, 1);
  assert.equal(await r.releaseHeld(), 0);
  r.dismiss(dec.id);
  assert.deepEqual(r.needsYou(), []);
  // No quiet hours configured → everything delivers.
  quiet = { hours: null, tz: "UTC" };
  assert.equal((await r.notify({ kind: "info", title: "i", body: "b", urgency: "low" })).status, "delivered");
});

test("notifications: a crash between claim and delivery is re-delivered at restart; a failing channel doesn't block others", async () => {
  const ctx = createContext({ clock: new SimClock("2026-09-26T12:00:00Z") });
  const r = new NotificationRouter(ctx, () => ({ hours: null, tz: "UTC" }));
  const seen: string[] = [];
  r.registerSink("toast", () => { throw new Error("toast service down"); });
  r.registerSink("console", n => { seen.push(n.id); return true; });
  const q = r.enqueue({ kind: "reminder", title: "t", body: "b", urgency: "normal" });
  ctx.db.prepare("update notifications set status = 'delivering' where id = ?").run(q.id);   // crashed mid-delivery
  assert.equal((await r.flush()).length, 0);
  const out = await r.resumeAfterRestart();
  assert.equal(out[0]!.status, "delivered"); assert.deepEqual(out[0]!.delivered_channels, ["console"]);
  assert.deepEqual(seen, [q.id]);
});

test("JarvisCore: a schedule intent → job; alarm fire → notification in the same commit; missed alarm at startup → 'missed' notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-p7-"));
  const clock = new SimClock("2026-09-26T12:00:00Z");
  const fake = new FakeAdapter("fake:boss", []);
  fake.push({ structured: { intents: [{ kind: "schedule", text: "Wake me at 7 tomorrow", schedule: { kind: "alarm", text: "Wake up", at_local: "2026-09-27T07:00" } }] } });
  let j = new JarvisCore({ dataDir: dir, clock, adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  j.episodic.setProfile(profile([]));
  const reply = await j.conversation.handle({ text: "Wake me at 7 tomorrow", channel: "console_text", owner_verified: true });
  assert.match(reply.replies[0]!, /^Scheduled: Alarm at 07:00 Europe\/London on Sun 27 Sep 2026\.$/);
  const job = j.scheduler.list()[0]!;
  assert.equal(job.next_fire_utc, "2026-09-27T06:00:00.000Z");
  const toasts: NotificationRecord[] = [];
  j.notifications.registerSink("toast", n => { toasts.push(n); return true; });
  clock.set(Date.parse("2026-09-27T06:00:10Z"));
  j.scheduler.tick();
  const n = j.notifications.log().find(x => x.schedule_id === job.schedule_id)!;
  assert.equal(n.kind, "alarm"); assert.equal(n.body, "Wake up");
  await j.notifications.flush();
  assert.equal(toasts.length, 1);
  // A second alarm; the PC is off through it; at restart it becomes a "missed" notice, never a late ring.
  const later = j.scheduler.create({ kind: "alarm", owner_text: "x", tz: "Europe/London", start_local: "2026-09-27T09:00", policy_revision: 0, message: "Meeting" });
  await j.shutdown();
  clock.set(Date.parse("2026-09-27T12:00:00Z"));
  j = new JarvisCore({ dataDir: dir, clock, adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  const missed = j.notifications.log().find(x => x.schedule_id === later.schedule_id)!;
  assert.equal(missed.kind, "missed"); assert.match(missed.title, /Missed alarm at 09:00/);
  assert.equal(j.scheduler.get(later.schedule_id)!.status, "completed");
  await j.shutdown(); rmSync(dir, { recursive: true, force: true });
});

test("JarvisCore: a scheduled task fires as a new task (origin: schedule, authorized afresh); a missed one-shot asks and can be run now", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-p7t-"));
  const clock = new SimClock("2026-09-26T12:00:00Z");
  const fake = new FakeAdapter("fake:boss", [], () => ({ text: "" }));
  fake.push({ structured: { intents: [{ kind: "schedule", text: "Every morning at 8, summarise my notes folder", objective: "Summarise the notes folder", mode: "research", effects: ["read.local"],
    schedule: { kind: "task", text: "Summarise my notes folder", at_local: "2026-09-27T08:00", rrule: "FREQ=DAILY" } }] } });
  const j = new JarvisCore({ dataDir: dir, clock, adapters: [{ adapter: fake, provider: "anthropic", model: "claude-opus-5-5", billing: "api" }] });
  j.start();
  const r = await j.conversation.handle({ text: "Every morning at 8, summarise my notes folder", channel: "console_text", owner_verified: true });
  assert.match(r.replies[0]!, /^Scheduled: Every day at 08:00 UTC, starting Sun 27 Sep 2026\.$/);
  const job = j.scheduler.list()[0]!;
  assert.equal(job.kind, "scheduled_task"); assert.ok(job.target.task_template);
  clock.set(Date.parse("2026-09-27T08:00:05Z"));
  const f = j.scheduler.tick();
  assert.equal(f.length, 1);
  const taskId = /task (tsk_\w+)/.exec(j.scheduler.get(job.schedule_id)!.last_fire!.outcome)![1]!;
  const t = j.tasks.require(taskId);
  assert.equal(t.origin.channel, "schedule"); assert.equal(t.mode, "research");
  assert.deepEqual(t.authorization.basis, [], "no envelope → no standing authority; consequential steps would need you");
  await j.idle();                                   // the fired task's planning runs in the background
  // An unverified channel can't schedule tasks.
  fake.push({ structured: { intents: [{ kind: "schedule", text: "x", schedule: { kind: "task", text: "x", at_local: "2026-09-28T08:00" } }] } });
  const r2 = await j.conversation.handle({ text: "schedule x", channel: "console_voice", owner_verified: false, transcript_confidence: "low" });
  assert.ok(r2.replies.some(x => /verified channel/.test(x)), r2.replies.join(" | "));
  // A one-shot task with an external effect missed by 2 h → "ask"; your "run it" runs it once.
  const one = j.scheduler.create({ kind: "scheduled_task", owner_text: "send it", tz: "UTC", start_local: "2026-09-27T09:00", policy_revision: 0, has_external_effect: true, target: { task_template: job.target.task_template as Record<string, unknown> } });
  clock.set(Date.parse("2026-09-27T11:00:00Z"));
  const g = j.scheduler.tick().find(x => x.schedule.schedule_id === one.schedule_id)!;
  assert.equal(g.action, "ask");
  await j.idle();
  assert.ok(j.notifications.needsYou().some(n => n.schedule_id === one.schedule_id && n.kind === "decision"));
  const ran = j.schedules.runNow(one.schedule_id);
  assert.equal(ran.origin.channel, "schedule");
  assert.throws(() => j.schedules.runNow("sch_nope"), /unknown schedule/);
  await j.shutdown(); rmSync(dir, { recursive: true, force: true });
});

test("review fixes: UNTIL in RFC 5545 forms, WKST=MO for INTERVAL weeks, rules keep firing after years, no date roll-over", async () => {
  const { occurrences } = await import("../src/scheduler/rrule.js");
  const start = parseLocal("2026-09-28T09:00");          // a Monday
  // UNTIL as UTC date-time, as a date, and COUNT+UNTIL together (rejected)
  assert.deepEqual(occurrences(parseRRule("FREQ=DAILY;UNTIL=20260930T075900Z", "Europe/London"), start, null, 10), ["2026-09-28T09:00", "2026-09-29T09:00"], "30 Sep 09:00 BST is after 07:59Z (08:59 BST)");
  assert.equal(occurrences(parseRRule("FREQ=DAILY;UNTIL=20260930T080000Z", "Europe/London"), start, null, 10).length, 3, "UNTIL is inclusive");
  assert.deepEqual(occurrences(parseRRule("FREQ=DAILY;UNTIL=20260930"), start, null, 10), ["2026-09-28T09:00", "2026-09-29T09:00", "2026-09-30T09:00"], "a date-only UNTIL includes that day");
  assert.throws(() => parseRRule("FREQ=DAILY;COUNT=2;UNTIL=20261001"), /both/);
  // Every 2 weeks on Mon and Sun: with Monday week start, Sun 4 Oct belongs to the first week.
  assert.deepEqual(occurrences(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU"), start, null, 4), ["2026-09-28T09:00", "2026-10-04T09:00", "2026-10-12T09:00", "2026-10-18T09:00"]);
  // A daily rule started 6 years ago still produces occurrences now.
  const old = occurrences(parseRRule("FREQ=DAILY"), parseLocal("2020-01-01T07:00"), "2026-09-26T12:00", 1);
  assert.deepEqual(old, ["2026-09-27T07:00"]);
  assert.throws(() => parseLocal("2026-02-30T08:00"), /no such date/);
  assert.throws(() => parseLocal("2026-03-01T24:00"), /no such date/);
});

test("review fixes: fixed instants read in your zone and can be revised; stop() hands the lease over", () => {
  const h = harness("2026-09-26T12:00:00Z");
  const j = h.s.create({ kind: "reminder", owner_text: "call", tz: "Asia/Karachi", at_instant: "2026-09-28T05:00:00Z", policy_revision: 0 });
  assert.match(j.interpretation, /^Reminder at 10:00 Asia\/Karachi on Mon 28 Sep 2026$/);
  const r = h.s.revise(j.schedule_id, { start_local: "2026-09-28T11:30" });
  assert.equal(r.next_fire_utc, "2026-09-28T06:30:00.000Z"); assert.match(r.interpretation, /11:30 Asia\/Karachi/);
  assert.throws(() => h.s.revise(j.schedule_id, { start_local: "2026-09-31T11:30" }), /no such date/);
  assert.equal(h.s.holdsLease(), true);
  const b = new Scheduler(h.ctx, h.leases, () => "x", "sch_b");
  assert.equal(b.holdsLease(), false);
  h.s.stop();
  assert.equal(b.holdsLease(), true, "standby takes over immediately after a clean stop");
});

test("review fix: a notification with nobody to show it to stays pending and is delivered when a client connects", async () => {
  const ctx = createContext({ clock: new SimClock("2026-09-26T12:00:00Z") });
  const r = new NotificationRouter(ctx, () => ({ hours: null, tz: "UTC" }));
  const n = await r.notify({ kind: "alarm", title: "Alarm", body: "Wake up", urgency: "high", channels: ["sound", "console"] });
  assert.equal(n.status, "pending", "no sinks yet → not 'delivered to no one'");
  const got: string[] = [];
  r.registerSink("console", x => { got.push(x.id); return true; });
  const out = await r.flush();
  assert.equal(out[0]!.status, "delivered"); assert.deepEqual(got, [n.id]);
  assert.equal((await r.flush()).length, 0, "delivered once");
});

test("F22: with the database unavailable, alarms sound from the in-memory cache once, and are not repeated when it returns", () => {
  const h = harness("2026-09-26T06:50:00Z");
  const sounded: string[] = [];
  h.s.onCachedAlarm = a => sounded.push(a.message);
  const j = h.s.create({ kind: "alarm", owner_text: "a", tz: "UTC", start_local: "2026-09-26T07:00", rrule: "FREQ=DAILY", policy_revision: 0, message: "Wake up" });
  assert.equal(h.s.holdsLease(), true);
  h.s.refreshAlarmCache();
  const standby = new Scheduler(h.ctx, h.leases, () => "x", "sch_b");
  standby.refreshAlarmCache(); standby.onCachedAlarm = () => assert.fail("a standby must not sound alarms");
  // The database becomes unavailable.
  const realPrepare = h.ctx.db.prepare.bind(h.ctx.db);
  (h.ctx.db as { prepare: unknown }).prepare = () => { throw new Error("SQLITE_IOERR: disk I/O error"); };
  h.clock.set(Date.parse("2026-09-26T07:00:20Z"));
  assert.throws(() => h.s.tick(), /SQLITE_IOERR/);
  assert.deepEqual(h.s.fireFromCache().map(a => a.schedule_id), [j.schedule_id]);
  assert.deepEqual(standby.fireFromCache(), []);
  h.clock.advance(30_000);
  assert.deepEqual(h.s.fireFromCache(), [], "once");
  assert.deepEqual(sounded, ["Wake up"]);
  // The database is back: the occurrence is recorded as fired, not rung again.
  (h.ctx.db as { prepare: unknown }).prepare = realPrepare;
  h.clock.set(Date.parse("2026-09-26T07:02:00Z"));
  assert.equal(h.s.tick().length, 0);
  assert.equal(h.fires.length, 0);
  const rec = h.ctx.db.prepare("select outcome from schedule_fires where schedule_id = ?").all(j.schedule_id) as { outcome: string }[];
  assert.deepEqual(rec.map(r => r.outcome), ["fired_from_cache"]);
  assert.equal(h.s.get(j.schedule_id)!.next_fire_utc, "2026-09-27T07:00:00.000Z");
});
