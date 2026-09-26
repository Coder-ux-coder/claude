import { JarvisError, type ScheduledJob, type TaskContract } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { TaskEngine, NewTaskInput } from "../tasks/task-engine.js";
import type { NotificationRouter } from "../notify/router.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { EpisodicStore } from "../memory/episodic.js";
import { buildContract } from "../boss/contract-builder.js";
import type { Intent } from "../boss/intents.js";
import type { ScheduleMessage } from "../boss/conversation.js";
import { Scheduler, type FireOutcome } from "./scheduler.js";
import { isValidZone } from "./tz.js";

export interface ScheduleServiceDeps {
  ctx: CoreContext; tasks: TaskEngine; notifications: NotificationRouter; policy: PolicyEngine; episodic: EpisodicStore;
  adapterId(): string;
  defaultTaskBudgetUsd: number;
  /** Runs a task created by a fire; called after the fire commits. */
  runTask(task: TaskContract): void;
  /** Tracks post-commit async work so shutdown can wait for it. */
  track?(p: Promise<unknown>): void;
}

/**
 * Glue between the Scheduler and the rest of the core (10 §15.2): turns a schedule intent
 * into a ScheduledJob, and turns a fire into what it produces (a notification, a task, or
 * a question), inside the fire's transaction.
 */
export class ScheduleService {
  readonly scheduler: Scheduler;
  private startedTasks: TaskContract[] = [];

  constructor(private d: ScheduleServiceDeps, leases: ConstructorParameters<typeof Scheduler>[1], instance?: string) {
    this.scheduler = new Scheduler(d.ctx, leases, f => this.onFire(f), instance);
    this.scheduler.afterTick = () => { const p = this.afterTick(); if (d.track) d.track(p); else void p.catch(() => {}); };
  }

  ownerTz(): string {
    const tz = this.d.episodic.getProfile()?.timezone;
    return tz && isValidZone(tz) ? tz : "UTC";
  }

