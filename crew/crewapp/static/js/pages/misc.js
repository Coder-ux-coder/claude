// Browser and phone pages, captures, skills, and the "More" menu for phones.

import { h, icon, btn, api, toast, fail, ask, dialog, confirmBox, bus, store, markdown, ago, bytes, humanize } from '../ui.js';
import { mountLive } from '../devices.js';
import { openViewer, captureScreen, recordScreen, canCaptureScreen, saveCapture } from '../live.js';

// ------------------------------------------------------------------ browser & phone pages

export function browserPage(view) {
  const box = h('div', { class: 'page-live' },
    h('div', { class: 'live-head' }, h('h2', { class: 'grow' }, 'Browser'),
      h('span', { class: 'muted small' }, 'You and the assistant share this browser. Sign in to websites here once.')),
  );
  const holder = h('div', { style: { display: 'flex', flex: '1', minHeight: '0' } });
  box.append(holder);
  view.append(box);
  holder.style.flexDirection = 'column';
  return mountLive('browser', holder, 'page');
}

export function phonePage(view) {
  const box = h('div', { class: 'page-live' },
    h('div', { class: 'live-head' }, h('h2', { class: 'grow' }, 'Your phone'),
      h('span', { class: 'muted small' }, 'Click to tap, drag to swipe, type to write. The assistant can use it too when you ask.')));
  const holder = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
  box.append(holder);
  view.append(box);
  return mountLive('phone', holder, 'page');
}

// ------------------------------------------------------------------ captures

