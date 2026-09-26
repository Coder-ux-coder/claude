import { newId, JarvisError } from "@jarvis/shared";
import type { CoreContext } from "../context.js";
import type { CredentialVault } from "./vault.js";

export interface AccountConnection {
  account_id: string;                     // acc_…
  connector: string;                      // "google", "anthropic", "upwork", …
  identity: string;                       // e.g. an email address (SENSITIVE)
  scopes: string[];
  credential_ref: string | null;          // cred_… in the vault; never the secret
  status: "connected" | "needs_auth" | "revoked";
  token_expires_at?: string;
  last_refresh_at?: string;
  revocation_instructions: string;
  connected_at: string;
}

/** Account connections (04 §10.12). Disconnecting deletes the credential; the connector revokes it at the provider. */
export class AccountStore {
  private listeners: ((accountId: string) => void)[] = [];
  constructor(private ctx: CoreContext, private vault: CredentialVault) {}

  onRevoked(fn: (accountId: string) => void): void { this.listeners.push(fn); }

  connect(input: Omit<AccountConnection, "account_id" | "status" | "connected_at">): AccountConnection {
    const a: AccountConnection = { ...input, account_id: newId("acc", this.ctx.clock.now()), status: "connected", connected_at: this.ctx.clock.iso() };
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into accounts(account_id, connector, status, record) values (?,?,?,?)").run(a.account_id, a.connector, a.status, JSON.stringify(a));
      this.ctx.events.append({ type: "account.connected", summary: `${a.connector} account connected`, data: { account_id: a.account_id, connector: a.connector, scopes: a.scopes } });
    });
    return a;
  }

  get(id: string): AccountConnection | undefined {
    const r = this.ctx.db.prepare("select record from accounts where account_id = ?").get(id) as { record: string } | undefined;
    return r ? JSON.parse(r.record) as AccountConnection : undefined;
  }
  list(): AccountConnection[] {
    return (this.ctx.db.prepare("select record from accounts order by account_id").all() as { record: string }[]).map(r => JSON.parse(r.record) as AccountConnection);
  }

  setStatus(id: string, status: AccountConnection["status"]): void {
    const a = this.get(id);
    if (!a) throw new JarvisError("invalid_input", `unknown account ${id}`);
    this.ctx.db.prepare("update accounts set status = ?, record = ? where account_id = ?").run(status, JSON.stringify({ ...a, status }), id);
  }

  /** Revocation: credential deleted, pending actions for the account invalidated (via listeners), tasks wait for auth. */
  revoke(id: string, owner_verified: boolean): AccountConnection {
    if (!owner_verified) throw new JarvisError("missing_permission", "only you can disconnect an account");
    const a = this.get(id);
    if (!a || a.status === "revoked") throw new JarvisError("conflict", "account is not connected");
    if (a.credential_ref) this.vault.delete(a.credential_ref);
    const next: AccountConnection = { ...a, status: "revoked", credential_ref: null };
    this.ctx.tx(() => {
      this.ctx.db.prepare("update accounts set status = 'revoked', record = ? where account_id = ?").run(JSON.stringify(next), id);
      this.ctx.events.append({ type: "account.revoked", summary: `${a.connector} account disconnected`, data: { account_id: id } });
    });
    for (const l of this.listeners) l(id);
    return next;
  }
}
