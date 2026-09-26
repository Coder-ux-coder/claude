import Database from "better-sqlite3";
import { JarvisError } from "@jarvis/shared";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type Db = Database.Database;

export interface OpenOptions {
  path: string;                 // ":memory:" for tests
  readonly?: boolean;
  /** Only the Update Supervisor may stage migrations (01 §4.5 step 2). Default true for dev and tests. */
  applyMigrations?: boolean;
  extraMigrations?: Migration[];
}

export interface OpenResult { db: Db; integrity: "ok" | string; schemaVersion: number; pendingMigrations: number }

/** Opens jarvis.db with the pragmas the design relies on: WAL, foreign keys, busy timeout. */
export function openDatabase(opts: OpenOptions): OpenResult {
  let db: Db;
  let integrity: string;
  try {
    db = new Database(opts.path, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
    if (!opts.readonly && opts.path !== ":memory:") db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    integrity = String(db.pragma("quick_check", { simple: true }));
  } catch (e) {
    // Fail closed (03 §9.9, F22): callers treat this as "policy and memory unavailable".
    throw new JarvisError("policy_unavailable", `database cannot be opened: ${(e as Error).message}`);
  }
  const all = [...MIGRATIONS, ...(opts.extraMigrations ?? [])].sort((a, b) => a.version - b.version);
  if (!opts.readonly) db.exec("create table if not exists schema_migrations (version integer primary key, name text not null, applied_at text not null)");
  const applied = new Set<number>(opts.readonly ? [] : (db.prepare("select version from schema_migrations").all() as { version: number }[]).map(r => r.version));
  const pending = all.filter(m => !applied.has(m.version));
  if (!opts.readonly && (opts.applyMigrations ?? true) && integrity === "ok") {
    for (const m of pending) {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare("insert into schema_migrations(version, name, applied_at) values (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
      })();
    }
  }
  const version = opts.readonly ? 0 : ((db.prepare("select max(version) v from schema_migrations").get() as { v: number | null }).v ?? 0);
  const stillPending = all.filter(m => m.version > version).length;
  return { db, integrity, schemaVersion: version, pendingMigrations: stillPending };
}

/** Runs fn in an IMMEDIATE transaction (the Task Engine's UnitOfWork). */
export function unitOfWork<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

