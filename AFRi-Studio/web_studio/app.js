/* AFRi Studio -- the composition root.
 *
 * Owns the document, the worker pool, the bench, and the wiring between the
 * modules. Nothing in here knows how to clip a triangle or write a ZIP; it
 * decides what happens when someone drags a slider, presses Undo, or asks
 * Claude for a fuller flower.
 */

import * as ENGINE from './engine.js';
import {
  FLOWER_GROUPS, SPLIT_GROUP, HAT_GROUP, PLACEMENT_GROUP, CONCEPTS, REFINED,
  MATERIALS, ENVIRONMENTS, VIEWS, VIEW_LABELS, HAT_STYLES, CURVE_FAMILIES,
  PARAMS, fmt, label,
} from './schema.js';
import { createStore } from './store.js';
import { createViewport } from './viewport.js';
import { createLibrary, newId } from './library.js';
import { createDesigner } from './designer.js';
import * as EX from './exporters.js';
import { $, h, clear, toast, askName, askConfirm, createPalette, slider, select } from './ui.js';
import { createLibraryView, createCompareView, createSpecView, writeFailure } from './views.js';

const MM = ENGINE.MM;

/* ===================== the document ===================== */
function freshDesign() {
  return {
    concept: 'B',
    flower: { ...ENGINE.FLOWER_DEFAULTS, ...REFINED },
    split: { ...ENGINE.SPLIT_DEFAULTS, ...CONCEPTS[1].split },
    hat: { ...ENGINE.HAT_DEFAULTS, style: 'wide_brim', brim_width_mm: 110, crown_height_mm: 104 },
    placement: { ...ENGINE.PLACEMENT_DEFAULTS },
    material: 'resin',
    environment: 'studio',
  };
}

const store = createStore(freshDesign(), {
  view: 'design', view3d: 'three_quarter', mode: 'assembled',
  showWall: true, showCurve: false, wireframe: false, showGround: true,
  gapMm: 0, quality: 'draft', scaleBar: true,
  name: 'Untitled marigold', openId: '',
});

const library = createLibrary();
let downloads = null;
let room = null;
let designer = null;
let viewport = null;

/* ===================== build pipeline ===================== */
function payload(design, quality) {
  const flower = quality === 'studio' ? design.flower : {
    ...design.flower,
    petal_segments_u: Math.min(design.flower.petal_segments_u, 10),
    petal_segments_v: Math.min(design.flower.petal_segments_v, 7),
  };
  return {
    flower,
    split: { ...design.split },
    // The hat is four times the flower across but far simpler; thinning it
    // while a slider is moving keeps the rebuild under a second.
    hat: { ...design.hat,
      revolve_segments: quality === 'studio' ? 96 : 64,
      profile_segments: quality === 'studio' ? 160 : 110 },
    placement: { ...design.placement },
  };
}

function createBuilder() {
  let worker = null, seq = 0;
  const jobs = new Map();
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (_) { worker = null; }
  if (worker) {
    worker.onmessage = (ev) => {
      const d = ev.data;
      const job = jobs.get(d.id);
      if (!job) return;
      if (d.type === 'progress') { if (job.onProgress) job.onProgress(d.stage); return; }
      jobs.delete(d.id);
      if (d.type === 'done') job.resolve(d);
      else job.reject(new Error(d.message || 'build failed'));
    };
    worker.onerror = (e) => {
      for (const [, job] of jobs) job.reject(new Error(e.message || 'worker failed'));
      jobs.clear();
    };
  }
  return {
    build(design, quality, onProgress) {
      const args = payload(design, quality);
      if (!worker) {
        // No worker in this host: build on the main thread. Slower to paint,
        // identical result.
        return new Promise((resolve, reject) => setTimeout(() => {
          try { resolve(ENGINE.generateDesign(args.flower, args.split, null, args.hat, args.placement)); }
          catch (e) { reject(e); }
        }, 0));
      }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, ...args });
      });
    },
  };
}

const mainBuilder = createBuilder();
const sideBuilder = createBuilder();

let pending = false, queued = false, settle = null;

function regenerate() {
  if (pending) {
    queued = true;
    return new Promise((res) => { const prev = settle; settle = (m) => { if (prev) prev(m); res(m); }; });
  }
  pending = true; queued = false;
  busy(true, 'Building');
  return mainBuilder.build(store.design, store.ui.quality, (stage) => busy(true, stage))
    .then((res) => {
      store.result = res;
      store.metrics = res.metrics;
      viewport.setResult(res, MM);
      viewport.setMaterial(store.design.material);
      viewport.setEnvironment(store.design.environment);
      viewport.setDisplay(store.ui);
      pending = false;
      busy(false);
      renderReadout();
      renderFit();
      renderStageChip();
      if (store.ui.view === 'compare') compareView.refresh();
      if (store.ui.view === 'spec') specView.render();
      if (queued) return regenerate();
      const done = settle; settle = null;
      if (done) done(res.metrics);
      return res.metrics;
    })
    .catch((e) => {
      pending = false;
      busy(true, 'Build failed: ' + (e && e.message ? e.message : e));
      setTimeout(() => busy(false), 5000);
      throw e;
    });
}

let debounceTimer = 0;
function scheduleBuild() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => regenerate().catch(() => {}), 170);
}

function busy(on, text) {
  const el = $('busy');
  el.hidden = !on;
  if (text) $('busyTxt').textContent = text;
}

/* ===================== left rail ===================== */
const sliders = [];

