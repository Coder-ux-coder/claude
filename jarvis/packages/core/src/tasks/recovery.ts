import type { CoreContext } from "../context.js";
import type { TaskEngine } from "./task-engine.js";
import type { ActionService } from "./actions.js";
import type { LeaseManager } from "./leases.js";

export interface RecoveryHooks {
  /** Policy snapshot loaded? If not, start in safe mode and dispatch nothing (01 §4.5 step 2). */
  policyLoaded(): boolean;
  /** Queue an uncertain action for reconciliation (never a blind retry). */
  enqueueReconciliation?(actionId: string): void;
  /** Re-validate a grant for policy revision and expiry; return false to invalidate. */
  revalidateGrant?(actionId: string): boolean;
  /** Is a process instance from a previous run still alive? */
  processAlive?(processInstance: string): boolean;
  /** Schedules apply missed-run policies; monitors resume (wired in Phase 7). */
  applyMissedRuns?(): { missed: number; fired: number };
  /** Work orders re-attach or restart from checkpoint (wired in Phase 8). */
  reattachWorkOrders?(): { reattached: number; restarted: number };
}

export interface RecoverySummary {
  safe_mode: boolean;
  integrity: string;
  uncertain_actions: string[];
  resumed_tasks: string[];
  invalidated_actions: string[];
  expired_leases: string[];
  missed_runs: { missed: number; fired: number };
  work_orders: { reattached: number; restarted: number };
  message: string;
}

/** Deterministic startup recovery scan (01 §4.5 step 3). */
export function runRecoveryScan(ctx: CoreContext, tasks: TaskEngine, actions: ActionService, leases: LeaseManager, hooks: RecoveryHooks): RecoverySummary {
  const safe_mode = ctx.integrity !== "ok" || !hooks.policyLoaded();
  const summary: RecoverySummary = {
    safe_mode, integrity: ctx.integrity, uncertain_actions: [], resumed_tasks: [], invalidated_actions: [], expired_leases: [],
    missed_runs: { missed: 0, fired: 0 }, work_orders: { reattached: 0, restarted: 0 }, message: "",
  };
  if (ctx.integrity !== "ok") {
    summary.message = "Safe mode: the database failed its integrity check. Nothing will be dispatched. A guided restore is available.";
    return summary;
  }
  ctx.tx(() => {
    // 1. Dispatched without acknowledgement → uncertain, queued for reconciliation.
    for (const a of actions.list({ states: ["dispatched"] })) {
      actions.markUncertain(a.action_id, "recovery scan: dispatched before the restart without an acknowledgement");
      summary.uncertain_actions.push(a.action_id);
    }
    for (const a of actions.list({ states: ["uncertain"] })) hooks.enqueueReconciliation?.(a.action_id);
    // 2. Leases held by dead process instances expire; expired ones too.
    summary.expired_leases = leases.expireStale(pi => !(hooks.processAlive?.(pi) ?? false));
    // 3. Authorized-but-undispatched actions: re-validate grants.
    for (const a of actions.list({ states: ["authorized"] })) {
      if (!(hooks.revalidateGrant?.(a.action_id) ?? true)) {
        actions.invalidate(a.action_id, "recovery scan: grant no longer valid (policy revision or expiry)");
        summary.invalidated_actions.push(a.action_id);
      }
    }
    // 4. Running or verifying tasks resume from their last checkpoint.
    for (const t of tasks.list({ status: ["running", "verifying"] })) {
      // Steps that were running when the process died are re-run only if they have no action in an effect-possible state.
      for (const s of tasks.steps(t.task_id)) {
        if (s.status !== "running") continue;
        const stepActions = actions.list({ taskId: t.task_id }).filter(a => a.step_id === s.step_id);
        const effectPossible = stepActions.some(a => ["dispatched", "acknowledged", "uncertain"].includes(a.state));
        tasks.updateStep(s.step_id, { status: effectPossible ? "waiting" : "ready" });
      }
      tasks.checkpoint(t.task_id, { recovered: true });
      summary.resumed_tasks.push(t.task_id);
    }
  });
  if (!safe_mode) {
    summary.missed_runs = hooks.applyMissedRuns?.() ?? summary.missed_runs;
    summary.work_orders = hooks.reattachWorkOrders?.() ?? summary.work_orders;
  }
  const parts = [
    summary.resumed_tasks.length ? `${summary.resumed_tasks.length} task(s) resumed` : "",
    summary.uncertain_actions.length ? `${summary.uncertain_actions.length} action outcome(s) being checked` : "",
    summary.missed_runs.missed ? `${summary.missed_runs.missed} scheduled item(s) were missed while JARVIS was off` : "",
  ].filter(Boolean);
  summary.message = safe_mode
    ? "Safe mode: rules could not be loaded, so nothing will be dispatched. Memory browsing and alarms still work."
    : parts.length ? `Back online: ${parts.join(", ")}.` : "Back online. Nothing needed recovery.";
  ctx.events.append({ type: "recovery.completed", summary: summary.message, data: { ...summary } });
  return summary;
}
