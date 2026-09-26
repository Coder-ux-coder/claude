// Phase 0 spike: can the memory store's SQLite stack run on this PC?
// Checks WAL, FTS5, transaction rollback, online backup, integrity_check,
// concurrent reader during a write, and sqlite-vec KNN. Uses a temp folder;
// touches nothing else. Writes results/sqlite.json.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveResult } from "./lib/results.mjs";

const dir = mkdtempSync(join(tmpdir(), "jarvis-p0-sqlite-"));
const checks = [];
const check = (name, fn) => {
  const t0 = performance.now();
  try {
    const value = fn();
    const ok = value !== false;
    checks.push({ name, status: ok ? "pass" : "fail", value, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    checks.push({ name, status: "fail", error: String(e?.message ?? e) });
  }
};

const dbPath = join(dir, "memory.db");
const db = new Database(dbPath);

check("versions", () => ({
  sqlite: db.prepare("select sqlite_version() v").get().v,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
}));
check("wal_mode", () => db.pragma("journal_mode = WAL", { simple: true }) === "wal");
check("foreign_keys", () => { db.pragma("foreign_keys = ON"); return db.pragma("foreign_keys", { simple: true }) === 1; });

check("fts5", () => {
  db.exec(`create table memory_item(id text primary key, body text not null, kind text not null);
           create virtual table memory_fts using fts5(body, content='memory_item', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
           create trigger mi_ai after insert on memory_item begin insert into memory_fts(rowid, body) values (new.rowid, new.body); end;`);
  const ins = db.prepare("insert into memory_item(id, body, kind) values (?, ?, ?)");
  // HYPOTHETICAL sample data.
  ins.run("mem_1", "HYPOTHETICAL: prefers window seats on long flights", "preference");
  ins.run("mem_2", "HYPOTHETICAL: dentist appointment reminders two days before", "preference");
  ins.run("mem_3", "HYPOTHETICAL: café near office opens at 8", "fact");
  const hits = db.prepare("select m.id from memory_fts f join memory_item m on m.rowid = f.rowid where memory_fts match ? order by rank").all("flight*");
  const diacritic = db.prepare("select count(*) c from memory_fts where memory_fts match ?").get("cafe").c;
  return hits.length === 1 && hits[0].id === "mem_1" && diacritic === 1 ? { hits: hits.map(h => h.id), diacritic_folding: true } : false;
});

check("transaction_rollback", () => {
  const before = db.prepare("select count(*) c from memory_item").get().c;
  const tx = db.transaction(() => {
    db.prepare("insert into memory_item(id, body, kind) values ('mem_x', 'temp', 'fact')").run();
    throw new Error("simulated failure mid-write");
  });
  try { tx(); } catch { /* expected */ }
  return db.prepare("select count(*) c from memory_item").get().c === before;
});

check("reader_during_write", () => {
  const reader = new Database(dbPath, { readonly: true });
  db.exec("begin immediate");
  db.prepare("insert into memory_item(id, body, kind) values ('mem_w', 'pending write', 'fact')").run();
  const seen = reader.prepare("select count(*) c from memory_item").get().c; // must not block, must not see uncommitted
  db.exec("commit");
  const after = reader.prepare("select count(*) c from memory_item").get().c;
  reader.close();
  return seen === 3 && after === 4 ? { seen_during: seen, seen_after: after } : false;
});

let backupOk = false;
const backupPath = join(dir, "backup.db");
try {
  await db.backup(backupPath);
  const b = new Database(backupPath, { readonly: true });
  backupOk = b.pragma("integrity_check", { simple: true }) === "ok" && b.prepare("select count(*) c from memory_item").get().c === 4;
  b.close();
  checks.push({ name: "online_backup_restores", status: backupOk ? "pass" : "fail" });
} catch (e) {
  checks.push({ name: "online_backup_restores", status: "fail", error: String(e?.message ?? e) });
}

check("integrity_check", () => db.pragma("integrity_check", { simple: true }) === "ok");

check("sqlite_vec_knn", () => {
  sqliteVec.load(db);
  const version = db.prepare("select vec_version() v").get().v;
  db.exec("create virtual table memory_vec using vec0(embedding float[4])");
  const ins = db.prepare("insert into memory_vec(rowid, embedding) values (?, ?)");
  const vecs = [[1, 0, 0, 0], [0, 1, 0, 0], [0.9, 0.1, 0, 0], [0, 0, 1, 0]];
  vecs.forEach((v, i) => ins.run(BigInt(i + 1), new Float32Array(v)));
  const rows = db.prepare("select rowid, distance from memory_vec where embedding match ? order by distance limit 2")
    .all(new Float32Array([1, 0, 0, 0]));
  const ids = rows.map(r => Number(r.rowid));
  return ids[0] === 1 && ids[1] === 3 ? { vec_version: version, nearest: ids } : false;
});

check("bulk_insert_10k", () => {
  const ins = db.prepare("insert into memory_item(id, body, kind) values (?, ?, 'fact')");
  const t0 = performance.now();
  db.transaction(() => { for (let i = 0; i < 10000; i++) ins.run(`bulk_${i}`, `synthetic note number ${i} about topic ${i % 50}`); })();
  const insertMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const n = db.prepare("select count(*) c from memory_fts where memory_fts match ?").get("topic").c;
  return { insert_ms: insertMs, fts_query_ms: Math.round(performance.now() - t1), fts_hits: n };
});

db.close();
rmSync(dir, { recursive: true, force: true });

const failed = checks.filter(c => c.status === "fail");
const status = failed.length === 0 ? "pass" : (failed.every(c => c.name === "sqlite_vec_knn") ? "partial" : "fail");
for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name}${c.error ? "  " + c.error : ""}`);
saveResult("sqlite", { status, note: status === "partial" ? "sqlite-vec failed: M1 falls back to FTS-only recall" : null, checks });
console.log(`SQLITE: ${status}`);