function buildConcepts() {
  const host = clear($('concepts'));
  for (const c of CONCEPTS) {
    const b = h('button', {
      class: 'concept', type: 'button', 'aria-pressed': String(c.key === store.design.concept),
      onclick: () => {
        store.commit('Concept ' + c.key, (d) => {
          d.concept = c.key;
          d.split = { ...ENGINE.SPLIT_DEFAULTS, ...c.split };
        });
        syncConcepts(); buildParams(); regenerate().catch(() => {});
      },
    },
      h('div', { class: 'k' }, 'Concept ' + c.key,
        c.priority ? h('span', { class: 'flag', text: ' · priority' }) : null),
      h('div', { class: 'n', text: c.name }),
      h('div', { class: 'd', text: c.desc }));
    b.dataset.concept = c.key;
    host.appendChild(b);
  }
}
function syncConcepts() {
  for (const b of $('concepts').children) {
    b.setAttribute('aria-pressed', String(b.dataset.concept === store.design.concept));
  }
}

function group(title, open, items, scope) {
  const body = h('div', { class: 'grpbody' });
  if (scope === 'split') {
    body.appendChild(select('curve family', CURVE_FAMILIES, store.design.split.type, (v) => {
      store.commit('Curve family', (d) => { d.split.type = v; });
      regenerate().catch(() => {});
    }, 'Every family is x = f(y), which is what guarantees the curve divides the plane into exactly two regions.'));
  }
  if (scope === 'hat') {
    body.appendChild(select('silhouette', HAT_STYLES, store.design.hat.style, (v) => {
      store.commit('Hat silhouette', (d) => { d.hat.style = v; });
      regenerate().catch(() => {});
    }, 'Sets crown taper, dome, flare and edge softness. Only the fedora and wide brim are creased.'));
  }
  for (const item of items) {
    const spec = PARAMS.get(scope + '.' + item[0]);
    const node = slider(spec, store.design[scope], {
      onDrag: () => { store.beginEdit(spec.label); store.touch(); scheduleBuild(); },
      onSettle: () => { store.endEdit(); clearTimeout(debounceTimer); regenerate().catch(() => {}); },
    });
    sliders.push({ node, scope, key: item[0] });
    body.appendChild(node);
  }
  const d = h('details', { class: 'grp' },
    h('summary', null, h('span', { text: title })), body);
  d.open = open;
  d.dataset.group = title;
  return d;
}

function buildParams() {
  const host = clear($('params'));
  sliders.length = 0;
  for (const [title, open, items] of FLOWER_GROUPS) host.appendChild(group(title, open, items, 'flower'));
  host.appendChild(group(SPLIT_GROUP[0], SPLIT_GROUP[1], SPLIT_GROUP[2], 'split'));
  host.appendChild(group(HAT_GROUP[0], HAT_GROUP[1], HAT_GROUP[2], 'hat'));
  host.appendChild(group(PLACEMENT_GROUP[0], PLACEMENT_GROUP[1], PLACEMENT_GROUP[2], 'placement'));
}

function syncParams() {
  for (const s of sliders) s.node.sync();
  for (const sel of $('params').querySelectorAll('select')) {
    if (sel.id === 'sel_curve_family') sel.value = store.design.split.type;
    if (sel.id === 'sel_silhouette') sel.value = store.design.hat.style;
  }
}

function buildFinish() {
  const host = clear($('finish'));
  host.appendChild(select('material', MATERIALS.map((m) => [m.key, m.name]), store.design.material, (v) => {
    store.commit('Finish', (d) => { d.material = v; });
    viewport.setMaterial(v);
    const m = MATERIALS.find((x) => x.key === v);
    if (m) toast(m.name + ' — ' + m.note);
  }));
  host.appendChild(select('lighting', ENVIRONMENTS.map((e) => [e.key, e.name]), store.design.environment, (v) => {
    store.commit('Lighting', (d) => { d.environment = v; });
    viewport.setEnvironment(v);
  }));
}

/* ===================== viewport chrome ===================== */
function buildChips() {
  const vc = clear($('viewChips'));
  for (const [key, text] of VIEW_LABELS) {
    vc.appendChild(h('button', {
      class: 'chip', type: 'button', text, 'aria-pressed': String(store.ui.view3d === key),
      onclick: () => setCameraView(key),
    }));
  }

  const mc = clear($('modeChips'));
  for (const [key, text] of [['assembled', 'Assembled'], ['a', 'Piece A'], ['b', 'Piece B']]) {
    mc.appendChild(h('button', {
      class: 'chip', type: 'button', text, 'aria-pressed': String(store.ui.mode === key),
      dataset: { mode: key },
      onclick: () => { store.ui.mode = key; viewport.setDisplay(store.ui); syncChips(); },
    }));
  }
  const toggle = (text, prop, after) => mc.appendChild(h('button', {
    class: 'chip', type: 'button', text, 'aria-pressed': String(!!store.ui[prop]),
    dataset: { toggle: prop },
    onclick: () => { store.ui[prop] = !store.ui[prop]; viewport.setDisplay(store.ui); syncChips(); if (after) after(); },
  }));
  mc.appendChild(h('button', {
    class: 'chip', type: 'button', text: 'On the hat', dataset: { hat: '1' },
    'aria-pressed': String(!!store.design.placement.show_hat),
    onclick: () => {
      store.commit('Hat on the head', (d) => { d.placement.show_hat = !d.placement.show_hat; });
      syncChips(); regenerate().catch(() => {});
    },
  }));
  toggle('Cut wall', 'showWall');
  toggle('Curve', 'showCurve');
  toggle('Wireframe', 'wireframe');
  toggle('Ground', 'showGround');
}

function syncChips() {
  for (const b of $('viewChips').children) {
    b.setAttribute('aria-pressed', String(b.textContent === (VIEW_LABELS.find((v) => v[0] === store.ui.view3d) || [])[1]));
  }
  for (const b of $('modeChips').children) {
    if (b.dataset.mode) b.setAttribute('aria-pressed', String(store.ui.mode === b.dataset.mode));
    else if (b.dataset.toggle) b.setAttribute('aria-pressed', String(!!store.ui[b.dataset.toggle]));
    else if (b.dataset.hat) b.setAttribute('aria-pressed', String(!!store.design.placement.show_hat));
  }
}

