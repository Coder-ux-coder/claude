import {
  newId, hashObject, JarvisError,
  type EffectClass, type EgressPolicy, type MemoryRecord, type Sensitivity, type TaskContract, type PreferenceContent,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { MemoryService } from "../memory/memory-service.js";
import type { EpisodicStore } from "../memory/episodic.js";

/** What the Policy Engine gives the Context Builder: every rule applicable by structure, never by relevance. */
export interface PolicyReader {
  currentRevision(): number;
  applicableRules(d: { effects: EffectClass[]; capabilities: string[]; entity_ids: string[]; project_id?: string; resources?: string[]; at: string }):
    { rule_id: string; revision: number; kind: string; decision: string; text: string; protection: string }[];
}

export interface ContextDescriptor {
  kind: "turn" | "task" | "work_order";
  task?: TaskContract;
  text?: string;                         // the owner's message or the task objective
  conversation_id?: string;
  entity_ids?: string[];
  project_id?: string;
  effects?: EffectClass[];
  capabilities?: string[];
  goal_class?: string;
  worker_type?: "agent" | "codex" | "claude_code";
  budget_tokens?: number;
  at?: string;
}

export interface ContextItem {
  tag: string;                           // "[mem_T3 r1 · stated · owner_verified]"
  text: string;
  source_id?: string; revision?: number;
  sensitivity: Sensitivity; egress: EgressPolicy;
  warning?: string;
  placeholder?: boolean;
}
export interface ContextSection { name: string; mandatory: boolean; priority: number; items: ContextItem[] }
export interface ContextPackage {
  id: string; created_at: string;
  descriptor_hash: string;
  sections: ContextSection[];
  version_vector: Record<string, number>;
  policy_revision: number; task_revision: number | null;
  tokens: number; omitted: Record<string, number>;
  hard_constraints: { source_id: string; text: string }[];
  egress_target?: string;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
const SYSTEM_EGRESS: EgressPolicy = { policy: "any_approved_provider" };

function tagFor(r: MemoryRecord): string {
  return `[${r.id} r${r.revision} · ${r.provenance.origin} · ${r.provenance.source_trust}]`;
}

/**
 * Context Builder (03 §9.9): describe → core (persona, profile, applicable rules) →
 * resolve (scoped preferences, requirements, commitments) → search (experiences,
 * lessons) → check (freshness, trust) → pack under budget (mandatory sections never
 * dropped) → tag every item. Fails closed with policy_unavailable.
 */
export class ContextBuilder {
  static MAX_AGE_MS = 5 * 60_000;
  private cache = new Map<string, ContextPackage & { task_id?: string }>();
  private listeners: ((taskIds: string[]) => void)[] = [];
  private unsubscribe: () => void;

  constructor(private ctx: CoreContext, private memory: MemoryService, private episodic: EpisodicStore, private policy: PolicyReader) {
    this.unsubscribe = ctx.events.subscribe(ctx.events.lastSeq(), e => this.onEvent(e.type, e.data));
  }
  close(): void { this.unsubscribe(); }

  onInvalidate(fn: (taskIds: string[]) => void): void { this.listeners.push(fn); }

  private onEvent(type: string, data: Record<string, unknown>): void {
    if (type !== "memory.changed" && type !== "policy.revised" && type !== "task.revised" && type !== "profile.changed") return;
    // Any memory change can add a record that matches a cached descriptor (not only change an
    // included one), and policy, task or profile changes affect every package, so all cached
    // packages are dropped. This is a strict superset of what 03 §9.9 requires.
    void data;
    const affected: string[] = [];
    for (const [k, p] of this.cache) { this.cache.delete(k); if (p.task_id) affected.push(p.task_id); }
    if (affected.length) {
      const uniq = [...new Set(affected)];
      this.ctx.events.append({ type: "context.invalidated", summary: `${uniq.length} task context package(s) invalidated`, data: { task_ids: uniq, cause: type } });
      for (const l of this.listeners) l(uniq);
    }
  }

  build(d: ContextDescriptor): ContextPackage {
    const at = d.at ?? this.ctx.clock.iso();
    let policyRevision: number;
    let rules: ReturnType<PolicyReader["applicableRules"]>;
    const effects = d.effects ?? d.task?.intended_effects ?? [];
    const entity_ids = d.entity_ids ?? [];
    try {
      policyRevision = this.policy.currentRevision();
      rules = this.policy.applicableRules({ effects, capabilities: d.capabilities ?? [], entity_ids, ...(d.project_id ? { project_id: d.project_id } : {}), at });
    } catch (e) {
      throw new JarvisError("policy_unavailable", `rules cannot be loaded, so no context is built: ${(e as Error).message}`);
    }
    const descriptor_hash = hashObject({ ...d, task: d.task ? { id: d.task.task_id, rev: d.task.revision } : null, at: d.at ? at : null });
    const cacheKey = `${descriptor_hash}|${d.task?.revision ?? ""}|${policyRevision}`;
    const cached = this.cache.get(cacheKey);
    // Validity windows pass with time even without an event, so packages also age out.
    if (cached && this.ctx.clock.now() - Date.parse(cached.created_at) < ContextBuilder.MAX_AGE_MS) return cached;

    const minimalWorker = d.kind === "work_order" && (d.worker_type === "codex" || d.worker_type === "claude_code");
    const sections: ContextSection[] = [];
    const version_vector: Record<string, number> = {};
    const hard_constraints: { source_id: string; text: string }[] = [];
    const memItem = (r: MemoryRecord, extra: Partial<ContextItem> = {}): ContextItem => {
      version_vector[r.id] = r.revision;
      return { tag: tagFor(r), text: r.text, source_id: r.id, revision: r.revision, sensitivity: r.sensitivity, egress: r.egress,
        ...(r.provenance.origin === "inferred" ? { warning: "inferred, not stated" } : {}), ...(r.status === "disputed" ? { warning: "disputed" } : {}), ...extra };
    };

    // 2. Core: persona and profile digest (not for coding workers), applicable rules (always).
    const profile = this.episodic.getProfile();
    if (profile && !minimalWorker) {
      sections.push({ name: "persona", mandatory: true, priority: 100, items: [{ tag: "[profile]", sensitivity: "personal", egress: SYSTEM_EGRESS,
        text: `You are ${profile.assistant.name}, assistant to ${profile.display_name}. Tone: ${profile.assistant.tone}; verbosity: ${profile.assistant.verbosity}. Owner timezone ${profile.timezone}, locale ${profile.locale}, units ${profile.units}.` }] });
    }
    sections.push({ name: "rules", mandatory: true, priority: 100, items: rules.map(r => ({
      tag: `[${r.rule_id} r${r.revision} · ${r.kind}${r.protection === "protected" ? " · protected" : ""}]`, text: `${r.text} (decision: ${r.decision})`,
      source_id: r.rule_id, revision: r.revision, sensitivity: "personal" as const, egress: SYSTEM_EGRESS })) });
    if (d.task) {
      const t = d.task;
      const lines = [`Objective: ${t.objective}`, `Mode: ${t.mode}; allowed effects: ${t.intended_effects.join(", ") || "none"}`,
        ...t.constraints.map(c => `Constraint ${c.id}: ${c.field} ${c.op} ${JSON.stringify(c.value)}${c.hard ? " (hard)" : ""}`),
        ...t.success_criteria.map(c => `Criterion ${c.id}${c.required ? " (required)" : ""}: ${c.description}`),
        ...t.overrides.map(o => `Override for this task only: ${o.target.kind} ${o.target.ref} -> ${JSON.stringify(o.replacement)}`)];
      sections.push({ name: "task", mandatory: true, priority: 100, items: [{ tag: `[${t.task_id} rev ${t.revision}]`, text: lines.join("\n"), sensitivity: "personal", egress: SYSTEM_EGRESS }] });
    }

    // 3. Resolve scoped preferences; requirements become hard constraints.
    if (!minimalWorker) {
      const resolved = this.memory.resolvePreferences({ entity_ids, ...(d.project_id ? { project_id: d.project_id } : {}), ...(d.task ? { task_id: d.task.task_id } : {}), at });
      const overridden = new Set((d.task?.overrides ?? []).filter(o => o.target.kind === "preference").map(o => o.target.ref));
      const reqs: ContextItem[] = [], prefs: ContextItem[] = [];
      for (const p of resolved) {
        if (overridden.has(p.winner.id)) continue;               // task override wins; memory untouched
        const content = p.winner.content as PreferenceContent;
        if (content.kind === "requirement" && p.winner.status === "active") {
          reqs.push(memItem(p.winner)); hard_constraints.push({ source_id: p.winner.id, text: p.winner.text });
        } else prefs.push(memItem(p.winner));
      }
      if (reqs.length) sections.push({ name: "requirements", mandatory: true, priority: 100, items: reqs });
      if (prefs.length) sections.push({ name: "preferences", mandatory: false, priority: 80, items: prefs });
      const commitments = entity_ids.flatMap(e => this.episodic.openCommitments({ entity_id: e }))
        .concat(d.project_id ? this.episodic.openCommitments({ project_id: d.project_id }) : []);
      const uniq = [...new Map(commitments.map(c => [c.id, c])).values()];
      if (uniq.length) sections.push({ name: "commitments", mandatory: false, priority: 60, items: uniq.map(c => ({ tag: `[${c.id} r${c.revision}]`, text: `${c.text}${c.due ? ` (due ${c.due.local} ${c.due.tz})` : ""}`, source_id: c.id, revision: c.revision, sensitivity: "personal", egress: SYSTEM_EGRESS })) });
      for (const c of uniq) version_vector[c.id] = c.revision;
    }

    // 4. Search experiences (successes and failures) for the goal.
    const q = d.goal_class ?? d.text ?? d.task?.objective ?? "";
    if (q && d.kind !== "turn") {
      const exps = this.episodic.searchExperiences(q, { limit: 5 });
      if (exps.length) sections.push({ name: "experiences", mandatory: false, priority: 50, items: exps.map(x => ({ tag: `[${x.record.id} · ${x.record.outcome}]`,
        text: `${x.record.goal_class}: ${x.summary}`, source_id: x.record.id, sensitivity: x.record.sensitivity, egress: SYSTEM_EGRESS })) });
    }
    // Relevant facts by search (active only; external-content facts only when task/project scoped, already enforced at write).
    if (q && !minimalWorker) {
      const facts = this.memory.search(q, { limit: 8, at }).filter(r => r.type === "fact" && !(r.id in version_vector));
      if (facts.length) sections.push({ name: "facts", mandatory: false, priority: 40, items: facts.map(r => memItem(r)) });
    }
    // Recent conversation window for turns.
    if (d.kind === "turn" && d.conversation_id) {
      const msgs = this.episodic.recentMessages(d.conversation_id, 12);
      if (msgs.length) sections.push({ name: "conversation", mandatory: false, priority: 90, items: msgs.map(m => ({ tag: `[${m.id} · ${m.author} · ${m.trust}]`,
        text: this.safeText(m.id), sensitivity: "personal" as const, egress: SYSTEM_EGRESS })) });
    }

    // 6. Pack under budget.
    const budget = d.budget_tokens ?? 6000;
    const mandatoryTokens = sections.filter(s => s.mandatory).reduce((n, s) => n + s.items.reduce((m, i) => m + estimateTokens(i.tag + i.text), 0), 0);
    if (mandatoryTokens > budget)
      throw new JarvisError("invalid_input", `the rules and constraints alone need ~${mandatoryTokens} tokens, over the ${budget}-token budget; split the task or raise the budget`);
    let used = mandatoryTokens;
    const omitted: Record<string, number> = {};
    for (const s of [...sections].filter(s => !s.mandatory).sort((a, b) => b.priority - a.priority)) {
      const kept: ContextItem[] = [];
      for (const it of s.items) {
        const t = estimateTokens(it.tag + it.text);
        if (used + t <= budget) { kept.push(it); used += t; } else omitted[s.name] = (omitted[s.name] ?? 0) + 1;
      }
      s.items = kept;
      const dropped = omitted[s.name];
      if (dropped) s.items.push({ tag: "[omitted]", text: `${dropped} more ${s.name} item(s) did not fit; use memory.search to retrieve them.`, sensitivity: "normal", egress: SYSTEM_EGRESS });
    }
    const pkg: ContextPackage & { task_id?: string } = {
      id: newId("ctx", this.ctx.clock.now()), created_at: this.ctx.clock.iso(), descriptor_hash,
      sections: sections.filter(s => s.mandatory || s.items.length), version_vector, policy_revision: policyRevision,
      task_revision: d.task?.revision ?? null, tokens: used, omitted, hard_constraints, ...(d.task ? { task_id: d.task.task_id } : {}),
    };
    this.cache.set(cacheKey, pkg);
    return pkg;
  }

  private safeText(messageId: string): string {
    try { return this.episodic.messageText(messageId); } catch { return "[message unavailable]"; }
  }

  /**
   * Egress filter (03 §9.9): before a provider call, local_only items (and listed_providers
   * items not listing this provider) become placeholders; the value is late-bound by the Broker.
   */
  static filterForProvider(pkg: ContextPackage, provider: string): { pkg: ContextPackage; withheld: number } {
    let withheld = 0;
    const sections = pkg.sections.map(s => ({ ...s, items: s.items.map(it => {
      const allowed = it.egress.policy === "any_approved_provider" || (it.egress.policy === "listed_providers" && (it.egress.providers ?? []).includes(provider));
      if (allowed) return it;
      withheld++;
      return { ...it, text: it.source_id ? `{{mem:${it.source_id}#value}} (withheld: ${it.egress.policy})` : "[withheld by egress policy]", placeholder: true };
    }) }));
    return { pkg: { ...pkg, sections, egress_target: provider }, withheld };
  }

  /** Renders a package as provenance-tagged text blocks for a model. */
  static render(pkg: ContextPackage): string {
    return pkg.sections.map(s => `## ${s.name}${s.mandatory ? " (mandatory)" : ""}\n` + s.items.map(i => `${i.tag}${i.warning ? ` (${i.warning})` : ""} ${i.text}`).join("\n")).join("\n\n");
  }
}
