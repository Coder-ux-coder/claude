import { join } from "node:path";
import { JarvisError, TERMINAL_TASK_STATUSES, type Clock, type TaskContract } from "@jarvis/shared";
import { createContext, type CoreContext } from "./context.js";
import type { KeyProvider, MasterKeyWrapper } from "./crypto/keys.js";
import { TaskEngine } from "./tasks/task-engine.js";
import { ActionService } from "./tasks/actions.js";
import { LeaseManager } from "./tasks/leases.js";
import { runRecoveryScan, type RecoverySummary } from "./tasks/recovery.js";
import { MemoryService } from "./memory/memory-service.js";
import { EpisodicStore } from "./memory/episodic.js";
import { Portability } from "./memory/portability.js";
import { ContextBuilder } from "./context/context-builder.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { CapabilityRegistry } from "./registry/registry.js";
import { CredentialVault } from "./vault/vault.js";
import { AccountStore } from "./vault/accounts.js";
import { EvidenceStore, Verifier } from "./verifier/verifier.js";
import { Broker } from "./broker/broker.js";
import { FilesExecutor } from "./executors/files.js";
import { ShellExecutor } from "./executors/shell.js";
import { WebFetchExecutor } from "./executors/web.js";
import { BUILTIN_CAPABILITIES } from "./executors/builtins.js";
import { ModelGateway, type AdapterRegistration } from "./models/gateway.js";
import { AnthropicAdapter } from "./models/anthropic-adapter.js";
import { Planner } from "./boss/planner.js";
import { StepController, type StepHandlers } from "./boss/step-controller.js";
import { AgentLoop } from "./boss/agent-loop.js";
import { ConversationManager } from "./boss/conversation.js";
import { NotificationRouter } from "./notify/router.js";
import { ScheduleService } from "./scheduler/schedule-service.js";
import type { Scheduler } from "./scheduler/scheduler.js";

export interface JarvisOptions {
  dataDir: string | null;                  // %LOCALAPPDATA%\Jarvis on Windows; null = in-memory
  clock?: Clock;
  keyWrapper?: MasterKeyWrapper;           // synchronous wrapper (dev); on Windows pass `keys` unwrapped via DPAPI
  keys?: KeyProvider;
  bossModel?: string;                      // default claude-opus-5-5 (owner decision)
  bossEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  adapters?: AdapterRegistration[];        // replaces the default Anthropic adapter (tests, offline)
  defaultTaskBudgetUsd?: number;
  stepHandlers?: StepHandlers;
  /** Start the scheduler's timer at start(); tests drive `scheduler.tick()` themselves. */
  runScheduler?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * The Coordinator process's core (01 §3): every module wired with explicit
 * dependencies, the recovery scan at start, and safe mode when rules can't load.
 */
export class JarvisCore {
  readonly ctx: CoreContext;
  readonly tasks: TaskEngine; readonly actions: ActionService; readonly leases: LeaseManager;
  readonly memory: MemoryService; readonly episodic: EpisodicStore; readonly portability: Portability;
  readonly policy: PolicyEngine; readonly registry: CapabilityRegistry; readonly vault: CredentialVault; readonly accounts: AccountStore;
  readonly evidence: EvidenceStore; readonly verifier: Verifier; readonly broker: Broker;
  readonly gateway: ModelGateway; readonly builder: ContextBuilder; readonly planner: Planner; readonly agent: AgentLoop;
  readonly steps: StepController; readonly conversation: ConversationManager;
  readonly notifications: NotificationRouter; readonly schedules: ScheduleService; readonly scheduler: Scheduler;
  recovery!: RecoverySummary;
  private background = new Set<Promise<unknown>>();

  /** Fire-and-forget work that must still finish (or fail visibly) before close. */
  track<T>(p: Promise<T>): void {
    const q = p.catch(e => { if (this.ctx.db.open) this.ctx.events.append({ type: "core.background_error", summary: String((e as Error).message).slice(0, 200), data: {} }); })
      .finally(() => this.background.delete(q));
    this.background.add(q);
  }
  /** Resolves when all tracked background work (task runs, notification delivery) has settled. */
  async idle(): Promise<void> { while (this.background.size) await Promise.all([...this.background]); }

