import { newId, JarvisError, type ResourceLease } from "@jarvis/shared";
import type { CoreContext } from "../context.js";

interface LeaseRow {
  lease_id: string; resource: string; mode: "exclusive" | "shared_read"; holder: string; task_id: string; process_instance: string;
  fencing_token: number; acquired_at: string; expires_at: string; heartbeat_at: string; state: ResourceLease["state"]; revoked_reason: string | null;
}

export type AcquireResult = { granted: true; lease: ResourceLease } | { granted: false; queue_position: number; holders: string[] };

/**
 * Resource leases with fencing tokens (02 §7.8, 12 §17.7). Tokens are monotonic
 * per resource and never reused, so a holder that lost its lease cannot act.
 */
export class LeaseManager {
  constructor(private ctx: CoreContext, private processInstance = `pi_${process.pid}`) {}

  private toLease(r: LeaseRow): ResourceLease {
    return {
      lease_id: r.lease_id, resource: r.resource, mode: r.mode, holder: JSON.parse(r.holder), fencing_token: r.fencing_token,
      acquired_at: r.acquired_at, expires_at: r.expires_at, heartbeat_at: r.heartbeat_at, state: r.state,
      ...(r.revoked_reason ? { revoked_reason: r.revoked_reason as NonNullable<ResourceLease["revoked_reason"]> } : {}),
    };
  }

  private active(resource: string): LeaseRow[] {
    this.expireStale();
    return this.ctx.db.prepare("select * from leases where resource = ? and state = 'active'").all(resource) as LeaseRow[];
  }