function setCameraView(key) {
  store.ui.view3d = key;
  viewport.setView(key);
  syncChips();
}

/* ---- the scale bar: measured, not decorative ---- */
let scaleTimer = 0, scaleLast = '';
function startScaleBar() {
  const bar = $('scalebar');
  const tick = () => {
    if (store.ui.view !== 'design' || !store.ui.scaleBar) { bar.hidden = true; return; }
    bar.hidden = false;
    const mmPerPx = viewport.mmPerPixel();
    if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) return;
    // Snap to a round number of millimetres that lands near 120 px.
    const raw = mmPerPx * 120;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const nice = [1, 2, 5, 10].map((f) => f * pow).reduce((a, b) =>
      Math.abs(b - raw) < Math.abs(a - raw) ? b : a);
    const px = nice / mmPerPx;
    const text = nice >= 10 ? Math.round(nice) + ' mm' : nice.toFixed(nice < 1 ? 1 : 0) + ' mm';
    if (text === scaleLast && Math.abs(parseFloat(bar.style.getPropertyValue('--w')) - px) < 1) return;
    scaleLast = text;
    bar.style.setProperty('--w', px.toFixed(1) + 'px');
    bar.querySelector('.slabel').textContent = text;
  };
  clearInterval(scaleTimer);
  scaleTimer = setInterval(tick, 220);
  tick();
}

/* ===================== right rail readout ===================== */
function renderReadout() {
  const m = store.metrics;
  if (!m) return;

  const specs = clear($('specs'));
  for (const [lab, num, unit] of [
    ['Diameter', fmt(m.diameter_mm, 1), 'mm'],
    ['Height', fmt(m.height_mm, 1), 'mm'],
    ['Petals', String(m.petals), 'in ' + m.rows + ' rows'],
    ['Triangles', (m.triangles / 1000).toFixed(1), 'k'],
  ]) {
    specs.appendChild(h('div', { class: 'spec' },
      h('div', { class: 'lab', text: lab }),
      h('div', { class: 'num' }, num, h('small', { text: unit }))));
  }

  const checks = clear($('checks'));
  const chk = (name, ok, v) => checks.appendChild(h('div', { class: 'chk ' + (ok ? 'ok' : 'bad') },
    h('span', { class: 'dot' }), h('span', { class: 'name', text: name }), h('span', { class: 'v', text: v })));
  chk('Piece A is a closed solid', m.open_edges_a === 0, m.open_edges_a + ' open edges');
  chk('Piece B is a closed solid', m.open_edges_b === 0, m.open_edges_b + ' open edges');
  chk('Every cut face capped', m.cap_failures === 0, m.cap_failures + ' failures');
  chk('A + B reconstruct the master', m.volume_error_pct < 1e-3,
      m.volume_error_pct < 1e-9 ? '0.000000%' : m.volume_error_pct.toExponential(2) + '%');
  chk('Material balance A : B', true,
      (m.balance * 100).toFixed(1) + ' : ' + ((1 - m.balance) * 100).toFixed(1));

  // The bound is 1e-3 %, not zero. Making each piece's winding globally
  // consistent flips any inside-out body, including the specks a cut through a
  // petal tip leaves behind, and flipping one shifts the A + B sum by twice its
  // volume. A real failure -- a petal landing on neither side -- is four orders
  // of magnitude above this.
  $('verifyNote').textContent = (m.open_edges_a === 0 && m.open_edges_b === 0)
    ? 'Two genuinely separate closed meshes, cut by exact per-triangle clipping — not a texture, ' +
      'a colour boundary or a drawn line. Hide either piece to confirm.'
    : 'This parameter combination left open edges. That is a real defect, reported rather than hidden.';

  const detail = clear($('detail'));
  const kv = (k, v) => detail.appendChild(h('div', { class: 'kv' },
    h('span', { text: k }), h('b', { text: String(v) })));
  if (m.hat) {
    kv('Hat', String(m.hat.style).replace(/_/g, ' ') + ', ' + m.hat.overall_diameter_mm.toFixed(0) + ' mm across');
    kv('Brim width', m.hat.brim_width_mm.toFixed(1) + ' mm');
    kv('Seated at radius', m.hat.seated_radius_mm.toFixed(1) + ' mm');
    kv('Hat triangles', m.hat.triangles);
  }
  kv('Bodies in master', m.bodies_master);
  kv('Bodies in piece A / B', m.bodies_a + ' / ' + m.bodies_b);
  kv('Closed bodies cut', m.bodies_total);
  kv('Bodies the curve divides', m.bodies_divided);
  kv('Triangles added by split', m.triangles_a + m.triangles_b - m.triangles);
  kv('Triangles clipped', m.triangles_clipped);
  kv('Cut-wall triangles', m.cap_triangles);
  kv('Boundary caps built', m.caps_built);
  kv('Path perturbation', fmt(m.path_perturbation_mm, 5) + ' mm');
  kv('Flower build', Math.round(m.flower_ms) + ' ms');
  kv('Split kernel', Math.round(m.split_ms) + ' ms');
}

/* The fit report: the one question a render cannot answer by being looked at.
 * Every figure here is measured against the hat's outer skin analytically, so
 * a sub-millimetre gap is a real number rather than the resolution of a mesh
 * sampled every six millimetres. */