  constructor(readonly opts: JarvisOptions) {
    this.ctx = createContext({ dataDir: opts.dataDir, ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.keyWrapper ? { keyWrapper: opts.keyWrapper } : {}), ...(opts.keys ? { keys: opts.keys } : {}) });
    const ctx = this.ctx;
    this.tasks = new TaskEngine(ctx); this.actions = new ActionService(ctx); this.leases = new LeaseManager(ctx);
    this.tasks.actions = this.actions; this.tasks.leases = this.leases;
    this.memory = new MemoryService(ctx); this.episodic = new EpisodicStore(ctx);
    this.vault = new CredentialVault(opts.dataDir ? join(opts.dataDir, "vault", "vault.bin") : null, ctx.keys, ctx.clock);
    ctx.events.setRedactor(s => this.vault.redactor.redact(s));
    this.accounts = new AccountStore(ctx, this.vault);
    const root = opts.dataDir ?? join(process.cwd(), ".jarvis-dev");
    this.policy = new PolicyEngine(ctx, {
      artifactsRoot: join(root, "artifacts"),
      messageTrust: id => this.episodic.getMessage(id)?.trust,
      memoryRecordTrusted: id => {
        if (id.startsWith("ent_")) { const e = this.memory.entities.get(id); return !!e && e.status === "active" && e.provenance.source_trust === "owner_verified" && e.identifiers.some(i => i.verified); }
        const r = this.memory.get(id); return !!r && r.status === "active" && r.provenance.source_trust === "owner_verified";
      },
    });
    this.portability = new Portability(ctx, this.memory, () => ({ "policy/rules.jsonl": this.policy.listRules() }));
    this.registry = new CapabilityRegistry(ctx, ctx.nodeId);
    this.evidence = new EvidenceStore(ctx); this.verifier = new Verifier(ctx, this.evidence);
    this.broker = new Broker(ctx, this.tasks, this.actions, this.leases, this.policy, this.registry, this.memory, this.vault, this.evidence, this.verifier);
    this.accounts.onRevoked(id => this.broker.onAccountRevoked(id));
    this.broker.registerExecutor(new FilesExecutor(join(root, "recovery-bin"), join(root, "trash")));
    this.broker.registerExecutor(new ShellExecutor());
    this.broker.registerExecutor(new WebFetchExecutor(opts.fetchImpl));
    for (const d of BUILTIN_CAPABILITIES) this.registry.register(d, { via: "builtin" });
    this.gateway = new ModelGateway(ctx);
    const adapters = opts.adapters ?? [{
      adapter: new AnthropicAdapter({ model: opts.bossModel ?? "claude-opus-5-5", effort: opts.bossEffort ?? "medium", ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
        // The API key lives only in the local vault; it is released inside this call and never stored elsewhere.
        withKey: async fn => {
          const cred = this.vault.findByProvider("anthropic");
          if (!cred) throw new (await import("@jarvis/shared")).JarvisError("missing_credential", "no Anthropic API key in the vault");
          return this.vault.use(cred.credential_ref, "model call", fn);
        } }),
      provider: "anthropic", model: opts.bossModel ?? "claude-opus-5-5", billing: "api" as const }];
    for (const a of adapters) this.gateway.register(a);
    if (opts.adapters?.length) for (const role of ["boss.reasoning", "boss.fast", "agent.worker", "vision.interpret", "vision.act"] as const)
      if (!this.gateway.route(role).chain.every(id => this.gateway.adapterIds().includes(id))) this.gateway.setRoute(role, [opts.adapters[0]!.adapter.id], "default");
    this.builder = new ContextBuilder(ctx, this.memory, this.episodic, this.policy);
    this.planner = new Planner(this.gateway, this.registry, this.policy, this.broker, this.tasks);
    this.agent = new AgentLoop(this.gateway, this.registry, this.broker, this.memory, this.evidence);
    this.steps = new StepController(ctx, this.tasks, this.actions, this.leases, this.broker, this.verifier, this.evidence, this.episodic, {
      reason: async (task, step) => {
        const pkg = this.builder.build({ kind: "task", task, text: `${task.objective} ${step.description}` });
        const r = await this.agent.run({ task, step_id: step.step_id, goal: step.description, context: pkg });
        if (r.text && task.origin.conversation_id) this.episodic.addMessage({ conversation_id: task.origin.conversation_id, author: "jarvis", channel: "console", trust: "system", modality: "text", text: r.text });
        return { evidence_ids: r.evidence_ids, text: r.text };
      },
      ...(opts.stepHandlers ?? {}),
    });
    this.notifications = new NotificationRouter(ctx, () => { const p = this.episodic.getProfile(); return { hours: p?.quiet_hours ?? null, tz: p?.timezone ?? "UTC" }; });
    this.schedules = new ScheduleService({ ctx, tasks: this.tasks, notifications: this.notifications, policy: this.policy, episodic: this.episodic,
      adapterId: () => this.gateway.route("boss.reasoning").chain[0] ?? "unknown", defaultTaskBudgetUsd: opts.defaultTaskBudgetUsd ?? 2,
      runTask: t => this.track(this.conversation.planAndRun(t)), track: p => this.track(p) },
      this.leases);
    this.scheduler = this.schedules.scheduler;
    this.conversation = new ConversationManager({ ctx, episodic: this.episodic, memory: this.memory, builder: this.builder, tasks: this.tasks, policy: this.policy, broker: this.broker,
      gateway: this.gateway, planner: this.planner, steps: this.steps, defaultTaskBudgetUsd: opts.defaultTaskBudgetUsd ?? 2,
      schedule: (intent, conv, m) => this.schedules.fromIntent(intent, conv, m), inboxDir: join(root, "artifacts", "inbox") });
  }