  acquire(resource: string, mode: ResourceLease["mode"], holder: { task_id: string; work_order_id?: string }, ttlMs = 5 * 60_000): AcquireResult {
    return this.ctx.tx(() => {
      const active = this.active(resource).filter(l => l.task_id !== holder.task_id || l.mode !== mode);
      const mine = this.ctx.db.prepare("select * from leases where resource = ? and state = 'active' and task_id = ? and mode = ?").get(resource, holder.task_id, mode) as LeaseRow | undefined;
      if (mine) return { granted: true, lease: this.toLease(mine) };
      const compatible = active.every(l => l.task_id === holder.task_id || (l.mode === "shared_read" && mode === "shared_read"));
      const waiting = this.ctx.db.prepare("select queue_id, task_id from lease_queue where resource = ? and state = 'waiting' order by queue_id").all(resource) as { queue_id: number; task_id: string }[];
      const firstWaiter = waiting[0];
      const ahead = firstWaiter && firstWaiter.task_id !== holder.task_id;
      if (!compatible || (ahead && mode === "exclusive")) {
        let pos = waiting.findIndex(w => w.task_id === holder.task_id);
        if (pos < 0) {
          this.ctx.db.prepare("insert into lease_queue(resource, mode, task_id, requested_at, state) values (?,?,?,?, 'waiting')").run(resource, mode, holder.task_id, this.ctx.clock.iso());
          pos = waiting.length;
        }
        return { granted: false, queue_position: pos + 1, holders: active.map(l => l.task_id) };
      }
      const tokenRow = this.ctx.db.prepare("select last_token from lease_tokens where resource = ?").get(resource) as { last_token: number } | undefined;
      const token = (tokenRow?.last_token ?? 0) + 1;
      this.ctx.db.prepare("insert into lease_tokens(resource, last_token) values (?, ?) on conflict(resource) do update set last_token = excluded.last_token").run(resource, token);
      const now = this.ctx.clock.now();
      const lease: ResourceLease = {
        lease_id: newId("lse", now), resource, mode,
        holder: { task_id: holder.task_id, ...(holder.work_order_id ? { work_order_id: holder.work_order_id } : {}), process_instance: this.processInstance, node_id: this.ctx.nodeId },
        fencing_token: token, acquired_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs).toISOString(), heartbeat_at: new Date(now).toISOString(), state: "active",
      };
      this.ctx.db.prepare(`insert into leases(lease_id, resource, mode, holder, task_id, process_instance, fencing_token, acquired_at, expires_at, heartbeat_at, state)
        values (?,?,?,?,?,?,?,?,?,?, 'active')`).run(lease.lease_id, resource, mode, JSON.stringify(lease.holder), holder.task_id, this.processInstance, token, lease.acquired_at, lease.expires_at, lease.heartbeat_at);
      this.ctx.db.prepare("update lease_queue set state = 'granted' where resource = ? and task_id = ? and state = 'waiting'").run(resource, holder.task_id);
      this.ctx.events.append({ type: "lease.acquired", correlation: { task_id: holder.task_id }, summary: `${resource} (${mode}) token ${token}`, data: { lease_id: lease.lease_id, resource, mode, fencing_token: token } });
      return { granted: true, lease };
    });
  }

  heartbeat(leaseId: string, ttlMs = 5 * 60_000): ResourceLease {
    return this.ctx.tx(() => {
      const r = this.ctx.db.prepare("select * from leases where lease_id = ?").get(leaseId) as LeaseRow | undefined;
      if (!r || r.state !== "active" || Date.parse(r.expires_at) <= this.ctx.clock.now()) throw new JarvisError("conflict", `lease ${leaseId} is no longer active`);
      const now = this.ctx.clock.now();
      this.ctx.db.prepare("update leases set heartbeat_at = ?, expires_at = ? where lease_id = ?").run(new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), leaseId);
      return this.toLease(this.ctx.db.prepare("select * from leases where lease_id = ?").get(leaseId) as LeaseRow);
    });
  }

  release(leaseId: string): void {
    this.ctx.tx(() => {
      const r = this.ctx.db.prepare("select * from leases where lease_id = ?").get(leaseId) as LeaseRow | undefined;
      if (!r || r.state !== "active") return;
      this.ctx.db.prepare("update leases set state = 'released' where lease_id = ?").run(leaseId);
      this.ctx.events.append({ type: "lease.released", correlation: { task_id: r.task_id }, summary: r.resource, data: { lease_id: leaseId, resource: r.resource } });
    });
  }

  revoke(filter: (l: ResourceLease) => boolean, reason: NonNullable<ResourceLease["revoked_reason"]>): string[] {
    return this.ctx.tx(() => {
      const rows = this.ctx.db.prepare("select * from leases where state = 'active'").all() as LeaseRow[];
      const out: string[] = [];
      for (const r of rows) {
        const l = this.toLease(r);
        if (!filter(l)) continue;
        this.ctx.db.prepare("update leases set state = 'revoked', revoked_reason = ? where lease_id = ?").run(reason, r.lease_id);
        this.ctx.events.append({ type: "lease.revoked", correlation: { task_id: r.task_id }, summary: `${r.resource}: ${reason}`, data: { lease_id: r.lease_id, resource: r.resource, reason } });
        out.push(r.lease_id);
      }
      return out;
    });
  }

  releaseForTask(taskId: string, opts: { only?: (resource: string) => boolean } = {}): void {
    this.ctx.tx(() => {
      for (const r of this.ctx.db.prepare("select * from leases where task_id = ? and state = 'active'").all(taskId) as LeaseRow[])
        if (!opts.only || opts.only(r.resource)) this.release(r.lease_id);
      if (!opts.only) this.ctx.db.prepare("update lease_queue set state = 'cancelled' where task_id = ? and state = 'waiting'").run(taskId);
    });
  }

  heldBy(taskId: string): ResourceLease[] {
    return (this.ctx.db.prepare("select * from leases where task_id = ? and state = 'active'").all(taskId) as LeaseRow[]).map(r => this.toLease(r));
  }

  /** Fencing check at the real boundary: the token must be the resource's newest and its lease still active. */
  validateFencing(resource: string, token: number): void {
    const last = (this.ctx.db.prepare("select last_token from lease_tokens where resource = ?").get(resource) as { last_token: number } | undefined)?.last_token;
    const lease = this.ctx.db.prepare("select * from leases where resource = ? and fencing_token = ?").get(resource, token) as LeaseRow | undefined;
    if (last === undefined || !lease) throw new JarvisError("conflict", `no lease with token ${token} on ${resource}`);
    const live = lease.state === "active" && Date.parse(lease.expires_at) > this.ctx.clock.now();
    if (!live) throw new JarvisError("conflict", `stale fencing token ${token} on ${resource} (lease ${lease.state})`);
    if (lease.mode === "exclusive" && token !== last) throw new JarvisError("conflict", `stale fencing token ${token} on ${resource} (current ${last})`);
  }

  /** Expires leases past their expiry, and those held by dead process instances (01 §4.5). */
  expireStale(deadProcess?: (processInstance: string) => boolean): string[] {
    const now = this.ctx.clock.now();
    const rows = this.ctx.db.prepare("select * from leases where state = 'active'").all() as LeaseRow[];
    const out: string[] = [];
    for (const r of rows) {
      if (Date.parse(r.expires_at) <= now || (deadProcess && deadProcess(r.process_instance))) {
        this.ctx.db.prepare("update leases set state = 'expired', revoked_reason = 'expired' where lease_id = ?").run(r.lease_id);
        out.push(r.lease_id);
      }
    }
    if (out.length) this.ctx.events.append({ type: "lease.expired", summary: `${out.length} lease(s) expired`, data: { lease_ids: out } });
    return out;
  }

  queue(resource: string): { task_id: string; position: number }[] {
    return (this.ctx.db.prepare("select task_id from lease_queue where resource = ? and state = 'waiting' order by queue_id").all(resource) as { task_id: string }[])
      .map((r, i) => ({ task_id: r.task_id, position: i + 1 }));
  }
}