function renderFit() {
  const f = store.metrics && store.metrics.fit;
  $('fitSec').hidden = !f;
  if (!f) return;

  const tol = f.contact_tolerance_mm;
  const collides = f.interference_mm > tol;
  const grazes = f.interference_mm > 1e-3;
  const overhangs = f.overhang_mm > 1e-3;

  const state = collides ? 'bad' : (overhangs || grazes) ? 'warn' : 'ok';
  const word = collides ? 'Does not fit'
    : overhangs ? 'Overhangs the brim'
    : grazes ? 'Grazes the hat'
    : 'Clears the hat';
  const detail = collides
    ? fmt(f.interference_mm, 2) + ' mm of the accessory is inside the hat'
    : overhangs
      ? fmt(f.overhang_mm, 1) + ' mm of the footprint is past the brim edge'
      : grazes
        ? 'touching by ' + fmt(f.interference_mm, 2) + ' mm, within the ' + fmt(tol, 2) + ' mm tolerance'
        : fmt(f.gap_min_mm, 2) + ' mm at the closest approach';

  const v = clear($('fitVerdict'));
  v.className = 'verdict ' + state;
  v.append(h('span', { class: 'mark' }),
           h('div', null, h('div', { class: 'word', text: word }),
                          h('div', { class: 'vsubtle', text: detail })));

  const host = clear($('fit'));
  const kv = (k, val, flag) => host.appendChild(h('div', { class: 'kv' + (flag || '') },
    h('span', { text: k }), h('b', { text: val })));
  kv('Interference', fmt(f.interference_mm, 3) + ' mm', collides ? ' flag' : grazes ? ' warnflag' : '');
  kv('Closest approach', fmt(f.gap_min_mm, 2) + ' mm');
  kv('Furthest gap', fmt(f.gap_max_mm, 2) + ' mm');
  kv('Conformance error', fmt(f.conformance_error_mm, 2) + ' mm');
  kv('Footprint touching', (f.contact_fraction * 100).toFixed(1) + ' %');
  kv('Brim edge radius', fmt(f.brim_edge_radius_mm, 1) + ' mm');
  kv('Footprint radius', fmt(f.footprint_radius_mm, 1) + ' mm');
  kv('Past the brim edge', fmt(f.overhang_mm, 2) + ' mm', overhangs ? ' warnflag' : '');
  kv('Mass at most', fmt(f.mass_upper_g, 1) + ' g');
  kv('Moment arm', fmt(f.moment_arm_mm, 1) + ' mm');
  kv('Brim moment at most', Math.round(f.brim_moment_upper_g_mm) + ' g\u00b7mm');
  kv('Underside samples', String(f.underside_samples));

  $('fitNote').textContent = collides
    ? 'Raise the standoff, move the accessory inboard, or give the hat a wider brim. The kernel ' +
      'measures the whole accessory against the hat\u2019s outer skin, not just its base.'
    : overhangs
      ? 'Part of the footprint reaches past the brim. That can be a deliberate look, but nothing ' +
        'out there is supported \u2014 the fixing carries it.'
      : 'Conformance error is how far the flat back departs from the doubly curved brim across the ' +
        'footprint. It is measured from the closest approach, so a deliberate standoff does not ' +
        'flatter it. Mass and moment are upper bounds: this build ships the flower as overlapping ' +
        'shells, so its volume is overcounted where petals intersect.';
}

function renderStageChip() {
  const on = !!(store.metrics && store.metrics.hat);
  $('stageChip').textContent = on ? 'Stage two · on the hat' : 'Stage one · flower only';
}

/* ===================== the document bar ===================== */
function renderDocBar() {
  $('docName').textContent = store.ui.name;
  const st = $('saveState');
  if (!library.available) st.textContent = 'Not saved · no library here';
  else if (!store.ui.openId) st.textContent = store.dirty ? 'Unsaved' : 'Not saved yet';
  else st.textContent = store.dirty ? 'Edited since saving' : 'Saved';
  st.className = 'savestate' + (store.dirty && store.ui.openId ? ' warn' : '');
  $('undoBtn').disabled = !store.canUndo;
  $('redoBtn').disabled = !store.canRedo;
  $('undoBtn').title = store.canUndo ? 'Undo ' + store.undoLabel : 'Nothing to undo';
  $('redoBtn').title = store.canRedo ? 'Redo ' + store.redoLabel : 'Nothing to redo';
}

/* ===================== views ===================== */
let libraryView = null, compareView = null, specView = null;

function setView(name) {
  store.ui.view = name;
  for (const pane of document.querySelectorAll('.viewpane')) {
    pane.hidden = pane.dataset.view !== name;
  }
  for (const b of $('viewNav').children) b.setAttribute('aria-pressed', String(b.dataset.viewKey === name));
  for (const b of $('tabBar').children) b.setAttribute('aria-pressed', String(b.dataset.viewKey === name));
  document.body.dataset.view = name;
  if (name === 'library') libraryView.render();
  if (name === 'compare') compareView.render();
  if (name === 'spec') specView.render();
  if (name === 'design') requestAnimationFrame(() => viewport.resize());
  if (room) room.presence({ view: name }).catch(() => {});
}

function buildViewNav() {
  const defs = [
    ['design', 'Bench', 'The viewport, the parameters and the verification'],
    ['compare', 'Compare', 'This design against one off the shelf'],
    ['library', 'Library', 'Every design the team has saved'],
    ['spec', 'Spec', 'The manufacturing sheet, generated from the geometry'],
  ];
  const nav = clear($('viewNav'));
  const tabs = clear($('tabBar'));
  for (const [key, text, title] of defs) {
    nav.appendChild(h('button', { class: 'vnav', type: 'button', text, title,
      dataset: { viewKey: key }, 'aria-pressed': String(store.ui.view === key),
      onclick: () => setView(key) }));
    tabs.appendChild(h('button', { class: 'tab', type: 'button', text,
      dataset: { viewKey: key }, 'aria-pressed': String(store.ui.view === key),
      onclick: () => setView(key) }));
  }
}

