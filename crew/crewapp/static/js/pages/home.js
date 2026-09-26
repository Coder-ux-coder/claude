// Home: one box for everything. Ask the assistant, or hand a job to the team.

import { h, icon, btn, iconBtn, api, fail, toast, store, ago, greeting, autosize, isSmall, bus } from '../ui.js';
import { dictate, canDictate } from '../voice.js';

const IDEAS = {
  ask: [
    'Summarise this week’s news on Pakistan’s industrial sector, with sources',
    'Draft a formal letter inviting investors to a Punjab investment roadshow',
    'Compare Punjab’s special economic zones with Vietnam’s, in a table',
    'Turn my rough notes into a one-page briefing for the Chief Secretary',
  ],
  build: [
    'A one-page website for an investment conference, with an agenda and a registration form',
    'A dashboard that shows project approvals from a spreadsheet, with charts',
    'A simple app for logging investor meetings, follow-ups and reminders',
  ],
};

export const TEAM_MODES = [
  { value: 'auto', label: 'Decide for me', hint: 'One agent for small jobs, the full team for big ones' },
  { value: 'solo', label: 'One agent', hint: 'One builder, plus an independent check' },
  { value: 'team', label: 'Full team', hint: 'Several agents build different parts at once' },
];

export function home(view) {
  let mode = localStorage.getItem('crew.homeMode') || 'ask';
  let teamMode = 'auto';
  const ta = h('textarea', { rows: 2, 'aria-label': 'Your request' });
  const fit = autosize(ta);
  const mic = iconBtn('mic', 'Speak instead of typing', () => dictate(ta, mic));
  mic.classList.add('mic');
  if (!canDictate) mic.classList.add('hidden');
  const talk = iconBtn('wave', 'Talk with the assistant — a voice conversation', () => {
    store.pendingTalk = true;
    location.hash = '#/assistant/new';
  });
  const go = btn('Ask', () => submit(), { cls: 'primary', ic: 'send' });
  const segBtns = {};
  const seg = h('div', { class: 'seg', role: 'tablist' },
    [['ask', 'Ask the assistant', 'chat'], ['build', 'Build with the team', 'users']].map(([v, label, ic]) => {
      segBtns[v] = h('button', { type: 'button', role: 'tab', onclick: () => { mode = v; localStorage.setItem('crew.homeMode', v); sync(); ta.focus(); } }, label);
      return segBtns[v];
    }));
  const teamPick = h('select', { class: 'mini', 'aria-label': 'Who builds it', onchange: (e) => { teamMode = e.target.value; } },
    TEAM_MODES.map((m) => h('option', { value: m.value, title: m.hint }, m.label)));
  const chips = h('div', { class: 'chips' });

  function sync() {
    for (const [k, b] of Object.entries(segBtns)) { b.classList.toggle('on', k === mode); b.setAttribute('aria-selected', k === mode); }
    ta.placeholder = mode === 'ask' ? 'Ask anything — research, letters, summaries, plans, the web, your phone…'
      : 'Describe what you want built. The more detail, the better the result.';
    go.lastChild.textContent = mode === 'ask' ? 'Ask' : 'Start building';
    teamPick.classList.toggle('hidden', mode !== 'build');
    talk.classList.toggle('hidden', mode !== 'ask' || !canDictate);
    chips.replaceChildren(...IDEAS[mode].map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { ta.value = t; fit(); ta.focus(); } }, t)));
  }

  async function submit() {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    if (mode === 'ask') {
      store.pendingChat = { text, attachments: [] };
      location.hash = '#/assistant/new';
      return;
    }
    go.disabled = true;
    try {
      const r = await api('/api/runs', { method: 'POST', body: { request: text, mode: teamMode } });
      bus.emit('runs');
      location.hash = '#/projects/' + r.id;
    } catch (e) { fail(e); go.disabled = false; }
  }

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && !isSmall()))) { e.preventDefault(); submit(); }
  });

  const tiles = h('div', { class: 'tiles' });
  const continueSec = h('section', { class: 'stack hidden' }, h('div', { class: 'row between' }, h('h2', null, 'Pick up where you left off'),
    h('a', { href: '#/projects', class: 'small' }, 'All projects')), tiles);
  const status = h('section', { class: 'grid three' });

  view.append(h('div', { class: 'page' },
    h('section', { class: 'hero' },
      h('div', { class: 'greet eyebrow' }, icon('sparkles', 'spark'), greeting()),
      h('h1', null, 'What shall we get done?'),
      h('div', { class: 'composer' }, ta, h('div', { class: 'tools' }, seg, teamPick, h('span', { class: 'grow' }), mic, talk, go)),
      chips),
    continueSec, status));
  sync();
  setTimeout(() => ta.focus(), 50);

  // Recent work
  const ov = store.overview || {};
  const items = [
    ...(ov.runs || []).slice(0, 4).map((r) => ({ t: r.started, el: projectTile(r) })),
    ...(ov.chats || []).slice(0, 4).map((c) => ({ t: c.updated, el: chatTile(c) })),
  ].sort((a, b) => b.t - a.t).slice(0, 6);
  if (items.length) { tiles.replaceChildren(...items.map((x) => x.el)); continueSec.classList.remove('hidden'); }

  // At-a-glance status
  const card = (href, ic, title, line) => h('a', { class: 'card status-card', href }, h('span', { class: 'ico' }, icon(ic)), h('div', { class: 'l' }, h('b', null, title), line));
  const subsLine = h('span', null, 'Checking…');
  const phoneLine = h('span', null, 'Checking…');
  const browserLine = h('span', null, ov.browser && !ov.browser.available ? 'Not installed yet' : 'Ready when you need it');
  status.append(card('#/settings/subscriptions', 'key', 'Subscriptions', subsLine), card('#/phone', 'phone', 'Your phone', phoneLine),
    card('#/browser', 'globe', 'Browser', browserLine));
  api('/api/accounts/status').then((r) => {
    const n = r.accounts.length, ok = r.accounts.filter((a) => a.signed_in).length;
    subsLine.replaceChildren(h('span', { class: 'dot ' + (ok === n ? 'ok' : ok ? 'warn' : 'bad') }), ` ${ok} of ${n} signed in`);
    const first = r.accounts.find((a) => !a.signed_in && a.vendor === 'claude');
    if (!ok && first && view.isConnected) {
      const signIn = btn('Sign in', async () => {
        try { const m = await api(`/api/accounts/${encodeURIComponent(first.name)}/login`, { method: 'POST', body: {} }); toast(m.message, { ms: 9000 }); } catch (e) { fail(e); }
      }, { cls: 'primary sm', ic: 'key' });
      view.querySelector('.hero').prepend(h('div', { class: 'card flat row wrap', style: { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } },
        icon('info'), h('div', { class: 'grow' }, h('b', null, 'One step before you start: '), 'sign in to your Claude subscription so Crew can work for you.'),
        store.isLocal ? signIn : null, h('a', { class: 'btn sm ghost', href: '#/settings/subscriptions' }, 'All subscriptions')));
    }
  }).catch(() => subsLine.replaceChildren('Could not check'));
  api('/api/phone/status').then((s) => {
    phoneLine.replaceChildren(h('span', { class: 'dot ' + (s.connected ? 'ok' : '') }), ' ' + (s.connected ? `Connected: ${s.device}` : s.available ? 'Not connected' : 'Connector not installed'));
  }).catch(() => phoneLine.replaceChildren('Could not check'));
}

export function projectTile(r) {
  const [d, t] = r.progress || [0, 0];
  return h('a', { class: 'tile', href: '#/projects/' + r.id },
    h('div', { class: 'row between' }, h('span', { class: 'kicker' }, icon('layers'), 'Project'),
      h('span', { class: 'pill' + (r.running ? ' live' : r.done ? ' ok' : '') }, r.running ? r.phase : r.done ? 'Finished' : r.phase)),
    h('div', { class: 't' }, r.title),
    t ? h('div', { class: 'bar' }, h('i', { style: { width: Math.round((100 * d) / t) + '%' } })) : null,
    h('div', { class: 'muted small' }, (t ? `${d} of ${t} parts done · ` : '') + ago(r.started)));
}

export function chatTile(c) {
  return h('a', { class: 'tile', href: '#/assistant/' + c.id },
    h('span', { class: 'kicker' }, icon('chat'), 'Conversation'),
    h('div', { class: 't' }, c.title),
    h('div', { class: 'muted small' }, ago(c.updated)));
}
