import {
  newId, JarvisError, Conversation, Message, ExperienceRecord, Project, Commitment, OwnerProfile, DEFAULT_EGRESS,
  type Channel, type Provenance, type Sensitivity, type ResourceSelector,
} from "@jarvis/shared";
import type { CoreContext } from "../context.js";

/** Conversations and messages (content in payloads), experiences, projects, commitments, owner profile (03 §9.2). */
export class EpisodicStore {
  constructor(private ctx: CoreContext) {}

  // ---- owner profile ----
  getProfile(): OwnerProfile | undefined {
    const r = this.ctx.db.prepare("select profile from owner_profile where owner_id = 'owner'").get() as { profile: string } | undefined;
    return r ? OwnerProfile.parse(JSON.parse(r.profile)) : undefined;
  }
  setProfile(p: Omit<OwnerProfile, "owner_id" | "schema" | "revision" | "updated_at">): OwnerProfile {
    return this.ctx.tx(() => {
      const prev = this.getProfile();
      const next = OwnerProfile.parse({ ...p, owner_id: "owner", schema: "jarvis.owner_profile/1", revision: (prev?.revision ?? 0) + 1, updated_at: this.ctx.clock.iso() });
      this.ctx.db.prepare("insert into owner_profile(owner_id, revision, profile, updated_at) values ('owner', ?, ?, ?) on conflict(owner_id) do update set revision = excluded.revision, profile = excluded.profile, updated_at = excluded.updated_at")
        .run(next.revision, JSON.stringify(next), next.updated_at);
      this.ctx.events.append({ type: "profile.changed", summary: "Owner profile updated", data: { revision: next.revision } });
      return next;
    });
  }

  // ---- conversations and messages ----
  startConversation(channel: Channel, id?: string): Conversation {
    const now = this.ctx.clock.iso();
    const c = Conversation.parse({ id: id ?? newId("cnv", this.ctx.clock.now()), channel, started_at: now, last_message_at: now, task_ids: [], retention: { policy: "keep" } });
    this.ctx.db.prepare("insert into conversations(id, channel, started_at, last_message_at, conversation) values (?,?,?,?,?)").run(c.id, channel, now, now, JSON.stringify(c));
    return c;
  }
  getConversation(id: string): Conversation | undefined {
    const r = this.ctx.db.prepare("select conversation from conversations where id = ?").get(id) as { conversation: string } | undefined;
    return r ? Conversation.parse(JSON.parse(r.conversation)) : undefined;
  }
  linkTask(conversationId: string, taskId: string): void {
    const c = this.getConversation(conversationId);
    if (!c || c.task_ids.includes(taskId)) return;
    c.task_ids.push(taskId);
    this.ctx.db.prepare("update conversations set conversation = ? where id = ?").run(JSON.stringify(c), c.id);
  }

