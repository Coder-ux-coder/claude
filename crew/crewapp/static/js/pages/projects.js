// Projects: jobs handed to the team. The list, and one project's live view:
// who is doing what, the plan, the team's group chat, usage, and the result.

import { h, icon, btn, api, toast, fail, confirmBox, store, bus, markdown, ago, clock, colorFor, autosize, isSmall } from '../ui.js';
import { dictate, canDictate } from '../voice.js';
import { TEAM_MODES, projectTile } from './home.js';

const STEPS = [
  ['refine', 'Understanding your request'],
  ['plan', 'Planning'],
  ['build', 'Building'],
  ['deliver', 'Final checks'],
  ['done', 'Finished'],
];
const ROLE = { lead: 'Team lead', member: 'Builder', ceo: 'Final approval', reviewer: 'Checker' };
const TASK_PILL = { done: 'ok', 'being built': 'live', 'being checked': 'live', 'being improved': 'warn', 'needs a decision': 'bad', approved: 'ok', dropped: '' };
const MODE_LABEL = { solo: 'One agent', team: 'Team', auto: 'Auto' };

// ------------------------------------------------------------------ list

export function projects(view) {
  const ta = h('textarea', { rows: 3, placeholder: 'Describe what you want built — a website, a dashboard, a tool, a report with charts…', 'aria-label': 'What to build' });
  const fit = autosize(ta, 0.4);
  let mode = 'auto';
  const modeSel = h('select', { class: 'mini', onchange: (e) => { mode = e.target.value; } }, TEAM_MODES.map((m) => h('option', { value: m.value }, m.label)));
  const folder = h('input', { type: 'text', placeholder: 'Optional: a folder on this computer to work in (leave empty for a new one)' });
  const mic = btn('', () => dictate(ta, mic), { cls: 'icon ghost mic', ic: 'mic', title: 'Speak instead of typing' });
  if (!canDictate) mic.classList.add('hidden');
  const start = btn('Start building', async () => {
    const text = ta.value.trim();
    if (text.length < 3) { ta.focus(); return; }
    start.disabled = true;
    try {
      const r = await api('/api/runs', { method: 'POST', body: { request: text, mode, folder: folder.value.trim() || null } });
      bus.emit('runs');
      location.hash = '#/projects/' + r.id;
    } catch (e) { fail(e); start.disabled = false; }
  }, { cls: 'primary', ic: 'zap' });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start.click(); } });
  const list = h('div', { class: 'tiles' });
  view.append(h('div', { class: 'page wide' },
    h('div', { class: 'stack' }, h('h1', null, 'Projects'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Hand a job to the team. They plan it, split it, build it, check each other’s work, and report back in plain words.')),
    h('div', { class: 'composer' }, ta,
      h('details', null, h('summary', { class: 'muted small', style: { cursor: 'pointer' } }, 'More options'), h('div', { style: { paddingTop: '8px' } }, folder)),
      h('div', { class: 'tools' }, h('span', { class: 'muted small' }, 'Who builds it:'), modeSel, h('span', { class: 'grow' }), mic, start)),
    h('section', { class: 'stack' }, h('h2', null, 'Your projects'), list)));
  fit();
  const load = async () => {
    try {
      const r = await api('/api/runs');
      list.replaceChildren(...(r.runs.length ? r.runs.map(projectTile) : [h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, 'No projects yet. Describe one above to begin.')]));
    } catch (e) { fail(e); }
  };
  load();
  const t = setInterval(load, 6000);
  return () => clearInterval(t);
}

// ------------------------------------------------------------------ one project

export function project(view, params) {
  const p = new ProjectPage(view, params[0]);
  return () => p.destroy();
}

class ProjectPage {
  constructor(view, id) {
    this.id = id;
    this.after = 0;
    this.alive = true;
    this.last = null;
    this.seen = new Set();
    this.build(view);
    this.tick();
  }

