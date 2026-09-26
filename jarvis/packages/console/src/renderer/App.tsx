import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JarvisApi, JarvisEventEnvelope } from "../shared/api.js";
import { Recorder, Speaker } from "./voice.js";

type View = "conversation" | "tasks" | "needs" | "schedules" | "memory" | "rules" | "usage" | "settings";
interface Msg { id: string; author: "owner" | "jarvis" | "system"; text: string | null; modality: string }
interface TaskRow { task_id: string; objective: string; mode: string; status: string; wait_reason: string | null; status_detail: string | null; origin: string }
interface Status { database?: "ok" | "unavailable"; safe_mode: boolean; halted: boolean; anthropic_key: boolean; needs_you: number; open_decisions: number; policy_revision: number; boss_route: string[] }
interface Decision { decision_request_id: string; task_id: string; why: { text: string }; proposal: { summary: string; target: string; expected_effect: string; reversibility: string; important_terms: string[] }; options: { id: string; label: string }[]; proposal_fingerprint: string; expires_at: string }
interface Note { id: string; kind: string; title: string; body: string; schedule_id?: string; created_at: string }
interface Schedule { schedule_id: string; kind: string; interpretation: string; status: string; next_fire_utc: string | null }
interface Memory { id: string; type: string; text: string; status: string; sensitivity: string }
interface Rule { rule_id: string; kind: string; text: string; status: string; protection: string; compile?: { interpretation?: string } }

/**
 * Out-of-order responses: an event-triggered refetch can resolve after a newer one.
 * `latest()` marks a request; only the most recent request's result is applied.
 */
function useLatest(): () => <T>(apply: (v: T) => void) => (v: T) => void {
  const seq = useRef(0);
  return useCallback(() => { const n = ++seq.current; return <T,>(apply: (v: T) => void) => (v: T) => { if (n === seq.current) apply(v); }; }, []);
}

const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e));

export function App({ api }: { api: JarvisApi }) {
  const [view, setView] = useState<View>("conversation");
  const [conn, setConn] = useState<"connected" | "reconnecting">("connected");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);                       // bumps on relevant events → views refetch
  const speaker = useMemo(() => new Speaker(), []);

  const latestStatus = useLatest();
  const refreshStatus = useCallback(() => { api.call<Status>("status.get").then(latestStatus()(setStatus)).catch(e => setError(errText(e))); }, [api, latestStatus]);
  useEffect(() => {
    refreshStatus();
    const offE = api.onEvent((e: JarvisEventEnvelope) => {
      if (/^(task|action|decision|notification|schedule|conversation|policy|rule|broker|memory|credential|settings)/.test(e.event.type)) setTick(t => t + 1);
    });
    const offC = api.onConnection(s => { setConn(s); if (s === "connected") refreshStatus(); });
    return () => { offE(); offC(); };
  }, [api, refreshStatus]);
  useEffect(() => { refreshStatus(); }, [tick, refreshStatus]);

  const stop = async () => {
    speaker.stop();
    try { await api.call("emergency.stop"); refreshStatus(); } catch (e) { setError(errText(e)); }
  };
  const tabs: [View, string][] = [["conversation", "Conversation"], ["tasks", "Tasks"], ["needs", "Needs you"], ["schedules", "Schedules"], ["memory", "Memory"], ["rules", "Rules"], ["usage", "Usage"], ["settings", "Settings"]];
  const needs = (status?.needs_you ?? 0) + (status?.open_decisions ?? 0);

  return (
    <div className="app">
      <header>
        <h1>JARVIS</h1>
        <nav>{tabs.map(([v, l]) => (
          <button key={v} className={view === v ? "tab active" : "tab"} onClick={() => setView(v)} data-testid={`tab-${v}`}>
            {l}{v === "needs" && needs > 0 ? <span className="badge" data-testid="needs-badge">{needs}</span> : null}
          </button>))}
        </nav>
        <div className="state">
          {conn !== "connected" && <span className="pill warn" data-testid="conn">Reconnecting…</span>}
          {status?.database === "unavailable" && <span className="pill danger" data-testid="db-down">Database unavailable — alarms still sound; nothing else runs</span>}
          {status?.safe_mode && <span className="pill warn">Safe mode</span>}
          {status?.halted
            ? <button className="pill danger" data-testid="resume" onClick={() => api.call("emergency.resume").then(refreshStatus).catch(e => setError(errText(e)))}>Stopped — resume</button>
            : <button className="stop" data-testid="emergency-stop" onClick={stop} title="Stop everything (also Ctrl+Alt+Shift+Pause)">Stop</button>}
        </div>
      </header>
      {status && !status.anthropic_key && view !== "settings" && (
        <div className="banner" data-testid="key-banner">No Anthropic API key yet. <button className="link" onClick={() => setView("settings")}>Add it in Settings</button> — it is stored only in the local vault.</div>)}
      {error && <div className="banner error" role="alert" data-testid="error">{error} <button className="link" onClick={() => setError(null)}>dismiss</button></div>}
      <main>
        {view === "conversation" && <Onboarding api={api} onError={setError} />}
        {view === "conversation" && <Conversation api={api} speaker={speaker} tick={tick} onError={setError} />}
        {view === "tasks" && <Tasks api={api} tick={tick} onError={setError} />}
        {view === "needs" && <NeedsYou api={api} tick={tick} onError={setError} />}
        {view === "schedules" && <Schedules api={api} tick={tick} onError={setError} />}
        {view === "memory" && <MemoryView api={api} tick={tick} onError={setError} />}
        {view === "rules" && <Rules api={api} tick={tick} onError={setError} />}
        {view === "usage" && <Usage api={api} tick={tick} onError={setError} />}
        {view === "settings" && <Settings api={api} status={status} onSaved={refreshStatus} onError={setError} />}
      </main>
    </div>
  );
}