  /** Messages are SENSITIVE: the text goes to an encrypted payload; the row holds a reference. */
  addMessage(input: { conversation_id: string; author: Message["author"]; channel: Channel; trust: Message["trust"]; modality: Message["modality"]; text: string; transcript_confidence?: Message["transcript_confidence"] }): Message {
    return this.ctx.tx(() => {
      const c = this.getConversation(input.conversation_id);
      if (!c) throw new JarvisError("invalid_input", `unknown conversation ${input.conversation_id}`);
      const { payload_id } = this.ctx.payloads.put(input.text, "personal");
      const now = this.ctx.clock.iso();
      const m = Message.parse({ id: newId("msg", this.ctx.clock.now()), conversation_id: c.id, author: input.author, channel: input.channel, trust: input.trust,
        modality: input.modality, content_ref: payload_id, ...(input.transcript_confidence ? { transcript_confidence: input.transcript_confidence } : {}), created_at: now, redaction_state: "none" });
      this.ctx.db.prepare("insert into messages(id, conversation_id, author, trust, created_at, message) values (?,?,?,?,?,?)").run(m.id, c.id, m.author, m.trust, now, JSON.stringify(m));
      c.last_message_at = now;
      this.ctx.db.prepare("update conversations set last_message_at = ?, conversation = ? where id = ?").run(now, JSON.stringify(c), c.id);
      this.ctx.events.append({ type: "conversation.message", correlation: { conversation_id: c.id }, summary: `${m.author} message (${m.modality})`, data: { message_id: m.id, author: m.author, trust: m.trust } });
      return m;
    });
  }
  getMessage(id: string): Message | undefined {
    const r = this.ctx.db.prepare("select message from messages where id = ?").get(id) as { message: string } | undefined;
    return r ? Message.parse(JSON.parse(r.message)) : undefined;
  }
  messageText(id: string): string {
    const m = this.getMessage(id);
    if (!m) throw new JarvisError("invalid_input", `unknown message ${id}`);
    if (m.redaction_state === "purged") throw new JarvisError("expired", `message ${id} was purged`);
    return this.ctx.payloads.getText(m.content_ref);
  }
  recentMessages(conversationId: string, limit = 20): Message[] {
    return (this.ctx.db.prepare("select message from messages where conversation_id = ? order by created_at desc, rowid desc limit ?").all(conversationId, limit) as { message: string }[])
      .map(r => Message.parse(JSON.parse(r.message))).reverse();
  }
  purgeMessage(id: string): void {
    this.ctx.tx(() => {
      const m = this.getMessage(id);
      if (!m) return;
      this.ctx.payloads.delete(m.content_ref);
      this.ctx.db.prepare("update messages set message = ? where id = ?").run(JSON.stringify({ ...m, redaction_state: "purged" }), id);
    });
  }

