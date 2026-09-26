import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JarvisApi, JarvisEventEnvelope } from "../shared/api.js";
import { Recorder, Speaker } from "./voice.js";

type View = "conversation" | "tasks" | "needs" | "schedules" | "memory" | "rules" | "settings";
interface Msg { id: string; author: "owner" | "jarvis" | "system"; text: string | null; modality: string }
interface TaskRow { task_id: string; objective: string; mode: string; status: string; wait_reason: string | null; status_detail: string | null; origin: string }
interface Status { safe_mode: boolean; halted: boolean; anthropic_key: boolean; needs_you: number; open_decisions: number; policy_revision: number; boss_route: string[] }
interface Decision { decision_request_id: string; task_id: string; why: { text: string }; proposal: { summary: string; target: string; expected_effect: string; reversibility: string; important_terms: string[] }; options: { id: string; label: string }[]; proposal_fingerprint: string; expires_at: string }
interface Note { id: string; kind: string; title: string; body: string; schedule_id?: string; created_at: string }
interface Schedule { schedule_id: string; kind: string; interpretation: string; status: string; next_fire_utc: string | null }
interface Memory { id: string; type: string; text: string; status: string; sensitivity: string }
interface Rule { rule_id: string; kind: string; text: string; status: string; protection: string; compile?: { interpretation?: string } }

const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e));

export function App({ api }: { api: JarvisApi }) {
  const [view, setView] = useState<View>("conversation");
  const [conn, setConn] = useState<"connected" | "reconnecting">("connected");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);                       // bumps on relevant events → views refetch
  const speaker = useMemo(() => new Speaker(), []);

  const refreshStatus = useCallback(() => { api.call<Status>("status.get").then(setStatus).catch(e => setError(errText(e))); }, [api]);
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
  const tabs: [View, string][] = [["conversation", "Conversation"], ["tasks", "Tasks"], ["needs", "Needs you"], ["schedules", "Schedules"], ["memory", "Memory"], ["rules", "Rules"], ["settings", "Settings"]];
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
        {view === "conversation" && <Conversation api={api} speaker={speaker} tick={tick} onError={setError} />}
        {view === "tasks" && <Tasks api={api} tick={tick} onError={setError} />}
        {view === "needs" && <NeedsYou api={api} tick={tick} onError={setError} />}
        {view === "schedules" && <Schedules api={api} tick={tick} onError={setError} />}
        {view === "memory" && <MemoryView api={api} tick={tick} onError={setError} />}
        {view === "rules" && <Rules api={api} tick={tick} onError={setError} />}
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
  const recorder = useMemo(() => new Recorder(), []);
  const lastSpoken = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { speaker.onChange = setSpeaking; return () => { speaker.onChange = null; }; }, [speaker]);
  useEffect(() => { api.call<Record<string, unknown>>("settings.get").then(s => setSpeakReplies(s["voice.speak_replies"] === true)).catch(() => {}); }, [api]);
  const load = useCallback(async (id: string) => {
    const m = await api.call<Msg[]>("conversation.messages", { conversation_id: id, limit: 100 });
    setMsgs(m);
    const last = m[m.length - 1];
    if (last && last.author === "jarvis" && last.text && last.id !== lastSpoken.current && speakReplies) { lastSpoken.current = last.id; speaker.speak(last.text); }
  }, [api, speaker, speakReplies]);
  useEffect(() => { if (conv) void load(conv).catch(e => onError(errText(e))); }, [conv, tick, load, onError]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [msgs]);

  const send = async (content: string, modality: "text" | "voice" = "text", confidence?: "high" | "medium" | "low") => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      const r = await api.call<{ conversation_id: string }>("conversation.send", { content, modality, ...(conv ? { conversation_id: conv } : {}), ...(confidence ? { transcript_confidence: confidence } : {}) });
      setConv(r.conversation_id);
      await load(r.conversation_id);
      setText("");
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
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
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(text); }}>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Message JARVIS" rows={2} data-testid="composer"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <button type="submit" disabled={busy || !text.trim()} data-testid="send">{busy ? "…" : "Send"}</button>
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
  useEffect(() => { api.call<TaskRow[]>("task.list", { limit: 100 }).then(setRows).catch(e => onError(errText(e))); }, [api, tick, onError]);
  useEffect(() => { if (open) api.call<typeof detail>("task.get", { task_id: open }).then(setDetail).catch(e => onError(errText(e))); else setDetail(null); }, [api, open, tick, onError]);
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
  useEffect(() => {
    api.call<Decision[]>("decision.list").then(setDecisions).catch(e => onError(errText(e)));
    api.call<Note[]>("notifications.needs_you").then(setNotes).catch(e => onError(errText(e)));
  }, [api, tick, onError]);
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
  useEffect(() => { api.call<Schedule[]>("schedules.list").then(setRows).catch(e => onError(errText(e))); }, [api, tick, onError]);
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
  const load = useCallback(() => (q.trim() ? api.call<Memory[]>("memory.search", { query: q }) : api.call<Memory[]>("memory.list", { limit: 200 })).then(setRows).catch(e => onError(errText(e))), [api, q, onError]);
  useEffect(() => { void load(); }, [tick, load]);
  return (
    <section>
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
  useEffect(() => { api.call<Rule[]>("rules.list").then(setRows).catch(e => onError(errText(e))); }, [api, tick, onError]);
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
