import { readFileSync, writeFileSync } from "node:fs";
import { sha256, JarvisError, MemoryRecord, Entity, Relationship, Project, Commitment, ExperienceRecord, MemoryCorrection, type PreferenceContent } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { MemoryService } from "./memory-service.js";
import { zipFiles, unzipFiles } from "./zip.js";

export const SEMANTICS_MD = `# JARVIS archive semantics

- Every record keeps its stable id, schema version and revision. Import preserves them.
- provenance.origin: stated (you said it), observed (seen with evidence), derived, inferred (from behaviour; lowest precedence), imported.
- provenance.source_trust: owner_verified, owner_unverified, trusted_service, external_content, worker_claim, system.
  External content never creates facts or preferences about the owner.
- scope: global, project, entity or task. More specific scope wins: task > person > org unit > organization > project > global.
- times.valid_from / valid_until: when the statement was or is true in the world. Superseded records keep their interval.
- status: pending_review, active, disputed, superseded, expired, deleted. Deleted records are tombstones with content purged.
- supersedes / superseded_by / contradicts link records; corrections (corrections.jsonl) record what changed and generalization_limit states what a correction does NOT imply.
- preference.kind: taste (can be traded off) or requirement (a hard planning constraint).
- sensitivity and egress: restricted records are local_only and used through placeholders {{mem:<id>#<field>}}.
- Credentials are never in this archive.
`;

export interface ImportDiff {
  edits: { record_id: string; old_text: string; new_text: string }[];
  added: { section: string; text: string }[];
  deletions: { record_id: string; text: string }[];
  conflicts: { record_id: string; exported_revision: number; current_revision: number; new_text: string }[];
}

const ANCHOR = /^<!--\s*(mem_[0-9A-Z]{26})@r(\d+)\s*-->\s*$/;

/** Export archive (.jarvis-archive zip) and Markdown views with anchors (03 §9.4, §9.18). */
export class Portability {
  constructor(private ctx: CoreContext, private memory: MemoryService, private extraJsonl: () => Record<string, unknown[]> = () => ({})) {}

  markdownView(type: MemoryRecord["type"]): string {
    const recs = this.memory.list({ status: ["active", "disputed", "pending_review"], type, limit: 100000 }).sort((a, b) => a.text.localeCompare(b.text));
    const lines = [`# ${type === "preference" ? "Preferences" : type === "fact" ? "Facts" : "Lessons"}`, "", "Edit the text after each marker, delete an item to delete it, or add new `- ` lines at the end. Then import this file.", ""];
    for (const r of recs) {
      const scope = r.scope.level === "global" ? "" : ` _(scope: ${r.scope.level}${r.scope.entity_ids?.length ? " " + r.scope.entity_ids.join(",") : ""}${r.scope.project_id ? " " + r.scope.project_id : ""})_`;
      const kind = r.type === "preference" ? ` _(${(r.content as PreferenceContent).kind})_` : "";
      lines.push(`<!-- ${r.id}@r${r.revision} -->`, `- ${r.text}${kind}${scope}`);
    }
    return lines.join("\n") + "\n";
  }