  /** The conversation's `schedule` intent: create the job and say exactly what was understood. */
  async fromIntent(intent: Intent, conversationId: string, m: ScheduleMessage): Promise<string> {
    const s = intent.schedule;
    if (!s) return "What should I schedule, and when?";
    if (!s.at_local) return `When should I ${s.kind === "alarm" ? "set the alarm for" : s.kind === "reminder" ? "remind you" : "do that"}?`;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s.at_local)) return `I didn't understand the time "${s.at_local}". Please give a date and time.`;
    const tz = s.tz ?? this.ownerTz();
    if (!isValidZone(tz)) return `I don't know the timezone "${tz}".`;
    if (!m.owner_verified && s.kind === "task") return "I can only schedule tasks from a verified channel.";
    try {
      let job: ScheduledJob;
      if (s.kind === "task") {
        const built = buildContract({ intent: { ...intent, kind: "new_task", objective: intent.objective ?? s.text }, message: { id: m.id, text: m.text, conversation_id: conversationId, channel: m.channel,
          ...(m.transcript_confidence ? { transcript_confidence: m.transcript_confidence } : {}) }, request_text_ref: m.content_ref,
          default_budget: { amount: { amount: this.d.defaultTaskBudgetUsd, currency: "USD" }, kind: "hard" }, adapter_id: this.d.adapterId(), now: this.d.ctx.clock.iso(),
          policy_revision: this.d.policy.currentRevision() });
        if (built.open_questions.length) return `Before I schedule it: ${built.open_questions.join(" ")}`;
        const consequential = built.input.intended_effects.some(e => !e.startsWith("read.") && e !== "write.local" && e !== "notify_owner");
        job = this.scheduler.create({ kind: "scheduled_task", owner_text: m.text, tz, start_local: s.at_local, ...(s.rrule ? { rrule: s.rrule } : {}),
          target: { task_template: stripForTemplate(built.input) }, ...(built.input.authorization.envelope ? { envelope: built.input.authorization.envelope } : {}),
          policy_revision: this.d.policy.currentRevision(), has_external_effect: consequential && !s.rrule });
      } else {
        job = this.scheduler.create({ kind: s.kind, owner_text: m.text, tz, start_local: s.at_local, ...(s.rrule ? { rrule: s.rrule } : {}), message: s.text,
          policy_revision: this.d.policy.currentRevision() });
      }
      return `Scheduled: ${job.interpretation}.`;
    } catch (e) {
      if (e instanceof JarvisError) return `I couldn't schedule that: ${e.message}.`;
      throw e;
    }
  }

  /**
   * Your answer to "run the missed task now?" (or a Console "run now"): one run from the
   * template, authorized afresh; the schedule itself is unchanged.
   */
  runNow(scheduleId: string): TaskContract {
    const j = this.scheduler.get(scheduleId);
    if (!j) throw new JarvisError("invalid_input", `unknown schedule ${scheduleId}`);
    if (j.kind !== "scheduled_task" && j.kind !== "monitor_run") throw new JarvisError("invalid_input", "only scheduled tasks can be run now");
    const task = this.d.ctx.tx(() => {
      const t = this.taskFromTemplate(j);
      this.d.ctx.events.append({ type: "schedule.run_now", summary: j.interpretation, data: { schedule_id: j.schedule_id, task_id: t.task_id } });
      return t;
    });
    this.d.runTask(task);
    return task;
  }

  private taskFromTemplate(j: ScheduledJob): TaskContract {
    const tpl = j.target.task_template as NewTaskInput | undefined;
    if (!tpl) throw new JarvisError("invalid_input", "this schedule has no task to run");
    return this.d.tasks.create({
      ...tpl,
      origin: { channel: j.kind === "monitor_run" ? "monitor" : "schedule", message_ids: [], owner_verified: tpl.origin.owner_verified, ...(tpl.origin.conversation_id ? { conversation_id: tpl.origin.conversation_id } : {}) },
      request_text_ref: j.owner_intent_text_ref,
      // The owner's scheduled intent is an authority source only when it carried a grounded envelope; everything is re-checked at dispatch.
      authorization: { ...tpl.authorization, basis: tpl.authorization.envelope ? ["schedule_owner_intent"] : [], policy_revision: this.d.policy.currentRevision() },
    });
  }

  /** Runs inside the fire transaction; must be synchronous and must not throw for ordinary failures. */
  private onFire(f: FireOutcome): string {
    const j = f.schedule;
    const due = f.scheduled_local.slice(11, 16);
    const base = { schedule_id: j.schedule_id, dedupe_key: f.fire_id };
    if (f.action === "skip") return f.coalesced ? `skipped (${f.coalesced + 1} missed)` : "skipped";
    if (f.action === "notify_missed") {
      this.d.notifications.enqueue({ ...base, kind: "missed", urgency: "normal", title: `Missed ${label(j)} at ${due}`,
        body: `${j.target.message ?? j.interpretation}${f.coalesced ? ` (${f.coalesced + 1} occurrences while I was off)` : ""}` });
      return "missed, told you";
    }
    if (f.action === "ask") {
      this.d.notifications.enqueue({ ...base, kind: "decision", urgency: "normal", title: `Run the ${due} task now?`,
        body: `"${j.interpretation}" was due at ${due} and I was off. Its timing may matter, so I haven't run it. Reply "run it" or "skip it".` });
      return "asked you";
    }
    const late = f.action === "fire_late" ? ` (due at ${due})` : "";
    if (j.kind === "alarm" || j.kind === "reminder") {
      this.d.notifications.enqueue({ ...base, kind: j.kind, urgency: j.kind === "alarm" ? "high" : "normal", title: j.kind === "alarm" ? "Alarm" : "Reminder",
        body: `${j.target.message ?? j.interpretation}${late}`, channels: j.delivery.channels, respect_quiet_hours: j.delivery.respect_quiet_hours,
        ...(j.delivery.sound ? { sound: j.delivery.sound } : {}) });
      return f.action === "fire" ? "delivered" : "delivered late";
    }
    // scheduled_task / monitor_run: a new task from the template, authorized afresh at every step (re_evaluate_on_fire).
    try {
      const task = this.taskFromTemplate(j);
      this.startedTasks.push(task);
      return `task ${task.task_id}${late}`;
    } catch (e) {
      this.d.notifications.enqueue({ ...base, kind: "info", urgency: "normal", title: "A scheduled task couldn't start", body: `${j.interpretation}: ${(e as Error).message}`.slice(0, 300) });
      return `error: ${(e as Error).message}`.slice(0, 200);
    }
  }

  private async afterTick(): Promise<void> {
    const started = this.startedTasks.splice(0);
    for (const t of started) this.d.runTask(t);
    await this.d.notifications.flush();
  }
}

function label(j: ScheduledJob): string {
  return j.kind === "alarm" ? "alarm" : j.kind === "reminder" ? "reminder" : j.kind === "monitor_run" ? "check" : "task";
}

/** The part of a contract that is re-used at every fire; origin and authorization are rebuilt then. */
function stripForTemplate(i: NewTaskInput): Record<string, unknown> {
  const { deadline: _d, ...rest } = i;
  return rest as unknown as Record<string, unknown>;
}
