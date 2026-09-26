import {
  JarvisError, CapabilityDescriptor, CapabilityHealth, ServicePolicy,
  type EffectClass, type TaskMode,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { effectCeiling } from "../tasks/task-engine.js";
import { evalCondition } from "../policy/match.js";

export interface CapabilityCard {
  id: string; version: string; title: string; purpose: string; effects: EffectClass[];
  health: CapabilityHealth["state"]; auth: string; cost: string; needs_scope_expansion: boolean; score: number;
}

const SEARCHABLE_LIFECYCLES = new Set(["active", "validated"]);
const BLOCKING_HEALTH = new Set(["disabled", "unsupported_on_node"]);

/** Capability Registry (05 §11.2–11.7): descriptors, health, search, service policies. Installed is not authorized. */
export class CapabilityRegistry {
  constructor(private ctx: CoreContext, private nodeId = "node_local") {}

  /** Registration makes a capability discoverable, nothing more (05 §11.5). Generated tools arrive via the Release Manager. */
  register(d: CapabilityDescriptor, opts: { via: "builtin" | "release_manager" }): CapabilityDescriptor {
    const desc = CapabilityDescriptor.parse(d);
    if (opts.via === "builtin" && desc.package.provenance_ref !== "builtin") throw new JarvisError("missing_permission", "only first-party packages register directly; others go through the Release Manager");
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into capabilities(id, version, lifecycle, admin_state, descriptor, registered_at) values (?,?,?,?,?,?) on conflict(id, version) do update set lifecycle = excluded.lifecycle, admin_state = excluded.admin_state, descriptor = excluded.descriptor")
        .run(desc.id, desc.version, desc.lifecycle, desc.admin_state, JSON.stringify(desc), this.ctx.clock.iso());
      this.ctx.db.prepare("delete from capability_fts where cap_key = ?").run(`${desc.id}@${desc.version}`);
      this.ctx.db.prepare("insert into capability_fts(title, purpose, goals, cap_key) values (?,?,?,?)").run(desc.title, desc.purpose, (desc.goal_patterns ?? []).join(" | "), `${desc.id}@${desc.version}`);
      this.ctx.events.append({ type: "capability.registered", summary: `${desc.id}@${desc.version} (${desc.lifecycle})`, data: { id: desc.id, version: desc.version, lifecycle: desc.lifecycle, via: opts.via } });
    });
    return desc;
  }

  /** Resolves "id", "id@1.2.0" or "id@^1" to the newest matching active/validated version (or any lifecycle with includeAll). */
  resolve(ref: string, opts: { includeAll?: boolean } = {}): CapabilityDescriptor | undefined {
    const [id, range] = ref.split("@") as [string, string | undefined];
    const rows = (this.ctx.db.prepare("select descriptor from capabilities where id = ?").all(id) as { descriptor: string }[]).map(r => CapabilityDescriptor.parse(JSON.parse(r.descriptor)));
    const ok = rows.filter(d => opts.includeAll || SEARCHABLE_LIFECYCLES.has(d.lifecycle) || d.lifecycle === "degraded").filter(d => {
      if (!range) return true;
      if (range.startsWith("^")) return d.version.split(".")[0] === range.slice(1).split(".")[0];
      return d.version === range;
    });
    return ok.sort((a, b) => cmpSemver(b.version, a.version))[0];
  }

  /**
   * Exact lookup for dispatch. An unknown id comes back as invalid_input with
   * suggestions so the model replans; nothing executes (F38).
   */
  require(ref: string, opts: { allowUnvalidated?: boolean } = {}): CapabilityDescriptor {
    const d = this.resolve(ref, { includeAll: true });
    if (!d) {
      const suggestions = this.search(ref.split("@")[0]!.replace(/^(tool|skill|worker|model_function):/, "").replace(/[._-]/g, " "), {}).slice(0, 3).map(c => c.id);
      throw new JarvisError("invalid_input", `no capability "${ref}"${suggestions.length ? `; did you mean ${suggestions.join(", ")}?` : ""}`, { details: { suggestions } });
    }
    if (d.admin_state === "disabled") throw new JarvisError("unsupported_operation", `${d.id} is disabled`);
    if (d.lifecycle === "quarantined" || d.lifecycle === "retired") throw new JarvisError("unsupported_operation", `${d.id} is ${d.lifecycle}`);
    if ((d.lifecycle === "draft" || d.lifecycle === "under_test") && !opts.allowUnvalidated) throw new JarvisError("unsupported_operation", `${d.id} is ${d.lifecycle}; only the validation pipeline may run it`);
    return d;
  }

  /** Effects this invocation can have: declared classes plus parameter-dependent ones (05 §11.2). */
  effectsFor(d: CapabilityDescriptor, params: Record<string, unknown>): EffectClass[] {
    const out = new Set(d.side_effects.effect_classes);
    for (const p of d.side_effects.param_dependent ?? []) if (evalCondition(p.when, params) !== false) p.effect_classes.forEach(e => out.add(e));
    return [...out];
  }

  setAdminState(id: string, state: "enabled" | "disabled", reason: string): void {
    this.ctx.tx(() => {
      const rows = this.ctx.db.prepare("select version, descriptor from capabilities where id = ?").all(id) as { version: string; descriptor: string }[];
      if (!rows.length) throw new JarvisError("invalid_input", `unknown capability ${id}`);
      for (const r of rows) {
        const d = CapabilityDescriptor.parse(JSON.parse(r.descriptor));
        d.admin_state = state;
        this.ctx.db.prepare("update capabilities set admin_state = ?, descriptor = ? where id = ? and version = ?").run(state, JSON.stringify(d), id, r.version);
      }
      this.ctx.events.append({ type: state === "disabled" ? "capability.disabled" : "capability.enabled", summary: `${id}: ${reason}`, data: { id, reason } });
    });
  }

  setLifecycle(id: string, version: string, lifecycle: CapabilityDescriptor["lifecycle"]): void {
    this.ctx.tx(() => {
      const r = this.ctx.db.prepare("select descriptor from capabilities where id = ? and version = ?").get(id, version) as { descriptor: string } | undefined;
      if (!r) throw new JarvisError("invalid_input", `unknown capability ${id}@${version}`);
      const d = CapabilityDescriptor.parse(JSON.parse(r.descriptor));
      d.lifecycle = lifecycle;
      this.ctx.db.prepare("update capabilities set lifecycle = ?, descriptor = ? where id = ? and version = ?").run(lifecycle, JSON.stringify(d), id, version);
      this.ctx.events.append({ type: "capability.lifecycle", summary: `${id}@${version} → ${lifecycle}`, data: { id, version, lifecycle } });
    });
  }

  // ---------- health (05 §11.3) ----------
  setHealth(h: Omit<CapabilityHealth, "checked_at" | "node_id" | "recent"> & { node_id?: string }): CapabilityHealth {
    const recent = this.recent(h.capability_id, h.account_id);
    const full = CapabilityHealth.parse({ ...h, node_id: h.node_id ?? this.nodeId, checked_at: this.ctx.clock.iso(), recent });
    this.ctx.db.prepare("insert into capability_health(capability_id, node_id, account_id, state, health) values (?,?,?,?,?) on conflict(capability_id, node_id, account_id) do update set state = excluded.state, health = excluded.health")
      .run(full.capability_id, full.node_id, full.account_id ?? "", full.state, JSON.stringify(full));
    return full;
  }

  health(capabilityId: string, accountId?: string): CapabilityHealth {
    const r = this.ctx.db.prepare("select health from capability_health where capability_id = ? and node_id = ? and account_id = ?").get(capabilityId, this.nodeId, accountId ?? "") as { health: string } | undefined;
    return r ? CapabilityHealth.parse(JSON.parse(r.health)) : { capability_id: capabilityId, node_id: this.nodeId, ...(accountId ? { account_id: accountId } : {}), state: "available", checked_at: this.ctx.clock.iso(), probe: "passive", recent: this.recent(capabilityId, accountId) };
  }

  private recent(capabilityId: string, accountId?: string) {
    const since = new Date(this.ctx.clock.now() - 7 * 86_400_000).toISOString();
    const r = this.ctx.db.prepare("select coalesce(sum(ok), 0) s, count(*) n from capability_outcomes where capability_id = ? and account_id = ? and at > ?").get(capabilityId, accountId ?? "", since) as { s: number; n: number };
    return { successes: r.s, failures: r.n - r.s, window: "P7D" };
  }

  /** Passive signal: three failures in a row of the same class set the capability to degraded. */
  recordOutcome(capabilityId: string, ok: boolean, opts: { account_id?: string; error_code?: string; goal_class?: string } = {}): void {
    this.ctx.db.prepare("insert into capability_outcomes(capability_id, account_id, ok, error_code, goal_class, at) values (?,?,?,?,?,?)")
      .run(capabilityId, opts.account_id ?? "", ok ? 1 : 0, opts.error_code ?? null, opts.goal_class ?? null, this.ctx.clock.iso());
    if (ok) {
      if (this.health(capabilityId, opts.account_id).state === "degraded") this.setHealth({ capability_id: capabilityId, ...(opts.account_id ? { account_id: opts.account_id } : {}), state: "available", probe: "passive", reason: "recovered" });
      return;
    }
    const last = this.ctx.db.prepare("select ok, error_code from capability_outcomes where capability_id = ? and account_id = ? order by rowid desc limit 3").all(capabilityId, opts.account_id ?? "") as { ok: number; error_code: string | null }[];
    if (last.length === 3 && last.every(x => !x.ok && x.error_code === last[0]!.error_code) && !["auth_required", "missing_credential", "missing_permission"].includes(last[0]!.error_code ?? ""))
      this.setHealth({ capability_id: capabilityId, ...(opts.account_id ? { account_id: opts.account_id } : {}), state: "degraded", probe: "passive", reason: `3 consecutive ${last[0]!.error_code} failures` });
    if (opts.error_code === "auth_required" || opts.error_code === "missing_credential")
      this.setHealth({ capability_id: capabilityId, ...(opts.account_id ? { account_id: opts.account_id } : {}), state: "needs_auth", probe: "passive", reason: opts.error_code });
  }

  /** Node events change availability instantly: lock/sleep make desktop capabilities unavailable_now. */
  onNodeAvailability(state: "unlocked" | "locked" | "asleep_expected" | "offline"): string[] {
    const changed: string[] = [];
    for (const d of this.list()) {
      const needsDesktop = d.environment.requires_unlocked_desktop;
      const needsNet = d.environment.network === "internet";
      const unavailable = (needsDesktop && state !== "unlocked") || (needsNet && state === "offline");
      const cur = this.health(d.id);
      if (unavailable && cur.state !== "unavailable_now") { this.setHealth({ capability_id: d.id, state: "unavailable_now", probe: "active", reason: state === "offline" ? "network offline" : `desktop ${state}` }); changed.push(d.id); }
      if (!unavailable && cur.state === "unavailable_now") { this.setHealth({ capability_id: d.id, state: "available", probe: "active", reason: "available again" }); changed.push(d.id); }
    }
    return changed;
  }

  list(): CapabilityDescriptor[] {
    return (this.ctx.db.prepare("select descriptor from capabilities").all() as { descriptor: string }[]).map(r => CapabilityDescriptor.parse(JSON.parse(r.descriptor)));
  }

  // ---------- search (05 §11.4) ----------
  search(query: string, f: { mode?: TaskMode; intended_effects?: EffectClass[]; repair?: boolean; account_id?: string; goal_class?: string; limit?: number }): CapabilityCard[] {
    const terms = query.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(t => t.length > 1).map(t => `"${t}"*`);
    if (!terms.length) return [];
    const rows = this.ctx.db.prepare("select cap_key, bm25(capability_fts) score from capability_fts where capability_fts match ? order by score limit 50").all(terms.join(" OR ")) as { cap_key: string; score: number }[];
    const ceiling = f.mode ? effectCeiling(f.mode, f.intended_effects ?? []) : null;
    const cards: CapabilityCard[] = [];
    for (const row of rows) {
      const at = row.cap_key.lastIndexOf("@");
      const d = this.resolve(row.cap_key.slice(0, at) + "@" + row.cap_key.slice(at + 1), { includeAll: true });
      if (!d || d.version !== row.cap_key.slice(at + 1)) continue;
      if (d.admin_state !== "enabled") continue;
      if (!f.repair && !SEARCHABLE_LIFECYCLES.has(d.lifecycle)) continue;
      if (!d.environment.node_kinds.includes("windows_desktop")) continue;
      const h = this.health(d.id, f.account_id);
      if (BLOCKING_HEALTH.has(h.state)) continue;
      const needsExpansion = ceiling ? d.side_effects.effect_classes.some(e => !ceiling.has(e)) : false;
      const rel = -row.score;
      const reliability = (h.recent.successes + 1) / (h.recent.successes + h.recent.failures + 2);
      const verif = d.verification.method === "none" ? 0 : 0.5;
      const cost = d.cost.kind === "metered" ? 0.3 : 0;
      const avail = h.state === "available" ? 0.5 : h.state === "degraded" ? -0.5 : 0;
      cards.push({ id: d.id, version: d.version, title: d.title, purpose: d.purpose.slice(0, 200), effects: d.side_effects.effect_classes, health: h.state,
        auth: d.auth.type, cost: d.cost.kind, needs_scope_expansion: needsExpansion, score: rel + reliability + verif + avail - cost });
    }
    const uniq = new Map<string, CapabilityCard>();
    for (const c of cards.sort((a, b) => b.score - a.score)) if (!uniq.has(c.id)) uniq.set(c.id, c);
    return [...uniq.values()].slice(0, f.limit ?? 8);
  }

  // ---------- service policies (05 §11.8) ----------
  setServicePolicy(p: ServicePolicy): void {
    const sp = ServicePolicy.parse(p);
    this.ctx.db.prepare("insert into service_policies(service, policy) values (?, ?) on conflict(service) do update set policy = excluded.policy").run(sp.service, JSON.stringify(sp));
  }
  servicePolicy(host: string): ServicePolicy {
    const h = host.toLowerCase();
    const all = (this.ctx.db.prepare("select policy from service_policies").all() as { policy: string }[]).map(r => ServicePolicy.parse(JSON.parse(r.policy)));
    return all.find(p => h === p.service || h.endsWith("." + p.service)) ?? { service: h, ui_automation: "unknown", api: "none", notes: "No recorded policy: owner-attended mode.", sources: [] };
  }
}

export function cmpSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(Number), pb = b.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}
