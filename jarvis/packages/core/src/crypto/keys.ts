import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { JarvisError } from "@jarvis/shared";

/**
 * Master-key protection (03 §9.14). On Windows the master key is wrapped with
 * DPAPI (CurrentUser) by the Exec Host; from M6 the Guard holds it. Every data
 * key is derived from the master key per purpose, so payloads, vault entries and
 * backups use different keys.
 */
export interface KeyProvider {
  readonly kind: string;
  dataKey(purpose: "payloads" | "vault" | "backups" | "artifacts" | "grants" | "memory_sensitive" | "nep_grants"): Buffer;
}

export interface MasterKeyWrapper {
  readonly kind: string;
  wrap(key: Buffer): Buffer;
  unwrap(blob: Buffer): Buffer;
}

/** Development and test wrapper: stores the key unwrapped in a 0600 file. Never the production default on Windows. */
export class PlainFileWrapper implements MasterKeyWrapper {
  readonly kind = "plain_file_dev";
  wrap(key: Buffer): Buffer { return key; }
  unwrap(blob: Buffer): Buffer { return blob; }
}

export class MasterKeyProvider implements KeyProvider {
  private master: Buffer;
  readonly kind: string;
  constructor(master: Buffer, kind: string) {
    if (master.length !== 32) throw new JarvisError("internal_error", "master key must be 32 bytes");
    this.master = master; this.kind = kind;
  }
  static ephemeral(): MasterKeyProvider { return new MasterKeyProvider(randomBytes(32), "ephemeral"); }

  /** Loads the wrapped master key from `path`, creating it on first run. */
  static fromFile(path: string, wrapper: MasterKeyWrapper): MasterKeyProvider {
    if (existsSync(path)) return new MasterKeyProvider(wrapper.unwrap(readFileSync(path)), wrapper.kind);
    mkdirSync(dirname(path), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(path, wrapper.wrap(key), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* not supported on some filesystems */ }
    return new MasterKeyProvider(key, wrapper.kind);
  }

  /** First run creates the key; later runs unwrap it. The wrapper may be asynchronous (DPAPI through the Exec Host). */
  static async fromFileAsync(path: string, wrapper: { kind: string; wrap(k: Buffer): Promise<Buffer>; unwrap(b: Buffer): Promise<Buffer> }): Promise<MasterKeyProvider> {
    if (existsSync(path)) return new MasterKeyProvider(await wrapper.unwrap(readFileSync(path)), wrapper.kind);
    mkdirSync(dirname(path), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(path, await wrapper.wrap(key), { mode: 0o600 });
    return new MasterKeyProvider(key, wrapper.kind);
  }

  dataKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.master, Buffer.alloc(0), `jarvis/${purpose}/v1`, 32));
  }
}

const MAGIC = Buffer.from("JV1");

/** AES-256-GCM: MAGIC | 12-byte nonce | 16-byte tag | ciphertext. `aad` binds the blob to its record id. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), body]);
}

export function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 31 || !blob.subarray(0, 3).equals(MAGIC)) throw new JarvisError("internal_error", "not a sealed blob");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(3, 15));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(15, 31));
  try {
    return Buffer.concat([d.update(blob.subarray(31)), d.final()]);
  } catch {
    throw new JarvisError("internal_error", "sealed blob failed authentication (wrong key or tampered)");
  }
}