interface ViewProps { api: JarvisApi; tick: number; onError: (e: string) => void }

function Conversation({ api, speaker, tick, onError }: ViewProps & { speaker: Speaker }) {
  const [conv, setConv] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [files, setFiles] = useState<{ name: string; media_type: string; data_base64: string; size: number }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useMemo(() => new Recorder(), []);
  const lastSpoken = useRef<string | null>(null);
  const reopening = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const lastInputVoice = useRef(false);
  useEffect(() => { speaker.onChange = setSpeaking; return () => { speaker.onChange = null; }; }, [speaker]);
  // Reopen the most recent conversation (after a restart or reload).
  useEffect(() => { api.call<{ id: string }[]>("conversation.list").then(l => { if (l[0]) setConv(c => { if (c) return c; reopening.current = true; return l[0]!.id; }); }).catch(() => {}); }, [api]);
  useEffect(() => { api.call<Record<string, unknown>>("settings.get").then(s => setSpeakReplies(s["voice.speak_replies"] === true)).catch(() => {}); }, [api]);
  const latest = useLatest();
  const load = useCallback(async (id: string) => {
    const only = latest();
    const m = await api.call<Msg[]>("conversation.messages", { conversation_id: id, limit: 100 });
    let applied = false;
    only<Msg[]>(v => { setMsgs(v); applied = true; })(m);
    if (!applied) return;
    const last = m[m.length - 1];
    // Spoken output only when you asked for it: the setting, or a reply to something you said aloud (09 §14.3).
    if (reopening.current) { reopening.current = false; lastSpoken.current = last?.id ?? null; return; }     // never read old messages on open
    if (last && last.author === "jarvis" && last.text && last.id !== lastSpoken.current && (speakReplies || lastInputVoice.current)) { lastSpoken.current = last.id; speaker.speak(last.text); }
  }, [api, speaker, speakReplies, latest]);
  useEffect(() => { if (conv) void load(conv).catch(e => onError(errText(e))); }, [conv, tick, load, onError]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [msgs]);

  const send = async (content: string, modality: "text" | "voice" = "text", confidence?: "high" | "medium" | "low") => {
    if (!content.trim() && !files.length) return;
    lastInputVoice.current = modality === "voice";
    setBusy(true);
    try {
      const attachments = files.map(({ size: _s, ...f }) => f);
      const r = await api.call<{ conversation_id: string }>("conversation.send", { content, modality, ...(conv ? { conversation_id: conv } : {}), ...(confidence ? { transcript_confidence: confidence } : {}), ...(attachments.length ? { attachments } : {}) });
      setConv(r.conversation_id);
      await load(r.conversation_id);
      setText(""); setFiles([]);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };
  const pick = async (list: FileList | null) => {
    const picked = [...(list ?? [])].slice(0, 8);
    try {
      const read = await Promise.all(picked.map(async f => {
        if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is over 25 MB`);
        const b = new Uint8Array(await f.arrayBuffer());
        let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
        return { name: f.name, media_type: f.type || "application/octet-stream", data_base64: btoa(bin), size: f.size };
      }));
      setFiles(x => {
        const next = [...x, ...read].slice(0, 8);
        // One message carries at most 32 MB of attachments (the Coordinator's request limit).
        if (next.reduce((a, f) => a + f.size, 0) > 32 * 1024 * 1024) { onError("Attachments in one message must total under 32 MB."); return x; }
        return next;
      });
    } catch (e) { onError(errText(e)); }
    if (fileInput.current) fileInput.current.value = "";
  };
  const pttDown = async () => {
    speaker.stop();                                  // barge-in: talking over JARVIS silences it
    try { await recorder.start(); setRecording(true); } catch (e) { onError(`Microphone: ${errText(e)}`); }
  };
  const pttUp = async () => {
    if (!recorder.recording) return;
    setRecording(false);
    const wav = await recorder.stop();
    if (!wav) return;
    try {
      const t = await api.transcribe(wav);
      if (!t.text) { onError("I didn't catch that."); return; }
      await send(t.text, "voice", t.confidence);
    } catch (e) { onError(errText(e)); }
  };

  return (
    <section className="conversation">
      <div className="messages" data-testid="messages">
        {msgs.length === 0 && <p className="muted">Ask JARVIS anything, or hold the mic button to talk.</p>}
        {msgs.map(m => (
          <div key={m.id} className={`msg ${m.author}`} data-testid={`msg-${m.author}`}>
            <span className="who">{m.author === "owner" ? "You" : m.author === "jarvis" ? "JARVIS" : "System"}{m.modality === "voice" ? " (voice)" : ""}</span>
            <p>{m.text ?? <em>(removed)</em>}</p>
            {m.author === "jarvis" && m.text && <button className="link small" onClick={() => speaker.speak(m.text!)}>Read aloud</button>}
          </div>))}
        <div ref={endRef} />
      </div>
      {files.length > 0 && <div className="row attachments" data-testid="attachments">{files.map((f, i) => (
        <span key={i} className="pill">{f.name} ({Math.ceil(f.size / 1024)} KB) <button type="button" className="link" onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>remove</button></span>))}</div>}
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(text); }}>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Message JARVIS" rows={2} data-testid="composer"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <input ref={fileInput} type="file" multiple hidden onChange={e => void pick(e.target.files)} data-testid="file-input" />
        <button type="button" onClick={() => fileInput.current?.click()} title="Attach images or files" data-testid="attach">Attach</button>
        <button type="submit" disabled={busy || (!text.trim() && !files.length)} data-testid="send">{busy ? "…" : "Send"}</button>
        <button type="button" className={recording ? "mic on" : "mic"} data-testid="ptt" title="Hold to talk"
          onPointerDown={() => void pttDown()} onPointerUp={() => void pttUp()} onPointerLeave={() => void pttUp()}>{recording ? "Listening…" : "Hold to talk"}</button>
        {speaking && <button type="button" onClick={() => speaker.stop()} data-testid="stop-speaking">Stop speaking</button>}
      </form>
    </section>
  );
}

function Tasks({ api, tick, onError }: ViewProps) {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ task: { objective: string; status: string; status_detail?: string }; steps: { step_id: string; description: string; status: string }[]; report: string } | null>(null);
  const latestList = useLatest(), latestDetail = useLatest();
  useEffect(() => { api.call<TaskRow[]>("task.list", { limit: 100 }).then(latestList()(setRows)).catch(e => onError(errText(e))); }, [api, tick, onError, latestList]);
  useEffect(() => { const only = latestDetail(); if (open) api.call<typeof detail>("task.get", { task_id: open }).then(only(setDetail)).catch(e => onError(errText(e))); else only(setDetail)(null); }, [api, open, tick, onError, latestDetail]);
  const control = (id: string, op: "pause" | "resume" | "cancel") => api.call("task.control", { task_id: id, op }).catch(e => onError(errText(e)));
  return (
    <section className="split">
      <ul className="list" data-testid="task-list">
        {rows.length === 0 && <li className="muted">No tasks yet.</li>}
        {rows.map(t => (
          <li key={t.task_id} className={open === t.task_id ? "sel" : ""} onClick={() => setOpen(t.task_id)}>
            <strong>{t.objective}</strong>
            <span className={`status ${t.status}`}>{t.status.replace(/_/g, " ")}{t.wait_reason ? ` (${t.wait_reason})` : ""}</span>
            {t.status_detail && <small>{t.status_detail}</small>}
          </li>))}
      </ul>
      {detail && open && (
        <div className="detail" data-testid="task-detail">
          <h2>{detail.task.objective}</h2>
          <p className={`status ${detail.task.status}`}>{detail.task.status.replace(/_/g, " ")}</p>
          <div className="row">
            <button onClick={() => control(open, "pause")}>Pause</button>
            <button onClick={() => control(open, "resume")}>Resume</button>
            <button className="danger" onClick={() => control(open, "cancel")}>Cancel</button>
          </div>
          <h3>Steps</h3>
          <ol>{detail.steps.map(s => <li key={s.step_id}>{s.description} — <em>{s.status}</em></li>)}</ol>
          <h3>Report</h3>
          <pre className="report">{detail.report}</pre>
        </div>)}
    </section>
  );
}

function NeedsYou({ api, tick, onError }: ViewProps) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const latestD = useLatest(), latestN = useLatest();
  useEffect(() => {
    api.call<Decision[]>("decision.list").then(latestD()(setDecisions)).catch(e => onError(errText(e)));
    api.call<Note[]>("notifications.needs_you").then(latestN()(setNotes)).catch(e => onError(errText(e)));
  }, [api, tick, onError, latestD, latestN]);
  const respond = async (d: Decision, option: string) => {
    try { await api.call("decision.respond", { decision_request_id: d.decision_request_id, option_id: option, proposal_fingerprint: d.proposal_fingerprint }); setDecisions(ds => ds.filter(x => x !== d)); }
    catch (e) { onError(errText(e)); }
  };
  return (
    <section data-testid="needs-you">
      {decisions.length === 0 && notes.length === 0 && <p className="muted">Nothing needs you.</p>}
      {decisions.map(d => (
        <article key={d.decision_request_id} className="card decision" data-testid="decision">
          <h3>{d.proposal.summary}</h3>
          <dl>
            <dt>Target</dt><dd>{d.proposal.target}</dd>
            <dt>Effect</dt><dd>{d.proposal.expected_effect}</dd>
            <dt>Can it be undone?</dt><dd>{d.proposal.reversibility}</dd>
            {d.proposal.important_terms.length > 0 && <><dt>Important</dt><dd>{d.proposal.important_terms.join("; ")}</dd></>}
            <dt>Why I'm asking</dt><dd>{d.why.text}</dd>
          </dl>
          <div className="row">{d.options.map(o => <button key={o.id} className={o.id === "approve" ? "primary" : ""} onClick={() => void respond(d, o.id)} data-testid={`opt-${o.id}`}>{o.label}</button>)}</div>
        </article>))}
      {notes.map(n => (
        <article key={n.id} className="card" data-testid="note">
          <h3>{n.title}</h3><p>{n.body}</p>
          <div className="row">
            {n.kind === "decision" && n.schedule_id && <button className="primary" onClick={() => api.call("schedules.control", { schedule_id: n.schedule_id, op: "run_now" }).then(() => api.call("notifications.dismiss", { id: n.id })).catch(e => onError(errText(e)))}>Run it now</button>}
            <button onClick={() => api.call("notifications.dismiss", { id: n.id }).then(() => setNotes(x => x.filter(y => y.id !== n.id))).catch(e => onError(errText(e)))}>Dismiss</button>
          </div>
        </article>))}
    </section>
  );
}

function Schedules({ api, tick, onError }: ViewProps) {
  const [rows, setRows] = useState<Schedule[]>([]);
  const latest = useLatest();
  useEffect(() => { api.call<Schedule[]>("schedules.list").then(latest()(setRows)).catch(e => onError(errText(e))); }, [api, tick, onError, latest]);
  const op = (id: string, o: string) => api.call("schedules.control", { schedule_id: id, op: o }).catch(e => onError(errText(e)));
  return (
    <section>
      <p className="muted">Create alarms, reminders and scheduled tasks by asking in the conversation, e.g. "Remind me every weekday at 8:30 to check the post".</p>
      <table data-testid="schedules"><thead><tr><th>What</th><th>Next</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map(s => (
          <tr key={s.schedule_id}><td>{s.kind}: {s.interpretation}</td><td>{s.next_fire_utc ? new Date(s.next_fire_utc).toLocaleString() : "—"}</td><td>{s.status}</td>
            <td className="row">{s.status === "active" ? <button onClick={() => op(s.schedule_id, "pause")}>Pause</button> : <button onClick={() => op(s.schedule_id, "resume")}>Resume</button>}
              <button className="danger" onClick={() => op(s.schedule_id, "cancel")}>Delete</button></td></tr>))}</tbody></table>
    </section>
  );
}

function MemoryView({ api, tick, onError }: ViewProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Memory[]>([]);
  const latest = useLatest();
  const load = useCallback(() => { const only = latest(); return (q.trim() ? api.call<Memory[]>("memory.search", { query: q }) : api.call<Memory[]>("memory.list", { limit: 200 })).then(only(setRows)).catch(e => onError(errText(e))); }, [api, q, onError, latest]);
  useEffect(() => { void load(); }, [tick, load]);
  const [editing, setEditing] = useState<{ markdown: string; exported_ids: string[]; type: string } | null>(null);
  const [diff, setDiff] = useState<{ edits: { record_id: string; old_text: string; new_text: string }[]; added: { text: string }[]; deletions: { record_id: string; text: string }[]; conflicts: { record_id: string; new_text: string }[] } | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const edit = (type: string) => api.call<{ markdown: string; exported_ids: string[] }>("memory.markdown", { type }).then(v => { setEditing({ ...v, type }); setDiff(null); }).catch(e => onError(errText(e)));
  const preview = () => editing && api.call<typeof diff>("memory.markdown_preview", { markdown: editing.markdown, exported_ids: editing.exported_ids }).then(setDiff).catch(e => onError(errText(e)));
  const apply = () => editing && api.call("memory.markdown_apply", { markdown: editing.markdown, exported_ids: editing.exported_ids }).then(() => { setEditing(null); setDiff(null); void load(); }).catch(e => onError(errText(e)));
  if (editing) return (
    <section data-testid="memory-editor">
      <p className="muted">Edit the text after each marker, delete a line to forget it, or add new "- " lines. Nothing changes until you apply.</p>
      <textarea className="md" value={editing.markdown} onChange={e => { setEditing({ ...editing, markdown: e.target.value }); setDiff(null); }} rows={18} data-testid="memory-md" />
      <div className="row"><button onClick={() => void preview()} data-testid="memory-preview">Preview changes</button>
        <button onClick={() => { setEditing(null); setDiff(null); }}>Cancel</button></div>
      {diff && (<div className="card" data-testid="memory-diff">
        {diff.edits.map(e => <p key={e.record_id}>Change: <s>{e.old_text}</s> → {e.new_text}</p>)}
        {diff.added.map((a, i) => <p key={i}>Add: {a.text}</p>)}
        {diff.deletions.map(d => <p key={d.record_id}>Forget: {d.text}</p>)}
        {diff.conflicts.map(c => <p key={c.record_id} className="danger">Changed elsewhere since you opened this, so not applied: {c.new_text}. Reopen the editor to see the latest.</p>)}
        {diff.edits.length + diff.added.length + diff.deletions.length === 0 ? <p className="muted">No changes.</p> : <button className="primary" onClick={() => void apply()} data-testid="memory-apply">Apply</button>}
      </div>)}
    </section>
  );
  return (
    <section>
      <div className="row">
        <button onClick={() => void edit("preference")} data-testid="edit-prefs">Edit preferences as text</button>
        <button onClick={() => void edit("fact")}>Edit facts as text</button>
        <button onClick={() => api.call<{ path: string }>("memory.export").then(r => setExported(r.path)).catch(e => onError(errText(e)))} data-testid="memory-export">Export everything</button>
      </div>
      {exported && <p className="ok" data-testid="exported">Exported to {exported}</p>}
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search what JARVIS remembers" data-testid="memory-search" />
      <ul className="list" data-testid="memory-list">
        {rows.length === 0 && <li className="muted">Nothing here.</li>}
        {rows.map(m => (
          <li key={m.id}><span>{m.text}</span> <small>{m.type} · {m.status} · {m.sensitivity}</small>
            <button className="link danger" onClick={() => api.call("memory.delete", { ids: [m.id], reason: "deleted in the Console" }).then(load).catch(e => onError(errText(e)))}>Forget</button></li>))}
      </ul>
    </section>
  );
}

function Rules({ api, tick, onError }: ViewProps) {
  const [rows, setRows] = useState<Rule[]>([]);
  const latest = useLatest();
  useEffect(() => { api.call<Rule[]>("rules.list").then(latest()(setRows)).catch(e => onError(errText(e))); }, [api, tick, onError, latest]);
  const act = async (r: Rule, method: "rules.confirm" | "rules.revoke") => {
    let typed: string | undefined;
    if (r.protection === "protected") { typed = window.prompt(`This is a protected rule. Type the rule text to ${method === "rules.confirm" ? "confirm" : "revoke"} it:`) ?? undefined; if (!typed) return; }
    try { await api.call(method, { rule_id: r.rule_id, ...(typed ? { typed_confirmation: typed } : {}) }); setRows(await api.call<Rule[]>("rules.list")); } catch (e) { onError(errText(e)); }
  };
  return (
    <section>
      <p className="muted">Say rules in the conversation ("never email clients after 8 pm without asking"); confirm them here.</p>
      <ul className="list" data-testid="rules">
        {rows.map(r => (
          <li key={r.rule_id}><strong>{r.text}</strong><small>{r.kind} · {r.status}{r.protection === "protected" ? " · protected" : ""}</small>
            {r.compile?.interpretation && <small>Interpreted as: {r.compile.interpretation}</small>}
            <span className="row">{r.status === "draft" && <button className="primary" onClick={() => void act(r, "rules.confirm")}>Confirm</button>}
              {r.status === "active" && <button className="danger" onClick={() => void act(r, "rules.revoke")}>Revoke</button>}</span></li>))}
      </ul>
    </section>
  );
}

interface UsageSummary { since: string; calls: number; cost_usd: { actual: number; estimated: number }; unknown_cost_calls: number; by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;
  budgets: { budget_id: string; period: string; kind: string; limit: { amount: number; currency: string }; spent: number; scope: { level: string } }[]; warnings: string[] }

function Usage({ api, tick, onError }: ViewProps) {
  const [u, setU] = useState<UsageSummary | null>(null);
  const latest = useLatest();
  useEffect(() => { api.call<UsageSummary>("usage.summary").then(latest()(setU)).catch(e => onError(errText(e))); }, [api, tick, onError, latest]);
  if (!u) return <section className="muted">Loading…</section>;
  const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  return (
    <section data-testid="usage">
      <h2>Last 30 days</h2>
      <dl>
        <dt>Model calls</dt><dd data-testid="usage-calls">{u.calls}</dd>
        <dt>Cost (billed)</dt><dd>{usd(u.cost_usd.actual)}</dd>
        <dt>Cost (estimated)</dt><dd>{usd(u.cost_usd.estimated)}</dd>
        {u.unknown_cost_calls > 0 && <><dt>Calls with unknown cost</dt><dd>{u.unknown_cost_calls} (subscription or unpriced; shown separately, never guessed)</dd></>}
      </dl>
      <h3>By model</h3>
      <table><thead><tr><th>Adapter</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
        <tbody>{Object.entries(u.by_model).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.calls}</td><td>{v.input_tokens}</td><td>{v.output_tokens}</td></tr>)}</tbody></table>
      <h3>Budgets</h3>
      {u.budgets.length === 0 ? <p className="muted">No budgets set. Each task has its own hard cap.</p> :
        <ul className="list">{u.budgets.map(b => <li key={b.budget_id}>{b.scope.level} · {b.period}: {usd(b.spent)} of {b.limit.amount} {b.limit.currency} ({b.kind})</li>)}</ul>}
      {u.warnings.map(w => <p key={w} className="banner">{w}</p>)}
    </section>
  );
}

function Onboarding({ api, onError }: { api: JarvisApi; onError: (e: string) => void }) {
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [quiet, setQuiet] = useState({ from: "22:00", to: "07:00" });
  useEffect(() => { api.call<unknown>("profile.get").then(p => setMissing(p === null)).catch(e => onError(errText(e))); }, [api, onError]);
  if (!missing) return null;
  const save = async () => {
    try {
      await api.call("profile.set", { display_name: name.trim() || "Owner", timezone: tz,
        quiet_hours: { tz, windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], from: quiet.from, to: quiet.to }] } });
      setMissing(false);
    } catch (e) { onError(errText(e)); }
  };
  return (
    <section className="card onboarding" data-testid="onboarding">
      <h2>Welcome</h2>
      <p className="muted">A few basics so reminders and quiet hours are right. You can change these any time in Settings.</p>
      <div className="row"><label>Your name <input value={name} onChange={e => setName(e.target.value)} data-testid="ob-name" /></label></div>
      <div className="row"><label>Time zone <input value={tz} onChange={e => setTz(e.target.value)} data-testid="ob-tz" /></label></div>
      <div className="row"><label>Quiet hours from <input value={quiet.from} onChange={e => setQuiet(q => ({ ...q, from: e.target.value }))} size={5} /></label>
        <label>to <input value={quiet.to} onChange={e => setQuiet(q => ({ ...q, to: e.target.value }))} size={5} /></label></div>
      <button className="primary" onClick={() => void save()} data-testid="ob-save">Save</button>
    </section>
  );
}

function Settings({ api, status, onSaved, onError }: { api: JarvisApi; status: Status | null; onSaved: () => void; onError: (e: string) => void }) {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  useEffect(() => { api.call<Record<string, unknown>>("settings.get").then(setSettings).catch(e => onError(errText(e))); }, [api, onError]);
  const storeKey = async () => {
    const k = key.trim();
    if (!k) return;
    try { await api.call("credentials.store", { provider: "anthropic", label: "Anthropic API key", secret: k }); setKey(""); setSaved("Saved to the local vault."); onSaved(); }
    catch (e) { onError(errText(e)); }
  };
  const set = (k: string, v: unknown) => api.call("settings.set", { key: k, value: v }).then(() => setSettings(s => ({ ...s, [k]: v }))).catch(e => onError(errText(e)));
  return (
    <section className="settings">
      <h2>Anthropic API key</h2>
      <p className="muted">Stored only in the encrypted local vault on this PC. It is never shown again, never logged, and never sent anywhere except to Anthropic for model calls.</p>
      <p data-testid="key-state">{status?.anthropic_key ? "A key is stored." : "No key stored."}</p>
      <form className="row" onSubmit={e => { e.preventDefault(); void storeKey(); }}>
        <input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-ant-…" data-testid="api-key" />
        <button type="submit" className="primary" data-testid="save-key">{status?.anthropic_key ? "Replace key" : "Save key"}</button>
      </form>
      {saved && <p className="ok" data-testid="key-saved">{saved}</p>}
      <h2>Voice</h2>
      <label><input type="checkbox" checked={settings["voice.speak_replies"] === true} onChange={e => void set("voice.speak_replies", e.target.checked)} data-testid="speak-replies" /> Read replies aloud</label>
      <h2>Status</h2>
      <dl data-testid="status">
        <dt>Boss model route</dt><dd>{status?.boss_route.join(" → ") || "—"}</dd>
        <dt>Policy revision</dt><dd>{status?.policy_revision ?? "—"}</dd>
        <dt>Safe mode</dt><dd>{status?.safe_mode ? "on" : "off"}</dd>
      </dl>
    </section>
  );
}