/* ===================== saving ===================== */
function summary() {
  const m = store.metrics || {};
  const f = m.fit;
  return {
    diameter_mm: m.diameter_mm, height_mm: m.height_mm,
    petals: m.petals, rows: m.rows, triangles: m.triangles,
    checksPass: m.open_edges_a === 0 && m.open_edges_b === 0 && m.cap_failures === 0,
    // Whether this design was on a hat when it was saved, and whether it fitted.
    // The shelf is more useful when it says so without opening every card.
    fit: !f ? null
      : f.interference_mm > f.contact_tolerance_mm ? 'collides'
      : f.overhang_mm > 1e-3 ? 'overhangs'
      : f.interference_mm > 1e-3 ? 'grazes'
      : 'clears',
  };
}

async function saveCurrent({ asNew = false } = {}) {
  if (!library.available) { toast('There is no library on this page to save into.', 'bad'); return; }
  let name = store.ui.name;
  if (asNew || !store.ui.openId) {
    name = await askName({ title: asNew ? 'Save a copy' : 'Save design', label: 'Design name',
      value: asNew ? store.ui.name + ' copy' : store.ui.name, confirm: 'Save' });
    if (!name) return;
  }
  const thumb = viewport.capture({ width: 480, height: 360, type: 'image/jpeg', quality: 0.72, sweep: sweep() });
  try {
    const id = await library.save({
      id: asNew ? null : (store.ui.openId || null),
      name, design: store.snapshot(), summary: summary(), thumb,
    });
    store.ui.openId = id;
    store.ui.name = name;
    store.markSaved();
    renderDocBar();
    toast('Saved “' + name + '” to the library');
    saveWorkspace();
  } catch (e) {
    toast(writeFailure(e), 'bad');
  }
}

function openDoc(doc) {
  store.load('Open ' + (doc.name || 'design'), doc.design);
  store.ui.name = doc.name || 'Untitled marigold';
  store.ui.openId = doc.id;
  store.markSaved();
  syncConcepts(); syncParams(); syncChips(); buildFinish(); renderDocBar();
  viewport.setMaterial(store.design.material);
  viewport.setEnvironment(store.design.environment);
  setView('design');
  regenerate().catch(() => {});
}

async function duplicateDoc(doc) {
  const name = await askName({ title: 'Duplicate design', label: 'Name for the copy',
    value: (doc.name || 'Untitled marigold') + ' copy', confirm: 'Duplicate' });
  if (!name) return;
  try {
    await library.save({ name, design: doc.design, summary: doc.summary, thumb: doc.thumb });
    toast('Duplicated as “' + name + '”');
  } catch (e) { toast(writeFailure(e), 'bad'); }
}

/* ---- the private workspace: where this viewer left off ---- */
let wsTimer = 0;
function saveWorkspace() {
  if (!library.workspaceReady()) return;
  clearTimeout(wsTimer);
  wsTimer = setTimeout(() => {
    library.saveWorkspace({
      design: store.snapshot(), name: store.ui.name, openId: store.ui.openId,
    }).catch(() => {});
  }, 2500);
}

/* ===================== export ===================== */
async function exportPieces() {
  if (!store.result) return;
  const enc = new TextEncoder();
  const tag = EX.slug(store.ui.name) + '_C' + store.design.concept;
  const blob = EX.zip([
    [tag + '_piece_A.stl', EX.stlBinary(store.result.A, MM, store.ui.name + ' piece A')],
    [tag + '_piece_B.stl', EX.stlBinary(store.result.B, MM, store.ui.name + ' piece B')],
    ['BUILD_REPORT.txt', enc.encode(EX.buildReport(store.design, store.metrics, store.ui.name))],
  ]);
  const r = await EX.offer(downloads, tag + '_pieces.zip', blob);
  toast(r.message, r.ok ? 'good' : 'bad');
}

async function exportConfig() {
  const body = JSON.stringify({
    name: store.ui.name, design: store.snapshot(), metrics: store.metrics,
  }, null, 2);
  const r = await EX.offer(downloads, EX.slug(store.ui.name) + '_config.json', body);
  toast(r.message, r.ok ? 'good' : 'bad');
}

async function exportStill(scale) {
  const url = viewport.capture({ scale, sweep: sweep() });
  if (!url) { toast('The viewport could not be captured.', 'bad'); return; }
  const r = await EX.offer(downloads, EX.slug(store.ui.name) + '_' + scale + 'x.png', EX.dataURLToBlob(url));
  toast(r.message, r.ok ? 'good' : 'bad');
}

async function exportSpec(model) {
  const r = await EX.offer(downloads, EX.slug(model.name) + '_specification.html', EX.specHTML(model));
  toast(r.message, r.ok ? 'good' : 'bad');
}

function buildExportPanel() {
  const host = clear($('exportBody'));
  if (!downloads) {
    host.appendChild(h('p', { class: 'note', text:
      'Saving files is not available on this page, so export is switched off. Everything else — ' +
      'building, measuring, verifying — still works.' }));
    return;
  }
  host.appendChild(h('div', { class: 'btnrow' },
    h('button', { class: 'btn ghost', type: 'button', text: 'Both pieces · STL', onclick: exportPieces }),
    h('button', { class: 'btn ghost', type: 'button', text: 'Configuration · JSON', onclick: exportConfig }),
    h('button', { class: 'btn ghost', type: 'button', text: 'Still · 2×', onclick: () => exportStill(2) }),
    h('button', { class: 'btn ghost', type: 'button', text: 'Still · 4×', onclick: () => exportStill(4) })));
  host.appendChild(h('p', { class: 'note', text:
    'Binary STL in millimetres, one mesh per piece, zipped with the build report. Stills are ' +
    'rendered at a multiple of the on-screen viewport \u2014 not upscaled \u2014 on the same ' +
    'backdrop the stage shows.' }));
}

/* ===================== Claude designer ===================== */
function bubble(cls, who, node) {
  const body = h('div', { class: 'body' });
  if (node) body.append(node);
  const d = h('div', { class: 'msg ' + cls }, h('div', { class: 'who', text: who }), body);
  const log = $('chatlog');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return body;
}

