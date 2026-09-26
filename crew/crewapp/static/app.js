// Crew app: start-up, navigation, the sidebar, and the side panel
// (browser, phone and file previews next to whatever you are doing).

import { $, $$, h, icon, btn, api, store, bus, fail, toast, markdown, isSmall, download, esc } from './js/ui.js';
import { home } from './js/pages/home.js';
import { assistant } from './js/pages/chat.js';
import { projects, project } from './js/pages/projects.js';
import { browserPage, phonePage, computerPage, capturesPage, skillsPage, morePage } from './js/pages/misc.js';
import { settingsPage, applyLook } from './js/pages/settings.js';
import { mountLive } from './js/devices.js';

const ROUTES = [
  [/^\/$/, home, 'home', 'Crew'],
  [/^\/assistant(?:\/([\w-]+))?$/, assistant, 'assistant', 'Assistant'],
  [/^\/projects$/, projects, 'projects', 'Projects'],
  [/^\/projects\/([\w.-]+)$/, project, 'projects', 'Project'],
  [/^\/browser$/, browserPage, 'browser', 'Browser'],
  [/^\/phone$/, phonePage, 'phone', 'Phone'],
  [/^\/computer$/, computerPage, 'computer', 'Computer'],
  [/^\/captures$/, capturesPage, 'captures', 'Captures'],
  [/^\/skills$/, skillsPage, 'skills', 'Skills'],
  [/^\/settings(?:\/(\w+))?$/, settingsPage, 'settings', 'Settings'],
  [/^\/more$/, morePage, 'more', 'More'],
];

let cleanup = null;

function currentPath() {
  return (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/';
}

function route() {
  const path = currentPath();
  const found = ROUTES.find(([rx]) => rx.test(path));
  if (!found) { location.hash = '#/'; return; }
  const [rx, render, nav, title] = found;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const view = $('#view');
  view.replaceChildren();
  view.scrollTop = 0;
  view.style.overflow = '';
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  $('#topTitle').textContent = title;
  document.title = title === 'Crew' ? 'Crew' : `${title} · Crew`;
  if (panel.isOpen && (isSmall() || !['assistant', 'projects'].includes(nav))) panel.close();
  try {
    cleanup = render(view, path.match(rx).slice(1)) || null;
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'This screen could not open. ' + e.message)));
  }
  markRecent();
  view.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ sidebar: recent work

let recentItems = [];

async function refreshRecent() {
  try {
    const ov = await api('/api/overview');
    store.overview = ov;
    const runs = ov.runs.map((r) => ({ href: '#/projects/' + r.id, title: r.title, t: r.started, ic: 'layers', live: r.running }));
    const chats = ov.chats.map((c) => ({ href: '#/assistant/' + c.id, title: c.title, t: c.updated, ic: 'chat' }));
    recentItems = [...runs, ...chats].sort((a, b) => b.t - a.t).slice(0, 30);
    const live = ov.runs.filter((r) => r.running).length;
    $('#liveBadge').textContent = live ? String(live) : '';
    drawRecent();
  } catch (e) {
    if (e.status === 401) location.reload();
  }
}

function drawRecent() {
  const box = $('#recent');
  box.replaceChildren(...(recentItems.length ? recentItems.map((it) => h('a', { href: it.href, title: it.title },
    it.live ? h('span', { class: 'live-dot', title: 'Working now' }) : icon(it.ic), h('span', null, it.title)))
    : [h('span', { class: 'muted small', style: { padding: '6px 12px' } }, 'Your conversations and projects will appear here.')]));
  markRecent();
}

function markRecent() {
  const here = '#' + currentPath();
  $$('#recent a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === here));
}

// ------------------------------------------------------------------ side panel

const panel = {
  el: $('#panel'),
  body: $('#panelBody'),
  tab: null,
  item: null,
  release: null,
  get isOpen() { return this.el.classList.contains('open'); },

  open(tab, item = null) {
    if ((tab === 'browser' || tab === 'phone') && currentPath() === '/' + tab) return; // already on screen
    if (item) this.item = item;
    this.el.classList.add('open');
    if (tab !== this.tab || tab === 'preview') this.show(tab);
  },

  close() {
    this.el.classList.remove('open', 'max');
    if (this.release) { this.release(); this.release = null; }
    this.body.replaceChildren();
    this.tab = null;
    $('#panelMax').replaceChildren(icon('expand'));
  },

  show(tab) {
    if (this.release) { this.release(); this.release = null; }
    this.tab = tab;
    this.body.replaceChildren();
    $$('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'browser' || tab === 'phone') {
      const holder = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '0' } });
      this.body.append(holder);
      this.release = mountLive(tab, holder, 'panel');
    } else {
      this.body.append(preview(this.item));
    }
  },
};

