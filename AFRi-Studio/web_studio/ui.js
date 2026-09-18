/* AFRi Studio -- the small pieces the interface is assembled from.
 *
 * No framework. Every widget here is a function that returns a DOM node and
 * owns its own listeners, which is all a page of this size needs.
 */

export const $ = (id) => document.getElementById(id);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/* ---------- toasts ---------- */
let toastHost = null;
export function toast(message, kind = 'info', ms = 3600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const node = h('div', { class: 'toast ' + kind }, h('span', { text: message }));
  toastHost.appendChild(node);
  const kill = () => { node.classList.add('out'); setTimeout(() => node.remove(), 240); };
  const timer = setTimeout(kill, ms);
  node.addEventListener('click', () => { clearTimeout(timer); kill(); });
  return kill;
}

/* ---------- modal ---------- */
function modal(render) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim' });
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
    document.addEventListener('keydown', onKey, true);
    const box = render(close);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    const focusable = box.querySelector('input, textarea, button.primary, button');
    if (focusable) focusable.focus();
    if (focusable && focusable.select) focusable.select();
  });
}

export function askName({ title, label, value = '', confirm = 'Save' }) {
  return modal((close) => {
    const input = h('input', { type: 'text', id: 'modalInput', value, maxlength: '120',
      onkeydown: (e) => { if (e.key === 'Enter') close(input.value.trim() || null); } });
    return h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { text: title }),
      h('label', { for: 'modalInput', class: 'dlabel', text: label }),
      input,
      h('div', { class: 'dactions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null), text: 'Cancel' }),
        h('button', { class: 'btn primary', type: 'button',
          onclick: () => close(input.value.trim() || null), text: confirm })));
  });
}

export function askConfirm({ title, body, confirm = 'Confirm', danger = false }) {
  return modal((close) => h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    h('h3', { text: title }),
    h('p', { class: 'dbody', text: body }),
    h('div', { class: 'dactions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close(false), text: 'Cancel' }),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button',
        onclick: () => close(true), text: confirm }))))
    .then((v) => v === true);
}

/* ---------- command palette ---------- */
/* Subsequence match with a bonus for word starts: "pdens" finds
 * "petal density" but "denpe" does not, which is what people expect. */
export function score(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    const wordStart = at === 0 || /[\s._—-]/.test(t[at - 1]);
    s += wordStart ? 3 : 1;
    run = at === ti ? run + 1 : 0;
    s += run;
    ti = at + 1;
  }
  return s + Math.max(0, 12 - t.length * 0.1);
}

export function createPalette({ getCommands, onRun }) {
  const input = h('input', { type: 'text', id: 'paletteInput', autocomplete: 'off',
    placeholder: 'Search parameters, views, concepts, designs…', 'aria-label': 'Command search' });
  const list = h('div', { class: 'plist', role: 'listbox' });
  const box = h('div', { class: 'pbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'pfield' }, input, h('kbd', { text: 'Esc' })), list);
  const root = h('div', { class: 'palette', hidden: true }, box);
  document.body.appendChild(root);

  let items = [], index = 0, open = false;

  function paint() {
    clear(list);
    if (!items.length) {
      list.appendChild(h('div', { class: 'pempty', text: 'Nothing matches that.' }));
      return;
    }
    items.forEach((cmd, i) => {
      const row = h('button', {
        class: 'prow' + (i === index ? ' on' : ''), type: 'button', role: 'option',
        'aria-selected': String(i === index),
        onmousemove: () => { if (index !== i) { index = i; paint(); } },
        onclick: () => run(cmd),
      },
        h('span', { class: 'pgroup', text: cmd.group }),
        h('span', { class: 'ptitle', text: cmd.title }),
        cmd.hint ? h('span', { class: 'phint', text: cmd.hint }) : null);
      list.appendChild(row);
    });
    const on = list.children[index];
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function refresh() {
    const q = input.value.trim();
    items = getCommands()
      .map((c) => ({ c, s: Math.max(score(q, c.title), score(q, c.group + ' ' + c.title) * 0.8) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    index = 0;
    paint();
  }

  function run(cmd) {
    hide();
    try { cmd.run(); } catch (e) { console.error(e); toast('That command failed.', 'bad'); }
    if (onRun) onRun(cmd);
  }

  function show() {
    open = true;
    root.hidden = false;
    input.value = '';
    refresh();
    input.focus();
  }
  function hide() { open = false; root.hidden = true; }

  input.addEventListener('input', refresh);
  root.addEventListener('mousedown', (e) => { if (e.target === root) hide(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(items.length - 1, index + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[index]) run(items[index]); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });

  return { show, hide, toggle: () => (open ? hide() : show()), get open() { return open; } };
}

/* ---------- parameter slider ---------- */
export function slider(spec, target, { onDrag, onSettle }) {
  const id = 'p_' + spec.scope + '_' + spec.key;
  const isInt = spec.step >= 1;
  const value = h('span', { class: 'val' });
  const input = h('input', {
    type: 'range', id, min: spec.lo, max: spec.hi, step: spec.step, value: target[spec.key],
    'aria-describedby': id + '_h',
  });
  const show = () => {
    const v = target[spec.key];
    value.textContent = (isInt ? String(Math.round(v)) : Number(v).toFixed(2)) +
      (spec.unit ? ' ' + spec.unit : '');
  };
  show();
  const read = () => (isInt ? Math.round(+input.value) : +input.value);
  input.addEventListener('input', () => { target[spec.key] = read(); show(); onDrag(); });
  input.addEventListener('change', () => { target[spec.key] = read(); show(); onSettle(); });
  const wrap = h('div', { class: 'p', dataset: { param: spec.scope + '.' + spec.key } },
    h('div', { class: 'prow2' }, h('label', { for: id, text: spec.label }), value),
    input,
    h('div', { class: 'hint', id: id + '_h', text: spec.help }));
  wrap.sync = () => { input.value = target[spec.key]; show(); };
  return wrap;
}

export function select(labelText, options, current, onChange, help) {
  const id = 'sel_' + labelText.replace(/\W+/g, '_').toLowerCase();
  const sel = h('select', { id, onchange: () => onChange(sel.value) },
    ...options.map(([v, t]) => h('option', { value: v, text: t })));
  sel.value = current;
  return h('div', { class: 'p' },
    h('div', { class: 'prow2' }, h('label', { for: id, text: labelText })),
    sel,
    help ? h('div', { class: 'hint', text: help }) : null);
}
