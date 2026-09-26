import { z } from "zod";
import {
  GapReport, JarvisError, newId, sha256, EFFECT_CLASSES,
  type DevWorkOrder, type EffectClass, type PlanStep, type ResolverOption, type StructuredError, type TaskContract,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { ModelGateway } from "../models/gateway.js";
import type { EpisodicStore } from "../memory/episodic.js";
import type { NotificationRouter } from "../notify/router.js";
import type { EvidenceStore } from "../verifier/verifier.js";
import { jsonOf } from "../boss/intents.js";
import type { MissingCapability } from "../boss/planner.js";
import type { HoldoutStore, WorkshopManager, WorkshopOutcome } from "../workshop/workshop.js";
import type { HoldoutCase } from "../workshop/validation.js";

type Classification = GapReport["classification"];

/** Deterministic first classification from the failure (07 §12.15); engineering vs authorization is never left to a model. */
export function classifyFailure(e: Pick<StructuredError, "code" | "message"> & { details?: Record<string, unknown> }): Classification {
  if (e.details && typeof e.details.missing_prerequisite === "string") return "environment";
  switch (e.code) {
    case "missing_permission": return "authorization";
    case "auth_required": case "missing_credential": return "authorization";
    case "external_refusal": return "external_restriction";
    case "unavailable_device": return "hardware";
    case "precondition_changed": case "conflict": case "verification_failed": case "uncertain_external_effect": return "reliability";
    case "transient_service_error": case "rate_limited": case "timeout": return "reliability";
    case "invalid_input": return /no capability|did you mean/i.test(e.message) ? "tool" : "data";
    case "unsupported_operation": return "tool";
    default: return "reliability";
  }
}

const NEVER_BUILD: ReadonlySet<Classification> = new Set(["authorization", "owner_decision", "external_restriction"]);

/** What the boss writes for the builder (the builder never sees the holdout cases). */
export const DevSpecProposal = z.object({
  name: z.string().describe("short snake_case name, e.g. csv_column_stats"),
  title: z.string(), purpose: z.string(), problem: z.string(),
  input_schema: z.record(z.string(), z.unknown()), output_schema: z.record(z.string(), z.unknown()),
  inputs: z.string(), outputs: z.string(),
  negative_cases: z.array(z.string()).min(1),
  fixtures: z.array(z.object({ name: z.string(), content: z.string() })).max(10),
  goal_patterns: z.array(z.string()).max(8),
});
export const HoldoutProposal = z.object({
  cases: z.array(z.object({ name: z.string(), input: z.unknown(), expect: z.object({ status: z.enum(["ok", "error"]), output_equals: z.unknown().optional(),
    output_contains: z.record(z.string(), z.unknown()).optional(), error_code: z.string().optional() }) })).min(3).max(20),
});

const SPEC_SYSTEM = `You write the specification for a small, sandboxed Node.js tool that JARVIS will have a coding worker build.
The tool reads JSON params on stdin and writes one JSON line; it has no network and only the effects listed. Use synthetic example data only — never personal data.
Name it precisely; define strict JSON Schemas; list the negative cases it must handle; give small synthetic fixtures.`;
const HOLDOUT_SYSTEM = `You write hidden acceptance tests (holdout cases) for a tool from its specification alone. The builder will never see them.
Cover normal cases, edge cases and at least one negative case expecting an error with code invalid_input. Use synthetic data. Prefer output_contains over exact equality unless the output is fully determined.`;

export interface GapResolverDeps {
  ctx: CoreContext; tasks: TaskEngine; registry: CapabilityRegistry; gateway: ModelGateway; episodic: EpisodicStore; notifications: NotificationRouter; evidence: EvidenceStore;
  holdouts: HoldoutStore;
  workshop?: WorkshopManager;
  /** Continues a task's loop in the background after its gap is resolved. */
  continueTask(taskId: string): void;
  /** Tracks background work so shutdown can wait for it. */
  track(p: Promise<unknown>): void;
  /** Build cost cap for one gap, USD (estimate; the builder's own usage is reported separately). */
  maxBuildUsd?: number;
}

/**
 * Capability-gap resolver v1 (07 §12.15): classify, search before building, never build
 * around authorization, build through the Workshop with holdouts the builder can't see,
 * and resume the original task at the failed step once the capability is released.
 */
export class GapResolver {
  constructor(private d: GapResolverDeps) {}

  get(gapId: string): GapReport | undefined {
    const r = this.d.ctx.db.prepare("select report from gap_reports where gap_id = ?").get(gapId) as { report: string } | undefined;
    return r ? GapReport.parse(JSON.parse(r.report)) : undefined;
  }
  list(status?: GapReport["status"][]): GapReport[] {
    const rows = this.d.ctx.db.prepare("select report from gap_reports order by created_at desc").all() as { report: string }[];
    return rows.map(r => GapReport.parse(JSON.parse(r.report))).filter(g => !status || status.includes(g.status));
  }
  private save(g: GapReport): void {
    const parsed = GapReport.parse(g);
    this.d.ctx.db.prepare("insert into gap_reports(gap_id, task_id, signature, status, report, created_at) values (?,?,?,?,?,?) on conflict(gap_id) do update set status = excluded.status, report = excluded.report")
      .run(parsed.gap_id, parsed.task_id, parsed.signature, parsed.status, JSON.stringify(parsed), this.d.ctx.clock.iso());
  }

  /** Builds the report: classification, signature, prior gaps, and options. */
  open(task: TaskContract, step: PlanStep, failure: StructuredError & { details?: Record<string, unknown> }, missing?: MissingCapability): GapReport {
    const classification: Classification = step.capability?.startsWith("gap:") ? "tool" : classifyFailure(failure);
    const intent = missing?.intent ?? step.description;
    const signature = sha256(`${intent.toLowerCase().replace(/\s+/g, " ").trim()}|${classification}|${failure.code}|${this.d.ctx.nodeId}`);
    const prior = (this.d.ctx.db.prepare("select gap_id from gap_reports where signature = ?").all(signature) as { gap_id: string }[]).map(r => r.gap_id);
    const options = this.options(classification, intent, failure);
    const g: GapReport = {
      gap_id: newId("gap", this.d.ctx.clock.now()), task_id: task.task_id, step_id: step.step_id,
      intended_step: { description: step.description, capability_intent: intent, effects: step.effects },
      observed_failure: failure, environment: { node_id: this.d.ctx.nodeId, os: process.platform },
      attempted_methods: step.capability && !step.capability.startsWith("gap:") ? [{ method: "tool", capability: step.capability, result: failure.code, evidence_ids: [] }] : [],
      evidence_ids: [], classification,
      minimum_missing_capability: missing ? `${missing.intent} (inputs: ${missing.inputs}; outputs: ${missing.outputs})` : typeof failure.details?.missing_prerequisite === "string" ? `prerequisite: ${failure.details.missing_prerequisite}` : intent,
      signature, options, status: "open", links: { prior_gap_ids: prior },
    };
    this.save(g);
    this.d.ctx.events.append({ type: "gap.opened", correlation: { task_id: task.task_id, step_id: step.step_id }, summary: `${classification}: ${intent}`.slice(0, 200), data: { gap_id: g.gap_id, classification, prior: prior.length } });
    return g;
  }

  private options(c: Classification, intent: string, f: StructuredError & { details?: Record<string, unknown> }): ResolverOption[] {
    const o = (id: string, kind: ResolverOption["kind"], description: string, success_likelihood: ResolverOption["success_likelihood"], reuse_value: ResolverOption["reuse_value"], extra: Partial<ResolverOption> = {}): ResolverOption => ({ id, kind, description, success_likelihood, reuse_value, ...extra });
    switch (c) {
      case "authorization": return f.code === "missing_permission"
        ? [o("o1", "ask_owner", `Ask you: ${f.message}`, "high", "none")]
        : [o("o1", "repair_auth", "Sign in again or add the credential in Settings", "high", "none"), o("o2", "ask_owner", "Ask you how to proceed", "medium", "none")];
      case "owner_decision": return [o("o1", "ask_owner", "Your decision is needed", "high", "none")];
      case "external_restriction": return [o("o1", "report_blocker", `The service refused: ${f.message}. I won't work around its rules.`, "high", "none")];
      case "hardware": return [o("o1", "wait", "Wait for the device or session to be available", "medium", "none"), o("o2", "report_blocker", "Report what is unavailable", "high", "none")];
      case "knowledge": case "data": return [o("o1", "ask_owner", `Ask you for the missing information: ${f.message}`, "high", "none"), o("o2", "retrieve_data", "Look it up where I'm allowed to", "medium", "low")];
      case "environment": return [o("o1", "install_prerequisite", `Install ${String(f.details?.missing_prerequisite ?? "the prerequisite")} (needs your approval)`, "high", "medium", { requires_authority: ["install"] }),
        o("o2", "report_blocker", `Report the exact missing prerequisite: ${String(f.details?.missing_prerequisite ?? f.message)}`, "high", "none")];
      case "reliability": return [o("o1", "alternative_route", "Try another route", "medium", "low"), o("o2", "repair_skill", "Repair the failing capability", "medium", "medium")];
      default: return [o("o1", "use_existing_differently", `Use an existing capability for: ${intent}`, "medium", "high"),
        o("o2", "build_tool", `Build a sandboxed tool for: ${intent}`, "medium", "high", { est_time: "PT30M" }),
        o("o3", "report_blocker", "Report the missing capability with alternatives", "high", "none")];
    }
  }

  private decide(g: GapReport, option: string, reason: string, by: "resolver" | "owner" = "resolver"): void {
    g.decision = { option_id: option, reason, decided_by: by, at: this.d.ctx.clock.iso() };
    this.save(g);
  }

  /**
   * The step controller's gap hook. Returns "waiting_subtask" while a build runs; "blocked"
   * when it needs you or can't be solved here. Never throws into the task loop.
   */
  async onStepGap(task: TaskContract, step: PlanStep, message: string): Promise<"blocked" | "waiting_subtask" | "resolved"> {
    const missing = this.d.episodic.getWorkingState(task.task_id, `gap:${step.step_id}`) as MissingCapability | undefined;
    const failure = new JarvisError("unsupported_operation", message.slice(0, 500)).structured;
    const g = this.open(task, step, failure, missing);
    try {
      if (NEVER_BUILD.has(g.classification)) { this.decide(g, "o1", "authorization and restrictions are never engineered around"); g.status = "blocked"; this.save(g); return "blocked"; }
      if (g.classification !== "tool" && g.classification !== "integration") { this.decide(g, g.options[g.options.length - 1]!.id, "not a tool gap"); g.status = "blocked"; this.save(g); return "blocked"; }
      // Search before building (07 §12.15): the planner already saw the capability list and found
      // nothing, so what counts here is prior work on this exact gap — a tool built for it that is
      // still active (reuse), or a build already under way (wait for it).
      const priors = g.links.prior_gap_ids.map(id => this.get(id)).filter((p): p is GapReport => !!p);
      for (const p of priors.filter(x => x.status === "resolved")) {
        const built = this.builtCapability(p);
        const ptr = built ? this.d.registry.resolve(built) : undefined;
        if (ptr) {
          this.d.tasks.updateStep(step.step_id, { capability: `${ptr.id}@${ptr.version}` });
          g.status = "resolved"; this.decide(g, "o1", `reused ${ptr.id}@${ptr.version}, built for the same gap before`);
          return "resolved";
        }
      }
      const running = priors.find(p => p.status === "resolving");
      if (running) { g.status = "resolving"; g.links.dev_task_id = running.links.dev_task_id; this.decide(g, "o2", `already being built under ${running.gap_id}`); return "waiting_subtask"; }
      if (!this.d.workshop) { this.decide(g, "o3", "the Workshop isn't set up on this PC"); g.status = "blocked"; this.save(g); this.notifyBlocked(task, g, "the Workshop (WSL and a coding worker) isn't set up yet"); return "blocked"; }
      if (!missing) { this.decide(g, "o3", "the missing capability wasn't described precisely enough to build"); g.status = "blocked"; this.save(g); return "blocked"; }
      this.decide(g, "o2", "no existing capability; worth building (reusable)");
      g.status = "resolving"; this.save(g);
      this.d.track(this.build(task, step, g, missing).catch(e => this.fail(task, g, (e as Error).message)));
      return "waiting_subtask";
    } catch (e) {
      g.status = "blocked"; this.save(g);
      this.d.ctx.events.append({ type: "gap.error", correlation: { task_id: task.task_id }, summary: String((e as Error).message).slice(0, 200), data: { gap_id: g.gap_id } });
      return "blocked";
    }
  }

  /** Spec (boss), holdouts (separate call; builder never sees them), dev subtask, Workshop, then resume. */
  private async build(task: TaskContract, step: PlanStep, g: GapReport, missing: MissingCapability): Promise<void> {
    const brief = `Missing capability: ${missing.intent}\nInputs: ${missing.inputs}\nOutputs: ${missing.outputs}\nAllowed effects: ${missing.effects.join(", ") || "none (pure computation)"}\nThe step that needs it: ${step.description}`;
    const spec = await this.d.gateway.call<z.infer<typeof DevSpecProposal>>({ role: "boss.reasoning", task_id: task.task_id, task_cap: task.budget.ai_cost_cap,
      system: [{ kind: "instructions", text: SPEC_SYSTEM, cacheable: true }], transcript: [{ role: "user", content: [{ type: "text", text: brief }] }],
      schema: { zod: DevSpecProposal, json: jsonOf(DevSpecProposal) }, max_output_tokens: 6000 });
    if (!spec.structured) throw new JarvisError("internal_error", "no specification");
    const s = spec.structured;
    const name = s.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    if (!name) throw new JarvisError("invalid_input", "the specification has no usable name");
    const capId = `tool:gen.${name}`;
    const hold = await this.d.gateway.call<z.infer<typeof HoldoutProposal>>({ role: "boss.reasoning", task_id: task.task_id, task_cap: task.budget.ai_cost_cap,
      system: [{ kind: "instructions", text: HOLDOUT_SYSTEM, cacheable: true }],
      transcript: [{ role: "user", content: [{ type: "text", text: `${s.title}: ${s.purpose}\nInput schema: ${JSON.stringify(s.input_schema)}\nOutput schema: ${JSON.stringify(s.output_schema)}\nNegative cases: ${s.negative_cases.join("; ")}` }] }],
      schema: { zod: HoldoutProposal, json: jsonOf(HoldoutProposal) }, max_output_tokens: 6000 });
    if (!hold.structured) throw new JarvisError("internal_error", "no holdout cases");
    this.d.holdouts.put(capId, { set: `${capId}@${g.gap_id}`, cases: hold.structured.cases as HoldoutCase[] });
    // The development subtask, linked to the original (07 §12.15 "preserve and resume").
    const dev = this.d.tasks.create({
      ...stripTask(task), parent_task_id: task.task_id, objective: `Build a tool: ${s.title}`, mode: "build", intended_effects: ["read.local", "write.local", "execute_code"],
      origin: { channel: "system", message_ids: [], owner_verified: false, ...(task.origin.conversation_id ? { conversation_id: task.origin.conversation_id } : {}) },
      authorization: { basis: [], grant_ids: [], policy_revision: task.authorization.policy_revision },
      success_criteria: [{ id: "released", description: `${capId} validated and released`, check: { kind: "tests_pass", spec: { capability_id: capId } }, acceptable_evidence: ["test_result"], required: true }],
      constraints: [], overrides: [], open_questions: [], assumptions: [], planned_artifacts: [], dependencies: [], required_capabilities: [],
    });
    g.links.dev_task_id = dev.task_id; this.save(g);
    this.d.tasks.transition(dev.task_id, "planned", { initiator: "gap_resolver" });
    this.d.tasks.transition(dev.task_id, "running", { initiator: "gap_resolver" });
    const order: DevWorkOrder = {
      work_order_id: newId("wo", this.d.ctx.clock.now()), task_id: dev.task_id, step_id: step.step_id, task_revision: 1, worker_type: "claude_code",
      objective: s.title, context_package_id: `gap:${g.gap_id}`, inputs: [], allowed_capabilities: [], allowed_effects: missing.effects, leases: [],
      budget: { max_wall_time: "PT1H", subscription_allowed: true, paid_fallback: "never", ...(this.d.maxBuildUsd ? { max_cost: { amount: this.d.maxBuildUsd, currency: "USD" } } : {}) },
      output_schema: s.output_schema, verification: { required_evidence: ["test_result"], holdout_ref: `holdout:${capId}` }, policy_revision: task.authorization.policy_revision,
      constraints: ["No network at run time.", "Synthetic data only."], report: { progress: true, questions: "allowed", heartbeat_s: 60 }, capability_token_ref: `gap:${g.gap_id}`,
      dev: {
        problem: s.problem, target: { kind: "tool", capability_id: capId, version_bump: "minor" },
        interface_contract: { contract: "jarvis.capability/1", descriptor_draft: { title: s.title, purpose: s.purpose, goal_patterns: s.goal_patterns }, input_schema: s.input_schema, output_schema: s.output_schema },
        io_expectations: { inputs: s.inputs, outputs: s.outputs, examples_ref: "fixtures/" },
        environment_constraints: { runtime: "node", os: "linux_wsl", network: { build: "none", runtime: "none" } },
        available_dependencies: { allowed_registries: ["https://registry.npmjs.org/"], license_allowlist: ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"] },
        permission_boundaries: { declared_effects: missing.effects.filter((e): e is EffectClass => (EFFECT_CLASSES as readonly string[]).includes(e)), tier: "T2", filesystem: { inputs: "fixtures/", outputs: "out/" } },
        test_requirements: { fixtures_ref: "fixtures/", negative_cases: s.negative_cases, holdout_ref: `holdout:${capId}` },
        artifact_location: "out/", data_policy: { synthetic_only: true }, review: { second_worker: false },
      },
    };
    const outcome = await this.d.workshop!.run(order, { fixtures: Object.fromEntries(s.fixtures.map(f => [f.name.replace(/[^A-Za-z0-9_.-]/g, "_"), f.content])) });
    await this.afterBuild(task.task_id, step.step_id, g.gap_id, outcome);
  }

  /** Released → resume the original at the failed step; approval needed → ask; failed → preserve and report. */
  async afterBuild(taskId: string, stepId: string, gapId: string, outcome: WorkshopOutcome): Promise<void> {
    const g = this.get(gapId)!;
    const task = this.d.tasks.require(taskId);
    const devId = g.links.dev_task_id;
    if (outcome.status === "released" && outcome.release) {
      this.resolveWith(task, stepId, g, outcome.release.capability_id, outcome.release.to_version);
      if (devId) this.settleDev(devId, true, `${outcome.release.capability_id}@${outcome.release.to_version} released`);
      return;
    }
    if (outcome.status === "awaiting_approval") {
      this.d.notifications.enqueue({ kind: "decision", urgency: "normal", title: "A tool I built needs your approval", task_id: taskId,
        body: `To finish "${task.objective}" I built ${outcome.report?.capability_id}. It needs your approval because: ${(outcome.reasons ?? []).join("; ")}. Approve it in Workshop.`, dedupe_key: `wo:${outcome.work_order_id}` });
      void this.d.notifications.flush();
      return;
    }
    const why = outcome.error?.message ?? outcome.reasons?.join("; ") ?? "validation failed";
    this.fail(task, g, why);
    if (devId) this.settleDev(devId, false, why);
  }

  /** After your approval of an awaiting candidate: resume every task waiting on its gap. */
  onReleased(capabilityId: string, version: string): string[] {
    const resumed: string[] = [];
    for (const g of this.list(["resolving"])) {
      const devId = g.links.dev_task_id;
      const wo = devId ? this.d.ctx.db.prepare("select order_json from dev_orders where task_id = ?").get(devId) as { order_json: string } | undefined : undefined;
      if (!wo || (JSON.parse(wo.order_json) as DevWorkOrder).dev.target.capability_id !== capabilityId) continue;
      const task = this.d.tasks.get(g.task_id);
      if (!task) continue;
      this.resolveWith(task, g.step_id, g, capabilityId, version);
      if (devId) this.settleDev(devId, true, `${capabilityId}@${version} released after your approval`);
      resumed.push(task.task_id);
    }
    return resumed;
  }

  /** The capability a resolved gap's build produced. */
  private builtCapability(g: GapReport): string | undefined {
    if (!g.links.dev_task_id) return undefined;
    const wo = this.d.ctx.db.prepare("select order_json from dev_orders where task_id = ? and status = 'released'").get(g.links.dev_task_id) as { order_json: string } | undefined;
    return wo ? (JSON.parse(wo.order_json) as DevWorkOrder).dev.target.capability_id : undefined;
  }

  private resolveWith(task: TaskContract, stepId: string, g: GapReport, capId: string, version: string): void {
    const d = this.d.registry.resolve(`${capId}@${version}`);
    if (!d) return this.fail(task, g, `${capId}@${version} is not active`);
    this.d.tasks.updateStep(stepId, { capability: `${capId}@${version}`, status: "ready" });
    g.status = "resolved"; this.save(g);
    this.d.ctx.events.append({ type: "gap.resolved", correlation: { task_id: task.task_id, step_id: stepId }, summary: `${g.intended_step.capability_intent} → ${capId}@${version}`.slice(0, 200), data: { gap_id: g.gap_id, capability_id: capId, version } });
    const t = this.d.tasks.require(task.task_id);
    if (t.status === "waiting" || t.status === "blocked") {
      this.d.tasks.transition(task.task_id, "running", { initiator: "gap_resolver", detail: `Built ${capId}; continuing` });
      this.d.continueTask(task.task_id);
    }
  }

  private settleDev(devId: string, ok: boolean, note: string): void {
    const dev = this.d.tasks.get(devId);
    if (!dev || dev.status !== "running") return;
    if (!ok) { this.d.tasks.transition(devId, "failed", { initiator: "gap_resolver", detail: note }); return; }
    const ev = this.d.evidence.add({ type: "test_result", claim: note, task_id: devId, source: { capability_id: "core", executor: "workshop" }, data: {} });
    this.d.tasks.transition(devId, "verifying", { initiator: "gap_resolver" });
    this.d.tasks.settle(devId, [{ criterion_id: "released", status: "verified", evidence_ids: [ev.evidence_id] }]);
  }

  private fail(task: TaskContract, g: GapReport, why: string): void {
    const cur = this.get(g.gap_id) ?? g;
    cur.status = "blocked"; this.save(cur);
    const t = this.d.tasks.get(task.task_id);
    // Preserve and report: nothing is labeled a success; the remaining requirement is stated.
    if (t && t.status === "waiting") {
      this.d.tasks.transition(task.task_id, "running", { initiator: "gap_resolver" });
      this.d.tasks.transition(task.task_id, "blocked", { initiator: "gap_resolver", detail: `I couldn't build what this needs (${why}). Still missing: ${cur.minimum_missing_capability}` });
    }
    this.notifyBlocked(task, cur, why);
  }

  private notifyBlocked(task: TaskContract, g: GapReport, why: string): void {
    this.d.notifications.enqueue({ kind: "info", urgency: "normal", task_id: task.task_id, title: "A task is blocked on a missing capability",
      body: `"${task.objective}": ${why}. Still missing: ${g.minimum_missing_capability}.`, dedupe_key: `gap:${g.gap_id}` });
    void this.d.notifications.flush();
  }
}

function stripTask(t: TaskContract) {
  const { task_id: _a, root_task_id: _b, schema: _c, revision: _d, created_at: _e, updated_at: _f, status: _g, wait_reason: _h, status_detail: _i, parent_task_id: _j, deadline: _k, ...rest } = t;
  return rest;
}