  // ---- experiences ----
  addExperience(e: Omit<ExperienceRecord, "id" | "schema" | "created_at">, summaryText: string): ExperienceRecord {
    const rec = ExperienceRecord.parse({ ...e, id: newId("exp", this.ctx.clock.now()), schema: "jarvis.experience/1", created_at: this.ctx.clock.iso() });
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into experiences(id, task_id, goal_class, outcome, created_at, experience) values (?,?,?,?,?,?)").run(rec.id, rec.task_id, rec.goal_class, rec.outcome, rec.created_at, JSON.stringify(rec));
      this.ctx.db.prepare("insert into experience_fts(goal_class, summary, experience_id) values (?,?,?)").run(rec.goal_class.replace(/_/g, " "), summaryText, rec.id);
    });
    return rec;
  }
  searchExperiences(query: string, opts: { goal_class?: string; limit?: number } = {}): { record: ExperienceRecord; summary: string }[] {
    const terms = query.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(t => t.length > 1).map(t => `"${t}"*`);
    if (!terms.length) return [];
    const rows = this.ctx.db.prepare(`select e.experience, f.summary from experience_fts f join experiences e on e.id = f.experience_id
      where experience_fts match ? ${opts.goal_class ? "and e.goal_class = ?" : ""} order by (e.outcome = 'verified_success') desc, rank, e.created_at desc limit ?`)
      .all(...[terms.join(" OR "), ...(opts.goal_class ? [opts.goal_class] : []), opts.limit ?? 10]) as { experience: string; summary: string }[];
    return rows.map(r => ({ record: ExperienceRecord.parse(JSON.parse(r.experience)), summary: r.summary }));
  }

  // ---- projects and commitments ----
  createProject(input: { name: string; description?: string; resources?: ResourceSelector[]; stakeholders?: Project["stakeholders"]; provenance: Provenance; sensitivity?: Sensitivity }): Project {
    const now = this.ctx.clock.iso();
    const sensitivity = input.sensitivity ?? "normal";
    const p = Project.parse({ id: newId("prj", this.ctx.clock.now()), schema: "jarvis.project/1", name: input.name, ...(input.description ? { description: input.description } : {}),
      status: "active", goals: [], stakeholders: input.stakeholders ?? [], resources: input.resources ?? [], convention_ids: [], provenance: input.provenance,
      sensitivity, egress: DEFAULT_EGRESS[sensitivity], times: { created_at: now }, revision: 1 });
    this.ctx.db.prepare("insert into projects(id, status, name, project) values (?,?,?,?)").run(p.id, p.status, p.name, JSON.stringify(p));
    return p;
  }
  getProject(id: string): Project | undefined {
    const r = this.ctx.db.prepare("select project from projects where id = ?").get(id) as { project: string } | undefined;
    return r ? Project.parse(JSON.parse(r.project)) : undefined;
  }
  listProjects(): Project[] {
    return (this.ctx.db.prepare("select project from projects order by name").all() as { project: string }[]).map(r => Project.parse(JSON.parse(r.project)));
  }

  addCommitment(input: Omit<Commitment, "id" | "schema" | "times" | "revision" | "status" | "linked_schedule_ids" | "linked_task_ids"> & { linked_task_ids?: string[] }): Commitment {
    const c = Commitment.parse({ ...input, id: newId("cmt", this.ctx.clock.now()), schema: "jarvis.commitment/1", status: "open", linked_schedule_ids: [], linked_task_ids: input.linked_task_ids ?? [],
      times: { created_at: this.ctx.clock.iso() }, revision: 1 });
    this.ctx.tx(() => {
      this.ctx.db.prepare("insert into commitments(id, status, project_id, commitment) values (?,?,?,?)").run(c.id, c.status, c.project_id ?? null, JSON.stringify(c));
      for (const e of c.counterparty_entity_ids) this.ctx.db.prepare("insert into commitment_parties(commitment_id, entity_id) values (?,?)").run(c.id, e);
    });
    return c;
  }
  setCommitmentStatus(id: string, status: Commitment["status"]): Commitment {
    const r = this.ctx.db.prepare("select commitment from commitments where id = ?").get(id) as { commitment: string } | undefined;
    if (!r) throw new JarvisError("invalid_input", `unknown commitment ${id}`);
    const c = Commitment.parse({ ...JSON.parse(r.commitment), status });
    c.revision++;
    this.ctx.db.prepare("update commitments set status = ?, commitment = ? where id = ?").run(status, JSON.stringify(c), id);
    return c;
  }
  /** "Which open commitments involve Sam?" Only explicit commitments are tracked as due. */
  openCommitments(filter: { entity_id?: string; project_id?: string } = {}): Commitment[] {
    const rows = filter.entity_id
      ? this.ctx.db.prepare("select c.commitment from commitments c join commitment_parties p on p.commitment_id = c.id where p.entity_id = ? and c.status = 'open'").all(filter.entity_id)
      : filter.project_id ? this.ctx.db.prepare("select commitment from commitments where project_id = ? and status = 'open'").all(filter.project_id)
      : this.ctx.db.prepare("select commitment from commitments where status = 'open'").all();
    return (rows as { commitment: string }[]).map(r => Commitment.parse(JSON.parse(r.commitment)));
  }

  // ---- task working state (category 8) ----
  setWorkingState(taskId: string, key: string, value: unknown, ttlMs?: number): void {
    this.ctx.db.prepare("insert into task_working_state(task_id, key, value, expires_at) values (?,?,?,?) on conflict(task_id, key) do update set value = excluded.value, expires_at = excluded.expires_at")
      .run(taskId, key, JSON.stringify(value), ttlMs ? new Date(this.ctx.clock.now() + ttlMs).toISOString() : null);
  }
  getWorkingState(taskId: string, key: string): unknown {
    const r = this.ctx.db.prepare("select value, expires_at from task_working_state where task_id = ? and key = ?").get(taskId, key) as { value: string; expires_at: string | null } | undefined;
    if (!r || (r.expires_at && r.expires_at <= this.ctx.clock.iso())) return undefined;
    return JSON.parse(r.value);
  }
  /** Deleted at task close unless promoted by the write pipeline. */
  clearWorkingState(taskId: string): number {
    return this.ctx.db.prepare("delete from task_working_state where task_id = ?").run(taskId).changes;
  }
}
