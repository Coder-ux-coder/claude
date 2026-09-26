import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, sha256, JarvisError, type Sensitivity, type Clock } from "@jarvis/shared";
import type { Db } from "../db/database.js";
import { open, seal, type KeyProvider } from "../crypto/keys.js";

/**
 * Payload store (12 §17.5 data\payloads\): large or sensitive content lives here,
 * referenced by id from events and records, never duplicated into them.
 * Everything except "normal" sensitivity is encrypted; deletion removes the file
 * and keeps the content hash.
 */
export class PayloadStore {
  private mem = new Map<string, Buffer>();
  constructor(private db: Db, private dir: string | null, private keys: KeyProvider, private clock: Clock) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  put(content: string | Buffer, sensitivity: Sensitivity): { payload_id: string; content_hash: string } {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const payload_id = newId("pld", this.clock.now());
    const content_hash = sha256(buf);
    const encrypted = sensitivity !== "normal";
    const stored = encrypted ? seal(this.keys.dataKey("payloads"), buf, payload_id) : buf;
    if (this.dir) writeFileSync(join(this.dir, `${payload_id}.bin`), stored, { mode: 0o600 });
    else this.mem.set(payload_id, stored);
    this.db.prepare("insert into payloads(payload_id, content_hash, size_bytes, sensitivity, encrypted, created_at) values (?,?,?,?,?,?)")
      .run(payload_id, content_hash, buf.length, sensitivity, encrypted ? 1 : 0, this.clock.iso());
    return { payload_id, content_hash };
  }

  get(payload_id: string): Buffer {
    const row = this.db.prepare("select encrypted, deleted_at, content_hash from payloads where payload_id = ?").get(payload_id) as
      { encrypted: number; deleted_at: string | null; content_hash: string } | undefined;
    if (!row) throw new JarvisError("invalid_input", `unknown payload ${payload_id}`);
    if (row.deleted_at) throw new JarvisError("expired", `payload ${payload_id} was deleted`);
    const stored = this.dir ? readFileSync(join(this.dir, `${payload_id}.bin`)) : this.mem.get(payload_id);
    if (!stored) throw new JarvisError("internal_error", `payload ${payload_id} is missing`);
    const buf = row.encrypted ? open(this.keys.dataKey("payloads"), stored, payload_id) : stored;
    if (sha256(buf) !== row.content_hash) throw new JarvisError("internal_error", `payload ${payload_id} failed its hash check`);
    return buf;
  }

  getText(payload_id: string): string { return this.get(payload_id).toString("utf8"); }

  delete(payload_id: string): void {
    if (this.dir) {
      const f = join(this.dir, `${payload_id}.bin`);
      if (existsSync(f)) rmSync(f);
    } else this.mem.delete(payload_id);
    this.db.prepare("update payloads set deleted_at = ? where payload_id = ? and deleted_at is null").run(this.clock.iso(), payload_id);
  }

  /** Removes payload files with no database row (left behind by a rolled-back transaction). */
  gcOrphans(): number {
    if (!this.dir) return 0;
    let n = 0;
    const has = this.db.prepare("select 1 from payloads where payload_id = ?");
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".bin")) continue;
      if (!has.get(f.slice(0, -4))) { rmSync(join(this.dir, f)); n++; }
    }
    return n;
  }
}
