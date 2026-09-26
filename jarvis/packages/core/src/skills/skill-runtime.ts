import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { CapabilityDescriptor, EffectClass, JarvisError, type NepInvoke } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { Broker } from "../broker/broker.js";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";
import { packageHash } from "../workshop/package.js";
import { riskClass } from "../workshop/validation.js";

/** The subset of the skill manifest (07 §12.3) Skill Runtime v0 uses: workflow skills. */
export const SkillManifest = z.object({
  schema: z.literal("jarvis.skill/1"),
  id: z.string().regex(/^skill:[a-z0-9_.-]+$/),
  name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string(),
  goal_patterns: z.array(z.string()), not_for: z.array(z.string()),
  parameters: z.object({ type: z.literal("object"), required: z.array(z.string()), properties: z.record(z.string(), z.object({ type: z.enum(["string", "number", "integer", "boolean"]), description: z.string().optional() })) }),
  outputs: z.record(z.string(), z.unknown()),
  permissions: z.object({ tier: z.enum(["T1", "T2"]), effects: z.array(EffectClass) }),
  strategy: z.object({ kind: z.literal("workflow"), procedure: z.literal("procedure/workflow.yaml") }),
  risk_class: z.enum(["R0", "R1", "R2", "R3"]),
  provenance: z.object({ created_from_task: z.string().optional(), created_at: z.string() }),
  lifecycle: z.object({ state: z.enum(["draft", "active"]), since: z.string(), reason: z.string() }),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

export const Workflow = z.object({
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string(),
    capability: z.string().regex(/^tool:[a-z0-9_.-]+(@(\^\d+|\d+\.\d+\.\d+))?$/i),
    params: z.record(z.string(), z.unknown()),
  })).min(1).max(50),
});
export type Workflow = z.infer<typeof Workflow>;

const TEMPLATE = /\{\{(params|steps)\.([a-z0-9_]+)(?:\.output((?:\.[A-Za-z0-9_]+)*))?\}\}/gi;

/** {{params.x}} and {{steps.s1.output.a.b}}; a whole-string template keeps the value's type. {{mem:…}} passes through to the Broker. */
export function renderTemplate(v: unknown, env: { params: Record<string, unknown>; steps: Record<string, unknown> }): unknown {
  if (typeof v === "string") {
    const whole = new RegExp(`^${TEMPLATE.source}$`, "i").exec(v);
    const look = (kind: string, name: string, path?: string): unknown => {
      if (kind === "params") { if (!(name in env.params)) throw new JarvisError("invalid_input", `missing skill parameter ${name}`); return env.params[name]; }
      let cur: unknown = env.steps[name];
      if (cur === undefined) throw new JarvisError("invalid_input", `step ${name} has no output yet`);
      for (const k of (path ?? "").split(".").filter(Boolean)) cur = (cur as Record<string, unknown> | undefined)?.[k];
      return cur;
    };
    if (whole) return look(whole[1]!.toLowerCase(), whole[2]!, whole[3]);
    return v.replace(TEMPLATE, (_m, k: string, n: string, p?: string) => String(look(k.toLowerCase(), n, p) ?? ""));
  }
  if (Array.isArray(v)) return v.map(x => renderTemplate(x, env));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderTemplate(x, env)]));
  return v;
}

function replaceLiterals(v: unknown, subs: { name: string; value: string }[]): unknown {
  if (typeof v === "string") {
    const exact = subs.find(s => s.value === v);
    if (exact) return `{{params.${exact.name}}}`;
    let out = v;
    for (const s of [...subs].sort((a, b) => b.value.length - a.value.length)) if (s.value.length >= 3) out = out.split(s.value).join(`{{params.${s.name}}}`);
    return out;
  }
  if (Array.isArray(v)) return v.map(x => replaceLiterals(x, subs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceLiterals(x, subs)]));
  if (typeof v === "number") { const exact = subs.find(s => s.value === String(v)); return exact ? `{{params.${exact.name}}}` : v; }
  return v;
}