  build(view) {
    this.titleEl = h('h1', null, 'Your project');
    this.phasePill = h('span', { class: 'pill' }, '…');
    this.modePill = h('span', { class: 'pill hidden' });
    this.progressBar = h('i', { style: { width: '0%' } });
    this.progressText = h('span', { class: 'muted small' });
    this.actions = h('div', { class: 'proj-actions' });
    this.steps = h('div', { class: 'steps' });
    this.result = h('section', { class: 'card result-card hidden' });
    this.team = h('div', { class: 'team' });
    this.tasks = h('div');
    this.accounts = h('div', { class: 'stack' });
    this.feed = h('div', { class: 'feed' });
    this.feedScroll = h('div', { class: 'feed-scroll' }, this.feed);
    this.sayIn = h('input', { type: 'text', placeholder: 'Message the team — they read it at their next step', 'aria-label': 'Message the team' });
    this.sayIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.say(); } });
    const sayMic = btn('', () => dictate(this.sayIn, sayMic), { cls: 'icon ghost mic', ic: 'mic', title: 'Speak' });
    if (!canDictate) sayMic.classList.add('hidden');
    this.request = h('p', { class: 'muted', style: { margin: 0, whiteSpace: 'pre-wrap' } });
    this.starting = h('div', { class: 'empty' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i')), h('div', null, 'Getting the team ready…'));

    view.append(h('div', { class: 'page wide' },
      h('a', { class: 'back', href: '#/projects' }, icon('left'), 'All projects'),
      h('div', { class: 'proj-head' },
        h('div', { class: 'row wrap' }, this.phasePill, this.modePill),
        this.titleEl, this.request,
        h('div', { class: 'row wrap between' }, h('div', { class: 'grow stack', style: { gap: '6px', minWidth: '220px' } }, h('div', { class: 'bar' }, this.progressBar), this.progressText), this.actions)),
      this.starting,
      this.result,
      h('div', { class: 'proj-grid' },
        h('div', null,
          h('section', { class: 'card' }, h('div', { class: 'row between', style: { marginBottom: '10px' } }, h('h2', null, 'Team chat'), h('span', { class: 'muted small' }, 'Everything the team says, as it happens')),
            this.feedScroll,
            h('div', { class: 'say', style: { marginTop: '12px' } }, this.sayIn, sayMic, btn('Send', () => this.say(), { cls: 'primary' })))),
        h('div', null,
          h('section', { class: 'card' }, h('h2', { style: { marginBottom: '8px' } }, 'Progress'), this.steps),
          h('section', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'The team'), this.team),
          h('section', { class: 'card' }, h('h2', { style: { marginBottom: '6px' } }, 'The plan'), this.tasks),
          h('section', { class: 'card' }, h('h2', { style: { marginBottom: '6px' } }, 'Subscriptions'), this.accounts)))));
  }

  async tick() {
    if (!this.alive) return;
    let s = null;
    try {
      s = await api(`/api/runs/${this.id}?after=${this.after}`);
      if (!this.alive) return;
      this.update(s);
    } catch (e) {
      if (e.status === 404) { toast('That project could not be found.'); location.hash = '#/projects'; return; }
    }
    this.timer = setTimeout(() => this.tick(), s && (s.running || s.starting) ? 1500 : 6000);
  }

  update(s) {
    if (s.starting) return;
    this.starting.classList.add('hidden');
    this.last = s;
    this.titleEl.textContent = s.title;
    document.title = s.title + ' · Crew';
    this.request.textContent = s.request && s.request !== s.title ? (s.request.length > 400 ? s.request.slice(0, 400) + '…' : s.request) : '';
    this.phasePill.className = 'pill' + (s.running ? ' live' : s.raw_phase === 'done' ? ' ok' : s.raw_phase === 'failed' ? ' bad' : '');
    this.phasePill.textContent = s.running ? s.phase : (s.raw_phase === 'done' ? 'Finished' : s.phase);
    this.modePill.textContent = MODE_LABEL[s.mode] ? `${MODE_LABEL[s.mode]} mode` : '';
    this.modePill.classList.toggle('hidden', !MODE_LABEL[s.mode]);
    const [d, t] = s.progress || [0, 0];
    this.progressBar.style.width = (s.raw_phase === 'done' ? 100 : t ? Math.round((100 * d) / t) : 0) + '%';
    this.progressText.textContent = t ? `${d} of ${t} parts finished` : (s.raw_phase === 'done' ? 'All done' : 'The plan is being made');

    // actions
    const acts = [];
    if (s.preview && s.preview.url) acts.push(btn('Preview', () => bus.emit('panel:preview', { name: s.title, kind: s.preview.kind, url: s.preview.url }), { cls: 'primary', ic: 'play' }));
    if (store.isLocal && s.folder) acts.push(btn('Open folder', () => api(`/api/runs/${this.id}/open-folder`, { method: 'POST', body: {} }).catch(fail), { ic: 'folder' }));
    if (s.running) acts.push(btn('Stop', () => this.stop(), { cls: 'danger', ic: 'stop' }));
    else if (s.raw_phase !== 'done') acts.push(btn('Continue', () => this.resume(), { cls: 'primary', ic: 'play' }));
    this.actions.replaceChildren(...acts);

    // steps
    const order = STEPS.map((x) => x[0]);
    const at = order.indexOf(s.raw_phase);
    this.steps.replaceChildren(...STEPS.map(([k, label], i) => {
      const done = s.raw_phase === 'done' || (at >= 0 && i < at);
      const active = at === i && s.raw_phase !== 'done';
      return h('div', { class: 'step' + (done ? ' done' : active ? ' active' : '') }, h('span', { class: 'dot' }, done ? icon('check') : null), h('span', { class: 't' }, label),
        active && !s.running ? h('span', { class: 'pill' }, 'paused') : null);
    }));

    // result
    if (s.report) {
      this.result.classList.remove('hidden');
      this.result.replaceChildren(h('div', { class: 'celebrate' }, s.raw_phase === 'done' ? 'Finished' : 'Report so far'),
        h('div', { class: 'md report', html: markdown(s.report) }),
        h('div', { class: 'row wrap', style: { marginTop: '12px' } },
          s.preview && s.preview.url ? btn('See the result', () => bus.emit('panel:preview', { name: s.title, kind: s.preview.kind, url: s.preview.url }), { cls: 'primary', ic: 'play' }) : null,
          store.isLocal && s.folder ? btn('Open the folder', () => api(`/api/runs/${this.id}/open-folder`, { method: 'POST', body: {} }).catch(fail), { ic: 'folder' }) : null));
    }

    // team
    this.team.replaceChildren(...(s.seats || []).map((m) => {
      const busy = m.status === 'busy';
      return h('div', { class: 'member' },
        h('span', { class: 'avatar' + (busy ? ' busy' : ''), style: { background: colorFor(m.name), color: '#fff' } }, m.name.slice(0, 2)),
        h('div', { class: 'who' }, h('b', null, cap(m.name)), h('span', null, `${ROLE[m.role] || cap(m.role)} · ${m.doing || m.status}`)));
    }));
    if (!(s.seats || []).length) this.team.replaceChildren(h('span', { class: 'muted' }, 'Starting…'));

    // plan
    this.tasks.replaceChildren(...((s.tasks || []).length ? s.tasks.map((t) => h('div', { class: 'task' },
      h('span', { class: 't' }, t.title, t.who ? h('div', { class: 'who' }, cap(t.who)) : null),
      h('span', { class: 'pill ' + (TASK_PILL[t.status] || '') }, t.status))) : [h('span', { class: 'muted' }, 'The plan is being made…')]));

    // subscriptions
    this.accounts.replaceChildren(...(s.accounts || []).map((a) => {
      const u = a.util == null ? null : Math.round(a.util * 100);
      const cls = a.raw === 'parked' ? 'bad' : a.raw === 'conserve' ? 'warn' : '';
      return h('div', null, h('div', { class: 'row between' }, h('b', null, a.name), h('span', { class: 'muted small' }, [a.mode, u != null ? `${u}% used` : '', a.reset && u != null ? `resets ${clock(a.reset)}` : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'meter' }, h('i', { class: cls, style: { width: (u || 0) + '%' } })));
    }));

    // chat feed
    const stick = this.feedScroll.scrollHeight - this.feedScroll.scrollTop - this.feedScroll.clientHeight < 80;
    for (const m of s.messages || []) {
      this.after = Math.max(this.after, m.id);
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      this.feed.append(message(m));
    }
    if (!this.feed.children.length) this.feed.append(h('div', { class: 'muted small', dataset: { placeholder: '1' } }, 'The team’s messages will appear here.'));
    else { const ph = this.feed.querySelector('[data-placeholder]'); if (ph) ph.remove(); }
    if (stick) this.feedScroll.scrollTop = this.feedScroll.scrollHeight;
  }

  async say() {
    const text = this.sayIn.value.trim();
    if (!text) return;
    this.sayIn.value = '';
    try {
      await api(`/api/runs/${this.id}/say`, { method: 'POST', body: { text } });
      clearTimeout(this.timer);
      this.tick();
    } catch (e) { fail(e); this.sayIn.value = text; }
  }

  async stop() {
    if (!(await confirmBox('Stop the team?', 'They save their work first. You can continue the project later.', { ok: 'Stop', danger: true }))) return;
    try { await api(`/api/runs/${this.id}/stop`, { method: 'POST', body: {} }); toast('The team is stopping after saving its work.'); } catch (e) { fail(e); }
  }

  async resume() {
    try { await api(`/api/runs/${this.id}/resume`, { method: 'POST', body: {} }); toast('The team is picking up where it left off.'); clearTimeout(this.timer); setTimeout(() => this.tick(), 1200); } catch (e) { fail(e); }
  }

  destroy() {
    this.alive = false;
    clearTimeout(this.timer);
    document.title = 'Crew';
  }
}

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

function message(m) {
  const who = m.who === 'you' ? 'You' : m.who === 'crew' ? 'Crew' : cap(m.who);
  const kind = m.who === 'you' ? 'you' : ({ decision: 'decision', blocker: 'blocker', concern: 'blocker', lesson: 'lesson', system: 'system' }[m.kind] || '');
  const label = { question: 'question', answer: 'answer', blocker: 'needs help', concern: 'concern', decision: 'decision', lesson: 'lesson learned' }[m.kind];
  if (kind === 'system') return h('div', { class: 'msg system' }, h('span', null, `${clock(m.t)} · `), m.text);
  return h('div', { class: 'msg ' + kind },
    h('div', { class: 'meta' }, m.who !== 'you' && m.who !== 'crew' ? h('span', { class: 'avatar', style: { width: '20px', height: '20px', borderRadius: '6px', fontSize: '10px', background: colorFor(m.who) } }, m.who.slice(0, 2)) : null,
      h('b', null, who), clock(m.t), label ? h('span', { class: 'pill' }, label) : null),
    h('div', { class: 'body' }, m.text));
}
