import { isAbsolute, resolve } from "node:path";
import {
  CONSEQUENTIAL_EFFECTS, MODE_CEILINGS, MODE_FORBIDDEN,
  type AuthorizationEnvelope, type Constraint, type EffectClass, type EvidenceType, type Money, type SuccessCriterion, type TaskMode,
} from "@jarvis/shared";
import type { NewTaskInput } from "../tasks/task-engine.js";
import type { Intent } from "./intents.js";

export const ACCEPTABLE_EVIDENCE: Record<SuccessCriterion["check"]["kind"], EvidenceType[]> = {
  file_exists: ["file_check"], file_content: ["file_check"], service_readback: ["service_readback"],
  confirmation_captured: ["service_confirmation", "service_readback"], tests_pass: ["test_result"],
  postcondition: ["postcondition_observation", "service_readback"], model_judgement: ["model_judgement", "owner_confirmation"], owner_confirmation: ["owner_confirmation"],
};

/** Effects needing an authority source beyond "within scope" (04 §10.5 defaults). */
const NEEDS_AUTHORITY: ReadonlySet<EffectClass> = new Set<EffectClass>(["delete.local", "write.account", "delete.account", "communicate", "publish", "spend", "commit", "access_control", "install", "admin", "execute_code"]);

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/** Every literal in a bound's value must be traceable to the quote, and the quote to the message (04 §10.6 source 1). */
export function groundBound(ownerText: string, quote: string, value: unknown): { ok: boolean; span?: [number, number]; why?: string } {
  const t = norm(ownerText), q = norm(quote);
  if (!q) return { ok: false, why: "no quote" };
  const at = t.indexOf(q);
  if (at < 0) return { ok: false, why: `"${quote}" is not in your message` };
  const literals: string[] = [];
  const walk = (v: unknown) => { if (typeof v === "number") literals.push(String(v)); else if (typeof v === "string") literals.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(value);
  for (const lit of literals) {
    const l = norm(lit);
    const numeric = /^-?\d+(\.\d+)?$/.test(l);
    const found = numeric ? new RegExp(`(^|[^\\d.])${l.replace(".", "\\.")}([^\\d]|$)`).test(q.replace(/,/g, "")) : q.includes(l) || (l.includes("@") && q.includes(l.split("@")[0]!));
    if (!found && !/^[A-Z]{3}$/.test(lit)) return { ok: false, why: `${lit} does not appear in "${quote}"` };
  }
  return { ok: true, span: [at, at + q.length] };
}

export interface BuildInput {
  intent: Intent;
  message: { id: string; text: string; conversation_id: string; channel: "console_text" | "console_voice"; transcript_confidence?: "high" | "medium" | "low" };
  request_text_ref: string;
  default_budget: { amount: Money; kind: "hard" | "soft" };
  hard_requirements?: { source_id: string; text: string }[];
  adapter_id: string;
  now: string;
  policy_revision: number;
  /** Resolves a name or address to a trusted identifier (verified entity), for recipients. */
  resolveRecipient?(nameOrAddress: string): { value: string; entity_id: string } | undefined;
}

export interface BuildOutput { input: NewTaskInput; open_questions: string[]; notes: string[] }

/** Contract Builder (02 §8.2–8.4): defaults, materiality, the ceiling, and a grounded envelope. */
export function buildContract(b: BuildInput): BuildOutput {
  const i = b.intent;
  const notes: string[] = [];
  const mode: TaskMode = i.mode ?? "plan";
  const forbidden = new Set(MODE_FORBIDDEN[mode] ?? []);
  let effects = [...new Set(i.effects ?? [])].filter(e => !forbidden.has(e));
  if (mode !== "execute") effects = effects.filter(e => MODE_CEILINGS[mode].includes(e));
  if (!effects.length) effects = [...MODE_CEILINGS[mode]].filter(e => !forbidden.has(e)) as EffectClass[];
  const constraints: Constraint[] = [];
  const grounding: AuthorizationEnvelope["grounding"] = [];
  const questions = (i.open_questions ?? []).map(q => q.question);
  (i.bounds ?? []).forEach((bd, n) => {
    const id = `b${n + 1}`;
    let value = bd.value;
    const isRecipient = bd.field.startsWith("recipient");
    const namesOnly = isRecipient && (Array.isArray(value) ? value as unknown[] : [value]).some(v => typeof v !== "string" || !v.includes("@"));
    // A name is not an actionable recipient: it must resolve to exactly one verified address (03 §9.8 "Which Dana?").
    let g = namesOnly ? { ok: false as const, why: "a name must resolve to one verified contact" } : groundBound(b.message.text, bd.quote, value);
    // Recipients named by the owner resolve through verified contacts (owner-confirmed memory).
    if (!g.ok && isRecipient && b.resolveRecipient) {
      const names = Array.isArray(value) ? value as string[] : [String(value)];
      const resolved = names.map(n => ({ n, r: b.resolveRecipient!(n) }));
      const quoteOk = norm(b.message.text).includes(norm(bd.quote));
      if (quoteOk && resolved.every(x => x.r && norm(bd.quote).includes(norm(x.n.split("@")[0]!).split(" ")[0]!))) {
        value = resolved.map(x => x.r!.value);
        constraints.push({ id, field: bd.field, op: bd.op, value, source: { kind: "memory", ref: resolved[0]!.r!.entity_id }, hard: true });
        grounding.push({ constraint_id: id, source: { kind: "memory", ref: resolved[0]!.r!.entity_id } });
        return;
      }
    }
    if (!g.ok) {
      notes.push(`Bound on ${bd.field} dropped: ${g.why}`);
      if (effects.some(e => CONSEQUENTIAL_EFFECTS.has(e))) questions.push(`Please confirm the ${bd.field.replace(/\..*/, "")}: I couldn't tie "${bd.quote}" to your words.`);
      return;
    }
    constraints.push({ id, field: bd.field, op: bd.op, value, source: { kind: "owner_message", ref: b.message.id }, hard: true });
    grounding.push({ constraint_id: id, source: { kind: "owner_message", ref: b.message.id, ...(g.span ? { span: g.span } : {}) } });
  });
  // Consequential effects with nothing bounding them: ask rather than assume (materiality test rule 1).
  const needsBound = effects.filter(e => CONSEQUENTIAL_EFFECTS.has(e) || e === "execute_code" || e === "install");
  if (needsBound.length && constraints.length === 0 && mode === "execute") questions.push(`What exactly should I ${needsBound.join("/")}? I need the target (recipient, amount, or item) from you.`);
  // Voice: critical slots from a low-confidence transcript are confirmed first (F25).
  if (b.message.channel === "console_voice" && b.message.transcript_confidence !== "high" && constraints.length)
    questions.push(`I heard: ${constraints.map(c => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join("; ")}. Is that right?`);
  const authorityEffects = effects.filter(e => NEEDS_AUTHORITY.has(e));
  const envelope: AuthorizationEnvelope | undefined = authorityEffects.length ? {
    effects: authorityEffects, bounds: constraints, substitution: "exact_target", grounding,
    derived_by: { adapter: b.adapter_id, at: b.now }, validated_at: b.now,
  } : undefined;
  const criteria: SuccessCriterion[] = (i.success_criteria ?? []).map((c, n) => ({
    id: `c${n + 1}`, description: c.description, check: { kind: c.check_kind, spec: c.spec }, acceptable_evidence: ACCEPTABLE_EVIDENCE[c.check_kind], required: c.required,
  }));
  if (!criteria.length) criteria.push({ id: "c1", description: mode === "advise" || mode === "research" || mode === "plan" ? "Answer delivered to you" : "Requested outcome achieved",
    check: { kind: mode === "execute" ? "owner_confirmation" : "model_judgement", spec: {} }, acceptable_evidence: mode === "execute" ? ["owner_confirmation"] : ["model_judgement", "owner_confirmation"], required: true });
  const scopePaths = (i.scope_paths ?? []).map(p => isAbsolute(p) || /^[A-Za-z]:\\/.test(p) ? p : resolve(p));
  const input: NewTaskInput = {
    origin: { channel: b.message.channel, conversation_id: b.message.conversation_id, message_ids: [b.message.id], owner_verified: true,
      ...(b.message.transcript_confidence ? { transcript_confidence: b.message.transcript_confidence } : {}) },
    request_text_ref: b.request_text_ref, objective: i.objective ?? i.text, mode,
    inputs: [], assumptions: (i.assumptions ?? []).map(a => ({ text: a.text, basis: "inference" as const, source_ids: [], material: a.material })),
    open_questions: questions.map(q => ({ question: q, why_material: "changes an external effect or cannot be inferred", blocks_step_ids: [] })),
    scope: { resources: scopePaths.map(p => ({ path_prefix: p })), accounts: [], exclusions: [] },
    intended_effects: effects,
    constraints: [...constraints, ...(b.hard_requirements ?? []).map((r, n) => ({ id: `req${n + 1}`, field: "requirement", op: "==" as const, value: r.text, source: { kind: "memory" as const, ref: r.source_id }, hard: true }))],
    overrides: [],
    authorization: { basis: envelope ? ["explicit_instruction"] : [], ...(envelope ? { envelope } : {}), grant_ids: [], policy_revision: b.policy_revision },
    success_criteria: criteria,
    budget: { ai_cost_cap: b.default_budget, subscription_usage: "allowed", paid_api_fallback: "never", max_dev_depth: 2, max_attempts_per_gap: 3 },
    ...(i.deadline ? { deadline: i.deadline } : {}),
    retry_policy: "default", cancellation: { on_cancel: "stop_and_report", children: "cancel" },
    required_capabilities: [], dependencies: [], planned_artifacts: [],
    notifications: { progress: "milestones", on_complete: ["console", "toast"], on_decision: ["console", "toast"] },
    memory_plan: { propose_updates: true, retain_task_details: "summary" },
  };
  return { input, open_questions: questions, notes };
}