function literals(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && !/\{\{(params|steps)\./.test(v)) out.push(v);            // fully fixed values only
  else if (Array.isArray(v)) v.forEach(x => literals(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach(x => literals(x, out));
  return out;
}

/**
 * Skill Runtime v0 (13 §18.2 M1): simple workflow skills. "Save this as a skill" turns a
 * finished task's tool steps into a parameterized, immutable package; running it
 * dispatches every step through the Broker, so each one is authorized on its own and a
 * skill grants nothing by itself (07 §12.1).
 */
export class SkillRuntime implements Executor {
  readonly id = "exec:skill-runtime"; readonly version = "0.1.0";
  capabilities: string[] = [];
  onCapabilitiesChanged: ((e: Executor) => void) | null = null;

  constructor(private ctx: CoreContext, private registry: CapabilityRegistry, private tasks: TaskEngine, private broker: Broker, private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pkgDir(id: string, version: string) { return join(this.dir, id.replace(/^skill:/, ""), version); }

  /** Registers the executor for every skill already on disk (startup). */
  restore(): void {
    for (const d of this.registry.list().filter(x => x.kind === "skill" && x.package.provenance_ref.startsWith("skill-runtime:"))) if (!this.capabilities.includes(d.id)) this.capabilities.push(d.id);
    this.onCapabilitiesChanged?.(this);
  }

  load(id: string, version: string): { manifest: SkillManifest; workflow: Workflow } {
    const dir = this.pkgDir(id, version);
    const d = this.registry.resolve(`${id}@${version}`, { includeAll: true });
    if (!d || !existsSync(dir)) throw new JarvisError("unsupported_operation", `${id}@${version} is not installed`);
    if (packageHash(dir) !== d.package.hash) throw new JarvisError("unsupported_operation", `${id}@${version} failed its integrity check`);
    return { manifest: SkillManifest.parse(parseYaml(readFileSync(join(dir, "skill.yaml"), "utf8"))), workflow: Workflow.parse(parseYaml(readFileSync(join(dir, "procedure", "workflow.yaml"), "utf8"))) };
  }

  /**
   * "Save this as a skill": the task's successful tool steps, in order, with the given
   * literal values turned into parameters. Returns the literals left in the package so you
   * can see nothing personal stayed in it.
   */
  saveFromTask(taskId: string, spec: { slug: string; name: string; description: string; parameters: { name: string; value: string; description?: string; type?: "string" | "number" | "integer" | "boolean" }[]; goal_patterns?: string[] }):
    { manifest: SkillManifest; descriptor: CapabilityDescriptor; remaining_literals: string[] } {
    const task = this.tasks.require(taskId);
    const slug = spec.slug.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) throw new JarvisError("invalid_input", "the skill needs a name");
    for (const p of spec.parameters) if (!/^[a-z][a-z0-9_]*$/.test(p.name)) throw new JarvisError("invalid_input", `bad parameter name ${p.name}`);
    const steps = this.tasks.steps(taskId).filter(s => s.kind === "tool" && s.status === "done" && s.capability && !s.capability.startsWith("gap:"));
    if (!steps.length) throw new JarvisError("invalid_input", "that task has no completed tool steps to save");
    // A compatible range, not the exact version: a later run uses the newest active 1.x (07 §12.9).
    const range = (cap: string) => { const [cid, v] = cap.split("@") as [string, string | undefined]; return v ? `${cid}@^${v.split(".")[0]}` : cid; };
    const workflow: Workflow = { steps: steps.map((s, i) => ({ id: `s${i + 1}`, description: s.description, capability: range(s.capability!), params: replaceLiterals(s.params ?? {}, spec.parameters) as Record<string, unknown> })) };
    Workflow.parse(workflow);
    const effects = [...new Set(steps.flatMap(s => { const d = this.registry.resolve(s.capability!, { includeAll: true }); return d ? d.side_effects.effect_classes : s.effects; }))];
    const id = `skill:${slug}`;
    const existing = this.registry.resolve(id, { includeAll: true });
    const version = existing ? existing.version.replace(/^(\d+)\.(\d+)\.\d+$/, (_m, a: string, b: string) => `${a}.${Number(b) + 1}.0`) : "1.0.0";
    const verified = task.status === "completed";
    const now = this.ctx.clock.iso();
    const manifest: SkillManifest = SkillManifest.parse({
      schema: "jarvis.skill/1", id, name: spec.name, version, description: spec.description, goal_patterns: spec.goal_patterns ?? [spec.name], not_for: [],
      parameters: { type: "object", required: spec.parameters.map(p => p.name), properties: Object.fromEntries(spec.parameters.map(p => [p.name, { type: p.type ?? "string", ...(p.description ? { description: p.description } : {}) }])) },
      outputs: { type: "object", properties: { steps: { type: "object" } } },
      permissions: { tier: "T1", effects }, strategy: { kind: "workflow", procedure: "procedure/workflow.yaml" }, risk_class: riskClass(effects),
      provenance: { created_from_task: taskId, created_at: now },
      lifecycle: verified ? { state: "active", since: now, reason: "saved on your request from a verified task" } : { state: "draft", since: now, reason: "the source task was not verified complete" },
    });
    const dir = this.pkgDir(id, version);
    if (existsSync(dir)) throw new JarvisError("conflict", `${id}@${version} already exists`);
    mkdirSync(join(dir, "procedure"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: ${JSON.stringify(spec.description)}\n---\n\n# ${spec.name}\n\n${spec.description}\n\nSteps:\n${workflow.steps.map(s => `1. ${s.description} (${s.capability})`).join("\n")}\n`);
    writeFileSync(join(dir, "skill.yaml"), toYaml(manifest));
    writeFileSync(join(dir, "procedure", "workflow.yaml"), toYaml(workflow));
    lockDown(dir);
    const hash = packageHash(dir);
    const descriptor = this.registry.register(CapabilityDescriptor.parse({
      id, kind: "skill", version, package: { id: `pkg.${slug}`, version, hash, provenance_ref: `skill-runtime:${taskId}` },
      title: spec.name, purpose: spec.description, goal_patterns: manifest.goal_patterns,
      input_schema: manifest.parameters, output_schema: manifest.outputs,
      prerequisites: { capabilities: [...new Set(workflow.steps.map(s => s.capability.split("@")[0]!))] },
      environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: false, requires_unlocked_desktop: false, network: "local" },
      auth: { type: "none", account_binding: "none" },
      side_effects: { effect_classes: effects, reversibility: effects.some(e => !e.startsWith("read.")) ? "compensable" : "none", idempotency: "none" },
      policy_scopes: [], cost: { kind: "free" }, cancellation: "cooperative", timeouts: { default_s: 600, max_s: 3600 },
      verification: { method: "none", describe: "each step is verified by its own capability" }, evidence_emitted: [], known_limitations: ["steps run in order; outputs are not passed between steps unless templated"],
      isolation_tier: "T1", lifecycle: verified ? "active" : "draft", admin_state: "enabled",
    }), { via: "release_manager" });
    if (!this.capabilities.includes(id)) this.capabilities.push(id);
    this.onCapabilitiesChanged?.(this);
    this.ctx.events.append({ type: "skill.saved", correlation: { task_id: taskId }, summary: `${id}@${version} (${manifest.lifecycle.state})`, data: { skill_id: id, version, steps: workflow.steps.length, risk_class: manifest.risk_class } });
    const used = new Set(spec.parameters.map(p => p.value));
    return { manifest, descriptor, remaining_literals: [...new Set(literals(workflow.steps.map(s => s.params)))].filter(l => !used.has(l)) };
  }

  /** Runs a workflow skill: every step goes through the Broker, pinned to the versions recorded at start (07 §12.9). */
  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const [id, ver] = nep.capability.split("@") as [string, string | undefined];
    const version = ver ?? this.registry.resolve(id)?.version;
    if (!version) throw new JarvisError("unsupported_operation", `${id} is not active`);
    const { manifest, workflow } = this.load(id, version);
    const params = (nep.params ?? {}) as Record<string, unknown>;
    for (const r of manifest.parameters.required) if (!(r in params)) throw new JarvisError("invalid_input", `missing parameter ${r}`);
    for (const [k, v] of Object.entries(params)) {
      const t = manifest.parameters.properties[k]?.type;
      if (!t) throw new JarvisError("invalid_input", `unknown parameter ${k}`);
      if ((t === "string" && typeof v !== "string") || ((t === "number" || t === "integer") && typeof v !== "number") || (t === "boolean" && typeof v !== "boolean")) throw new JarvisError("invalid_input", `${k} must be a ${t}`);
    }
    const pinned = workflow.steps.map(s => { const d = this.registry.require(s.capability); return `${d.id}@${d.version}`; });
    // Check every step whose parameters are already known before running anything: a skill
    // never starts work it can't finish without a decision it didn't ask for.
    for (const [i, s] of workflow.steps.entries()) {
      if (JSON.stringify(s.params).includes("{{steps.")) continue;
      const p = renderTemplate(s.params, { params, steps: {} }) as Record<string, unknown>;
      const pre = this.broker.precheck({ task_id: ectx.task_id, capability: pinned[i]!, params: p });
      if (pre.decision !== "allow") throw new JarvisError("missing_permission", `skill step "${s.description}" ${pre.decision === "deny" ? "isn't allowed" : "needs your decision"}: ${pre.reason}. Nothing was run.`, { effect_state: "none" });
    }
    const outputs: Record<string, unknown> = {};
    const evidence: ExecResult["evidence"] = [];
    for (const [i, s] of workflow.steps.entries()) {
      if (ectx.signal.aborted) throw new JarvisError("cancelled", "skill cancelled");
      const p = renderTemplate(s.params, { params, steps: outputs }) as Record<string, unknown>;
      const r = await this.broker.execute({ task_id: ectx.task_id, capability: pinned[i]!, params: p, requested_by: { kind: "skill", ref: `${id}@${version}` } });
      if (r.status === "waiting_decision") {
        this.broker.withdraw(r.action_id, `skill ${id} stopped: step "${s.description}" needs your decision`);
        throw new JarvisError("missing_permission", `skill step "${s.description}" needs your decision; it was not run`, { effect_state: i === 0 ? "none" : "partial" });
      }
      if (r.status !== "done") {
        const err = r.result.error;
        throw new JarvisError(err?.code ?? "internal_error", `skill step "${s.description}" failed: ${err?.message ?? r.status}`, { effect_state: i === 0 ? (err?.effect_state ?? "none") : "partial" });
      }
      outputs[s.id] = r.result.output;
      evidence.push(...r.result.evidence);
    }
    return { status: "ok", effect_state: manifest.permissions.effects.some(e => !e.startsWith("read.")) ? "complete" : "none", output: { steps: outputs }, evidence };
  }
}

function lockDown(dir: string): void {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { lockDown(p); chmodSync(p, 0o555); } else chmodSync(p, 0o444); }
  chmodSync(dir, 0o555);
}
