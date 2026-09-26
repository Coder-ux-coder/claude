import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, JarvisError, redactMessage, type Clock } from "@jarvis/shared";
import { open, seal, type KeyProvider } from "../crypto/keys.js";

export interface CredentialMeta {
  credential_ref: string;                 // "cred_…" — never the secret
  kind: "oauth_token" | "api_key" | "connector_secret" | "backup_key";
  provider: string;                       // "anthropic", "google", …
  account_id?: string;                    // acc_…
  label: string;
  scopes?: string[];
  expires_at?: string;
  created_at: string;
  last_used_at?: string;
}

interface VaultFile { version: 1; entries: Record<string, { meta: CredentialMeta; secret: string }> }

/**
 * Exact-match scrubbing of every secret value the vault released in this process's
 * lifetime (04 §10.13 layer 1), plus pattern detectors (layer 2).
 */
export class SecretRedactor {
  private secrets = new Set<string>();
  register(value: string): void { if (value.length >= 6) this.secrets.add(value); }
  redact(text: string): string {
    let out = text;
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted-secret]");
    return redactMessage(out)
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
      .replace(/\b(?:ghp|gho|github_pat|xox[abprs])_[A-Za-z0-9_]{10,}\b/g, "[redacted-token]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-key]");
  }
}

/**
 * Credential Vault (04 §10.12): the only place credentials live. Encrypted file
 * (vault.bin) under a vault data key; the master key is DPAPI-wrapped on Windows
 * and moves behind the Guard in M6. Never in the database, context, logs or exports.
 * Secrets are used inside an executor callback and never returned to callers.
 */
export class CredentialVault {
  private data: VaultFile;
  constructor(private path: string | null, private keys: KeyProvider, private clock: Clock, readonly redactor = new SecretRedactor()) {
    this.data = { version: 1, entries: {} };
    if (path && existsSync(path)) {
      const plain = open(keys.dataKey("vault"), readFileSync(path), "vault.bin");
      this.data = JSON.parse(plain.toString("utf8")) as VaultFile;
    }
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.vault-${process.pid}.tmp`);
    writeFileSync(tmp, seal(this.keys.dataKey("vault"), Buffer.from(JSON.stringify(this.data)), "vault.bin"), { mode: 0o600 });
    renameSync(tmp, this.path);      // write to a temporary name, then rename (03 §9.16)
  }

  put(meta: Omit<CredentialMeta, "credential_ref" | "created_at">, secret: string): CredentialMeta {
    if (!secret) throw new JarvisError("invalid_input", "empty secret");
    const full: CredentialMeta = { ...meta, credential_ref: newId("cred", this.clock.now()), created_at: this.clock.iso() };
    this.data.entries[full.credential_ref] = { meta: full, secret };
    this.persist();
    return full;
  }

  /** Replaces a secret in place (token refresh) without changing its reference. */
  rotate(ref: string, secret: string, expires_at?: string): void {
    const e = this.data.entries[ref];
    if (!e) throw new JarvisError("missing_credential", `no credential ${ref}`);
    e.secret = secret; if (expires_at) e.meta.expires_at = expires_at;
    this.persist();
  }

  list(): CredentialMeta[] { return Object.values(this.data.entries).map(e => ({ ...e.meta })); }
  meta(ref: string): CredentialMeta | undefined { const e = this.data.entries[ref]; return e ? { ...e.meta } : undefined; }
  findByProvider(provider: string): CredentialMeta | undefined { return this.list().find(m => m.provider === provider); }

  /**
   * vault.use(credential_ref, purpose, operation): the secret exists only inside `fn`,
   * which runs inside a connector executor. Its value is registered for redaction.
   */
  async use<T>(ref: string, purpose: string, fn: (secret: string) => Promise<T> | T): Promise<T> {
    const e = this.data.entries[ref];
    if (!e) throw new JarvisError("missing_credential", `no credential configured (${ref})`);
    if (e.meta.expires_at && e.meta.expires_at <= this.clock.iso()) throw new JarvisError("auth_required", `${e.meta.label} expired; sign in again`);
    if (!purpose.trim()) throw new JarvisError("invalid_input", "vault.use needs a purpose");
    this.redactor.register(e.secret);
    e.meta.last_used_at = this.clock.iso();
    return await fn(e.secret);
  }

  /** Disconnecting deletes the credential; provider-side revocation is the connector's job. */
  delete(ref: string): boolean {
    if (!this.data.entries[ref]) return false;
    delete this.data.entries[ref];
    this.persist();
    return true;
  }
}