async function askClaude() {
  const field = $('ask');
  const q = field.value.trim();
  if (!q || !designer || !designer.available) return;
  field.value = '';
  bubble('you', 'You', document.createTextNode(q));
  const out = bubble('cc', 'Claude', h('span', { class: 'thinking', text: 'Thinking…' }));
  $('send').disabled = true;
  $('stop').hidden = false;

  const changeList = h('ul', { class: 'changes' });
  try {
    const res = await designer.ask(q, {
      onText: ({ text }) => { out.firstChild.textContent = text; },
      onRound: (applied, rejected) => {
        if (!changeList.parentNode) out.appendChild(changeList);
        for (const a of applied) {
          changeList.appendChild(h('li', null,
            h('code', { text: a.name.split('.')[1] }), ' → ',
            h('code', { text: String(a.value) }),
            a.reason ? ' — ' + a.reason : ''));
        }
        for (const r of rejected) {
          changeList.appendChild(h('li', { class: 'rej', text: 'Rejected: ' + r }));
        }
      },
    });
    if (res.kind === 'single') {
      out.firstChild.textContent = res.text || 'No parameter changes proposed.';
      if (!changeList.parentNode && (res.applied.length || res.rejected.length)) out.appendChild(changeList);
    } else if (!out.firstChild.textContent) {
      out.firstChild.textContent = 'Done.';
    }
  } catch (e) {
    out.firstChild.textContent = designer.message(e && e.code);
    out.firstChild.classList.add('err');
  } finally {
    $('send').disabled = false;
    $('stop').hidden = true;
  }
}

/* What the designer's tools are allowed to do: move parameters that exist,
 * within their bounds, as one undoable step -- then rebuild and hand back what
 * the kernel measured. */
async function applyFromClaude(applied) {
  store.commit('Claude · ' + applied.length + ' change' + (applied.length === 1 ? '' : 's'), (d) => {
    for (const a of applied) {
      const spec = PARAMS.get(a.name);
      if (spec) d[spec.scope][spec.key] = a.value;
      else if (a.name === 'split.type') d.split.type = a.value;
      else if (a.name === 'hat.style') d.hat.style = a.value;
    }
  });
  syncParams(); syncConcepts(); syncChips();
  const m = await regenerate();
  return describeGeometry(m);
}

function describeGeometry(m) {
  const mm = m || store.metrics;
  if (!mm) return { built: false };
  return {
    diameter_mm: +mm.diameter_mm.toFixed(2),
    height_mm: +mm.height_mm.toFixed(2),
    height_over_diameter: +(mm.height_mm / mm.diameter_mm).toFixed(3),
    petals: mm.petals, rows: mm.rows, triangles: mm.triangles,
    balance_a_pct: +(mm.balance * 100).toFixed(1),
    open_edges: mm.open_edges_a + mm.open_edges_b,
    cap_failures: mm.cap_failures,
    volume_error_pct: +Number(mm.volume_error_pct).toExponential(2),
    on_hat: !!mm.hat,
    fit: mm.fit ? {
      interference_mm: +mm.fit.interference_mm.toFixed(3),
      overhang_past_brim_mm: +mm.fit.overhang_mm.toFixed(2),
      closest_approach_mm: +mm.fit.gap_min_mm.toFixed(2),
      conformance_error_mm: +mm.fit.conformance_error_mm.toFixed(2),
      footprint_touching_pct: +(mm.fit.contact_fraction * 100).toFixed(1),
      brim_edge_radius_mm: +mm.fit.brim_edge_radius_mm.toFixed(1),
      footprint_radius_mm: +mm.fit.footprint_radius_mm.toFixed(1),
    } : null,
  };
}

/* ===================== live review (room) ===================== */
async function connectRoom() {
  try { room = (await window.claude?.use?.('room')) || null; } catch (_) { room = null; }
  if (!room) return;
  const strip = $('peers');
  room.onPeers(async (change) => {
    const others = change.peers.filter((p) => p.kind === 'viewer' && !p.isMe);
    clear(strip);
    strip.hidden = others.length === 0;
    if (!others.length) return;
    const ids = others.map((p) => p.presence && p.presence.who).filter(Boolean);
    const people = ids.length ? await library.profiles(ids) : {};
    for (const p of others.slice(0, 5)) {
      const who = p.presence && p.presence.who;
      const person = who && people[who];
      const initials = (person && person.name ? person.name : 'Someone')
        .split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
      strip.appendChild(h('span', {
        class: 'peer', title: (person && person.name ? person.name : 'Someone') +
          ' · ' + ((p.presence && p.presence.view) || 'studio'),
        style: 'background:' + ((person && person.color) || '#8A8F7E'), text: initials || '?',
      }));
    }
    if (others.length > 5) strip.appendChild(h('span', { class: 'peer more', text: '+' + (others.length - 5) }));
  });
  room.on('present', (msg) => {
    if (msg.isMe) return;
    const d = msg.data || {};
    const name = typeof d.name === 'string' ? d.name.slice(0, 80) : 'a design';
    const id = typeof d.id === 'string' ? d.id : '';
    const kill = toast('Someone is presenting “' + name + '” — tap to open', 'info', 12000);
    const node = $('toasts') && $('toasts').lastChild;
    if (node && id) {
      node.addEventListener('click', () => {
        const doc = (library.designs || []).find((x) => x.id === id);
        if (doc) openDoc(doc); else toast('That design is not on the shelf yet.', 'bad');
        kill();
      });
    }
  });
  room.presence({ who: library.uid || null, view: store.ui.view }).catch(() => {});
}

