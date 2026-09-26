// Settings: every choice in plain words, with drop-downs and switches.
// Changes save immediately.

import { h, icon, btn, api, toast, fail, ask, confirmBox, store, bus, humanize, clear } from '../ui.js';
import { speech, canSpeak, canDictate } from '../voice.js';
import { modelOptions, EFFORT_LABELS } from './chat.js';
import { TEAM_MODES } from './home.js';
import qrcode from '../../vendor/qrcode.mjs';

const SECTIONS = [
  ['general', 'Look & feel', 'sun'],
  ['models', 'Models & effort', 'zap'],
  ['team', 'How the team works', 'users'],
  ['subscriptions', 'Subscriptions', 'key'],
  ['instructions', 'Instructions', 'book'],
  ['keys', 'API keys', 'shield'],
  ['voice', 'Voice', 'mic'],
  ['phone', 'Use on your phone', 'phone'],
  ['lessons', 'Lessons learned', 'bulb'],
  ['about', 'About & check-up', 'info'],
];

const LANGS = [
  ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-IN', 'English (India / Pakistan)'],
  ['ur-PK', 'اردو — Urdu (Pakistan)'], ['ar-SA', 'العربية — Arabic'], ['hi-IN', 'Hindi'], ['pa-IN', 'Punjabi (Gurmukhi)'],
  ['zh-CN', 'Chinese (Mandarin)'], ['tr-TR', 'Turkish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['es-ES', 'Spanish'],
];

// ------------------------------------------------------------------ small controls

function row(label, hint, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'l' }, h('b', null, label), hint ? h('small', null, hint) : null), control);
}

function seg(options, value, onchange) {
  const btns = options.map(([v, label]) => h('button', {
    type: 'button', class: v === value ? 'on' : '', onclick: (e) => {
      btns.forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      onchange(v);
    },
  }, label));
  return h('div', { class: 'seg' }, btns);
}

function toggle(checked, onchange, label = '') {
  return h('label', { class: 'switch', title: label || null }, h('input', { type: 'checkbox', checked, 'aria-label': label || 'On or off', onchange: (e) => onchange(e.target.checked) }), h('i'));
}

