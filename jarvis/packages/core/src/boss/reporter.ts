import type { TaskContract } from "@jarvis/shared";
import type { CriterionVerdict } from "../tasks/task-engine.js";
import type { ActionRecord } from "../tasks/actions.js";

const COMPLETION_WORDS = /\b(done|completed?|finished|booked|sent|paid|delivered|all set|succeeded|successfully|confirmed|submitted|purchased|published|deleted)\b/i;

/** The wording guard (02 §7.7): completion language only when the structured status supports it. */
export function wordingGuard(text: string, status: TaskContract["status"]): { ok: boolean; reason?: string } {
  if (status === "completed") return { ok: true };
  const m = COMPLETION_WORDS.exec(text);
  return m ? { ok: false, reason: `"${m[0]}" is not supported: the task is ${status.replace(/_/g, " ")}` } : { ok: true };
}

const STATUS_LINE: Record<string, string> = {
  completed: "Completed and verified.",
  partially_completed: "Partly finished. Some results are not verified.",
  failed: "I couldn't finish this.",
  cancelled: "Cancelled.",
  blocked: "Blocked: this needs something I can't supply.",
  waiting: "Waiting.",
  running: "In progress.",
  needs_clarification: "I need an answer before I start.",
};

/**
 * Reporter (02 §7.1): reports are generated from task state and evidence, never from
 * model claims. The template is authoritative; optional model prose must pass the guard.
 */
export function buildReport(task: TaskContract, verdicts: CriterionVerdict[], actions: ActionRecord[]): string {
  const lines = [STATUS_LINE[task.status] ?? task.status];
  if (task.status_detail && task.status !== "completed") lines.push(task.status_detail);
  for (const c of task.success_criteria) {
    const v = verdicts.find(x => x.criterion_id === c.id);
    const mark = v?.status === "verified" ? "✓ verified" : v?.status === "unmet" ? "✗ not met" : "• not verified";
    lines.push(`${mark}: ${c.description}${v?.note && v.status !== "verified" ? ` (${v.note})` : ""}`);
  }
  const effects = actions.filter(a => ["verified", "effect_observed", "acknowledged", "compensated"].includes(a.state));
  const uncertain = actions.filter(a => a.state === "uncertain");
  if (effects.length) lines.push(`Changes made: ${effects.map(a => `${a.preview ?? a.capability} (${a.state === "verified" ? "checked" : a.state.replace(/_/g, " ")})`).join("; ")}.`);
  if (uncertain.length) lines.push(`Not yet confirmed: ${uncertain.map(a => a.preview ?? a.capability).join("; ")}. I'm checking before doing anything else.`);
  if (task.status === "cancelled" && !effects.length) lines.push("Nothing was changed.");
  return lines.join("\n");
}