function presentCurrent() {
  if (!room) { toast('Live review is not available on this page.', 'bad'); return; }
  if (!store.ui.openId) { toast('Save the design first, then present it.', 'bad'); return; }
  room.emit('present', { id: store.ui.openId, name: store.ui.name })
    .then(() => toast('Presented to everyone in the studio'))
    .catch((e) => toast(e && e.code === 'not_permitted'
      ? 'You do not have permission to present here.' : 'Could not present just now.', 'bad'));
}

/* ===================== command palette ===================== */
function commands() {
  const out = [];
  const nav = [['design', 'Bench'], ['compare', 'Compare'], ['library', 'Library'], ['spec', 'Spec']];
  for (const [key, text] of nav) {
    out.push({ group: 'Go to', title: text, hint: '', run: () => setView(key) });
  }
  for (const [key, text] of VIEW_LABELS) {
    out.push({ group: 'Camera', title: text + ' view', run: () => { setView('design'); setCameraView(key); } });
  }
  for (const c of CONCEPTS) {
    out.push({ group: 'Concept', title: c.key + ' — ' + c.name, hint: c.desc.slice(0, 48) + '…',
      run: () => { $('concepts').querySelector('[data-concept="' + c.key + '"]').click(); } });
  }
  for (const m of MATERIALS) {
    out.push({ group: 'Finish', title: m.name, hint: m.note, run: () => {
      store.commit('Finish', (d) => { d.material = m.key; });
      viewport.setMaterial(m.key); buildFinish();
    } });
  }
  for (const e of ENVIRONMENTS) {
    out.push({ group: 'Lighting', title: e.name, run: () => {
      store.commit('Lighting', (d) => { d.environment = e.key; });
      viewport.setEnvironment(e.key); buildFinish();
    } });
  }
  out.push(
    { group: 'Design', title: 'Save design', hint: '⌘S', run: () => saveCurrent() },
    { group: 'Design', title: 'Save a copy', run: () => saveCurrent({ asNew: true }) },
    { group: 'Design', title: 'Rename design', run: renameCurrent },
    { group: 'Design', title: 'Start a new design', run: newDesign },
    { group: 'Design', title: 'Undo', hint: store.undoLabel, run: () => doUndo() },
    { group: 'Design', title: 'Redo', hint: store.redoLabel, run: () => doRedo() },
    { group: 'Design', title: 'Present to everyone here', run: presentCurrent },
    { group: 'Quality', title: 'Draft tessellation', run: () => setQuality('draft') },
    { group: 'Quality', title: 'Studio tessellation', run: () => setQuality('studio') },
    { group: 'Display', title: 'Toggle the hat', run: () => $('modeChips').querySelector('[data-hat]').click() },
    { group: 'Display', title: 'Toggle wireframe', run: () => $('modeChips').querySelector('[data-toggle="wireframe"]').click() },
    { group: 'Display', title: 'Toggle the dividing curve', run: () => $('modeChips').querySelector('[data-toggle="showCurve"]').click() },
    { group: 'Display', title: 'Toggle the cut wall', run: () => $('modeChips').querySelector('[data-toggle="showWall"]').click() },
  );
  if (downloads) {
    out.push(
      { group: 'Export', title: 'Both pieces as STL', run: exportPieces },
      { group: 'Export', title: 'Configuration as JSON', run: exportConfig },
      { group: 'Export', title: 'Still at 4×', run: () => exportStill(4) });
  }
  for (const [name, spec] of PARAMS) {
    out.push({ group: 'Parameter', title: spec.label, hint: spec.scope + ' · ' + spec.lo + '…' + spec.hi,
      run: () => revealParam(name) });
  }
  for (const doc of (library.designs || []).slice(0, 20)) {
    out.push({ group: 'Open', title: doc.name || 'Untitled marigold', hint: 'saved design',
      run: () => openDoc(doc) });
  }
  return out;
}

function revealParam(name) {
  setView('design');
  const node = $('params').querySelector('[data-param="' + name + '"]');
  if (!node) return;
  const det = node.closest('details');
  if (det) det.open = true;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  const input = node.querySelector('input');
  if (input) input.focus();
}

/* ===================== document commands ===================== */
function setQuality(q) {
  store.ui.quality = q;
  $('qDraft').setAttribute('aria-pressed', String(q === 'draft'));
  $('qStudio').setAttribute('aria-pressed', String(q === 'studio'));
  regenerate().catch(() => {});
}

function doUndo() {
  const l = store.undo();
  if (!l) return;
  afterHistory();
}
function doRedo() {
  const l = store.redo();
  if (!l) return;
  afterHistory();
}
function afterHistory() {
  syncConcepts(); syncParams(); syncChips(); buildFinish();
  viewport.setMaterial(store.design.material);
  viewport.setEnvironment(store.design.environment);
  regenerate().catch(() => {});
}

async function renameCurrent() {
  const name = await askName({ title: 'Rename design', label: 'Design name',
    value: store.ui.name, confirm: 'Rename' });
  if (!name) return;
  store.ui.name = name;
  renderDocBar();
  if (store.ui.openId && library.available) {
    library.rename(store.ui.openId, name).catch((e) => toast(writeFailure(e), 'bad'));
  }
  saveWorkspace();
}

async function newDesign() {
  if (store.dirty && store.ui.openId) {
    const ok = await askConfirm({ title: 'Start a new design?',
      body: 'The design on the bench has changes that are not saved to the library.',
      confirm: 'Start new' });
    if (!ok) return;
  }
  store.load('New design', freshDesign());
  store.ui.name = 'Untitled marigold';
  store.ui.openId = '';
  syncConcepts(); syncParams(); syncChips(); buildFinish(); renderDocBar();
  viewport.setMaterial(store.design.material);
  viewport.setEnvironment(store.design.environment);
  setView('design');
  regenerate().catch(() => {});
}

