/* AFRi Studio -- the three views that are not the bench.
 *
 * Each one is a renderer over a context object the app hands in. They own no
 * state of their own beyond what is on screen, so switching views never
 * strands a subscription or a WebGL context.
 */

import { h, clear, toast, askName, askConfirm } from './ui.js';
import { CONCEPTS, MATERIALS, fmt, PARAMS, label } from './schema.js';
import { diffDesigns } from './store.js';
import { ago } from './library.js';
import { specModel } from './exporters.js';

/* =================== LIBRARY =================== */
export function createLibraryView(root, ctx) {
  let rows = [], errorText = '', profiles = {};

  async function resolveNames() {
    const ids = rows.map((r) => r.authorId).filter(Boolean);
    if (!ids.length) { profiles = {}; return; }
    profiles = await ctx.library.profiles(ids);
  }

  function card(doc) {
    const s = doc.summary || {};
    const person = profiles[doc.authorId];
    const isCurrent = ctx.store.ui.openId === doc.id;
    const thumb = doc.thumb
      ? h('img', { class: 'thumb', src: doc.thumb, alt: '', loading: 'lazy' })
      : h('div', { class: 'thumb blank' }, h('span', { text: 'no still' }));

    const byline = h('span', { class: 'by' });
    byline.textContent = person && person.name
      ? person.name
      : (doc.authorId && doc.authorId === ctx.library.uid ? 'You' : 'Someone');

    return h('article', { class: 'card' + (isCurrent ? ' current' : '') },
      h('button', { class: 'cardopen', type: 'button', title: 'Open this design',
        onclick: () => ctx.open(doc) }, thumb),
      h('div', { class: 'cardbody' },
        h('div', { class: 'cardtop' },
          h('h3', { class: 'cardname', text: doc.name || 'Untitled marigold' }),
          h('span', { class: 'pill', text: 'Concept ' + (doc.concept || '?') })),
        h('div', { class: 'cardmeta' },
          h('span', { text: s.diameter_mm ? fmt(s.diameter_mm, 1) + ' × ' + fmt(s.height_mm, 1) + ' mm' : '—' }),
          h('span', { text: s.petals ? s.petals + ' petals' : '' }),
          s.checksPass === false ? h('span', { class: 'bad', text: 'failed checks' }) : null,
          s.fit ? h('span', {
            class: s.fit === 'clears' ? 'good' : s.fit === 'collides' ? 'bad' : 'warn',
            text: s.fit === 'clears' ? 'fits the hat'
              : s.fit === 'collides' ? 'collides'
              : s.fit === 'overhangs' ? 'overhangs the brim'
              : 'grazes the hat',
          }) : null),
        h('div', { class: 'cardfoot' },
          byline, h('span', { class: 'dot', text: '·' }), h('span', { text: ago(doc.updatedAt) })),
        h('div', { class: 'cardacts' },
          h('button', { class: 'mini', type: 'button', text: 'Open', onclick: () => ctx.open(doc) }),
          h('button', { class: 'mini', type: 'button', text: 'Duplicate', onclick: () => ctx.duplicate(doc) }),
          h('button', { class: 'mini', type: 'button', text: 'Rename', onclick: () => rename(doc) }),
          h('button', { class: 'mini danger', type: 'button', text: 'Delete', onclick: () => remove(doc) }))));
  }

  async function rename(doc) {
    const name = await askName({ title: 'Rename design', label: 'Design name',
      value: doc.name || '', confirm: 'Rename' });
    if (!name) return;
    try { await ctx.library.rename(doc.id, name); toast('Renamed to “' + name + '”'); }
    catch (e) { toast(writeFailure(e), 'bad'); }
  }

  async function remove(doc) {
    const ok = await askConfirm({ title: 'Delete this design?',
      body: '“' + (doc.name || 'Untitled marigold') + '” will be removed for everyone who ' +
            'can open this studio. This cannot be undone.',
      confirm: 'Delete', danger: true });
    if (!ok) return;
    try { await ctx.library.remove(doc.id); toast('Deleted “' + (doc.name || 'design') + '”'); }
    catch (e) { toast(writeFailure(e), 'bad'); }
  }

  function render() {
    clear(root);
    const head = h('div', { class: 'vhead' },
      h('div', null,
        h('h2', { class: 'vtitle', text: 'Design library' }),
        h('p', { class: 'vsub', text: ctx.library.available
          ? rows.length + (rows.length === 1 ? ' design saved. Everyone who can open this studio sees the same shelf.'
                                             : ' designs saved. Everyone who can open this studio sees the same shelf.')
          : 'Saving is not available on this page, so the studio runs without a memory.' })),
      h('div', { class: 'vacts' },
        h('button', { class: 'btn primary', type: 'button', text: 'Save current design',
          disabled: !ctx.library.available, onclick: () => ctx.saveCurrent() })));
    root.appendChild(head);

    if (errorText) root.appendChild(h('p', { class: 'banner bad', text: errorText }));

    if (!ctx.library.available) {
      root.appendChild(h('div', { class: 'empty' },
        h('h3', { text: 'No library on this page' }),
        h('p', { text: 'The studio still designs, measures, verifies and exports. It just cannot ' +
          'keep a design after the tab closes. Export the configuration JSON to carry one out by hand.' })));
      return;
    }
    if (!rows.length) {
      root.appendChild(h('div', { class: 'empty' },
        h('h3', { text: 'The shelf is empty' }),
        h('p', { text: 'Save the design on the bench and it appears here, with the still, the ' +
          'measurements and whoever saved it — for everyone on the team.' }),
        h('button', { class: 'btn primary', type: 'button', text: 'Save current design',
          onclick: () => ctx.saveCurrent() })));
      return;
    }
    const grid = h('div', { class: 'grid' });
    for (const doc of rows) grid.appendChild(card(doc));
    root.appendChild(grid);
  }

  const unsub = ctx.library.subscribe(async (docs, err) => {
    rows = docs; errorText = err;
    await resolveNames();
    if (ctx.store.ui.view === 'library') render();
  });

  return { render, dispose: unsub, get rows() { return rows; } };
}

