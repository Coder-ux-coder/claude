import type { z } from "zod";
import {
  newId, JarvisError, Budget, UsageLedgerEntry,
  type Money, type NeutralMessage, type ReasoningAdapter, type ReasoningRequest, type ModelRole, type SystemBlock, type ToolSpec, type UsageReport,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { ContextBuilder, type ContextPackage } from "../context/context-builder.js";
import { MODELS, PRICE_TABLE_DATE, estimateCostUsd } from "./price-table.js";

export interface AdapterRegistration {
  adapter: ReasoningAdapter;
  provider: string;                 // "anthropic", "local", …
  model?: string;                   // for price lookups
  billing: "api" | "subscription" | "local";
}

export interface RoleRoute { role: ModelRole; chain: string[]; allow_paid_fallback: boolean; changed_at: string; changed_by: "owner" | "routing_release" | "default" }

export interface CallInput<T> {
  role: ModelRole;
  system: SystemBlock[];
  transcript: NeutralMessage[];
  context?: ContextPackage;
  tools?: ToolSpec[];
  schema?: { zod: z.ZodType<T>; json: Record<string, unknown> };
  max_output_tokens?: number;
  timeout_s?: number;
  task_id?: string;
  work_order_id?: string;
  signal?: AbortSignal;
}

export interface CallResult<T> {
  adapter: string;
  text: string;
  tool_calls: { call_id: string; tool: string; input: unknown }[];
  structured?: T;
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: UsageReport;
  native?: { adapter: string; content: unknown };
  withheld_items: number;
}

const DEFAULT_ROUTES: RoleRoute[] = [
  // Owner decision: the boss runs on Claude Opus 5.5 (switchable by a routing release, F30).
  { role: "boss.reasoning", chain: ["anthropic:claude-opus-5-5"], allow_paid_fallback: false, changed_at: "2026-09-26T00:00:00Z", changed_by: "owner" },
  { role: "boss.fast", chain: ["anthropic:claude-opus-5-5"], allow_paid_fallback: false, changed_at: "2026-09-26T00:00:00Z", changed_by: "default" },
  { role: "agent.worker", chain: ["anthropic:claude-opus-5-5"], allow_paid_fallback: false, changed_at: "2026-09-26T00:00:00Z", changed_by: "default" },
  { role: "vision.interpret", chain: ["anthropic:claude-opus-5-5"], allow_paid_fallback: false, changed_at: "2026-09-26T00:00:00Z", changed_by: "default" },
  { role: "vision.act", chain: ["anthropic:claude-opus-5-5"], allow_paid_fallback: false, changed_at: "2026-09-26T00:00:00Z", changed_by: "default" },
];

/**
 * Model Gateway (06 §11.17, §11.20): every model call goes through here. Routing per
 * role, hard/soft budgets checked BEFORE the call, a usage ledger that never blends
 * actual/estimated/unknown cost, egress filtering, schema validation with one bounded
 * repair, explicit fallback chains, concurrency limits, and lifecycle warnings.
 */
export class ModelGateway {
  private adapters = new Map<string, AdapterRegistration>();
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private ctx: CoreContext, private opts: { maxConcurrent?: number } = {}) {}

  register(r: AdapterRegistration): void { this.adapters.set(r.adapter.id, r); }
  adapterIds(): string[] { return [...this.adapters.keys()]; }

  // ---------- routing ----------
  routes(): RoleRoute[] {
    const r = this.ctx.db.prepare("select value from settings where key = 'model_routing'").get() as { value: string } | undefined;
    return r ? JSON.parse(r.value) as RoleRoute[] : DEFAULT_ROUTES;
  }
  route(role: ModelRole): RoleRoute {
    const r = this.routes().find(x => x.role === role);
    if (!r) throw new JarvisError("unsupported_operation", `no route for ${role}`);
    return r;
  }
  /** A routing change is a release (08 §13.11): recorded, evented, and never widens paid use on its own. */
  setRoute(role: ModelRole, chain: string[], by: RoleRoute["changed_by"], allow_paid_fallback = false): void {
    for (const id of chain) if (!this.adapters.has(id)) throw new JarvisError("invalid_input", `unknown adapter ${id}`);
    const routes = this.routes().filter(r => r.role !== role).concat({ role, chain, allow_paid_fallback, changed_at: this.ctx.clock.iso(), changed_by: by });
    this.ctx.db.prepare("insert into settings(key, value, updated_at) values ('model_routing', ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(routes), this.ctx.clock.iso());
    this.ctx.events.append({ type: "model.route_changed", summary: `${role} → ${chain.join(" → ")}`, data: { role, chain, by } });
  }

  // ---------- budgets (06 §11.20) ----------
  setBudget(b: Omit<Budget, "budget_id"> & { budget_id?: string }): Budget {
    const budget = Budget.parse({ ...b, budget_id: b.budget_id ?? newId("bud", this.ctx.clock.now()) });
    this.ctx.db.prepare("insert into budgets(budget_id, level, ref, budget) values (?,?,?,?) on conflict(budget_id) do update set budget = excluded.budget")
      .run(budget.budget_id, budget.scope.level, budget.scope.ref ?? null, JSON.stringify(budget));
    return budget;
  }
  budgets(): Budget[] {
    return (this.ctx.db.prepare("select budget from budgets").all() as { budget: string }[]).map(r => Budget.parse(JSON.parse(r.budget)));
  }
  private periodStart(period: Budget["period"]): string {
    const d = new Date(this.ctx.clock.now());
    if (period === "day") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    if (period === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    return "0000";
  }
  spent(b: Budget, taskId?: string): number {
    const since = this.periodStart(b.period);
    const where = ["at >= ?", "currency = ?", "kind != 'unknown'"]; const args: unknown[] = [since, b.limit.currency];
    if (b.scope.level === "provider") { where.push("provider = ?"); args.push(b.scope.ref); }
    if (b.scope.level === "task") { where.push("task_id = ?"); args.push(b.scope.ref ?? taskId); }
    if (b.scope.level === "work_order") { where.push("work_order_id = ?"); args.push(b.scope.ref); }
    return (this.ctx.db.prepare(`select coalesce(sum(amount), 0) s from usage_ledger where ${where.join(" and ")}`).get(...args) as { s: number }).s;
  }
  private applicable(reg: AdapterRegistration, taskId?: string, workOrderId?: string): Budget[] {
    return this.budgets().filter(b => b.scope.level === "owner" || (b.scope.level === "provider" && b.scope.ref === reg.provider)
      || (b.scope.level === "task" && taskId && b.scope.ref === taskId) || (b.scope.level === "work_order" && workOrderId && b.scope.ref === workOrderId));
  }

  /** Pre-call enforcement: input estimate × input price + max_output × output price must fit every hard budget. */
  private preCheck(reg: AdapterRegistration, estInputTokens: number, maxOut: number, taskId?: string, workOrderId?: string, taskCap?: { amount: Money; kind: "hard" | "soft" }): number {
    if (reg.billing !== "api") return 0;
    const worst = reg.model ? estimateCostUsd(reg.model, { input: estInputTokens, output: maxOut }) : null;
    if (worst === null) throw new JarvisError("budget_exhausted", `no price on file for ${reg.adapter.id}; metered use needs a price or your approval`);
    const buds = this.applicable(reg, taskId, workOrderId);
    if (taskCap && taskId) buds.push({ budget_id: `task:${taskId}`, scope: { level: "task", ref: taskId }, period: "task", limit: taskCap.amount, kind: taskCap.kind, alert_at: [0.8], fallback: { chain: [], never: [] } });
    for (const b of buds) {
      if (b.limit.currency !== "USD") continue;
      const spent = this.spent(b, taskId);
      if (b.kind === "hard" && spent + worst > b.limit.amount)
        throw new JarvisError("budget_exhausted", `${b.scope.level} budget: ${spent.toFixed(4)} of ${b.limit.amount} ${b.limit.currency} used; this call could cost up to ${worst.toFixed(4)}`, { details: { budget_id: b.budget_id } });
    }
    return worst;
  }
  private alerts(reg: AdapterRegistration, taskId?: string): void {
    for (const b of this.applicable(reg, taskId)) {
      const frac = this.spent(b, taskId) / b.limit.amount;
      for (const th of b.alert_at) if (frac >= th) {
        const r = this.ctx.db.prepare("insert or ignore into budget_alerts(budget_id, period_key, threshold, at) values (?,?,?,?)").run(b.budget_id, this.periodStart(b.period), th, this.ctx.clock.iso());
        if (r.changes) this.ctx.events.append({ type: "budget.alert", summary: `${Math.round(th * 100)}% of the ${b.scope.level} AI budget used`, data: { budget_id: b.budget_id, threshold: th } });
      }
    }
  }

  record(reg: AdapterRegistration, role: string, usage: UsageReport, taskId?: string, workOrderId?: string): UsageLedgerEntry {
    const est = reg.billing === "api" && reg.model && usage.tokens ? estimateCostUsd(reg.model, usage.tokens) : null;
    const entry = UsageLedgerEntry.parse({
      use_id: newId("use", this.ctx.clock.now()), provider: reg.provider, adapter: reg.adapter.id, role, ...(taskId ? { task_id: taskId } : {}), ...(workOrderId ? { work_order_id: workOrderId } : {}),
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(est !== null ? { amount: { amount: Math.round(est * 1e6) / 1e6, currency: "USD" } } : {}),
      kind: reg.billing === "api" ? (est !== null ? "estimated" : "unknown") : reg.billing === "local" ? "actual" : "unknown",
      basis: reg.billing === "api" ? `price table ${PRICE_TABLE_DATE}` : reg.billing === "local" ? "local model: no charge" : "subscription: not exposed",
      at: this.ctx.clock.iso(),
    });
    this.ctx.db.prepare("insert into usage_ledger(use_id, provider, adapter, role, task_id, work_order_id, amount, currency, kind, at, entry) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(entry.use_id, entry.provider, entry.adapter, entry.role, taskId ?? null, workOrderId ?? null, entry.amount?.amount ?? (reg.billing === "local" ? 0 : null), entry.amount?.currency ?? "USD", entry.kind, entry.at, JSON.stringify(entry));
    return entry;
  }

  ledger(filter: { task_id?: string; since?: string } = {}): UsageLedgerEntry[] {
    const where = ["at >= ?"], args: unknown[] = [filter.since ?? "0000"];
    if (filter.task_id) { where.push("task_id = ?"); args.push(filter.task_id); }
    return (this.ctx.db.prepare(`select entry from usage_ledger where ${where.join(" and ")} order by at`).all(...args) as { entry: string }[]).map(r => UsageLedgerEntry.parse(JSON.parse(r.entry)));
  }

  // ---------- lifecycle (F52) ----------
  lifecycleWarnings(withinDays = 60): string[] {
    const out: string[] = [];
    const now = this.ctx.clock.now();
    for (const r of this.routes()) for (const id of r.chain) {
      const reg = this.adapters.get(id);
      const info = reg?.model ? MODELS[reg.model] : undefined;
      if (info?.retirement_not_before && Date.parse(info.retirement_not_before) - now < withinDays * 86_400_000)
        out.push(`${r.role} uses ${info.id}, which may retire from ${info.retirement_not_before}; evaluate a replacement and switch through a routing release.`);
      if (info?.status === "legacy") out.push(`${r.role} uses legacy model ${info.id}.`);
    }
    return [...new Set(out)];
  }

  // ---------- calls ----------
  private async slot(): Promise<() => void> {
    const max = this.opts.maxConcurrent ?? 4;
    if (this.active >= max) await new Promise<void>(res => this.waiters.push(res));
    this.active++;
    return () => { this.active--; this.waiters.shift()?.(); };
  }

  async call<T = unknown>(input: CallInput<T> & { task_cap?: { amount: Money; kind: "hard" | "soft" } }): Promise<CallResult<T>> {
    const route = this.route(input.role);
    const errors: string[] = [];
    let lastErr: JarvisError | undefined;
    for (let i = 0; i < route.chain.length; i++) {
      const reg = this.adapters.get(route.chain[i]!);
      if (!reg) { errors.push(`${route.chain[i]} not registered`); continue; }
      // Never silently move from a subscription or local route to paid API usage (06 §11.16).
      if (i > 0 && reg.billing === "api" && this.adapters.get(route.chain[0]!)?.billing !== "api" && !route.allow_paid_fallback) { errors.push(`${reg.adapter.id}: paid fallback not allowed`); continue; }
      try {
        return await this.callOne(reg, input);
      } catch (e) {
        if (!(e instanceof JarvisError)) throw e;
        lastErr = e;
        errors.push(`${reg.adapter.id}: ${e.code}`);
        if (!["rate_limited", "transient_service_error", "unavailable_device"].includes(e.code) && !(e.code === "invalid_input" && e.message.startsWith("malformed"))) throw e;
      }
    }
    throw lastErr ?? new JarvisError("unsupported_operation", `no adapter could serve ${input.role}: ${errors.join("; ")}`);
  }

  private async callOne<T>(reg: AdapterRegistration, input: CallInput<T> & { task_cap?: { amount: Money; kind: "hard" | "soft" } }): Promise<CallResult<T>> {
    let system = input.system;
    let withheld = 0;
    if (input.context) {
      const f = ContextBuilder.filterForProvider(input.context, reg.provider);
      withheld = f.withheld;
      system = [...system, { kind: "context", text: ContextBuilder.render(f.pkg) }];
    }
    const maxOut = input.max_output_tokens ?? 16_000;
    const estIn = Math.ceil((JSON.stringify(system).length + JSON.stringify(input.transcript).length + JSON.stringify(input.tools ?? []).length) / 3.5);
    this.preCheck(reg, estIn, maxOut, input.task_id, input.work_order_id, input.task_cap);
    let transcript = input.transcript;
    for (let attempt = 0; attempt < 2; attempt++) {
      const release = await this.slot();
      const req: ReasoningRequest = {
        role: input.role, system, context_package_id: input.context?.id ?? "none", transcript,
        ...(input.tools ? { tools: input.tools } : {}), ...(input.schema ? { output_schema: input.schema.json } : {}),
        limits: { max_output_tokens: maxOut, timeout_s: input.timeout_s ?? 120, budget_id: input.task_id ?? "owner" },
        correlation: { ...(input.task_id ? { task_id: input.task_id } : {}), ...(input.work_order_id ? { work_order_id: input.work_order_id } : {}) },
      };
      let text = ""; const tool_calls: CallResult<T>["tool_calls"] = []; let structured: unknown; let stop: CallResult<T>["stop"] = "end";
      let usage: UsageReport = { duration_ms: 0 }; let native: CallResult<T>["native"]; let err: JarvisError | undefined;
      try {
        for await (const ev of reg.adapter.run(req, input.signal ?? new AbortController().signal)) {
          if (ev.type === "text_delta") text += ev.text;
          else if (ev.type === "tool_call") tool_calls.push({ call_id: ev.call_id, tool: ev.tool, input: ev.input });
          else if (ev.type === "structured_output") structured = ev.value;
          else if (ev.type === "usage") usage = ev.usage;
          else if (ev.type === "native") native = ev.native;
          else if (ev.type === "stop") {
            if (ev.reason === "error") err = ev.error ? Object.assign(new JarvisError(ev.error.code, ev.error.message, ev.error), {}) : new JarvisError("internal_error", "adapter error");
            else stop = ev.reason;
          }
        }
      } finally { release(); }
      if (usage.tokens) this.record(reg, input.role, usage, input.task_id, input.work_order_id);
      this.alerts(reg, input.task_id);
      if (err) throw err;
      if (stop === "refusal" || !input.schema) return { adapter: reg.adapter.id, text, tool_calls, stop, usage, ...(native ? { native } : {}), withheld_items: withheld };
      // Structured output: validated deterministically; one bounded repair turn, then fail (F37).
      const parsed = input.schema.zod.safeParse(structured);
      if (parsed.success) return { adapter: reg.adapter.id, text, tool_calls, structured: parsed.data, stop, usage, ...(native ? { native } : {}), withheld_items: withheld };
      this.ctx.events.append({ type: "model.structured_invalid", correlation: input.task_id ? { task_id: input.task_id } : {}, summary: `invalid structured output from ${reg.adapter.id}`, data: { attempt, issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join(".")}: ${i.message}`) } });
      transcript = [...transcript,
        { role: "assistant", content: [{ type: "text", text: typeof structured === "object" ? JSON.stringify(structured).slice(0, 4000) : text.slice(0, 4000) }], ...(native ? { native } : {}) },
        { role: "user", content: [{ type: "text", text: `That output did not match the required schema: ${parsed.error.issues.slice(0, 5).map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}. Reply again with only valid JSON for the schema.` }] }];
    }
    throw new JarvisError("invalid_input", `malformed structured output from ${reg.adapter.id} after a repair attempt; nothing was acted on`);
  }
}
