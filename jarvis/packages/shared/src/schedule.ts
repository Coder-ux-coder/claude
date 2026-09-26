import { z } from "zod";
import { Channel } from "./primitives.js";
import { AuthorizationEnvelope } from "./task.js";

// Schedules: docs/jarvis/10-time-and-attention.md §15.2

export const ScheduledJob = z.object({
  schedule_id: z.string(),
  schema: z.literal("jarvis.schedule/1"),
  kind: z.enum(["alarm", "reminder", "scheduled_task", "monitor_run"]),
  owner_intent_text_ref: z.string(),
  interpretation: z.string(),
  time: z.object({
    semantics: z.enum(["floating_local", "fixed_instant"]),
    tz: z.string(),
    follow_owner_tz: z.boolean(),
    start_local: z.string().optional(),
    at_instant: z.string().optional(),
    rrule: z.string().optional(),
    until: z.string().optional(), count: z.number().int().positive().optional(),
  }),
  dst_policy: z.object({ nonexistent: z.enum(["shift_forward", "skip"]), ambiguous: z.enum(["first", "second"]) }),
  missed_run: z.object({ policy: z.enum(["fire_if_within", "notify_missed", "coalesce_once", "skip"]), grace: z.string().optional() }),
  delivery: z.object({
    channels: z.array(Channel), sound: z.string().optional(), escalate_after: z.string().optional(),
    respect_quiet_hours: z.boolean(),
    calendar_mirror: z.object({ account_id: z.string(), enabled: z.boolean() }).optional(),
  }),
  target: z.object({ capability: z.string().optional(), params: z.unknown().optional(), task_template: z.record(z.string(), z.unknown()).optional(), message: z.string().optional() }),
  authorization: z.object({ envelope: AuthorizationEnvelope.optional(), grant_ids: z.array(z.string()), policy_revision_at_creation: z.number().int(), re_evaluate_on_fire: z.literal(true) }),
  wake_system: z.boolean(),
  os_wake_task_ref: z.string().optional(),
  status: z.enum(["active", "paused", "cancelled", "completed", "error"]),
  next_fire_utc: z.string().optional(),
  last_fire: z.object({ fire_id: z.string(), at: z.string(), outcome: z.string() }).optional(),
  revision: z.number().int().positive(), created_from_task_id: z.string().optional(), created_at: z.string(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;