/* ===================== keyboard ===================== */
function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function bindKeys(palette) {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.toggle(); return; }
    if (mod && e.key.toLowerCase() === 'z') {
      if (typing(e) && e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); return; }
    if (typing(e) || palette.open) return;
    const k = e.key.toLowerCase();
    if (k === '1') setView('design');
    else if (k === '2') setView('compare');
    else if (k === '3') setView('library');
    else if (k === '4') setView('spec');
    else if (k === 'w') $('modeChips').querySelector('[data-toggle="wireframe"]').click();
    else if (k === 'c') $('modeChips').querySelector('[data-toggle="showCurve"]').click();
    else if (k === 'h') $('modeChips').querySelector('[data-hat]').click();
    else if (k === 'a') { store.ui.mode = store.ui.mode === 'a' ? 'assembled' : 'a'; viewport.setDisplay(store.ui); syncChips(); }
    else if (k === 'b') { store.ui.mode = store.ui.mode === 'b' ? 'assembled' : 'b'; viewport.setDisplay(store.ui); syncChips(); }
    else if (k === ' ') { e.preventDefault(); viewport.spinning = !viewport.spinning; }
  });
}

/* The two stops of the stage sweep, as the theme currently defines them, so a
 * captured still carries the same backdrop the viewport shows. */
function sweep() {
  const cs = getComputedStyle(document.documentElement);
  return [cs.getPropertyValue('--stage-1').trim() || '#E3E4DA',
          cs.getPropertyValue('--stage-2').trim() || '#B7BAA9'];
}

/* ===================== theme ===================== */
function themeIsDark() {
  const stamped = document.documentElement.getAttribute('data-theme');
  if (stamped === 'dark') return true;
  if (stamped === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  const dark = themeIsDark();
  if (viewport) viewport.setPoolOpacity(dark ? 0.9 : 0.5);
}

/* ===================== boot ===================== */
function fatal(message) {
  document.querySelector('.stage').innerHTML = '';
  document.querySelector('.stage').appendChild(
    h('div', { class: 'fatal' }, h('p', { text: message })));
}

function boot() {
  if (!window.THREE) {
    fatal('The 3D library could not be loaded, so the viewport is unavailable. ' +
          'Check the network connection and reload the page.');
    return;
  }
  viewport = createViewport($('view'), { interactive: true });
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  buildViewNav();
  buildConcepts();
  buildParams();
  buildFinish();
  buildChips();
  buildExportPanel();
  renderDocBar();
  startScaleBar();

  const ctx = {
    store, library, MM,
    open: openDoc, duplicate: duplicateDoc, saveCurrent: () => saveCurrent(),
    buildOther: (design) => sideBuilder.build(design, 'draft'),
    makeViewport: (canvas) => createViewport(canvas, { interactive: true, autoSpin: false, capture: false }),
    exportSpec,
  };
  libraryView = createLibraryView($('libraryPane'), ctx);
  compareView = createCompareView($('comparePane'), ctx);
  specView = createSpecView($('specPane'), ctx);

  const palette = createPalette({ getCommands: commands });
  bindKeys(palette);
  $('paletteBtn').addEventListener('click', () => palette.toggle());
  $('undoBtn').addEventListener('click', doUndo);
  $('redoBtn').addEventListener('click', doRedo);
  $('saveBtn').addEventListener('click', () => saveCurrent());
  $('docName').addEventListener('click', renameCurrent);
  $('newBtn').addEventListener('click', newDesign);
  $('send').addEventListener('click', askClaude);
  $('stop').addEventListener('click', () => designer && designer.stop());
  $('ask').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askClaude();
  });
  $('gap').addEventListener('input', (e) => {
    store.ui.gapMm = +e.target.value;
    $('gapVal').textContent = fmt(store.ui.gapMm, 1) + ' mm';
    // Widen the framing so both halves stay in view, but never undo a
    // deliberate zoom-out.
    const need = VIEWS[store.ui.view3d][2] * viewport.frameRadius + store.ui.gapMm * MM * 0.55;
    if (viewport.cam.dist < need) viewport.cam.dist = need;
    viewport.setDisplay(store.ui);
  });
  for (const [id, q] of [['qDraft', 'draft'], ['qStudio', 'studio']]) {
    $(id).addEventListener('click', () => setQuality(q));
  }

  store.on('design', () => { renderDocBar(); saveWorkspace(); });
  store.on('history', renderDocBar);
  store.on('saved', renderDocBar);

  setView('design');
  regenerate().catch((e) => console.error(e));

  /* Capabilities light up after the page is already usable. */
  (async () => {
    try { downloads = (await window.claude?.use?.('downloads')) || null; } catch (_) { downloads = null; }
    buildExportPanel();

    await library.connect();
    renderDocBar();
    if (library.available) {
      const ws = await library.loadWorkspace();
      if (ws && ws.design) {
        store.load('Restore workspace', ws.design, { record: false });
        store.ui.name = ws.name || store.ui.name;
        store.ui.openId = ws.openId || '';
        store.markSaved();
        syncConcepts(); syncParams(); syncChips(); buildFinish(); renderDocBar();
        viewport.setMaterial(store.design.material);
        viewport.setEnvironment(store.design.environment);
        regenerate().catch(() => {});
        toast('Picked up where you left off');
      }
    }

    designer = createDesigner({
      store, apply: applyFromClaude, describe: () => describeGeometry(),
    });
    if (await designer.connect()) {
      $('aiSec').hidden = false;
      $('aiMode').textContent = designer.agentic
        ? 'Claude can move parameters, rebuild, and read the measurements back.'
        : 'Claude proposes parameter changes; each one is checked against its bounds here.';
    }

    connectRoom();
  })();

  /* Carry the bench across a republish, so an open viewer does not lose the
   * design they were working on. */
  if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
    window.claude.hot.snapshot(() => ({ design: store.snapshot(), ui: { ...store.ui } }));
  }
}

const hot = window.claude && window.claude.hot;
if (hot && hot.ready) hot.ready(() => boot());
else boot();
