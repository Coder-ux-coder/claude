import { newId, JarvisError, Entity, Relationship, DEFAULT_EGRESS, type Provenance, type Sensitivity } from "@jarvis/shared";
import type { CoreContext } from "../context.js";

export const OWNER_ENTITY = "owner";

export function normName(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}@.+]+/gu, " ").trim();
}

const KIND_RANK: Record<Entity["kind"], number> = { person: 0, account: 1, org_unit: 2, organization: 3, place: 4, device: 5, resource: 5, product: 5, other: 6 };

export interface EntityCandidate { entity: Entity; score: number; matched: string }

/** People, organizations, places, accounts and their relationships (03 §9.8). Relational, with recursive CTEs. */
export class EntityStore {
  constructor(private ctx: CoreContext) {}

  create(input: { kind: Entity["kind"]; names: Entity["names"]; identifiers?: Entity["identifiers"]; attributes?: Record<string, unknown>; provenance: Provenance; sensitivity?: Sensitivity; id?: string }): Entity {
    const now = this.ctx.clock.iso();
    const sensitivity = input.sensitivity ?? "personal";
    const e = Entity.parse({
      id: input.id ?? newId("ent", this.ctx.clock.now()), schema: "jarvis.entity/1", kind: input.kind, names: input.names,
      identifiers: input.identifiers ?? [], ...(input.attributes ? { attributes: input.attributes } : {}),
      provenance: input.provenance, sensitivity, egress: DEFAULT_EGRESS[sensitivity], status: "active", revision: 1, times: { created_at: now },
    });
    if (!e.names.some(n => n.kind === "primary")) throw new JarvisError("invalid_input", "an entity needs a primary name");
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into entities(id, kind, status, revision, entity) values (?,?,?,?,?)").run(e.id, e.kind, e.status, 1, JSON.stringify(e));
      this.index(e);
      this.ctx.events.append({ type: "entity.created", summary: `Entity created (${e.kind})`, data: { entity_id: e.id, kind: e.kind } });
    });
    return e;
  }

  private index(e: Entity): void {
    this.ctx.db.prepare("delete from entity_names where entity_id = ?").run(e.id);
    this.ctx.db.prepare("delete from entity_identifiers where entity_id = ?").run(e.id);
    for (const n of e.names) this.ctx.db.prepare("insert into entity_names(entity_id, value, norm, kind) values (?,?,?,?)").run(e.id, n.value, normName(n.value), n.kind);
    for (const i of e.identifiers) this.ctx.db.prepare("insert into entity_identifiers(entity_id, system, value, norm) values (?,?,?,?)").run(e.id, i.system, i.value, i.value.trim().toLowerCase());
  }

  get(id: string): Entity | undefined {
    const r = this.ctx.db.prepare("select entity from entities where id = ?").get(id) as { entity: string } | undefined;
    return r ? Entity.parse(JSON.parse(r.entity)) : undefined;
  }

  update(id: string, patch: Partial<Pick<Entity, "names" | "identifiers" | "attributes" | "kind">>): Entity {
    return this.ctx.tx(() => {
      const e = this.get(id);
      if (!e || e.status !== "active") throw new JarvisError("invalid_input", `entity ${id} is not active`);
      const next = Entity.parse({ ...e, ...patch, revision: e.revision + 1 });
      this.ctx.db.prepare("update entities set kind = ?, revision = ?, entity = ? where id = ?").run(next.kind, next.revision, JSON.stringify(next), id);
      this.index(next);
      this.ctx.events.append({ type: "entity.updated", summary: "Entity updated", data: { entity_id: id, revision: next.revision } });
      return next;
    });
  }

  /** Name, alias and identifier match (03 §9.8 "Which Dana?"). Ranked; the caller asks when ambiguous and consequential. */
  resolve(text: string, opts: { projectEntityIds?: string[]; recentEntityIds?: string[] } = {}): EntityCandidate[] {
    const q = normName(text);
    if (!q) return [];
    const byId = new Map<string, EntityCandidate>();
    const add = (id: string, score: number, matched: string) => {
      const e = this.get(id);
      if (!e || e.status !== "active") return;
      const prev = byId.get(id);
      if (!prev || prev.score < score) byId.set(id, { entity: e, score, matched });
    };
    for (const r of this.ctx.db.prepare("select entity_id from entity_identifiers where norm = ?").all(text.trim().toLowerCase()) as { entity_id: string }[]) add(r.entity_id, 100, "identifier");
    for (const r of this.ctx.db.prepare("select entity_id, kind, norm from entity_names where norm = ? or norm like ? or ? like norm || ' %'").all(q, `${q} %`, q) as { entity_id: string; kind: string; norm: string }[]) {
      const exact = r.norm === q;
      add(r.entity_id, (exact ? 60 : 40) + (r.kind === "primary" ? 5 : 0), exact ? "name" : "partial_name");
    }
    const project = new Set(opts.projectEntityIds ?? []), recent = new Set(opts.recentEntityIds ?? []);
    for (const c of byId.values()) {
      if (project.has(c.entity.id)) c.score += 15;
      if (recent.has(c.entity.id)) c.score += 10;
    }
    return [...byId.values()].sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
  }

  relate(input: { from: string; to: string; type: Relationship["type"]; qualifiers?: Record<string, unknown>; provenance: Provenance; confidence?: Relationship["confidence"]; valid_from?: string }): Relationship {
    if (!this.get(input.from) || !this.get(input.to)) throw new JarvisError("invalid_input", "relationship endpoints must exist");
    const r = Relationship.parse({
      id: newId("rel", this.ctx.clock.now()), schema: "jarvis.relationship/1", from_entity_id: input.from, to_entity_id: input.to, type: input.type,
      ...(input.qualifiers ? { qualifiers: input.qualifiers } : {}), ...(input.valid_from ? { valid_from: input.valid_from } : {}),
      provenance: input.provenance, confidence: input.confidence ?? { level: "confirmed", basis: "stated" }, status: "active", revision: 1,
    });
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into relationships(id, from_entity_id, to_entity_id, type, status, relationship) values (?,?,?,?,?,?)").run(r.id, r.from_entity_id, r.to_entity_id, r.type, r.status, JSON.stringify(r));
      this.ctx.events.append({ type: "relationship.created", summary: `Relationship ${r.type}`, data: { relationship_id: r.id, type: r.type } });
    });
    return r;
  }

  endRelationship(id: string): void {
    this.ctx.tx(() => {
      const row = this.ctx.db.prepare("select relationship from relationships where id = ?").get(id) as { relationship: string } | undefined;
      if (!row) throw new JarvisError("invalid_input", `unknown relationship ${id}`);
      const r = Relationship.parse(JSON.parse(row.relationship));
      const next = { ...r, status: "ended" as const, valid_until: this.ctx.clock.iso(), revision: r.revision + 1 };
      this.ctx.db.prepare("update relationships set status = 'ended', relationship = ? where id = ?").run(JSON.stringify(next), id);
    });
  }

  relationships(entityId: string, direction: "from" | "to" = "from"): Relationship[] {
    const col = direction === "from" ? "from_entity_id" : "to_entity_id";
    return (this.ctx.db.prepare(`select relationship from relationships where ${col} = ? and status = 'active'`).all(entityId) as { relationship: string }[])
      .map(r => Relationship.parse(JSON.parse(r.relationship)));
  }

  /**
   * The entity itself plus every organization or unit it belongs to (member_of / works_at),
   * transitively, with hop depth. "Is Northwind Finance part of Northwind?" is a recursive CTE.
   */
  ancestry(entityId: string, maxDepth = 6): { entity_id: string; depth: number; kind: Entity["kind"] }[] {
    const rows = this.ctx.db.prepare(`
      with recursive chain(entity_id, depth) as (
        select ?, 0
        union
        select r.to_entity_id, c.depth + 1 from relationships r join chain c on r.from_entity_id = c.entity_id
        where r.type in ('member_of', 'works_at') and r.status = 'active' and c.depth < ?
      )
      select c.entity_id, min(c.depth) depth, e.kind from chain c join entities e on e.id = c.entity_id where e.status = 'active' group by c.entity_id`)
      .all(entityId, maxDepth) as { entity_id: string; depth: number; kind: Entity["kind"] }[];
    return rows.sort((a, b) => a.depth - b.depth || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  }

  isPartOf(entityId: string, orgId: string): boolean {
    return this.ancestry(entityId).some(a => a.entity_id === orgId && a.depth > 0);
  }

  /** Entity deletion: tombstone with content purged. */
  delete(id: string): void {
    this.ctx.tx(() => {
      const e = this.get(id);
      if (!e) return;
      const tomb = { ...e, names: [{ value: "[deleted]", kind: "primary" as const }], identifiers: [], attributes: {}, status: "deleted" as const, revision: e.revision + 1 };
      this.ctx.db.prepare("update entities set status = 'deleted', revision = ?, entity = ? where id = ?").run(tomb.revision, JSON.stringify(tomb), id);
      this.ctx.db.prepare("delete from entity_names where entity_id = ?").run(id);
      this.ctx.db.prepare("delete from entity_identifiers where entity_id = ?").run(id);
      this.ctx.db.prepare("update relationships set status = 'deleted' where from_entity_id = ? or to_entity_id = ?").run(id, id);
      this.ctx.events.append({ type: "entity.deleted", summary: "Entity deleted", data: { entity_id: id } });
    });
  }

  ensureOwner(displayName: string): Entity {
    return this.get(OWNER_ENTITY) ?? this.create({ id: OWNER_ENTITY, kind: "person", names: [{ value: displayName, kind: "primary" }], provenance: { origin: "stated", source_refs: [], source_trust: "system", recorded_by: "onboarding" } });
  }

  /** Kind ranking used for specificity ties: person > org_unit > organization. */
  static kindRank(kind: Entity["kind"]): number { return KIND_RANK[kind]; }
}