  /** Parses an edited view and compares it with the database. Nothing is applied here. */
  diffImport(markdown: string, exportedIds: string[]): ImportDiff {
    const diff: ImportDiff = { edits: [], added: [], deletions: [], conflicts: [] };
    const seen = new Set<string>();
    const lines = markdown.split(/\r?\n/);
    let section = "notes";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("# ")) { section = line.slice(2).trim(); continue; }
      const m = ANCHOR.exec(line);
      if (m) {
        const id = m[1]!, rev = Number(m[2]);
        const item = lines[i + 1] ?? "";
        i++;
        if (!item.startsWith("- ")) continue;       // anchor without an item: treated as deleted
        seen.add(id);
        const newText = item.slice(2).replace(/\s*_\((?:taste|requirement)\)_/, "").replace(/\s*_\(scope:[^)]*\)_\s*$/, "").trim();
        const cur = this.memory.get(id);
        if (!cur || cur.status === "deleted") continue;
        if (newText === cur.text) continue;
        if (cur.revision !== rev) diff.conflicts.push({ record_id: id, exported_revision: rev, current_revision: cur.revision, new_text: newText });
        else diff.edits.push({ record_id: id, old_text: cur.text, new_text: newText });
      } else if (line.startsWith("- ") && !ANCHOR.test(lines[i - 1] ?? "")) {
        diff.added.push({ section, text: line.slice(2).trim() });
      }
    }
    for (const id of exportedIds) {
      if (seen.has(id)) continue;
      const cur = this.memory.get(id);
      if (cur && cur.status !== "deleted") diff.deletions.push({ record_id: id, text: cur.text });
    }
    return diff;
  }

  /** Applies the accepted parts of a diff as corrections and new stated records (source: owner_edit). */
  applyImport(diff: ImportDiff, accept: { edits?: string[]; added?: number[]; deletions?: string[] }, editRef: string): { corrected: string[]; created: string[]; deleted: string[] } {
    const out = { corrected: [] as string[], created: [] as string[], deleted: [] as string[] };
    this.ctx.tx(() => {
      for (const e of diff.edits.filter(e => accept.edits?.includes(e.record_id))) {
        const r = this.memory.require(e.record_id);
        this.memory.correct({ kind: "wrong_value", target_ids: [r.id], owner_statement_ref: editRef, generalization_limit: "Only this item's wording; its structured value and scope are unchanged.",
          replacements: [{ type: r.type, text: e.new_text, content: r.content as never, scope: r.scope, subject_entity_ids: r.subject_entity_ids, sensitivity: r.sensitivity, egress: r.egress }] });
        out.corrected.push(r.id);
      }
      diff.added.forEach((a, i) => {
        if (!accept.added?.includes(i)) return;
        const res = this.memory.write({ type: "fact", text: a.text, content: { predicate: "note", value: a.text }, scope: { level: "global" }, subject_entity_ids: ["owner"],
          provenance: { origin: "stated", source_refs: [{ kind: "owner_edit", ref: editRef }], source_trust: "owner_verified", recorded_by: "markdown_import" } });
        if ("record" in res) out.created.push(res.record.id);
      });
      const del = diff.deletions.filter(d => accept.deletions?.includes(d.record_id)).map(d => d.record_id);
      if (del.length) out.deleted.push(...this.memory.delete(del, "owner_edit_import").deleted);
    });
    return out;
  }

  exportArchive(path: string): { files: number; sha256: string; counts: Record<string, number> } {
    const q = (sql: string) => (this.ctx.db.prepare(sql).all() as Record<string, string>[]).map(r => Object.values(r)[0]!);
    const jsonl = (rows: string[]) => Buffer.from(rows.map(r => JSON.stringify(JSON.parse(r))).join("\n") + (rows.length ? "\n" : ""));
    const data: Record<string, Buffer> = {
      "memory/records.jsonl": jsonl(q("select record from memory_records order by id")),
      "memory/corrections.jsonl": jsonl(q("select correction from memory_corrections order by applied_at")),
      "entities.jsonl": jsonl(q("select entity from entities order by id")),
      "relationships.jsonl": jsonl(q("select relationship from relationships order by id")),
      "projects.jsonl": jsonl(q("select project from projects order by id")),
      "commitments.jsonl": jsonl(q("select commitment from commitments order by id")),
      "experiences.jsonl": jsonl(q("select experience from experiences order by id")),
      "views/preferences.md": Buffer.from(this.markdownView("preference")),
      "views/facts.md": Buffer.from(this.markdownView("fact")),
      "views/lessons.md": Buffer.from(this.markdownView("lesson")),
      "SEMANTICS.md": Buffer.from(SEMANTICS_MD),
    };
    for (const [name, rows] of Object.entries(this.extraJsonl())) data[name] = Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    const counts = Object.fromEntries(Object.entries(data).filter(([n]) => n.endsWith(".jsonl")).map(([n, b]) => [n, b.toString().split("\n").filter(Boolean).length]));
    const manifest = { format: "jarvis-archive/1", exported_at: this.ctx.clock.iso(), schema_versions: { memory: "jarvis.memory.*/1", entity: "jarvis.entity/1" },
      counts, hashes: Object.fromEntries(Object.entries(data).map(([n, b]) => [n, sha256(b)])), vault_included: false };
    const zip = zipFiles([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...Object.entries(data).map(([name, d]) => ({ name, data: d }))]);
    if (!path.endsWith(".jarvis-archive")) throw new JarvisError("invalid_input", "export path must end with .jarvis-archive");
    writeFileSync(path, zip, { mode: 0o600 });
    return { files: Object.keys(data).length + 1, sha256: sha256(zip), counts };
  }

  /**
   * Imports a .jarvis-archive, preserving ids and revisions. Existing ids are left
   * untouched (reported as skipped). Hashes in the manifest are checked first.
   */
  importArchive(path: string): { imported: Record<string, number>; skipped: Record<string, number> } {
    const files = new Map(unzipFiles(readFileSync(path)).map(f => [f.name, f.data]));
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "null") as { format: string; hashes: Record<string, string> } | null;
    if (!manifest || manifest.format !== "jarvis-archive/1") throw new JarvisError("invalid_input", "not a JARVIS archive");
    for (const [name, h] of Object.entries(manifest.hashes)) if (!files.has(name) || sha256(files.get(name)!) !== h) throw new JarvisError("invalid_input", `archive file ${name} is missing or altered`);
    const rows = (name: string) => (files.get(name)?.toString() ?? "").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
    const imported: Record<string, number> = {}, skipped: Record<string, number> = {};
    const count = (k: string, ok: boolean) => { const t = ok ? imported : skipped; t[k] = (t[k] ?? 0) + 1; };
    const db = this.ctx.db;
    const exists = (table: string, id: unknown) => !!db.prepare(`select 1 from ${table} where id = ?`).get(id);
    this.ctx.tx(() => {
      for (const r of rows("entities.jsonl")) {
        const e = Entity.parse(r);
        if (exists("entities", e.id)) { count("entities", false); continue; }
        db.prepare("insert into entities(id, kind, status, revision, entity) values (?,?,?,?,?)").run(e.id, e.kind, e.status, e.revision, JSON.stringify(e));
        for (const n of e.names) db.prepare("insert into entity_names(entity_id, value, norm, kind) values (?,?,?,?)").run(e.id, n.value, n.value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}@.+]+/gu, " ").trim(), n.kind);
        for (const i of e.identifiers) db.prepare("insert into entity_identifiers(entity_id, system, value, norm) values (?,?,?,?)").run(e.id, i.system, i.value, i.value.trim().toLowerCase());
        count("entities", true);
      }
      for (const r of rows("relationships.jsonl")) {
        const x = Relationship.parse(r);
        if (exists("relationships", x.id)) { count("relationships", false); continue; }
        db.prepare("insert into relationships(id, from_entity_id, to_entity_id, type, status, relationship) values (?,?,?,?,?,?)").run(x.id, x.from_entity_id, x.to_entity_id, x.type, x.status, JSON.stringify(x));
        count("relationships", true);
      }
      for (const r of rows("memory/records.jsonl")) count("memory", this.memory.importRecord(r));
      for (const r of rows("memory/corrections.jsonl")) {
        const c = MemoryCorrection.parse(r);
        if (exists("memory_corrections", c.id)) { count("corrections", false); continue; }
        db.prepare("insert into memory_corrections(id, applied_at, correction) values (?,?,?)").run(c.id, c.applied_at, JSON.stringify(c)); count("corrections", true);
      }
      for (const r of rows("projects.jsonl")) {
        const p = Project.parse(r);
        if (exists("projects", p.id)) { count("projects", false); continue; }
        db.prepare("insert into projects(id, status, name, project) values (?,?,?,?)").run(p.id, p.status, p.name, JSON.stringify(p)); count("projects", true);
      }
      for (const r of rows("commitments.jsonl")) {
        const c = Commitment.parse(r);
        if (exists("commitments", c.id)) { count("commitments", false); continue; }
        db.prepare("insert into commitments(id, status, project_id, commitment) values (?,?,?,?)").run(c.id, c.status, c.project_id ?? null, JSON.stringify(c));
        for (const e of c.counterparty_entity_ids) db.prepare("insert into commitment_parties(commitment_id, entity_id) values (?,?)").run(c.id, e);
        count("commitments", true);
      }
      for (const r of rows("experiences.jsonl")) {
        const x = ExperienceRecord.parse(r);
        if (exists("experiences", x.id)) { count("experiences", false); continue; }
        db.prepare("insert into experiences(id, task_id, goal_class, outcome, created_at, experience) values (?,?,?,?,?,?)").run(x.id, x.task_id, x.goal_class, x.outcome, x.created_at, JSON.stringify(x));
        db.prepare("insert into experience_fts(goal_class, summary, experience_id) values (?,?,?)").run(x.goal_class.replace(/_/g, " "), x.goal_class.replace(/_/g, " "), x.id);
        count("experiences", true);
      }
    });
    this.ctx.events.append({ type: "memory.imported", summary: "Archive imported", data: { imported, skipped } });
    return { imported, skipped };
  }
}
