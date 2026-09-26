// Shared building blocks: elements, icons, the API client, live streams,
// toasts, dialogs, time formatting and a small, safe Markdown renderer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ elements

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', ('i ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function btn(label, onclick, { cls = '', ic = '', title = '', disabled = false, type = 'button' } = {}) {
  return h('button', { class: ('btn ' + cls).trim(), onclick, title: title || null, 'aria-label': title || null, disabled, type },
    ic ? icon(ic) : null, label || null);
}

export function iconBtn(ic, title, onclick, cls = 'ghost') {
  return btn('', onclick, { cls: 'icon ' + cls, ic, title });
}

export function clear(el, ...kids) {
  el.replaceChildren();
  add(el, kids);
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ state + events

export const store = { overview: null, settings: null, isLocal: true };

const listeners = {};
export const bus = {
  on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); },
  emit(ev, data) { for (const fn of listeners[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } },
};

// ------------------------------------------------------------------ API

export async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const headers = {};
  let payload;
  if (method !== 'GET') headers['X-Crew'] = '1';
  if (raw !== undefined) { payload = raw; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal, credentials: 'same-origin' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Crew is not answering. Is it still running on your computer?');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// A live stream (Server-Sent Events). The browser reconnects by itself after a drop.
export function stream(url, handlers) {
  const es = new EventSource(url);
  for (const [ev, fn] of Object.entries(handlers)) {
    if (ev === 'open') es.onopen = fn;
    else if (ev === 'error') es.onerror = fn;
    else es.addEventListener(ev, (e) => { let d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ } fn(d); });
  }
  return es;
}

// Wait until a stream is connected (so no early event is missed).
export function opened(es, ms = 4000) {
  return new Promise((resolve) => {
    if (es.readyState === 1) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    es.addEventListener('open', () => { clearTimeout(t); resolve(true); }, { once: true });
  });
}

// ------------------------------------------------------------------ toasts & dialogs

export function toast(msg, { bad = false, ms = 4200, action = null, onAction = null } = {}) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  if (action) {
    t.append(' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); t.remove(); onAction && onAction(); } }, action));
  }
  box.append(t);
  setTimeout(() => t.remove(), bad ? Math.max(ms, 6500) : ms);
  return t;
}

export function fail(e) {
  if (e && e.name === 'AbortError') return;
  console.warn(e);
  toast(e && e.message ? e.message : String(e), { bad: true });
}

// A modal box. `actions`: [{label, value, primary, danger}]. Resolves with the value (or null).
export function dialog({ title, body, actions = [{ label: 'Close', value: null }], wide = false, onOpen = null }) {
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const bar = h('div', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'wrap' } },
      actions.map((a) => h('button', {
        class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), type: a.primary ? 'submit' : 'button',
        onclick: (e) => {
          if (a.primary) return; // submit handler below
          e.preventDefault();
          close(typeof a.value === 'function' ? a.value() : a.value);
        },
      }, a.label)));
    const primary = actions.find((a) => a.primary);
    const form = h('form', {
      class: 'box' + (wide ? ' wide' : ''), onsubmit: (e) => {
        e.preventDefault();
        if (!primary) return;
        const v = typeof primary.value === 'function' ? primary.value() : primary.value;
        if (v === undefined) return; // validation failed: keep open
        close(v);
      },
    }, title ? h('h2', null, title) : null, body, bar);
    if (wide) form.style.width = 'min(860px, 100%)';
    const wrap = h('div', { class: 'dialog', onmousedown: (e) => { if (e.target === wrap) close(null); } }, form);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    const first = form.querySelector('input, textarea, select');
    setTimeout(() => (first || form.querySelector('.btn.primary') || form).focus(), 30);
    onOpen && onOpen(form, close);
  });
}

export async function confirmBox(title, text, { ok = 'OK', danger = false } = {}) {
  const v = await dialog({
    title, body: h('p', { class: 'muted', style: { margin: 0 } }, text),
    actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true, danger }],
  });
  return !!v;
}

// A small form in a dialog. fields: [{name, label, type, value, placeholder, hint, options, required, rows}]
export async function ask(title, fields, { ok = 'Save', intro = '' } = {}) {
  const inputs = {};
  const body = h('div', { class: 'stack' }, intro ? h('p', { class: 'muted', style: { margin: 0 } }, intro) : null,
    fields.map((f) => {
      let input;
      if (f.type === 'textarea') input = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '' }, f.value || '');
      else if (f.type === 'select') input = h('select', null, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      else input = h('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '', autocomplete: 'off' });
      inputs[f.name] = input;
      return h('label', { class: 'field' }, h('span', null, f.label), input, f.hint ? h('small', null, f.hint) : null);
    }));
  return dialog({
    title, body, actions: [{ label: 'Cancel', value: null }, {
      label: ok, primary: true, value: () => {
        const out = {};
        for (const f of fields) {
          out[f.name] = inputs[f.name].value.trim();
          if (f.required && !out[f.name]) { inputs[f.name].focus(); toast(`Please fill in “${f.label}”.`, { bad: true }); return undefined; }
        }
        return out;
      },
    }],
  });
}

// ------------------------------------------------------------------ time & sizes

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(ts * 1000);
  if (s < 172800) return 'yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
}

export const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

export function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

export function colorFor(name) {
  let x = 0;
  for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 52% 44%)`;
}

export function humanize(id) {
  const s = String(id || '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function autosize(ta, max = 0.4) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * max) + 'px';
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch (e) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied.');
  }
}

export function download(url, name) {
  const a = h('a', { href: url, download: name || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export const isSmall = () => window.matchMedia('(max-width: 860px)').matches;

// ------------------------------------------------------------------ Markdown (safe: escapes everything first)

function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<img alt="$1" src="$2" loading="lazy" style="max-width:100%;border-radius:10px">');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[n]}</code>`);
}

const LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function listHtml(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    if (it.cont != null) { html += '<br>' + inline(it.cont); continue; }
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ indent: it.indent, tag });
      html += `<${tag}${it.ordered && it.start > 1 ? ` start="${it.start}"` : ''}><li>`;
    } else {
      html += '</li><li>';
    }
    let text = it.text;
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) text = (task[1] === ' ' ? '☐ ' : '☑ ') + task[2];
    html += inline(text);
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function markdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const hd = line.match(/^(#{1,6})\s+(.*)$/);
    if (hd) { const n = Math.min(hd[1].length + 1, 4); out.push(`<h${n}>${inline(hd[2].replace(/\s#+\s*$/, ''))}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (LI.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LI);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
          items.push({ cont: lines[i].trim() });
          i++;
        } else if (!lines[i].trim() && i + 1 < lines.length && LI.test(lines[i + 1])) {
          i++; // a blank line between items keeps the list going
        } else break;
      }
      out.push(listHtml(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>)/.test(lines[i]) && !LI.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) { out.push(`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

// Plain words for reading aloud: no symbols, code or addresses.
export function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?(```|$)/g, ' (I have left out a block of code.) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`~#>]+/g, '')
    .replace(/\n{2,}/g, '.\n')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .trim();
}