function writeFailure(e) {
  const code = e && e.code;
  return code === 'invalid_argument' ? 'You have view-only access to this studio, so that change was not saved.'
    : code === 'quota_exceeded' ? 'The library is full. Delete a design to make room.'
    : code === 'resource_exhausted' ? 'Too many changes at once — try again in a moment.'
    : 'That change could not be saved (' + (code || 'unknown') + ').';
}
export { writeFailure };

/* =================== COMPARE =================== */
export function createCompareView(root, ctx) {
  let rightId = '';
  let rightDoc = null;
  let rightMetrics = null;
  let leftPane = null, rightPane = null;
  let sync = true;
  let built = false;

  function paneShell(title, subtitle, emptyText) {
    const canvas = h('canvas', { class: 'cmpcanvas' });
    const empty = emptyText ? h('div', { class: 'cmpempty', text: emptyText }) : null;
    const pane = h('div', { class: 'cmppane' },
      h('div', { class: 'cmphead' },
        h('span', { class: 'cmptitle', text: title }),
        h('span', { class: 'cmpsub', text: subtitle })),
      h('div', { class: 'cmpstage' }, canvas, empty));
    return { pane, canvas, empty, sub: pane.querySelector('.cmpsub') };
  }

  function metricRows() {
    const L = ctx.store.metrics, R = rightMetrics;
    if (!L || !R) return [];
    const pick = [
      ['Diameter', 'diameter_mm', 1, 'mm'],
      ['Height', 'height_mm', 1, 'mm'],
      ['Petals', 'petals', 0, ''],
      ['Rows', 'rows', 0, ''],
      ['Triangles', 'triangles', 0, ''],
      ['Balance A:B', 'balance', 3, ''],
    ];
    return pick.map(([name, key, dp, unit]) => {
      const a = Number(L[key]), b = Number(R[key]);
      const d = a - b;
      return { name, a: a.toFixed(dp) + (unit ? ' ' + unit : ''),
               b: b.toFixed(dp) + (unit ? ' ' + unit : ''),
               d: (d > 0 ? '+' : '') + d.toFixed(dp), sign: Math.sign(d) };
    });
  }

  async function loadRight(id) {
    rightId = id;
    rightDoc = (ctx.library.designs || []).find((d) => d.id === id) || null;
    if (!rightDoc || !rightPane) { renderTables(); return; }
    rightPane.sub.textContent = 'Building…';
    try {
      const res = await ctx.buildOther(rightDoc.design);
      rightMetrics = res.metrics;
      if (rightPane.empty) rightPane.empty.hidden = true;
      rightPane.vp.setResult(res, ctx.MM);
      rightPane.vp.setMaterial(rightDoc.design.material || 'resin');
      rightPane.vp.setEnvironment(rightDoc.design.environment || 'studio');
      rightPane.vp.setDisplay({ ...ctx.store.ui, gapMm: ctx.store.ui.gapMm });
      rightPane.vp.setView(ctx.store.ui.view3d);
      rightPane.sub.textContent = fmt(res.metrics.diameter_mm, 1) + ' × ' +
        fmt(res.metrics.height_mm, 1) + ' mm';
    } catch (e) {
      rightPane.sub.textContent = 'Could not build that design.';
    }
    renderTables();
  }

  function renderTables() {
    const host = root.querySelector('.cmptables');
    if (!host) return;
    clear(host);

    const mrows = metricRows();
    if (mrows.length) {
      const t = h('table', { class: 'dtable' },
        h('thead', null, h('tr', null,
          h('th', { text: 'Measured' }), h('th', { text: 'On the bench' }),
          h('th', { text: rightDoc ? (rightDoc.name || 'Saved') : 'Saved' }), h('th', { text: 'Delta' }))),
        h('tbody', null, ...mrows.map((r) => h('tr', null,
          h('th', { text: r.name }), h('td', { text: r.a }), h('td', { text: r.b }),
          h('td', { class: r.sign > 0 ? 'up' : r.sign < 0 ? 'down' : '', text: r.d })))));
      host.appendChild(h('section', { class: 'cmpsec' },
        h('h3', { class: 'eyebrow', text: 'Measured difference' }), t));
    }

    if (rightDoc) {
      const rowsDiff = diffDesigns(ctx.store.design, rightDoc.design);
      const body = rowsDiff.length
        ? h('table', { class: 'dtable' },
            h('thead', null, h('tr', null,
              h('th', { text: 'Parameter' }), h('th', { text: 'On the bench' }),
              h('th', { text: 'Saved' }), h('th', { text: 'Change' }))),
            h('tbody', null, ...rowsDiff.slice(0, 60).map((r) => {
              const num = typeof r.a === 'number' && typeof r.b === 'number';
              return h('tr', null,
                h('th', null, h('span', { class: 'scope', text: r.scope }), ' ' + label(r.key)),
                h('td', { text: num ? Number(r.a).toFixed(2) : String(r.a) }),
                h('td', { text: num ? Number(r.b).toFixed(2) : String(r.b) }),
                h('td', { class: num ? (r.a > r.b ? 'up' : 'down') : '',
                  text: num ? ((r.a - r.b > 0 ? '+' : '') + (r.a - r.b).toFixed(2)) : 'changed' }));
            })))
        : h('p', { class: 'vsub', text: 'Every parameter matches. These two designs are identical.' });
      host.appendChild(h('section', { class: 'cmpsec' },
        h('h3', { class: 'eyebrow', text: 'Parameter difference' }), body));
    }
  }

  function render() {
    if (built) { refreshPicker(); renderTables(); resizeSoon(); return; }
    built = true;
    clear(root);

    const picker = h('select', { id: 'cmpPick', onchange: () => loadRight(picker.value) });
    const head = h('div', { class: 'vhead' },
      h('div', null,
        h('h2', { class: 'vtitle', text: 'Compare' }),
        h('p', { class: 'vsub', text: 'The design on the bench against one off the shelf, in the ' +
          'same light, from the same angle — with every parameter that differs listed underneath.' })),
      h('div', { class: 'vacts' },
        h('label', { class: 'switch', for: 'cmpSync' },
          h('input', { type: 'checkbox', id: 'cmpSync', checked: true,
            onchange: (e) => { sync = e.target.checked; } }),
          h('span', { text: 'Locked cameras' })),
        picker));
    root.appendChild(head);

    const L = paneShell('On the bench', '');
    const R = paneShell('From the library', 'Pick a design',
      ctx.library.available
        ? 'Pick a saved design above to stand it beside the one on the bench.'
        : 'There is no library on this page, so there is nothing to compare against yet.');
    root.appendChild(h('div', { class: 'cmpgrid' }, L.pane, R.pane));
    root.appendChild(h('div', { class: 'cmptables' }));

    leftPane = { ...L, vp: ctx.makeViewport(L.canvas) };
    rightPane = { ...R, vp: ctx.makeViewport(R.canvas) };
    leftPane.vp.spinning = false;
    rightPane.vp.spinning = false;
    leftPane.vp.onCamera((cam) => { if (sync) rightPane.vp.syncFrom(cam); });
    rightPane.vp.onCamera((cam) => { if (sync) leftPane.vp.syncFrom(cam); });

    refreshPicker();
    pushLeft();
    resizeSoon();
  }

  function resizeSoon() {
    requestAnimationFrame(() => {
      if (leftPane) leftPane.vp.resize();
      if (rightPane) rightPane.vp.resize();
    });
  }

  function refreshPicker() {
    const picker = root.querySelector('#cmpPick');
    if (!picker) return;
    const docs = ctx.library.designs || [];
    const keep = rightId;
    clear(picker);
    picker.appendChild(h('option', { value: '', text: docs.length ? 'Pick a saved design…' : 'Nothing saved yet' }));
    for (const d of docs) picker.appendChild(h('option', { value: d.id, text: d.name || 'Untitled marigold' }));
    picker.value = keep && docs.some((d) => d.id === keep) ? keep : '';
    picker.disabled = !docs.length;
  }

  function pushLeft() {
    if (!leftPane || !ctx.store.result) return;
    leftPane.vp.setResult(ctx.store.result, ctx.MM);
    leftPane.vp.setMaterial(ctx.store.design.material);
    leftPane.vp.setEnvironment(ctx.store.design.environment);
    leftPane.vp.setDisplay(ctx.store.ui);
    leftPane.vp.setView(ctx.store.ui.view3d);
    const m = ctx.store.metrics;
    if (m) leftPane.sub.textContent = fmt(m.diameter_mm, 1) + ' × ' + fmt(m.height_mm, 1) + ' mm';
  }

  return {
    render,
    refresh() { if (!built) return; refreshPicker(); pushLeft(); renderTables(); },
    dispose() {
      if (leftPane) leftPane.vp.stop();
      if (rightPane) rightPane.vp.stop();
      leftPane = rightPane = null; built = false;
    },
  };
}

