# 10 · Scheduling, Alarms, Monitoring, and Proactive Assistance

Deliverable 15. It also covers brief §25, §34, and §39. Terms are defined in the [README glossary](README.md#glossary).

---

# 15. Time and attention

## 15.1 Four different things

Scheduling is durable, deterministic software. A model never "remembers to wake up."

| | **Alarm** | **Reminder** | **Scheduled task** | **Monitor** |
|---|---|---|---|---|
| Purpose | Get your attention at an exact time | Surface something at a time | Perform work at a time or on a recurrence | Watch a source and notify on meaningful change |
| Delivery | Sound, notification, speech. Overrides quiet hours. | Notification. Respects quiet hours by default. | Produces an artifact or effect, then a notice if relevant | Notification, digest, or silence |
| Timing precision | Minutes matter | Approximate is fine | Per task | Cadence |
| Missed-run default | Sound if within 10 minutes, otherwise a missed-alarm notice | Deliver late with a "was due at…" note | Run once (coalesce), never a burst | One catch-up run covering the gap |
| Allowed effects | `notify_owner` | `notify_owner` | Its own authorization envelope | Usually `read.*`, `notify_owner`, `write.local` |
| Example | "Alarm at 7." | "Remind me tomorrow afternoon." | "Every weekday, tell me what needs attention." | "Tell me about good Upwork matches." |

## 15.2 Schedules and time semantics

```ts
interface ScheduledJob {
  schedule_id: string;                 // sch_…
  schema: "jarvis.schedule/1";
  kind: "alarm" | "reminder" | "scheduled_task" | "monitor_run";
  owner_intent_text_ref: string;       // what you said // SENSITIVE
  interpretation: string;              // exact and shown to you:
                                       // "Weekdays at 08:30 Europe/London, starting Mon 28 Sep 2026"
  time: {
    semantics: "floating_local" | "fixed_instant";   // wall-clock time in a zone, or an absolute instant
    tz: string;                        // IANA; from the owner profile unless you named a zone
    follow_owner_tz: boolean;          // floating schedules follow you when your profile timezone changes
    start_local?: string;              // "2026-09-26T14:00"
    at_instant?: string;               // for fixed_instant
    rrule?: string;                    // RFC 5545, e.g. "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30"
    until?: string; count?: number;
  };
  dst_policy: { nonexistent: "shift_forward" | "skip"; ambiguous: "first" | "second" };
  missed_run: { policy: "fire_if_within" | "notify_missed" | "coalesce_once" | "skip"; grace?: string };
  delivery: {
    channels: Channel[]; sound?: string; escalate_after?: string;
    respect_quiet_hours: boolean;
    calendar_mirror?: { account_id: string; enabled: boolean };   // §15.4
  };
  target: { capability?: string; params?: unknown; task_template?: Partial<TaskContract>; message?: string };
  authorization: { envelope?: AuthorizationEnvelope; grant_ids: string[];
                   policy_revision_at_creation: number; re_evaluate_on_fire: true };
  wake_system: boolean;                // request an OS wake timer
  os_wake_task_ref?: string;           // Windows Task Scheduler task registered by the Exec Host
  status: "active" | "paused" | "cancelled" | "completed" | "error";
  next_fire_utc?: string;
  last_fire?: { fire_id: string; at: string; outcome: string };
  revision: number; created_from_task_id?: string; created_at: string;
}
```

**Timezone.** The timezone comes **only** from your owner profile, or from a zone you name explicitly ("7 pm New York time"). It is never inferred from language, filenames, or a worker's environment. When you change your profile timezone, for example while travelling, floating schedules with `follow_owner_tz` move with you. JARVIS asks once about any that are ambiguous ("Keep your weekday briefing at 08:30 in the new timezone?").

**Floating versus fixed.** Personal routines are *floating local*: "every weekday at 08:30" stays 08:30 on the wall clock across DST. Things anchored elsewhere are *fixed instants*: "10 minutes before the 15:00 UTC call."

**Recurrence** is computed in local time from the RRULE and converted to UTC. It is recomputed after every fire, after timezone-database updates, after profile timezone changes, and after detected clock changes.

**DST rules.** A local time that does not exist (the spring-forward gap) shifts forward to the first valid instant. A local time that occurs twice (fall back) fires on its **first** occurrence. Example (HYPOTHETICAL, Europe/London): DST ends on Sunday 25 Oct 2026, when 02:00 BST becomes 01:00 GMT. A daily 01:30 reminder fires once that night, at the first 01:30 (BST).

**Clock changes.** JARVIS detects Windows time-change notifications [I] and drift between the monotonic and wall clocks, then recomputes next fires.

**Exactly one scheduler, exactly one fire per occurrence.**

- A database lease row with a fencing token, plus a per-session named mutex [I], ensures a single active scheduler.
- Each occurrence has a deterministic `fire_id = hash(schedule_id, scheduled_local_time, revision)` with a unique constraint. The fire is committed **in the same transaction** as the task or notification it creates, so a crash cannot cause a double fire or a lost fire.

**Timer mechanics.** An event-driven timer is set to the earliest `next_fire_utc`, with no per-second polling, plus a one-minute watchdog. A 24-hour in-memory cache of alarm fires keeps alarms working through a database outage ([03 §9.9](03-memory.md#99-context-builder)).

**Edits by stable ID.** "Make that 8 instead" resolves "that" to the most recently discussed schedule in this conversation, which the Conversation Manager tracks as `last_referenced_schedule_id`. It applies a **revision** to the same `sch_…`. It never creates a second alarm. JARVIS asks only if two schedules are equally plausible.

## 15.3 Missed-run behavior

| Kind | Default policy | Behavior |
|---|---|---|
| Alarm | `fire_if_within` 10 minutes, else `notify_missed` | Never sounds hours late. Instead: "Missed alarm: 07:00. Your PC was asleep." |
| Reminder | `fire_if_within` 24 hours | Delivered late with a note ("was due at 15:00"). Older ones go into the attention view. |
| Recurring scheduled task | `coalesce_once` within a grace window (for example 4 hours for a daily briefing), else skip with a note | Never runs every missed occurrence in a burst |
| Monitor run | `coalesce_once` | One catch-up run whose cursor covers the gap |
| One-shot task with an external effect ("at 17:00, send the draft to Dana") | `fire_if_within` 15 minutes, otherwise **ask** | The time was part of your intent, so JARVIS does not send it late on its own: "It's 19:12. Send now, or reschedule?" |

## 15.4 Delivery depends on the PC's actual state

| PC state | Alarm | Reminder |
|---|---|---|
| On and unlocked | Sound, notification, optional speech | Notification |
| Locked | Sound plays [I]. The notification is visible after unlock. | Waits in "Needs you" |
| Asleep | Fires **only if a wake timer works on this PC**. The PC wakes, JARVIS resumes, the sound plays [U, verified by test]. Otherwise the missed-run policy applies on resume. | Missed-run policy on resume |
| Hibernated | Wake from hibernation is hardware-dependent [U] | Missed-run policy |
| Powered off, signed out, or JARVIS stopped | **Nothing fires.** The missed-run policy applies at the next start. | Same |
| Muted or volume at zero | Sound is inaudible. A visual alert is shown. Optionally JARVIS may unmute for alarms, if you opt in. | — |

**Wake timers.** For schedules with `wake_system`, the Exec Host registers a Windows Task Scheduler task with "Wake the computer to run this task" (`WakeToRun`) [V-S: [ITaskSettings WakeToRun](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itasksettings-get_waketorun)]. The power plan's "Allow wake timers" setting must be **Enable** (or "Important Wake Timers Only"), and it can differ between battery and mains power [V-S]. Microsoft's own forums contain many reports of wake timers not waking machines, so JARVIS never promises a wake.

**The alarm reliability test** (onboarding or Settings): JARVIS schedules a wake two minutes out, you put the PC to sleep, and JARVIS records whether it woke and whether sound played, on battery and on mains power. The result is stored for the device and shown with every alarm, for example: *"This alarm sounds if your PC is on, or asleep on mains power (wake tested ✓ 2 Oct). It will not sound if the PC is off."*

**Backup channel for important reminders.** If your Google Calendar is connected and you authorize `write.account` for it, JARVIS can mirror an important reminder as a calendar event with a pop-up reminder. Your phone then alerts you even when the PC is off. That is your phone's calendar notification, not a JARVIS alarm, and JARVIS says so. A phone-native alarm arrives with the phone app ([09 §14.10](09-interface-and-modalities.md#1410-the-phone-later)).

## 15.5 Monitors

```ts
interface Monitor {
  monitor_id: string;                  // mon_…
  schema: "jarvis.monitor/1";
  name: string; owner_intent_text_ref: string;
  source: { capability: string; account_id?: string; query: unknown; service_policy_ref: string };
  mechanism: "poll" | "push";          // push where the service offers notifications (later, via cloud)
  schedule_id: string;                 // polling cadence, with jitter
  active_hours?: WeeklyHours;
  rate_budget: { max_source_calls_per_day: number; max_model_evals_per_day: number; max_cost_per_day?: Money };
  cursor: MonitorCursor;
  match: {
    hard_filters: PolicyCondition;     // deterministic: exclusions, minimum budget, keywords
    scoring?: { method: "rules" | "model"; criteria_memory_ids: string[]; rubric_ref: string;
                threshold: "high" | "medium" };
  };
  dedup: { key_fields: string[]; seen_retention_days: number };
  notify: {
    policy: "important_only" | "digest" | "all";
    digest_schedule_id?: string;
    quiet_hours: "respect" | "override_for_urgent";
    max_interrupts_per_day: number;
    escalate_when?: PolicyCondition;   // e.g. an application deadline within 24 hours
  };
  allowed_effects: EffectClass[];      // typically [read.account, notify_owner, write.local]
  status: "active" | "paused" | "stopped" | "needs_auth" | "error";
  health: { last_success_at?: string; consecutive_failures: number };
  revision: number; created_from_task_id: string;
}

interface MonitorCursor {
  monitor_id: string;
  position: unknown;                   // e.g. { last_message_id: "...", last_seen_published_at: "..." }
  seen_keys_ref: string;               // keys shown or dismissed, within retention
  updated_at: string; last_run_id: string;
}
```

**A monitor run is deterministic.** A model is used only to score genuinely new items.

1. The schedule fires. A lightweight `run_…` record is created, not a full task unless the run escalates.
2. Authorization (the monitor's own envelope) and health are checked. If a sign-in is needed, the monitor becomes `needs_auth` and you get **one** notice, not one per run.
3. Items since the cursor are fetched through the permitted source.
4. Items are normalized, keyed, and deduplicated against seen keys.
5. Hard filters apply.
6. New candidates are scored within the daily model budget. Scores are cached by item key.
7. The attention model decides (§15.7): high goes to an interrupt within the daily cap, medium goes to the digest, low is recorded only.
8. The cursor, seen keys, run record, and notifications commit **in one transaction**.
9. **No meaningful change means silence.** The run record says "no change," the cursor advances, and nothing else happens.
10. Errors back off. After a threshold of consecutive failures, you get one notice ("The Upwork alert monitor can't read Gmail: it needs sign-in").

**"Stop watching this."** JARVIS resolves the monitor from the focus or reference, sets it to `stopped`, cancels its schedule, drops its pending digest items, and invalidates related future actions. It confirms: *"Stopped watching for Upwork jobs. The 12 matches I already showed you are kept in Results."*

**Visibility.** Tasks → Scheduled and Monitors lists every monitor with its source, cadence, last run, last notification, and budget use. Each can be paused, edited, or stopped individually.

## 15.6 Recurring work keeps its original scope

Every schedule and monitor carries its own authorization envelope, fixed at creation and re-evaluated against current policy at every fire. Widening it ("also apply to the good ones") requires a new explicit instruction, which creates a new revision with a new envelope, subject to normal authorization.

| Recurring permission | Does not imply |
|---|---|
| Monitor new jobs | Applying, spending platform credits, or messaging clients |
| Check prices | Buying |
| Triage your inbox | Replying or deleting |
| Download monthly statements | Paying bills |

## 15.7 Proactive assistance and the attention model

**Where suggestions come from**, and only these sources: project deadlines, commitments, scheduled events (through the calendar connector), explicit monitors, task history (stalled tasks, unanswered decisions, overdue follow-ups), your stated goals, and connected data **within scope**. JARVIS does not watch your screen or read everything to find ideas.

```ts
interface Suggestion {
  suggestion_id: string;               // sug_…
  kind: "deadline_risk" | "follow_up" | "open_loop" | "opportunity" | "maintenance" | "improvement";
  text: string;
  why: string;                         // the reason, in plain words
  evidence_refs: string[];             // cmt_…, tsk_…, mon_… items, ev_…
  proposed_action?: { mode: TaskMode; objective: string; effects: EffectClass[] };
  scores: { urgency: number; relevance: number; usefulness: number; interruption_cost: number };  // internal, relative
  decision: "interrupt" | "digest" | "attention_view" | "drop";
  status: "new" | "shown" | "accepted" | "dismissed" | "snoozed" | "expired";
  created_at: string; expires_at?: string;
}
```

**The attention model.**

- **Urgency**: time until a deadline or due commitment, rising as the deadline nears.
- **Relevance**: the link to active projects and goals, weighted by their priority.
- **Usefulness**: learned *per suggestion kind and source* from your accept and dismiss history over a decaying window. Ignoring follow-up suggestions lowers follow-up suggestions only. It never becomes a broad judgement about you.
- **Interruption cost**: quiet hours, a meeting on your calendar, a full-screen presentation, recent interruptions.
- **Budget**: at most 3 interrupts per day by default, plus digest slots.

Interrupt only when urgency and relevance are high and budget remains outside quiet hours. Moderate items go to the digest. Low ones go to the attention view. Repeatedly dismissed low-urgency kinds are dropped.

**Suggesting is not executing.** A suggestion never acts. Its "Do it" button creates a task that needs normal authority.

**The daily briefing** exists only if you ask for one ("Every weekday, tell me what needs attention"). Gathering is deterministic: commitments due soon, today's calendar, pending decisions, blocked tasks, monitor highlights since the last briefing, budget alerts, skills awaiting your decision. It is then summarized by `boss.fast` under a small budget and delivered as a Console card plus a notification, and spoken if you are at your desk and allow it. Every item links to its evidence.

**"What needs my attention"** shows the same information on demand, at any time.

**Commitments versus casual talk.** Explicit commitments, with a holder, an action, and usually a due time, are tracked ("Remind me to submit this Friday"). "I might learn design someday" is not a commitment. JARVIS may offer, once, "Want me to keep that as a goal?" and does nothing unless you say yes.