bus.on('live:claim', ({ kind, owner }) => {
  if (owner !== 'panel' && panel.isOpen && panel.tab === kind) panel.close();
});
bus.on('panel:open', (tab) => panel.open(tab));
bus.on('panel:preview', (item) => panel.open('preview', item));

$$('#panelTabs button').forEach((b) => b.addEventListener('click', () => panel.open(b.dataset.tab)));
$('#panelClose').addEventListener('click', () => panel.close());
$('#panelMax').addEventListener('click', () => {
  const max = panel.el.classList.toggle('max');
  $('#panelMax').replaceChildren(icon(max ? 'shrink' : 'expand'));
});
$('#topBrowser').addEventListener('click', () => { location.hash = '#/browser'; });

// ------------------------------------------------------------------ previews (files made by the assistant or the team)

function preview(item) {
  if (!item) {
    return h('div', { class: 'screen-wrap' }, h('div', { class: 'placeholder' }, icon('doc'),
      h('div', null, 'Pages, documents and pictures that the assistant or the team make will open here.')));
  }
  const name = String(item.name || '').split('/').pop() || 'Preview';
  const bar = h('div', { class: 'screen-bar' }, h('b', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    btn('', () => { const f = box.querySelector('iframe'); if (f) f.src = f.src; else panel.show('preview'); }, { cls: 'icon ghost', ic: 'reload', title: 'Reload' }),
    btn('', () => window.open(item.url, '_blank', 'noopener'), { cls: 'icon ghost', ic: 'external', title: 'Open in a new window' }),
    btn('', () => download(item.url, name), { cls: 'icon ghost', ic: 'download', title: 'Download' }));
  const box = h('div', { class: 'livebox' }, bar);
  const kind = item.kind || 'file';
  if (kind === 'web') {
    box.append(h('iframe', { class: 'preview-frame', src: item.url, sandbox: 'allow-scripts allow-forms allow-popups allow-modals', title: name }));
  } else if (kind === 'pdf') {
    box.append(h('iframe', { class: 'preview-frame', src: item.url, title: name }));
  } else if (kind === 'image') {
    box.append(h('div', { class: 'preview-img' }, h('img', { src: item.url, alt: name })));
  } else if (kind === 'doc' || kind === 'table') {
    const doc = h('div', { class: 'preview-doc md' }, h('p', { class: 'muted' }, 'Opening…'));
    box.append(doc);
    fetch(item.url, { credentials: 'same-origin' }).then((r) => r.text()).then((text) => {
      if (kind === 'table' || /\.csv$/i.test(name)) doc.innerHTML = csvTable(text);
      else if (/\.(md|markdown)$/i.test(name)) doc.innerHTML = markdown(text);
      else doc.replaceChildren(h('pre', { style: { whiteSpace: 'pre-wrap' } }, text));
    }).catch(fail);
  } else {
    box.append(h('div', { class: 'screen-wrap' }, h('div', { class: 'placeholder' }, icon('doc'), h('div', null, 'This file cannot be shown here.'),
      btn('Download it', () => download(item.url, name), { cls: 'primary', ic: 'download' }))));
  }
  return box;
}

function csvTable(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return '<p class="muted">Empty file.</p>';
  const [head, ...rest] = rows.slice(0, 1001);
  return '<table><thead><tr>' + head.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    rest.map((r) => '<tr>' + head.map((_, k) => `<td>${esc(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>' +
    (rows.length > 1001 ? `<p class="muted">Showing the first 1,000 of ${rows.length - 1} rows.</p>` : '');
}

// ------------------------------------------------------------------ theme button

$('#themeBtn').addEventListener('click', async () => {
  const app = (store.overview && store.overview.app) || {};
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  app.theme = dark ? 'light' : 'dark';
  applyLook(app);
  try { await api('/api/settings', { method: 'PUT', body: { app: { theme: app.theme } } }); } catch (e) { fail(e); }
});

// ------------------------------------------------------------------ start

async function boot() {
  try {
    store.overview = await api('/api/overview');
  } catch (e) {
    if (e.status === 401) { location.reload(); return; }
    $('#view').append(h('div', { class: 'page' }, h('div', { class: 'empty' }, e.message, h('div', { style: { marginTop: '12px' } }, btn('Try again', () => location.reload(), { cls: 'primary' })))));
    return;
  }
  store.isLocal = !!store.overview.local;
  applyLook(store.overview.app || {});
  window.addEventListener('hashchange', route);
  route();
  refreshRecent();
  bus.on('chats', refreshRecent);
  bus.on('runs', refreshRecent);
  setInterval(refreshRecent, 20000);
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
  }
  window.addEventListener('offline', () => toast('You are offline. Crew will reconnect by itself.', { bad: true }));
}

boot();