  /** Startup (01 §4.5): integrity, policy load, deterministic recovery scan, safe mode if needed. */
  start(): RecoverySummary {
    let policyOk = true;
    try { this.policy.activeRules(); } catch { policyOk = false; }
    this.recovery = runRecoveryScan(this.ctx, this.tasks, this.actions, this.leases, {
      policyLoaded: () => policyOk,
      enqueueReconciliation: id => this.broker.enqueueReconciliation(id),
      revalidateGrant: id => {
        const a = this.actions.get(id);
        const row = a.grant_id ? this.ctx.db.prepare("select decision from grants where decision_id = ?").get(a.grant_id) as { decision: string } | undefined : undefined;
        if (!row) return false;
        return this.policy.verifyGrant(JSON.parse(row.decision), { task_revision: this.tasks.require(a.task_id).revision, fingerprint: a.fingerprint ?? "" }).ok;
      },
      processAlive: () => false,
    });
    this.broker.safeMode = this.recovery.safe_mode;
    this.memory.expireSweep();
    // Missed runs (10 §15.3): recompute from the last fire, then apply each kind's policy once.
    this.scheduler.recomputeAll();
    if (this.opts.runScheduler) this.scheduler.start(); else this.scheduler.tick();
    this.track(this.notifications.resumeAfterRestart());
    return this.recovery;
  }

  // ---------- operations shared by every client (12 §17.6 UI ↔ Coordinator) ----------

  /** Your answer to a decision request; the waiting step gets the outcome, then the task continues. */
  async respondDecision(input: { decision_request_id: string; option_id: string; proposal_fingerprint: string; owner_verified: boolean }): Promise<{ status: string; task_id: string }> {
    const req = this.policy.getDecisionRequest(input.decision_request_id);
    if (!req) throw new JarvisError("invalid_input", `unknown decision request ${input.decision_request_id}`);
    const out = await this.broker.onDecision(input.decision_request_id, input.option_id, input.proposal_fingerprint, input.owner_verified);
    const stepId = req.action_ids.map(id => { try { return this.actions.get(id).step_id; } catch { return null; } }).find(Boolean);
    const step = stepId ? this.tasks.getStep(stepId) : undefined;
    const task = this.tasks.require(req.task_id);
    if (step && step.status === "waiting") {
      await this.steps.applyOutcome(task, step, out);
      this.continueTask(task.task_id);
    }
    return { status: out.status, task_id: req.task_id };
  }

  /** pause / resume / cancel from a client; resume restarts the step loop. */
  controlTask(taskId: string, op: "pause" | "resume" | "cancel"): TaskContract {
    if (op === "pause") return this.tasks.pause(taskId);
    if (op === "cancel") { this.tasks.cancel(taskId); return this.tasks.require(taskId); }
    const t = this.tasks.resume(taskId);
    this.continueTask(taskId);
    return t;
  }

  /** Runs the task loop in the background; a settled task's report goes to its conversation. */
  continueTask(taskId: string): void {
    this.track(this.steps.run(taskId).then(t => {
      const conv = t.origin.conversation_id;
      if (conv && (TERMINAL_TASK_STATUSES.has(t.status) || t.status === "blocked"))
        this.episodic.addMessage({ conversation_id: conv, author: "jarvis", channel: "console", trust: "system", modality: "text", text: this.conversation.report(t.task_id) });
    }));
  }

  /** Emergency stop (09 §14.2): halts dispatch everywhere; resuming needs you. */
  emergencyStop(reason = "emergency stop"): { cancelled: string[] } {
    const r = this.broker.halt(reason);
    this.leases.revoke(l => l.resource.startsWith("desktop:"), "emergency_stop");
    return r;
  }

  static SETTING_KEY = /^(ui|voice|notifications|console)\.[a-z0-9_.]{1,64}$/;
  getSettings(): Record<string, unknown> {
    const rows = this.ctx.db.prepare("select key, value from settings where key not like 'internal.%'").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.filter(r => JarvisCore.SETTING_KEY.test(r.key)).map(r => [r.key, JSON.parse(r.value)]));
  }
  /** Client-editable preferences only; secrets go to the vault, never to settings. */
  setSetting(key: string, value: unknown): void {
    if (!JarvisCore.SETTING_KEY.test(key)) throw new JarvisError("invalid_input", `not a client setting: ${key}`);
    const json = JSON.stringify(value ?? null);
    if (json.length > 4096) throw new JarvisError("invalid_input", "setting value too large");
    if (this.vault.redactor.redact(json) !== json) throw new JarvisError("invalid_input", "that looks like a secret; store it in the vault instead");
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into settings(key, value, updated_at) values (?,?,?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at").run(key, json, this.ctx.clock.iso());
      this.ctx.events.append({ type: "settings.changed", summary: key, data: { key } });
    });
  }

  close(): void { this.scheduler.stop(); this.notifications.close(); this.builder.close(); this.ctx.db.close(); }
  /** Stops timers, waits for background work, then closes. */
  async shutdown(): Promise<void> { this.scheduler.stop(); await this.idle(); this.close(); }
}
