import { SimClock, type EffectClass } from "@jarvis/shared";
import { createContext, type CoreContext } from "../../src/context.js";
import { MemoryService } from "../../src/memory/memory-service.js";
import { EpisodicStore } from "../../src/memory/episodic.js";
import { ContextBuilder, type PolicyReader } from "../../src/context/context-builder.js";

export const owner = { origin: "stated" as const, source_trust: "owner_verified" as const, recorded_by: "test" };
export const said = (msg: string) => ({ ...owner, source_refs: [{ kind: "message" as const, ref: msg }] });

export class StubPolicy implements PolicyReader {
  revision = 1; fail = false;
  rules: { rule_id: string; revision: number; kind: string; decision: string; text: string; protection: string; effects: EffectClass[] }[] = [];
  currentRevision() { if (this.fail) throw new Error("policy store unreadable"); return this.revision; }
  applicableRules(d: { effects: EffectClass[] }) { if (this.fail) throw new Error("policy store unreadable"); return this.rules.filter(r => r.effects.some(e => d.effects.includes(e))); }
}

export function memHarness(opts: { dataDir?: string; clock?: SimClock } = {}) {
  const clock = opts.clock ?? new SimClock("2026-03-10T10:00:00Z");
  const ctx: CoreContext = createContext({ dataDir: opts.dataDir ?? null, clock });
  const memory = new MemoryService(ctx);
  const episodic = new EpisodicStore(ctx);
  const policy = new StubPolicy();
  const builder = new ContextBuilder(ctx, memory, episodic, policy);
  memory.entities.ensureOwner("HYPOTHETICAL Owner");
  return { ctx, clock, memory, episodic, policy, builder };
}

/** The Northwind world from 03 §9.7 (all HYPOTHETICAL). */
export function northwind(h: ReturnType<typeof memHarness>) {
  const p = { origin: "stated" as const, source_refs: [], source_trust: "owner_verified" as const, recorded_by: "test" };
  const nw = h.memory.entities.create({ kind: "organization", names: [{ value: "Northwind Traders", kind: "primary" }, { value: "Northwind", kind: "alias" }], provenance: p });
  const fin = h.memory.entities.create({ kind: "org_unit", names: [{ value: "Northwind Finance", kind: "primary" }], provenance: p });
  const dana = h.memory.entities.create({ kind: "person", names: [{ value: "Dana Whitfield", kind: "primary" }, { value: "Dana", kind: "alias" }], identifiers: [{ system: "email", value: "dana@northwind.example", verified: true }], provenance: p });
  const sam = h.memory.entities.create({ kind: "person", names: [{ value: "Sam Ortiz", kind: "primary" }, { value: "Sam", kind: "alias" }], provenance: p });
  const des = h.memory.entities.create({ kind: "person", names: [{ value: "Riley Park", kind: "primary" }], provenance: p });
  const other = h.memory.entities.create({ kind: "organization", names: [{ value: "Contoso", kind: "primary" }], provenance: p });
  const otherDana = h.memory.entities.create({ kind: "person", names: [{ value: "Dana Lee", kind: "primary" }, { value: "Dana", kind: "alias" }], provenance: p });
  h.memory.entities.relate({ from: fin.id, to: nw.id, type: "member_of", provenance: p });
  h.memory.entities.relate({ from: dana.id, to: fin.id, type: "member_of", provenance: p });
  h.memory.entities.relate({ from: dana.id, to: nw.id, type: "works_at", provenance: p });
  h.memory.entities.relate({ from: sam.id, to: nw.id, type: "works_at", provenance: p });
  h.memory.entities.relate({ from: des.id, to: nw.id, type: "works_at", provenance: p });
  h.memory.entities.relate({ from: otherDana.id, to: other.id, type: "works_at", provenance: p });
  return { nw, fin, dana, sam, des, other, otherDana };
}
