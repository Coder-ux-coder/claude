import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SystemClock, type Clock } from "@jarvis/shared";
import { openDatabase, type Db } from "./db/database.js";
import type { Migration } from "./db/migrations.js";
import { EventStore } from "./events/event-store.js";
import { PayloadStore } from "./events/payloads.js";
import { MasterKeyProvider, PlainFileWrapper, type KeyProvider, type MasterKeyWrapper } from "./crypto/keys.js";

/** Shared infrastructure every core module receives. */
export interface CoreContext {
  db: Db;
  clock: Clock;
  events: EventStore;
  payloads: PayloadStore;
  keys: KeyProvider;
  nodeId: string;
  dataDir: string | null;
  integrity: string;
  /** UnitOfWork: an IMMEDIATE transaction; events are delivered to subscribers only after commit. */
  tx<T>(fn: () => T): T;
}

export interface CreateContextOptions {
  dataDir?: string | null;       // null = in-memory (tests)
  clock?: Clock;
  keys?: KeyProvider;
  keyWrapper?: MasterKeyWrapper;
  extraMigrations?: Migration[];
  nodeId?: string;
}

export function createContext(opts: CreateContextOptions = {}): CoreContext {
  const dataDir = opts.dataDir ?? null;
  if (dataDir) mkdirSync(join(dataDir, "data"), { recursive: true });
  const { db, integrity } = openDatabase({ path: dataDir ? join(dataDir, "data", "jarvis.db") : ":memory:", ...(opts.extraMigrations ? { extraMigrations: opts.extraMigrations } : {}) });
  const clock = opts.clock ?? new SystemClock();
  const keys = opts.keys ?? (dataDir
    ? MasterKeyProvider.fromFile(join(dataDir, "vault", "master.key"), opts.keyWrapper ?? new PlainFileWrapper())
    : MasterKeyProvider.ephemeral());
  const payloads = new PayloadStore(db, dataDir ? join(dataDir, "data", "payloads") : null, keys, clock);
  const nodeId = opts.nodeId ?? "node_local";
  const events = new EventStore(db, payloads, clock, { node_id: nodeId, version: "0.1.0", process_instance: `pi_${process.pid}` });
  const tx = <T>(fn: () => T): T => {
    if (db.inTransaction) {
      // Nested: better-sqlite3 runs a nested transaction function as a SAVEPOINT,
      // so a caught inner failure rolls back only the inner writes and events.
      const mark = events.pendingMark();
      try { return db.transaction(fn)(); } catch (e) { events.truncatePending(mark); throw e; }
    }
    try {
      const r = db.transaction(fn).immediate();
      events.flush();
      return r;
    } catch (e) {
      events.discardPending();
      throw e;
    }
  };
  return { db, clock, events, payloads, keys, nodeId, dataDir, integrity, tx };
}