function select(options, value, onchange) {
  return h('select', { style: { width: 'auto', minWidth: '200px' }, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function number(value, { min = 0, max = 1000, step = 1 } = {}, onchange) {
  let t = null;
  return h('input', {
    type: 'number', value: String(value), min, max, step, style: { width: '110px' },
    oninput: (e) => { clearTimeout(t); t = setTimeout(() => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v >= min && v <= max) onchange(v); }, 600); },
  });
}

async function save(partial, quiet = false) {
  try {
    const s = await api('/api/settings', { method: 'PUT', body: partial });
    if (store.overview) Object.assign(store.overview, { models: s.models, team: s.team, app: s.app, accounts: s.accounts });
    store.settings = { ...store.settings, ...s };
    bus.emit('settings', s);
    if (!quiet) toast('Saved.');
    return s;
  } catch (e) { fail(e); throw e; }
}

export function applyLook(app) {
  const root = document.documentElement;
  if (!app.theme || app.theme === 'system') delete root.dataset.theme; else root.dataset.theme = app.theme;
  if (!app.accent || app.accent === 'green') delete root.dataset.accent; else root.dataset.accent = app.accent;
  try { localStorage.setItem('crew.theme', app.theme || 'system'); localStorage.setItem('crew.accent', app.accent || 'green'); } catch (e) { /* private mode */ }
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--accent').trim() || '#0C7A55';
}

// ------------------------------------------------------------------ page

export function settingsPage(view, params) {
  const section = SECTIONS.some((s) => s[0] === params[0]) ? params[0] : 'general';
  const body = h('div', { class: 'stack', style: { gap: '18px' } }, h('div', { class: 'empty' }, 'Loading…'));
  const nav = h('nav', { class: 'subnav' }, SECTIONS.map(([k, label]) => h('a', { href: '#/settings/' + k, class: k === section ? 'on' : '' }, label)));
  view.append(h('div', { class: 'page wide' }, h('h1', null, 'Settings'), h('div', { class: 'settings' }, nav, body)));
  let alive = true;
  api('/api/settings').then((s) => {
    if (!alive) return;
    store.settings = s;
    body.replaceChildren(...[].concat(RENDER[section](s)));
  }).catch(fail);
  return () => { alive = false; };
}

const card = (title, intro, ...kids) => h('section', { class: 'card set-card' }, h('h2', null, title), intro ? h('p', { class: 'muted' }, intro) : null, ...kids);

const RENDER = {
  general(s) {
    const app = s.app;
    const accents = [['green', '#0C7A55'], ['blue', '#2F5FD0'], ['plum', '#8A3FB8'], ['amber', '#B86A00']];
    const sw = h('div', { class: 'swatches' }, accents.map(([k, c]) => h('button', {
      type: 'button', class: app.accent === k ? 'on' : '', style: { background: c }, title: humanize(k), 'aria-label': humanize(k),
      onclick: async (e) => {
        sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        app.accent = k; applyLook(app); await save({ app: { accent: k } }, true);
      },
    })));
    return [
      card('Look & feel', '',
        row('Theme', 'Light, dark, or follow Windows', seg([['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']], app.theme,
          async (v) => { app.theme = v; applyLook(app); await save({ app: { theme: v } }, true); })),
        row('Colour', 'The accent used for buttons and highlights', sw)),
      store.isLocal ? card('Crew’s folder', 'Everything Crew keeps — projects, captures, settings, lessons — lives in one folder on this computer.',
        row('Open the folder', '', btn('Open', () => api('/api/open-home', { method: 'POST', body: {} }).catch(fail), { ic: 'folder' }))) : null,
    ].filter(Boolean);
  },

  models(s) {
    const m = s.models, app = s.app;
    const models = modelOptions().map((o) => [o.value, o.label]);
    const efforts = (s.efforts || Object.keys(EFFORT_LABELS)).map((e) => [e, EFFORT_LABELS[e] || e]);
    const claude = s.accounts.filter((a) => a.vendor === 'claude');
    const chips = (list, key, warn) => {
      const box = h('div', { class: 'chiplist' });
      const draw = () => box.replaceChildren(...list.map((x) => h('span', { class: 'pill' }, x, h('button', {
        type: 'button', title: 'Remove', 'aria-label': 'Remove ' + x, onclick: async () => {
          if (warn && !(await warn(x))) return;
          list.splice(list.indexOf(x), 1); draw(); await save({ models: { [key]: list } });
        },
      }, '×'))), h('button', {
        class: 'btn sm ghost', type: 'button', onclick: async () => {
          const v = await ask(key === 'allowed' ? 'Allow a model' : 'Ban a word', [{ name: 'v', label: key === 'allowed' ? 'Model name' : 'Word in the model name', required: true, placeholder: key === 'allowed' ? 'claude-…' : 'e.g. haiku' }], { ok: 'Add' });
          if (!v || list.includes(v.v)) return;
          list.push(v.v); draw();
          try { await save({ models: { [key]: list } }); } catch (e) { list.pop(); draw(); }
        },
      }, icon('plus'), 'Add'));
      draw();
      return box;
    };
    return [
      card('The Assistant', 'The model that answers you in conversations.',
        row('Model', '', select(models, app.chat_model, (v) => save({ app: { chat_model: v } }))),
        row('Effort', 'Higher effort thinks longer and uses more of your limits', select(efforts, app.chat_effort, (v) => save({ app: { chat_effort: v } }))),
        claude.length > 1 ? row('Subscription', 'Which Claude subscription the Assistant uses', select([['', 'The first one'], ...claude.map((a) => [a.name, a.name])], app.chat_account || '', (v) => save({ app: { chat_account: v } }))) : null),
      card('The team', 'Models for team projects. Quality comes first: every builder uses the main model.',
        row('Main model', 'Does the planning, building and checking', select(models, m.work, (v) => save({ models: { work: v } }))),
        row('Final approval (the “CEO”)', 'Looks over the whole result once, at the end', select([...models, ['', 'No separate final model']], m.ceo, (v) => save({ models: { ceo: v } }))),
        row('Effort for the work', '', select(efforts, m.effort_work, (v) => save({ models: { effort_work: v } }))),
        row('Effort for light jobs', 'Checking, notes and research', select(efforts, m.effort_light, (v) => save({ models: { effort_light: v } }))),
        row('Effort for final approval', '', select(efforts, m.effort_ceo, (v) => save({ models: { effort_ceo: v } }))),
        row('ChatGPT (Codex) model', 'Leave empty to use its best model', (() => {
          const inp = h('input', { type: 'text', value: m.codex || '', placeholder: 'Its best model', style: { width: '220px' } });
          inp.addEventListener('change', () => save({ models: { codex: inp.value.trim() } }));
          return inp;
        })())),
      card('Allowed and banned models', 'Only allowed Claude models may run. Any model whose name contains a banned word is refused everywhere.',
        row('Allowed', '', chips([...m.allowed], 'allowed')),
        row('Banned', '', chips([...m.banned], 'banned', (x) => confirmBox(`Lift the ban on “${x}”?`, 'Your rule was to never use it. Lift the ban anyway?', { ok: 'Lift the ban', danger: true })))),
    ];
  },

  team(s) {
    const t = s.team;
    return [
      card('How the team works', '',
        row('Who builds', TEAM_MODES.find((x) => x.value === t.mode)?.hint || '', select(TEAM_MODES.map((x) => [x.value, x.label]), t.mode, (v) => save({ team: { mode: v } }))),
        row('Checking each piece', 'Every piece of work is checked by someone who did not build it',
          select([['cross', 'A member on another subscription checks'], ['same', 'Any other member checks'], ['off', 'No checks (not recommended)']], t.review, (v) => save({ team: { review: v } }))),
        row('Final approval by the CEO model', 'One last look at the whole result before it is handed over', toggle(t.ceo_reviews, (v) => save({ team: { ceo_reviews: v } }))),
        row('When the work is finished', '', select([['merge', 'Put it in the project folder'], ['branch', 'Keep it as a separate version for me to check'], ['push', 'Put it in the folder and upload it online']], t.deliver, (v) => save({ team: { deliver: v } }))),
        row('Let agents do anything without asking', 'On: fully automatic (your choice). Off: a safety check approves each action.',
          toggle(t.permission_mode === 'bypassPermissions', (v) => save({ team: { permission_mode: v ? 'bypassPermissions' : 'auto' } })))),
      card('Limits and pacing', 'Sensible defaults; change them only if you need to.',
        row('Time limit (hours)', 'The team wraps up and reports when this is reached', number(t.max_hours, { min: 0.25, max: 48, step: 0.25 }, (v) => save({ team: { max_hours: v } }))),
        row('Spending limit (US$)', '0 means no limit (subscriptions are flat-rate)', number(t.max_cost_usd, { min: 0, max: 10000, step: 1 }, (v) => save({ team: { max_cost_usd: v } }))),
        row('Nudge a quiet member after (minutes)', '', number(t.stall_minutes, { min: 2, max: 60 }, (v) => save({ team: { stall_minutes: v } }))),
        row('Progress review every (minutes)', 'The lead re-plans when progress stalls', number(t.ledger_minutes, { min: 3, max: 120 }, (v) => save({ team: { ledger_minutes: v } }))),
        row('Team-chat messages per member per step', 'Keeps discussion short and useful', number(t.chat_budget, { min: 2, max: 50 }, (v) => save({ team: { chat_budget: Math.round(v) } }))),
        row('Rounds of corrections before the lead decides', '', number(t.max_review_rounds, { min: 1, max: 10 }, (v) => save({ team: { max_review_rounds: Math.round(v) } }))),
        row('Time allowed for automatic tests (minutes)', '', number(t.checks_timeout_minutes, { min: 1, max: 120 }, (v) => save({ team: { checks_timeout_minutes: v } })))),
    ];
  },

  subscriptions(s) {
    const list = h('div');
    const vendorName = (v) => (v === 'claude' ? 'Claude' : 'ChatGPT (Codex)');
    async function load(refresh = false) {
      list.replaceChildren(h('div', { class: 'muted', style: { padding: '10px 0' } }, 'Checking your subscriptions…'));
      try {
        const r = await api('/api/accounts/status' + (refresh ? '?refresh=1' : ''));
        list.replaceChildren(...r.accounts.map((a) => h('div', { class: 'acct' },
          h('span', { class: 'avatar', style: { background: a.vendor === 'claude' ? '#C15F3C' : '#10A37F' } }, a.vendor === 'claude' ? 'C' : 'G'),
          h('div', { class: 'grow' }, h('b', null, a.name), h('div', { class: 'muted small' }, vendorName(a.vendor) + (a.detail ? ' · ' + a.detail : ''))),
          h('span', { class: 'pill ' + (a.signed_in ? 'ok' : a.signed_in === false ? 'bad' : '') }, a.signed_in ? 'Signed in' : a.signed_in === false ? 'Not signed in' : 'Unknown'),
          store.isLocal ? btn(a.signed_in ? 'Sign in again' : 'Sign in', async () => {
            try { const m = await api(`/api/accounts/${encodeURIComponent(a.name)}/login`, { method: 'POST', body: {} }); toast(m.message, { ms: 9000 }); } catch (e) { fail(e); }
          }, { cls: 'sm' + (a.signed_in ? ' ghost' : ' primary') }) : null,
          btn('', async () => {
            if (!(await confirmBox(`Remove ${a.name}?`, 'Crew stops using this subscription. Its sign-in stays on this computer.', { ok: 'Remove', danger: true }))) return;
            const rest = s.accounts.filter((x) => x.name !== a.name);
            if (!rest.some((x) => x.vendor === 'claude')) { toast('At least one Claude subscription is needed: the team lead runs on Claude.', { bad: true }); return; }
            try { const n = await save({ accounts: rest }); s.accounts = n.accounts; load(); } catch (e) { /* shown */ }
          }, { cls: 'sm icon ghost', ic: 'trash', title: 'Remove' }))));
      } catch (e) { fail(e); }
    }
    async function add() {
      const v = await ask('Add a subscription', [
        { name: 'vendor', label: 'Which service', type: 'select', value: 'claude', options: [{ value: 'claude', label: 'Claude (Pro or Max)' }, { value: 'codex', label: 'ChatGPT (Plus or Pro) — through Codex' }] },
        { name: 'name', label: 'A short name for it', placeholder: 'e.g. claude-2, work-max, chatgpt', required: true },
      ], { ok: 'Add', intro: 'Each subscription signs in once, separately. Crew spreads the work across all of them and switches automatically when one reaches its limit.' });
      if (!v) return;
      const name = v.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      if (s.accounts.some((a) => a.name === name)) { toast('That name is already used.', { bad: true }); return; }
      try {
        const n = await save({ accounts: [...s.accounts, { name, vendor: v.vendor, profile: '' }] });
        s.accounts = n.accounts;
        await load();
        if (store.isLocal) {
          const m = await api(`/api/accounts/${encodeURIComponent(name)}/login`, { method: 'POST', body: {} });
          toast(m.message, { ms: 9000 });
        }
      } catch (e) { /* shown */ }
    }
    load();
    return [card('Subscriptions', 'Your Claude and ChatGPT subscriptions. The team shares the work across them so no single one runs out, and carries on with the others if one does.',
      list,
      h('div', { class: 'row wrap', style: { marginTop: '10px' } }, btn('Add a subscription', add, { cls: 'primary', ic: 'plus' }), btn('Check again', () => load(true), { ic: 'reload' })),
      h('p', { class: 'muted small', style: { margin: '10px 0 0' } }, 'Use only your own subscriptions, for your own work, and never share a sign-in.'))];
  },

  instructions(s) {
    const editor = (value, path, label) => {
      const ta = h('textarea', { class: 'editor', rows: 16, 'aria-label': label }, value);
      const saveBtn = btn('Save', async () => {
        try { await api(path, { method: 'PUT', body: { text: ta.value } }); toast('Saved. New work follows these instructions.'); saveBtn.disabled = true; } catch (e) { fail(e); }
      }, { cls: 'primary', disabled: true });
      ta.addEventListener('input', () => { saveBtn.disabled = false; });
      return [ta, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } }, saveBtn)];
    };
    return [
      card('Team rules', 'Standing instructions every team member follows on every project. Write them like a memo to your staff.', ...editor(s.rules, '/api/rules', 'Team rules')),
      card('Assistant instructions', 'How the Assistant should behave in conversations: tone, format, what to ask before acting.', ...editor(s.assistant, '/api/assistant-instructions', 'Assistant instructions')),
    ];
  },

  keys(s) {
    const list = h('div');
    const draw = (secrets) => list.replaceChildren(...(secrets.length ? secrets.map((k) => h('div', { class: 'acct' },
      icon('key'), h('div', { class: 'grow' }, h('b', { class: 'code-box' }, k.name), h('div', { class: 'muted small code-box' }, k.hint)),
      btn('', async () => {
        if (!(await confirmBox(`Delete ${k.name}?`, 'Agents will no longer be able to use this key.', { ok: 'Delete', danger: true }))) return;
        try { const r = await api('/api/secrets', { method: 'PUT', body: { name: k.name, value: null } }); draw(r.secrets); } catch (e) { fail(e); }
      }, { cls: 'sm icon ghost', ic: 'trash', title: 'Delete' }))) : [h('p', { class: 'muted' }, 'No keys yet.')]));
    draw(s.secrets);
    const add = async () => {
      const v = await ask('Add an API key', [
        { name: 'name', label: 'Name', placeholder: 'e.g. OPENWEATHER_API_KEY', required: true, hint: 'Capital letters, digits and underscores.' },
        { name: 'value', label: 'The key', type: 'password', required: true },
      ], { ok: 'Save key' });
      if (!v) return;
      try { const r = await api('/api/secrets', { method: 'PUT', body: { name: v.name.toUpperCase(), value: v.value } }); draw(r.secrets); toast('Key saved.'); } catch (e) { fail(e); }
    };
    return [card('API keys', 'Keys for other services (weather, maps, email…). They stay on this computer; agents can use them, and they are hidden from every chat, log and report.',
      list, h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Add a key', add, { cls: 'primary', ic: 'plus' })))];
  },

  voice(s) {
    const app = s.app;
    const voiceSel = h('select', { style: { width: 'auto', minWidth: '240px' }, onchange: (e) => save({ app: { voice_name: e.target.value } }) });
    const fillVoices = () => {
      const voices = speech.voices().slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      voiceSel.replaceChildren(h('option', { value: '' }, 'Automatic'), ...voices.map((v) => h('option', { value: v.name, selected: v.name === app.voice_name }, `${v.name} — ${v.lang}`)));
    };
    fillVoices();
    document.addEventListener('crew:voices', fillVoices, { once: true });
    const rate = h('input', { type: 'range', min: 0.6, max: 1.8, step: 0.1, value: String(app.voice_rate || 1) });
    const rateLabel = h('span', { class: 'muted small', style: { width: '40px' } }, `${Number(app.voice_rate || 1).toFixed(1)}×`);
    let rt = null;
    rate.addEventListener('input', () => {
      rateLabel.textContent = `${Number(rate.value).toFixed(1)}×`;
      store.overview.app.voice_rate = Number(rate.value);
      clearTimeout(rt);
      rt = setTimeout(() => save({ app: { voice_rate: Number(rate.value) } }, true), 500);
    });
    return [
      card('Speaking to Crew', canDictate ? 'Press the microphone to type with your voice, or the sound-wave button for a spoken conversation.' : 'Voice typing needs Microsoft Edge or Google Chrome.',
        row('Language you speak', 'Urdu works too', select(LANGS, app.dictation_lang, (v) => save({ app: { dictation_lang: v } })))),
      card('Crew speaking to you', canSpeak ? 'Answers can be read aloud. Microsoft Edge has the most natural voices, including Urdu (Uzma, Asad).' : 'Reading aloud needs Microsoft Edge or Google Chrome.',
        row('Voice', '', voiceSel),
        row('Speed', '', h('div', { class: 'row' }, rate, rateLabel)),
        row('Read every answer aloud', 'Otherwise press the speaker button under an answer', toggle(app.auto_read, (v) => save({ app: { auto_read: v } }))),
        row('Try it', '', btn('Play a sample', () => speech.speak('Hello. This is how I will sound when I read my answers to you.'), { ic: 'volume' }))),
    ];
  },

  phone(s) {
    if (!store.isLocal) {
      return [card('Use on your phone', 'You are already using Crew on this device. To pair another phone or sign phones out, open Settings on the computer running Crew.')];
    }
    const out = h('div', { class: 'stack' });
    const draw = (p) => {
      const sw = toggle(p.enabled, async (v) => {
        try { const r = await api('/api/phone-access', { method: 'POST', body: { enabled: v } }); toast(r.message, { ms: 8000 }); draw(r); } catch (e) { fail(e); }
      }, 'Phone access');
      const codes = h('div', { class: 'stack' });
      if (p.enabled && p.urls.length) {
        for (const url of p.urls) {
          const qr = qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          codes.append(h('div', { class: 'qr-wrap' },
            h('div', { class: 'qr', html: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: false }) }),
            h('ol', { class: 'connect-steps' },
              h('li', null, h('div', null, 'Make sure the phone is on the same Wi-Fi as this computer.')),
              h('li', null, h('div', null, 'Open the phone’s camera and point it at this code. Tap the link that appears.')),
              h('li', null, h('div', null, 'In Chrome, tap ⋮ then “Add to Home screen” for a Crew app icon.')))));
        }
      } else if (p.enabled) {
        codes.append(h('p', { class: 'muted' }, 'This computer is not connected to a network.'));
      }
      clear(out,
        row('Allow my phone to open Crew', 'Only phones you pair with the code below can get in', sw),
        codes,
        p.enabled ? row('Sign out all paired phones', 'Makes a new code; phones must scan again', btn('Sign out phones', async () => {
          if (!(await confirmBox('Sign out all phones?', 'Every paired phone will need to scan the new code.', { ok: 'Sign out', danger: true }))) return;
          try { draw(await api('/api/phone-access/new-code', { method: 'POST', body: {} })); toast('Done. Scan the new code to pair again.'); } catch (e) { fail(e); }
        }, { cls: 'sm danger' })) : null);
    };
    api('/api/pair').then(draw).catch(fail);
    return [
      card('Use Crew on your phone', 'Ask, build and follow projects from your Samsung. Crew keeps running on this computer; the phone is a remote screen for it.', out),
      card('Voice on the phone', 'The phone’s browser only allows the microphone on secure connections. Two easy ways:',
        h('ol', { class: 'connect-steps' },
          h('li', null, h('div', null, h('b', null, 'At your desk: '), 'connect the phone on the Phone page. Crew then also opens on the phone at ', h('span', { class: 'code-box' }, 'localhost:' + (location.port || '8765')), ', where the microphone works.')),
          h('li', null, h('div', null, h('b', null, 'Anywhere: '), 'install Tailscale (free) on both the computer and the phone. It gives Crew a private, secure address that works away from home too.'))),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('a', { class: 'btn sm', href: '#/phone' }, icon('phone'), 'Open the Phone page'))),
    ];
  },

  lessons() {
    const box = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    api('/api/lessons').then((r) => {
      box.replaceChildren(...(r.lessons.length ? r.lessons.map((l) => h('div', { class: 'lesson' },
        h('div', { class: 'row' }, h('span', { class: 'pill' }, humanize(l.category)), l.weight > 1 ? h('span', { class: 'muted small' }, `confirmed ${l.weight}×`) : null),
        h('div', null, l.text))) : [h('p', { class: 'muted' }, 'No lessons yet. They are written after each project.')]));
    }).catch(fail);
    return [card('Lessons learned', 'After every project the team writes down what worked and what did not. Future teams read the most useful lessons before they start, so Crew improves with use.', box)];
  },

  about() {
    const box = h('div', { class: 'health' }, h('p', { class: 'muted' }, 'Checking…'));
    const meta = h('p', { class: 'muted small', style: { margin: '10px 0 0' } });
    api('/api/health').then((r) => {
      box.replaceChildren(...r.items.map((i) => h('div', { class: 'row' },
        h('span', { class: 'dot ' + (i.ok ? 'ok' : i.optional ? 'warn' : 'bad') }), h('span', { class: 'grow' }, i.label),
        h('span', { class: 'pill ' + (i.ok ? 'ok' : i.optional ? 'warn' : 'bad') }, i.ok ? 'Ready' : i.optional ? 'Optional — not installed' : 'Missing'))));
      meta.textContent = `Crew ${r.version} · Python ${r.python} · Crew’s folder: ${r.home}`;
    }).catch(fail);
    return [
      card('Check-up', 'What Crew needs on this computer. Anything missing? Run the Crew installer again; it only adds what is missing.', box, meta),
      card('About Crew', '',
        h('p', { style: { margin: 0 } }, 'Crew turns your subscriptions into one team. A lead plans the work, members build separate parts at the same time, every part is checked by someone else, and a final review approves the whole. Everything runs on this computer, on your own subscriptions.')),
    ];
  },
};