export function capturesPage(view) {
  let filter = 'all';
  let items = [];
  const gallery = h('div', { class: 'gallery' });
  const segBtns = {};
  const seg = h('div', { class: 'seg' }, [['all', 'All'], ['image', 'Pictures'], ['video', 'Recordings']].map(([v, l]) => {
    segBtns[v] = h('button', { type: 'button', onclick: () => { filter = v; render(); } }, l);
    return segBtns[v];
  }));
  const upload = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,video/webm,video/mp4', multiple: true, class: 'hidden', onchange: async (e) => {
      for (const f of e.target.files) {
        const ext = (f.name.split('.').pop() || 'png').toLowerCase();
        try { await saveCapture(f, ext === 'jpeg' ? 'jpg' : ext, f.name.replace(/\.[^.]+$/, '')); } catch (x) { fail(x); }
      }
      e.target.value = '';
    },
  });
  const tools = h('div', { class: 'capture-tools' },
    canCaptureScreen ? btn('Capture my screen', () => captureScreen(), { cls: 'primary', ic: 'camera' }) : null,
    canCaptureScreen ? btn('Record my screen', () => recordScreen(), { ic: 'record', cls: 'rec' }) : null,
    btn('Browser picture', async () => {
      try { const info = await api('/api/browser/screenshot', { method: 'POST', body: { full: false } }); bus.emit('captures'); openViewer(info); } catch (e) { fail(e); }
    }, { ic: 'globe' }),
    btn('Phone picture', async () => {
      try { const info = await api('/api/phone/screenshot', { method: 'POST', body: {} }); bus.emit('captures'); openViewer(info); } catch (e) { fail(e); }
    }, { ic: 'phone' }),
    btn('Add from this device', () => upload.click(), { ic: 'plus' }), upload);

  function render() {
    for (const [k, b] of Object.entries(segBtns)) b.classList.toggle('on', k === filter);
    const shown = items.filter((c) => filter === 'all' || c.kind === filter);
    if (!shown.length) {
      gallery.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1/-1' } },
        items.length ? 'Nothing here yet.' : 'Screenshots and recordings you make appear here. You can draw on them, copy them, or ask the assistant about them.'));
      return;
    }
    gallery.replaceChildren(...shown.map((c) => h('div', { class: 'shot', role: 'button', tabindex: 0, onclick: () => openViewer(c, { onChange: load }), onkeydown: (e) => { if (e.key === 'Enter') openViewer(c, { onChange: load }); } },
      c.kind === 'video' ? h('video', { src: c.url + '#t=0.5', preload: 'metadata', muted: true }) : h('img', { src: c.url, loading: 'lazy', alt: c.name }),
      c.kind === 'video' ? h('span', { class: 'kind' }, 'Recording') : null,
      h('div', null, h('span', null, ago(c.created)), h('span', null, bytes(c.size))))));
  }
  async function load() {
    try { items = (await api('/api/captures')).captures; render(); } catch (e) { fail(e); }
  }
  view.append(h('div', { class: 'page wide' },
    h('div', { class: 'stack' }, h('h1', null, 'Captures'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Take pictures and recordings of your screen, the browser or your phone. Click one to draw on it, copy it, or ask the assistant about it.')),
    tools, h('div', { class: 'row between' }, seg), gallery));
  load();
  return bus.on('captures', load);
}

// ------------------------------------------------------------------ skills

export function skillsPage(view) {
  const list = h('div', { class: 'grid two' });
  async function load() {
    try {
      const r = await api('/api/skills');
      list.replaceChildren(...r.skills.map(card));
    } catch (e) { fail(e); }
  }
  function card(s) {
    const sw = h('input', {
      type: 'checkbox', checked: s.enabled, 'aria-label': 'Switched on', onchange: async (e) => {
        try { await api(`/api/skills/${s.id}/toggle`, { method: 'POST', body: { enabled: e.target.checked } }); toast(e.target.checked ? 'Skill switched on.' : 'Skill switched off.'); } catch (x) { fail(x); e.target.checked = !e.target.checked; }
      },
    });
    return h('div', { class: 'card skill' },
      h('div', { class: 'row' }, h('h3', null, humanize(s.name)), h('label', { class: 'switch', title: 'Switch on or off' }, sw, h('i'))),
      h('p', null, s.summary || s.description.replace(/^Use when /i, 'Used when ')),
      h('div', { class: 'row wrap' }, h('span', { class: 'pill' + (s.origin === 'built-in' ? '' : ' live') }, s.origin === 'built-in' ? 'Built in' : 'Made by your teams'),
        h('span', { class: 'grow' }),
        btn('View', () => viewSkill(s.id), { cls: 'sm ghost' }),
        s.origin !== 'built-in' ? btn('Delete', async () => {
          if (!(await confirmBox('Delete this skill?', 'The team will no longer use it.', { ok: 'Delete', danger: true }))) return;
          try { await api('/api/skills/' + s.id, { method: 'DELETE' }); load(); } catch (e) { fail(e); }
        }, { cls: 'sm ghost danger' }) : null));
  }
  async function viewSkill(id) {
    try {
      const s = await api('/api/skills/' + id);
      dialog({ title: humanize(s.name), wide: true, body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, s.description), h('div', { class: 'md', html: markdown(s.body) })) });
    } catch (e) { fail(e); }
  }
  async function create() {
    const v = await ask('Create a skill', [
      { name: 'name', label: 'Name', placeholder: 'e.g. Formal letter format', required: true },
      { name: 'when', label: 'When should it be used?', type: 'textarea', rows: 2, placeholder: 'e.g. writing any official letter or notification', required: true },
      { name: 'steps', label: 'What should be done — in plain words', type: 'textarea', rows: 8, placeholder: '1. Use the department letterhead…\n2. Reference number and date at the top…\n3. …', required: true },
    ], { ok: 'Create skill', intro: 'A skill is a written procedure the assistant and the team follow whenever it applies. They get better with it over time.' });
    if (!v) return;
    try { await api('/api/skills', { method: 'POST', body: v }); toast('Skill created and switched on.'); load(); } catch (e) { fail(e); }
  }
  view.append(h('div', { class: 'page wide' },
    h('div', { class: 'row wrap between' }, h('div', { class: 'stack' }, h('h1', null, 'Skills'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Proven ways of working that the assistant and the team follow automatically. Switch any off, or add your own.')),
    h('div', { class: 'row wrap' },
      btn('Help me write one', () => {
        store.pendingChat = { text: 'Help me create a new skill for Crew. Ask me what it should do and when it applies, then write it clearly as numbered steps.', attachments: [] };
        location.hash = '#/assistant/new';
      }, { ic: 'chat' }),
      btn('Create a skill', create, { cls: 'primary', ic: 'plus' }))),
    list));
  load();
}

// ------------------------------------------------------------------ "More" (phones)

export function morePage(view) {
  const item = (href, ic, title, sub) => h('a', { href }, h('span', { class: 'ico' }, icon(ic)), h('div', null, title, h('small', null, sub)));
  view.append(h('div', { class: 'page' }, h('h1', null, 'More'),
    h('div', { class: 'more-list' },
      item('#/browser', 'globe', 'Browser', 'The browser you share with the assistant'),
      item('#/phone', 'phone', 'Phone control', 'See and control an Android phone'),
      item('#/skills', 'sparkles', 'Skills', 'Ways of working the team follows'),
      item('#/settings', 'settings', 'Settings', 'Models, subscriptions, voice, look'),
      item('#/settings/lessons', 'bulb', 'Lessons learned', 'What the team has learned so far'),
      item('#/settings/about', 'info', 'About Crew', 'Version and installation check'))));
}
