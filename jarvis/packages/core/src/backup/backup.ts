import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import Database from "better-sqlite3";
import { argon2id } from "hash-wasm";
import { JarvisError, newId } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import { seal, open, type KeyProvider } from "../crypto/keys.js";
import { zipFiles, unzipFiles } from "../memory/zip.js";

/**
 * Backups v1 (03 §9.16): nightly online backups, encrypted with AES-256-GCM under a key
 * derived from your recovery passphrase (Argon2id). The master key is escrowed inside the
 * encrypted body, so the passphrase alone restores on a new PC. The vault is excluded by
 * default. A weekly restore test proves each backup can actually be restored.
 */
export const KDF_DEFAULTS = { t: 3, m: 64 * 1024, p: 1 } as const;           // 64 MiB, 3 passes
const MAGIC = "JARVIS-BACKUP/1\n";

export interface BackupHeader { format: "jarvis.backup/1"; backup_id: string; created_at: string; kdf: { alg: "argon2id"; salt: string; t: number; m: number; p: number }; nonce: string; includes_vault: boolean }
export interface BackupManifest { backup_id: string; created_at: string; schema_version: number; counts: Record<string, number>; files: Record<string, string>; includes_vault: boolean }
export interface BackupRecord { backup_id: string; at: string; path: string; sha256: string; bytes: number; kind: string; verified_at?: string; verify_result?: string }

export async function deriveBackupKey(passphrase: string, salt: Buffer, kdf: { t: number; m: number; p: number } = KDF_DEFAULTS): Promise<Buffer> {
  if (passphrase.length < 12) throw new JarvisError("invalid_input", "use a recovery passphrase of at least 12 characters");
  const out = await argon2id({ password: passphrase.normalize("NFKC"), salt, iterations: kdf.t, memorySize: kdf.m, parallelism: kdf.p, hashLength: 32, outputType: "binary" });
  return Buffer.from(out);
}

function encrypt(key: Buffer, header: BackupHeader, body: Buffer): Buffer {
  const nonce = Buffer.from(header.nonce, "hex");
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const h = Buffer.from(JSON.stringify(header));
  c.setAAD(h);                                          // the header can't be swapped or edited
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([Buffer.from(MAGIC), Buffer.from(`${h.length}\n`), h, c.getAuthTag(), ct]);
}