/* =================== SPEC SHEET =================== */
export function createSpecView(root, ctx) {
  function render() {
    clear(root);
    const m = ctx.store.metrics;
    if (!m) {
      root.appendChild(h('div', { class: 'empty' }, h('h3', { text: 'Nothing measured yet' })));
      return;
    }
    const model = specModel(ctx.store.design, m, ctx.store.ui.name);

    root.appendChild(h('div', { class: 'vhead' },
      h('div', null,
        h('h2', { class: 'vtitle', text: 'Specification' }),
        h('p', { class: 'vsub', text: 'Generated from the design on the bench. Every number here was ' +
          'measured off the built geometry, not typed in.' })),
      h('div', { class: 'vacts' },
        h('button', { class: 'btn ghost', type: 'button', text: 'Print', onclick: () => window.print() }),
        h('button', { class: 'btn primary', type: 'button', text: 'Export spec sheet',
          onclick: () => ctx.exportSpec(model) }))));

    const sheet = h('div', { class: 'sheet' });
    sheet.appendChild(h('header', { class: 'sheethead' },
      h('div', { class: 'sheetmark', text: 'AFRi · Marigold Studio' }),
      h('h1', { class: 'sheettitle', text: model.name }),
      h('div', { class: 'sheetmeta' },
        h('span', { text: 'Concept ' + model.concept }),
        h('span', { text: model.generated }),
        h('span', { text: 'Units: millimetres' }))));

    const cols = h('div', { class: 'sheetcols' });
    for (const s of model.sections) {
      cols.appendChild(h('section', { class: 'sheetsec' },
        h('h3', { class: 'eyebrow', text: s.title }),
        h('table', { class: 'stable' }, h('tbody', null,
          ...s.rows.map((r) => h('tr', { class: String(r[1]).length > 26 ? 'long' : null },
            h('th', { text: r[0] }), h('td', { text: r[1] })))))));
    }
    cols.appendChild(h('section', { class: 'sheetsec' },
      h('h3', { class: 'eyebrow', text: 'Split verification' }),
      h('table', { class: 'stable' }, h('tbody', null,
        ...model.checks.map((c) => h('tr', null,
          h('th', { text: c[0] }),
          h('td', { class: c[1] ? 'ok' : 'bad', text: c[2] })))))));
    sheet.appendChild(cols);

    sheet.appendChild(h('p', { class: 'sheetnote' },
      h('strong', { text: 'Provisional. ' }),
      'Every value in this document is a studio assumption. AFRi has supplied no reference deck, ' +
      'brand palette or size chart, and nothing here has been reviewed by a maker or approved for ' +
      'production.'));
    root.appendChild(sheet);
  }
  return { render };
}
