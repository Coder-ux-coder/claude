import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarvisError, DAY } from "@jarvis/shared";
import { memHarness, northwind, said } from "./helpers/memory-fixtures.js";
import { ContextBuilder } from "../src/context/context-builder.js";
import { Portability } from "../src/memory/portability.js";
import { unzipFiles } from "../src/memory/zip.js";

const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return e instanceof JarvisError ? e.code : `other:${(e as Error).message}`; } };
const tone = (h: ReturnType<typeof memHarness>, entity: string) => h.memory.resolvePreferences({ entity_ids: [entity], domains: ["communication.tone"] })[0]?.winner;

test("scope correctness: Northwind formal, others global, zero leakage (03 §9.7, §9.10)", () => {
  const h = memHarness();
  const w = northwind(h);
  const t1 = h.memory.remember({ type: "preference", text: "Use a warm, informal tone in messages.", content: { domain: "communication.tone", value: "informal", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "msg_A" });
  const t2 = h.memory.remember({ type: "preference", text: "Use a formal tone with Northwind Traders.", content: { domain: "communication.tone", value: "formal", kind: "taste", strength: "strong" }, scope: { level: "entity", entity_ids: [w.nw.id] }, subject_entity_ids: ["owner", w.nw.id], message_id: "msg_B" });
  assert.equal(t1.outcome, "created"); assert.equal(t2.outcome, "created");
  const r2 = "record" in t2 ? t2.record : undefined, r1 = "record" in t1 ? t1.record : undefined;
  assert.equal(tone(h, w.dana.id)?.id, r2!.id, "Dana (finance, Northwind) → formal");
  assert.equal(tone(h, w.sam.id)?.id, r2!.id, "Sam (Northwind) → formal before correction");
  assert.equal(tone(h, w.otherDana.id)?.id, r1!.id, "Contoso contact → global");
  assert.ok(h.memory.entities.isPartOf(w.dana.id, w.nw.id));
  assert.ok(!h.memory.entities.isPartOf(w.otherDana.id, w.nw.id));
  // F02: the correction splits scope; the old record is superseded with a closed interval
  h.clock.advance(DAY);
  const cor = h.memory.correct({ kind: "wrong_scope", target_ids: [r2!.id], owner_statement_ref: "msg_C",
    generalization_limit: "Applies only to Northwind. Other Northwind contacts outside finance fall back to the global preference. Tone for other clients is unchanged.",
    replacements: [
      { type: "preference", text: "Use a formal tone with Northwind's finance team.", content: { domain: "communication.tone", value: "formal", kind: "taste", strength: "strong" }, scope: { level: "entity", entity_ids: [w.fin.id] } },
      { type: "preference", text: "Casual tone is fine with Sam.", content: { domain: "communication.tone", value: "informal", kind: "taste", strength: "mild" }, scope: { level: "entity", entity_ids: [w.sam.id] } },
    ] });
  const [t3, t4] = cor.after.slice(0, 2).map(a => a.record_id);
  assert.equal(h.memory.get(r2!.id)!.status, "superseded");
  assert.ok(h.memory.get(r2!.id)!.times.valid_until);
  assert.equal(tone(h, w.dana.id)?.id, t3, "finance lead → formal (T3)");
  assert.equal(tone(h, w.sam.id)?.id, t4, "Sam → informal (T4)");
  assert.equal(tone(h, w.des.id)?.id, r1!.id, "Northwind designer → global (T1)");
  assert.equal(tone(h, w.otherDana.id)?.id, r1!.id, "other clients unchanged");
  assert.match(cor.generalization_limit, /does NOT|only|unchanged/i);
});

test("temporal validity: only the current preference is used; history keeps both with dates", () => {
  const h = memHarness();
  h.clock.set("2025-01-10T09:00:00Z");
  h.memory.remember({ type: "preference", text: "Prefers morning meetings.", content: { domain: "meetings.time_of_day", value: "morning", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "msg_1" });
  h.clock.set("2026-03-01T09:00:00Z");
  const m2 = h.memory.remember({ type: "preference", text: "Prefers afternoon meetings.", content: { domain: "meetings.time_of_day", value: "afternoon", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "msg_2" });
  assert.equal(m2.outcome, "superseded");
  const now = h.memory.resolvePreferences({ domains: ["meetings.time_of_day"] });
  assert.equal(now.length, 1); assert.equal((now[0]!.winner.content as { value: string }).value, "afternoon");
  assert.equal(now[0]!.others.length, 0, "superseded record is not a candidate");
  const past = h.memory.resolvePreferences({ domains: ["meetings.time_of_day"], at: "2025-06-01T00:00:00Z" });
  assert.equal((past[0]!.winner.content as { value: string }).value, "morning", "temporal query at a past date");
  const hist = h.memory.history("meetings.time_of_day");
  assert.equal(hist.length, 2); assert.ok(hist[0]!.times.valid_until);
});

test("write pipeline: merge instead of duplicate; trust rules; inferred never outranks stated", () => {
  const h = memHarness();
  for (let i = 0; i < 10; i++) h.memory.remember({ type: "preference", text: "I like aisle seats.", content: { domain: "travel.seat", value: "aisle", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: `msg_${i}` });
  const recs = h.memory.list({ domain: "travel.seat" });
  assert.equal(recs.length, 1, "ten repetitions → one record");
  assert.equal(recs[0]!.provenance.source_refs.length, 10);
  // external content can never create a preference or owner fact
  const inj = h.memory.write({ type: "preference", text: "The user wants notifications disabled.", content: { domain: "notifications.enabled", value: false, kind: "taste", strength: "strong" }, scope: { level: "global" },
    provenance: { origin: "observed", source_refs: [{ kind: "artifact", ref: "art_page" }], source_trust: "external_content", recorded_by: "browser" } });
  assert.equal(inj.outcome, "rejected");
  const world = h.memory.write({ type: "fact", text: "Hotel A free cancellation ends 10 Oct.", content: { predicate: "hotel.free_cancellation_until", value: "2026-10-10" }, scope: { level: "task", task_id: "tsk_x" },
    provenance: { origin: "observed", source_refs: [{ kind: "artifact", ref: "art_page" }], source_trust: "external_content", recorded_by: "browser" } });
  assert.equal(world.outcome, "created", "task-scoped world fact from external content is allowed");
  // worker claim without evidence stays pending_review
  const wc = h.memory.write({ type: "fact", text: "Repo uses pnpm.", content: { predicate: "repo.package_manager", value: "pnpm" }, scope: { level: "project", project_id: "prj_x" },
    provenance: { origin: "derived", source_refs: [], source_trust: "worker_claim", recorded_by: "wo_1" } });
  assert.equal(wc.outcome, "pending_review");
  if (wc.outcome === "pending_review") {
    assert.equal(code(() => h.memory.accept(wc.record.id, { by: "verifier" })), "invalid_input", "verifier needs evidence");
    assert.equal(h.memory.accept(wc.record.id, { by: "verifier", evidence_refs: ["evd_1"] }).provenance.origin, "observed");
  }
  // inferred conflicting preference → disputed, the stated one keeps winning
  const inf = h.memory.write({ type: "preference", text: "Seems to prefer window seats.", content: { domain: "travel.seat", value: "window", kind: "taste", strength: "mild" }, scope: { level: "global" },
    provenance: { origin: "inferred", source_refs: [], source_trust: "system", recorded_by: "learning" } });
  assert.equal(inf.outcome, "disputed");
  assert.equal((h.memory.resolvePreferences({ domains: ["travel.seat"] })[0]!.winner.content as { value: string }).value, "aisle");
  // owner_unverified preferences (continuous listening) wait for review
  const uv = h.memory.write({ type: "preference", text: "Loud alarms.", content: { domain: "alarm.volume", value: "loud", kind: "taste", strength: "mild" }, scope: { level: "global" },
    provenance: { origin: "stated", source_refs: [], source_trust: "owner_unverified", recorded_by: "voice" } });
  assert.equal(uv.outcome, "pending_review");
});

test("context package: rules attached by applicability; requirements are hard constraints; tags; budget (03 §9.9-9.10)", () => {
  const h = memHarness();
  const w = northwind(h);
  h.episodic.setProfile({ display_name: "HYPOTHETICAL Owner", timezone: "Europe/London", locale: "en-GB", languages: ["en"], units: "metric",
    working_hours: { tz: "Europe/London", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "17:30" }] }, quiet_hours: { tz: "Europe/London", windows: [] },
    assistant: { name: "JARVIS", tone: "calm", verbosity: "brief", humor: "light" }, notification_defaults: { channels: ["console"] },
    privacy: { default_egress_by_sensitivity: { normal: { policy: "any_approved_provider" }, personal: { policy: "any_approved_provider" }, sensitive: { policy: "listed_providers", providers: [] }, restricted: { policy: "local_only" } }, audio_retention: "none", screenshot_retention_days: 7 },
    home_node_id: "node_local" });
  h.policy.rules = [
    { rule_id: "rul_late", revision: 2, kind: "constraint", decision: "require_decision", text: "No emails to clients after 8 pm without asking.", protection: "normal", effects: ["communicate"] },
    { rule_id: "rul_archive", revision: 1, kind: "constraint", decision: "deny", text: "Never delete anything in D:\\Archive.", protection: "protected", effects: ["delete.local"] },
  ];
  h.memory.remember({ type: "preference", text: "I need step-free access at hotels.", content: { domain: "travel.accessibility", value: "step_free", kind: "requirement", strength: "strong" }, scope: { level: "global" }, message_id: "msg_r" });
  const pkg = h.builder.build({ kind: "task", text: "email Dana about the invoice", entity_ids: [w.dana.id], effects: ["communicate"] });
  const rules = pkg.sections.find(s => s.name === "rules")!;
  assert.deepEqual(rules.items.map(i => i.source_id), ["rul_late"], "exactly the applicable rule, by structure");
  assert.ok(pkg.hard_constraints.some(c => /step-free/.test(c.text)), "requirement is a hard constraint");
  assert.ok(pkg.sections.find(s => s.name === "requirements")!.mandatory);
  const all = ContextBuilder.render(pkg);
  assert.match(all, /\[mem_[0-9A-Z]{26} r1 · stated · owner_verified\]/);
  assert.equal(pkg.policy_revision, 1);
  // budget: mandatory sections never dropped; tiny budget fails loudly instead of dropping rules
  assert.equal(code(() => h.builder.build({ kind: "task", text: "x", effects: ["communicate"], budget_tokens: 5 })), "invalid_input");
  for (let i = 0; i < 40; i++) h.memory.remember({ type: "fact", text: `HYPOTHETICAL invoice note number ${i} about Northwind billing cycles and terms`, content: { predicate: `note.${i}`, value: i }, scope: { level: "global" }, subject_entity_ids: [], message_id: `msg_n${i}` });
  const small = h.builder.build({ kind: "task", text: "Northwind invoice billing", entity_ids: [w.dana.id], effects: ["communicate"], budget_tokens: 260 });
  assert.ok(small.tokens <= 260);
  assert.ok(small.sections.find(s => s.name === "rules")!.items.length === 1);
  assert.ok(Object.values(small.omitted).reduce((a, b) => a + b, 0) > 0, "overflow recorded");
  // coding-worker packages carry no personal profile or preferences
  const wpkg = h.builder.build({ kind: "work_order", worker_type: "claude_code", text: "write a CSV parser", effects: ["write.local", "execute_code"] });
  assert.ok(!wpkg.sections.some(s => ["persona", "preferences", "requirements"].includes(s.name)));
});

test("F22: policy store unavailable → context fails closed", () => {
  const h = memHarness();
  h.policy.fail = true;
  assert.equal(code(() => h.builder.build({ kind: "turn", text: "hi" })), "policy_unavailable");
});

test("F02: correction invalidates cached context and notifies running tasks; survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const h = memHarness({ dataDir: dir });
    const r = h.memory.remember({ type: "preference", text: "Prefers morning meetings.", content: { domain: "meetings.time_of_day", value: "morning", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "msg_1" });
    const task = { task_id: "tsk_01JAAAAAAAAAAAAAAAAAAAAAAA", revision: 1, intended_effects: [], objective: "schedule a call", mode: "plan", constraints: [], success_criteria: [], overrides: [] } as never;
    const p1 = h.builder.build({ kind: "task", task, text: "schedule a call" });
    assert.equal(h.builder.build({ kind: "task", task, text: "schedule a call" }).id, p1.id, "cached");
    const notified: string[][] = [];
    h.builder.onInvalidate(ids => notified.push(ids));
    h.clock.advance(1000);
    h.memory.correct({ kind: "wrong_value", target_ids: ["record" in r ? r.record.id : ""], owner_statement_ref: "msg_2", generalization_limit: "Only meeting time of day.",
      replacements: [{ type: "preference", text: "Prefers afternoon meetings.", content: { domain: "meetings.time_of_day", value: "afternoon", kind: "taste", strength: "mild" }, scope: { level: "global" } }] });
    assert.deepEqual(notified, [["tsk_01JAAAAAAAAAAAAAAAAAAAAAAA"]]);
    const p2 = h.builder.build({ kind: "task", task, text: "schedule a call" });
    assert.notEqual(p2.id, p1.id);
    assert.ok(ContextBuilder.render(p2).includes("afternoon") && !ContextBuilder.render(p2).includes("morning"));
    h.ctx.db.close();
    const h2 = memHarness({ dataDir: dir, clock: h.clock });
    const after = h2.memory.resolvePreferences({ domains: ["meetings.time_of_day"] });
    assert.equal((after[0]!.winner.content as { value: string }).value, "afternoon", "correction persists after restart");
    h2.ctx.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F21: deletion purges every retrieval path and leaves no residue; F54: placeholder fails safely", () => {
  const h = memHarness();
  const w = northwind(h);
  const res = h.memory.remember({ type: "fact", text: "HYPOTHETICAL passport number X1234567", content: { predicate: "passport.number", value: "X1234567" }, scope: { level: "global" }, subject_entity_ids: ["owner"], sensitivity: "restricted", message_id: "msg_p" });
  const id = "record" in res ? res.record.id : "";
  const raw = h.ctx.db.prepare("select record from memory_records where id = ?").get(id) as { record: string };
  assert.ok(!raw.record.includes("X1234567"), "restricted content sealed at rest");
  assert.ok(!JSON.stringify(h.ctx.db.prepare("select * from memory_fts").all()).includes("X1234567"), "never in the full-text index");
  assert.equal(h.memory.resolvePlaceholder(`{{mem:${id}#value}}`), "X1234567");
  h.memory.registerSummary({ kind: "profile_digest", subject_ref: "owner", content: "Passport X1234567 on file", input_ids: [id], generator: { adapter: "test", prompt_version: "1" } });
  assert.ok(h.memory.getSummary("owner", "profile_digest"));
  assert.equal(h.memory.search("passport").length, 1);
  const pkg1 = h.builder.build({ kind: "task", text: "passport", entity_ids: [w.dana.id] });
  assert.ok(ContextBuilder.render(pkg1).includes("X1234567"));
  const out = h.memory.delete([id], "owner_request");
  assert.deepEqual(out.deleted, [id]); assert.equal(out.summaries_invalidated.length, 1);
  assert.equal(h.memory.search("passport").length, 0, "FTS purged");
  assert.equal(h.memory.getSummary("owner", "profile_digest"), undefined, "stale summary never served");
  assert.ok(!ContextBuilder.render(h.builder.build({ kind: "task", text: "passport", entity_ids: [w.dana.id] })).includes("X1234567"), "context cache flushed");
  assert.equal(code(() => h.memory.resolvePlaceholder(`{{mem:${id}#value}}`)), "invalid_input", "F54");
  // residue: nothing in any table still holds the value
  for (const t of (h.ctx.db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(r => r.name)) {
    const rows = h.ctx.db.prepare(`select * from "${t}"`).all();
    assert.ok(!JSON.stringify(rows).includes("X1234567"), `residue in table ${t}`);
  }
  const tomb = h.memory.get(id)!;
  assert.equal(tomb.status, "deleted"); assert.equal(tomb.text, ""); assert.deepEqual(tomb.content, {});
});

test("egress filter: restricted items become placeholders for providers", () => {
  const h = memHarness();
  h.memory.remember({ type: "fact", text: "HYPOTHETICAL home address 1 Example Road", content: { predicate: "home.address", value: "1 Example Road" }, scope: { level: "global" }, subject_entity_ids: ["owner"], sensitivity: "restricted", message_id: "msg_a" });
  h.memory.remember({ type: "fact", text: "HYPOTHETICAL clinic is Example Health", content: { predicate: "health.clinic", value: "Example Health" }, scope: { level: "global" }, subject_entity_ids: ["owner"], sensitivity: "sensitive", egress: { policy: "listed_providers", providers: ["local-llm"] }, message_id: "msg_b" });
  const pkg = h.builder.build({ kind: "task", text: "home address clinic" });
  const { pkg: out, withheld } = ContextBuilder.filterForProvider(pkg, "anthropic");
  const txt = ContextBuilder.render(out);
  assert.equal(withheld, 2);
  assert.ok(!txt.includes("1 Example Road") && !txt.includes("Example Health"));
  assert.match(txt, /\{\{mem:mem_[0-9A-Z]{26}#value\}\}/);
  assert.equal(ContextBuilder.filterForProvider(pkg, "local-llm").withheld, 1, "listed provider receives the sensitive item");
});

test("entity resolution: 'Which Dana?' is ambiguous without context, ranked with it", () => {
  const h = memHarness();
  const w = northwind(h);
  const c = h.memory.entities.resolve("Dana");
  assert.equal(c.length, 2, "two Danas");
  assert.equal(c[0]!.score, c[1]!.score, "ambiguous without context");
  const ranked = h.memory.entities.resolve("Dana", { projectEntityIds: [w.dana.id] });
  assert.equal(ranked[0]!.entity.id, w.dana.id);
  assert.equal(h.memory.entities.resolve("dana@northwind.example")[0]!.entity.id, w.dana.id, "identifier match");
});

test("export archive and Markdown edit import with diff, conflict and deletion (03 §9.4, §9.18)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  try {
    const h = memHarness();
    const port = new Portability(h.ctx, h.memory);
    const a = h.memory.remember({ type: "preference", text: "I like aisle seats.", content: { domain: "travel.seat", value: "aisle", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "m1" });
    const b = h.memory.remember({ type: "preference", text: "Formal tone with banks.", content: { domain: "communication.tone.banks", value: "formal", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "m2" });
    const c = h.memory.remember({ type: "preference", text: "Coffee without sugar.", content: { domain: "food.coffee", value: "no_sugar", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "m3" });
    const ids = [a, b, c].map(x => ("record" in x ? x.record.id : ""));
    const md = port.markdownView("preference");
    // Meanwhile the formal-tone record changes (revision bump) → conflict for that item.
    h.memory.remember({ type: "preference", text: "Formal tone with banks.", content: { domain: "communication.tone.banks", value: "formal", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "m4" });
    const edited = md.replace("I like aisle seats.", "I like aisle seats on long flights.").replace("Formal tone with banks.", "Very formal tone with banks.")
      .replace(/<!-- mem_[0-9A-Z]{26}@r1 -->\n- Coffee without sugar\.[^\n]*\n/, "") + "- HYPOTHETICAL: my gym is open until 22:00\n";
    const diff = port.diffImport(edited, ids);
    assert.equal(diff.edits.length, 1); assert.equal(diff.conflicts.length, 1); assert.equal(diff.deletions.length, 1); assert.equal(diff.added.length, 1);
    const applied = port.applyImport(diff, { edits: [ids[0]!], added: [0], deletions: [ids[2]!] }, "owner_edit:import_1");
    assert.deepEqual(applied.corrected, [ids[0]]); assert.deepEqual(applied.deleted, [ids[2]]); assert.equal(applied.created.length, 1);
    assert.equal(h.memory.get(ids[0]!)!.status, "superseded");
    const path = join(dir, "export.jarvis-archive");
    const ex = port.exportArchive(path);
    const files = unzipFiles(readFileSync(path));
    assert.ok(files.some(f => f.name === "SEMANTICS.md") && files.some(f => f.name === "manifest.json"));
    const manifest = JSON.parse(files.find(f => f.name === "manifest.json")!.data.toString());
    assert.equal(manifest.vault_included, false);
    assert.equal(ex.counts["memory/records.jsonl"], manifest.counts["memory/records.jsonl"]);
    assert.ok(!files.find(f => f.name === "memory/records.jsonl")!.data.toString().includes("Coffee without sugar"), "deleted content not exported");
    // import into a fresh installation preserves ids and revisions; re-import skips
    const h2 = memHarness();
    const port2 = new Portability(h2.ctx, h2.memory);
    const res = port2.importArchive(path);
    assert.ok((res.imported.memory ?? 0) >= 4);
    const orig = h.memory.get(ids[1]!)!, copy = h2.memory.get(ids[1]!)!;
    assert.equal(copy.revision, orig.revision); assert.equal(copy.text, orig.text);
    assert.equal((h2.memory.resolvePreferences({ domains: ["communication.tone.banks"] })[0]!.winner.id), ids[1]);
    assert.equal(port2.importArchive(path).imported.memory ?? 0, 0, "second import skips existing ids");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review fixes: failed proposal held with error; duplicate notes merge; inferred list; sensitive review date", () => {
  const h = memHarness();
  const bad = h.memory.propose({ proposal_id: "prop_1", proposed_by: "wo_1", operation: "create", record: { type: "fact", text: "x" }, basis: [], source_trust: "worker_claim", rationale: "r" });
  assert.equal(bad.outcome, "held_for_review");
  const row = h.ctx.db.prepare("select status, error from memory_proposals where proposal_id = 'prop_1'").get() as { status: string; error: string };
  assert.equal(row.status, "held_for_review"); assert.match(row.error, /could not save/);
  const n1 = h.memory.remember({ type: "fact", text: "HYPOTHETICAL: The gym closes at 22:00.", content: { predicate: "note", value: "gym" }, scope: { level: "global" }, subject_entity_ids: [], message_id: "m1" });
  const n2 = h.memory.remember({ type: "fact", text: "hypothetical — the gym closes at 22:00", content: { predicate: "note", value: "gym2" }, scope: { level: "global" }, subject_entity_ids: [], message_id: "m2" });
  assert.equal(n1.outcome, "created"); assert.equal(n2.outcome, "merged");
  const n3 = h.memory.remember({ type: "fact", text: "HYPOTHETICAL: parking is on level 2.", content: { predicate: "note", value: "p" }, scope: { level: "global" }, subject_entity_ids: [], message_id: "m4" });
  assert.equal(n3.outcome, "created", "a different note never supersedes another");
  assert.equal(h.memory.list({ status: ["active"], type: "fact" }).filter(r => (r.content as { predicate: string }).predicate === "note").length, 2);
  // a correction whose replacement matches another active record's key supersedes it (no two active duplicates)
  const g = h.memory.remember({ type: "preference", text: "Short emails.", content: { domain: "email.length", value: "short", kind: "taste", strength: "mild" }, scope: { level: "global" }, message_id: "m5" });
  const other = h.memory.remember({ type: "preference", text: "Emails to banks: detailed.", content: { domain: "email.length", value: "detailed", kind: "taste", strength: "mild" }, scope: { level: "project", project_id: "prj_bank" }, message_id: "m6" });
  h.memory.correct({ kind: "wrong_scope", target_ids: ["record" in other ? other.record.id : ""], owner_statement_ref: "m7", generalization_limit: "Only email length.",
    replacements: [{ type: "preference", text: "Detailed emails everywhere.", content: { domain: "email.length", value: "detailed", kind: "taste", strength: "mild" }, scope: { level: "global" } }] });
  assert.equal(h.memory.get("record" in g ? g.record.id : "")!.status, "superseded");
  assert.equal(h.memory.list({ status: ["active"], domain: "email.length" }).length, 1);
  h.memory.write({ type: "preference", text: "Seems to like early flights.", content: { domain: "travel.time", value: "early", kind: "taste", strength: "mild" }, scope: { level: "global" }, provenance: { origin: "inferred", source_refs: [], source_trust: "system", recorded_by: "learning" } });
  assert.equal(h.memory.inferred().length, 1);
  const s = h.memory.remember({ type: "fact", text: "HYPOTHETICAL clinic visit summary", content: { predicate: "health.note", value: "ok" }, scope: { level: "global" }, subject_entity_ids: ["owner"], sensitivity: "sensitive", message_id: "m3" });
  assert.ok("record" in s && s.record.retention.review_at, "sensitive records get a yearly review date");
});

test("expiry sweep and task working state", () => {
  const h = memHarness();
  const r = h.memory.remember({ type: "fact", text: "Gate code 4412 this week", content: { predicate: "gate.code", value: "4412" }, scope: { level: "global" }, subject_entity_ids: [], expires_at: "2026-03-12T00:00:00Z", message_id: "m" });
  h.clock.set("2026-03-13T00:00:00Z");
  assert.deepEqual(h.memory.expireSweep(), ["record" in r ? r.record.id : ""]);
  assert.equal(h.memory.search("gate").length, 0);
  h.episodic.setWorkingState("tsk_1", "cursor", { n: 120 }, 60_000);
  assert.deepEqual(h.episodic.getWorkingState("tsk_1", "cursor"), { n: 120 });
  h.clock.advance(61_000);
  assert.equal(h.episodic.getWorkingState("tsk_1", "cursor"), undefined);
  assert.equal(h.episodic.clearWorkingState("tsk_1"), 1);
});