export function readHeader(file: Buffer): { header: BackupHeader; rest: Buffer; headerBytes: Buffer } {
  if (!file.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new JarvisError("invalid_input", "not a JARVIS backup");
  const nl = file.indexOf(10, MAGIC.length);
  const len = Number(file.subarray(MAGIC.length, nl).toString());
  const headerBytes = file.subarray(nl + 1, nl + 1 + len);
  return { header: JSON.parse(headerBytes.toString()) as BackupHeader, rest: file.subarray(nl + 1 + len), headerBytes };
}

function decrypt(key: Buffer, file: Buffer): { header: BackupHeader; body: Buffer } {
  const { header, rest, headerBytes } = readHeader(file);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "hex"));
  d.setAAD(headerBytes);
  d.setAuthTag(rest.subarray(0, 16));
  try { return { header, body: Buffer.concat([d.update(rest.subarray(16)), d.final()]) }; }
  catch { throw new JarvisError("auth_required", "wrong passphrase, or the backup is damaged"); }
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(p, base)); else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export class BackupService {
  constructor(private ctx: CoreContext, private keys: KeyProvider & { escrowCopy?(): Buffer }, private o: { dataDir: string; destination?: string; retentionDays?: number }) {}

  get destination(): string { return this.o.destination ?? join(this.o.dataDir, "backups"); }

  /** Sets (or changes) the recovery passphrase. Only the derived key is kept, sealed under the master key. */
  async setPassphrase(passphrase: string): Promise<void> {
    const salt = randomBytes(16);
    const key = await deriveBackupKey(passphrase, salt);
    const sealed = seal(this.keys.dataKey("backups"), key, "backup-key");
    this.ctx.db.prepare("insert into settings(key, value, updated_at) values ('internal.backup_key', ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify({ salt: salt.toString("hex"), kdf: KDF_DEFAULTS, sealed: sealed.toString("base64") }), this.ctx.clock.iso());
    this.ctx.events.append({ type: "backup.passphrase_set", summary: "recovery passphrase set", data: {} });
  }

  configured(): boolean { return !!this.ctx.db.prepare("select 1 from settings where key = 'internal.backup_key'").get(); }

  private backupKey(): { key: Buffer; salt: string; kdf: { t: number; m: number; p: number } } {
    const r = this.ctx.db.prepare("select value from settings where key = 'internal.backup_key'").get() as { value: string } | undefined;
    if (!r) throw new JarvisError("missing_credential", "set a recovery passphrase first (Settings → Backups)");
    const v = JSON.parse(r.value) as { salt: string; kdf: { t: number; m: number; p: number }; sealed: string };
    return { key: open(this.keys.dataKey("backups"), Buffer.from(v.sealed, "base64"), "backup-key"), salt: v.salt, kdf: v.kdf };
  }

  list(): BackupRecord[] {
    return (this.ctx.db.prepare("select * from backups order by at desc").all() as (BackupRecord & { verified_at: string | null; verify_result: string | null })[])
      .map(r => ({ backup_id: r.backup_id, at: r.at, path: r.path, sha256: r.sha256, bytes: r.bytes, kind: r.kind, ...(r.verified_at ? { verified_at: r.verified_at } : {}), ...(r.verify_result ? { verify_result: r.verify_result } : {}) }));
  }

  /** One backup now (nightly, or before a migration or update). */
  async run(kind: "nightly" | "manual" | "pre_migration" = "manual", opts: { includeVault?: boolean } = {}): Promise<BackupRecord> {
    if (!this.keys.escrowCopy) throw new JarvisError("unsupported_operation", "this key provider can't escrow the master key");
    const { key, salt, kdf } = this.backupKey();
    const backup_id = newId("bkp", this.ctx.clock.now());
    const tmp = join(this.o.dataDir, "data", `.backup-${backup_id}.db`);
    await this.ctx.db.backup(tmp);                                       // SQLite online backup API: consistent while running
    try {
      const files: { name: string; data: Buffer }[] = [];
      const add = (name: string, data: Buffer) => files.push({ name, data });
      add("jarvis.db", readFileSync(tmp));
      for (const [dir, prefix] of [[join(this.o.dataDir, "data", "payloads"), "payloads"], [join(this.o.dataDir, "artifacts"), "artifacts"], [join(this.o.dataDir, "tools"), "tools"], [join(this.o.dataDir, "holdouts"), "holdouts"]] as const)
        for (const f of walk(dir)) add(`${prefix}/${f}`, readFileSync(join(dir, f)));
      if (opts.includeVault && existsSync(join(this.o.dataDir, "vault", "vault.bin"))) add("vault/vault.bin", readFileSync(join(this.o.dataDir, "vault", "vault.bin")));
      const snap = new Database(tmp, { readonly: true });
      let counts: Record<string, number>, schema_version: number;
      try {
        const tables = (snap.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'").all() as { name: string }[]).map(t => t.name);
        counts = Object.fromEntries(tables.map(t => [t, (snap.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n]));
        schema_version = (snap.prepare("select max(version) v from schema_migrations").get() as { v: number } | undefined)?.v ?? 0;
      } finally { snap.close(); }
      const manifest: BackupManifest = { backup_id, created_at: this.ctx.clock.iso(), schema_version, counts, files: Object.fromEntries(files.map(f => [f.name, sha(f.data)])), includes_vault: !!opts.includeVault };
      add("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
      const escrow = this.keys.escrowCopy();
      add("master.key.escrow", escrow);
      const body = zipFiles(files);
      escrow.fill(0);
      const header: BackupHeader = { format: "jarvis.backup/1", backup_id, created_at: manifest.created_at, kdf: { alg: "argon2id", salt, ...kdf }, nonce: randomBytes(12).toString("hex"), includes_vault: !!opts.includeVault };
      const blob = encrypt(key, header, body);
      mkdirSync(this.destination, { recursive: true });
      const path = join(this.destination, `${manifest.created_at.slice(0, 10)}-${backup_id}.jvbak`);
      writeFileSync(`${path}.part`, blob, { mode: 0o600 });
      renameSync(`${path}.part`, path);                                 // written, then renamed: never half a backup
      const rec: BackupRecord = { backup_id, at: manifest.created_at, path, sha256: sha(blob), bytes: blob.length, kind };
      this.ctx.db.prepare("insert into backups(backup_id, at, path, sha256, bytes, kind) values (?,?,?,?,?,?)").run(rec.backup_id, rec.at, rec.path, rec.sha256, rec.bytes, rec.kind);
      this.ctx.events.append({ type: "backup.created", summary: `${kind} backup, ${Math.round(blob.length / 1024)} KB`, data: { backup_id, bytes: blob.length, files: files.length, includes_vault: !!opts.includeVault } });
      this.expire();
      return rec;
    } finally { rmSync(tmp, { force: true }); rmSync(`${tmp}-wal`, { force: true }); rmSync(`${tmp}-shm`, { force: true }); }
  }

  /** The weekly restore test: decrypt into scratch, integrity_check, schema, counts, sample queries, file hashes. */
  async verify(backupId?: string): Promise<{ ok: boolean; checks: string[] }> {
    const rec = backupId ? this.list().find(b => b.backup_id === backupId) : this.list()[0];
    if (!rec) throw new JarvisError("invalid_input", "no backup to test");
    const checks: string[] = [];
    let ok = true;
    const fail = (c: string) => { ok = false; checks.push(`FAIL ${c}`); };
    const scratch = join(this.o.dataDir, "data", `.restore-test-${rec.backup_id}`);
    try {
      const blob = readFileSync(rec.path);
      if (sha(blob) !== rec.sha256) fail("file hash differs from when it was written"); else checks.push("file hash matches");
      const { body } = decrypt(this.backupKey().key, blob);
      checks.push("decrypts with the stored key");
      const files = new Map(unzipFiles(body).map(f => [f.name, f.data]));
      const manifest = JSON.parse(files.get("manifest.json")!.toString()) as BackupManifest;
      for (const [name, h] of Object.entries(manifest.files)) { const d = files.get(name); if (!d || sha(d) !== h) fail(`${name} hash`); }
      checks.push(`${Object.keys(manifest.files).length} file hashes checked`);
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "jarvis.db"), files.get("jarvis.db")!);
      const db = new Database(join(scratch, "jarvis.db"), { readonly: true });
      try {
        const ic = (db.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
        if (ic !== "ok") fail(`integrity_check: ${ic}`); else checks.push("integrity_check ok");
        const v = (db.prepare("select max(version) v from schema_migrations").get() as { v: number }).v;
        if (v !== manifest.schema_version) fail(`schema version ${v} ≠ ${manifest.schema_version}`); else checks.push(`schema version ${v}`);
        for (const [t, n] of Object.entries(manifest.counts)) { const got = (db.prepare(`select count(*) n from "${t}"`).get() as { n: number }).n; if (got !== n) fail(`${t}: ${got} rows ≠ ${n}`); }
        checks.push(`row counts match for ${Object.keys(manifest.counts).length} tables`);
        db.prepare("select task_id, status from tasks limit 5").all(); db.prepare("select seq from events order by seq desc limit 5").all();
        checks.push("sample queries ran");
      } finally { db.close(); }
      if (!files.get("master.key.escrow") || files.get("master.key.escrow")!.length !== 32) fail("master key escrow missing"); else checks.push("master key escrow present");
    } catch (e) { fail((e as Error).message); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
    const result = ok ? "passed" : checks.filter(c => c.startsWith("FAIL")).join("; ").slice(0, 500);
    this.ctx.db.prepare("update backups set verified_at = ?, verify_result = ? where backup_id = ?").run(this.ctx.clock.iso(), result, rec.backup_id);
    this.ctx.events.append({ type: "backup.restore_test", summary: `restore test ${ok ? "passed" : "FAILED"}`, data: { backup_id: rec.backup_id, ok } });
    return { ok, checks };
  }

  /** 30-day rolling retention; the newest backup that passed a restore test is always kept. */
  expire(): string[] {
    const cutoff = new Date(this.ctx.clock.now() - (this.o.retentionDays ?? 30) * 86_400_000).toISOString();
    const all = this.list();
    const keep = all.find(b => b.verify_result === "passed")?.backup_id ?? all[0]?.backup_id;
    const gone: string[] = [];
    for (const b of all.filter(x => x.at < cutoff && x.backup_id !== keep)) { rmSync(b.path, { force: true }); this.ctx.db.prepare("delete from backups where backup_id = ?").run(b.backup_id); gone.push(b.backup_id); }
    return gone;
  }

  /** "Purge from backups now" (03 §9.15): destroys every backup set, at the cost of those restore points. */
  purgeAll(): number {
    const all = this.list();
    for (const b of all) rmSync(b.path, { force: true });
    this.ctx.db.prepare("delete from backups").run();
    this.ctx.events.append({ type: "backup.purged", summary: `${all.length} backup(s) destroyed on your request`, data: { count: all.length } });
    return all.length;
  }

  /** Nightly and weekly work, called periodically by the runtime. */
  async maintenance(): Promise<{ backed_up?: string; tested?: boolean }> {
    if (!this.configured()) return {};
    const last = this.list()[0];
    const out: { backed_up?: string; tested?: boolean } = {};
    if (!last || this.ctx.clock.now() - Date.parse(last.at) > 23 * 3_600_000) out.backed_up = (await this.run("nightly")).backup_id;
    const lastTest = this.list().find(b => b.verified_at)?.verified_at;
    if (!lastTest || this.ctx.clock.now() - Date.parse(lastTest) > 7 * 86_400_000) out.tested = (await this.verify()).ok;
    return out;
  }
}

/**
 * Restore into a NEW data directory (guided restore, or a new PC). The passphrase opens
 * the backup; the escrowed master key is re-wrapped for this machine (DPAPI on Windows).
 */
export async function restoreBackup(input: { file: string; passphrase: string; targetDir: string; wrapMasterKey(key: Buffer): Promise<Buffer> | Buffer }): Promise<{ manifest: BackupManifest; files: number }> {
  if (existsSync(join(input.targetDir, "data", "jarvis.db"))) throw new JarvisError("conflict", "restore into a new, empty data directory");
  const blob = readFileSync(input.file);
  const { header } = readHeader(blob);
  const key = await deriveBackupKey(input.passphrase, Buffer.from(header.kdf.salt, "hex"), header.kdf);
  const { body } = decrypt(key, blob);
  const files = new Map(unzipFiles(body).map(f => [f.name, f.data]));
  const manifest = JSON.parse(files.get("manifest.json")!.toString()) as BackupManifest;
  for (const [name, h] of Object.entries(manifest.files)) if (sha(files.get(name) ?? Buffer.alloc(0)) !== h) throw new JarvisError("verification_failed", `backup file ${name} is damaged`);
  const place = (rel: string, data: Buffer) => {
    if (rel.includes("..") || rel.startsWith("/")) throw new JarvisError("invalid_input", `bad path in backup: ${rel}`);
    const dest = rel === "jarvis.db" ? join(input.targetDir, "data", "jarvis.db") : rel.startsWith("payloads/") ? join(input.targetDir, "data", rel) : join(input.targetDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data, { mode: 0o600 });
  };
  for (const [name, data] of files) if (name !== "manifest.json" && name !== "master.key.escrow") place(name, data);
  const escrow = files.get("master.key.escrow")!;
  mkdirSync(join(input.targetDir, "vault"), { recursive: true });
  writeFileSync(join(input.targetDir, "vault", "master.key"), await input.wrapMasterKey(escrow), { mode: 0o600 });
  escrow.fill(0);
  return { manifest, files: files.size };
}

export const _fileSize = (p: string) => statSync(p).size;
