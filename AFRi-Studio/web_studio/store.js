/* AFRi Studio -- the design document, its history, and who is listening.
 *
 * One rule runs through this module: the design is the only thing that is
 * undoable. Camera angle, which piece is hidden, which view is open -- none of
 * that belongs in history, because nobody wants Undo to give them back a
 * camera. Those live in `ui`, which changes freely and is never recorded.
 */

const clone = (o) => JSON.parse(JSON.stringify(o));

export function createStore(design, ui) {
  const subs = new Map();
  const past = [];
  const future = [];
  let editBase = null;
  let editLabel = '';
  let dirty = false;
  const LIMIT = 80;

  const store = {
    design,
    ui,
    metrics: null,
    result: null,

    /* ---- listeners ---- */
    on(evt, fn) {
      if (!subs.has(evt)) subs.set(evt, new Set());
      subs.get(evt).add(fn);
      return () => subs.get(evt).delete(fn);
    },
    emit(evt, payload) {
      const set = subs.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        // One broken listener must not stop the others: a failed readout
        // should never take the viewport down with it.
        try { fn(payload); } catch (e) { console.error('[' + evt + ']', e); }
      }
    },

    /* ---- editing ----
     * commit(label, mutate) is one undoable step. beginEdit/endEdit wrap a
     * drag: every frame of a slider mutates the design, but the whole drag
     * collapses into a single history entry with the value it landed on. */
    commit(label, mutate) {
      const before = clone(store.design);
      mutate(store.design);
      push(label, before);
      changed(label);
    },
    beginEdit(label) {
      if (editBase) return;
      editBase = clone(store.design);
      editLabel = label;
    },
    touch(label) {           // mid-drag: mutate already happened, just redraw
      changed(label || editLabel, true);
    },
    endEdit() {
      if (!editBase) return;
      const before = editBase;
      editBase = null;
      if (JSON.stringify(before) === JSON.stringify(store.design)) return;
      push(editLabel, before);
      changed(editLabel);
    },
    /* Replace the whole design -- loading from the library, undo, a preset. */
    load(label, next, { record = true } = {}) {
      const before = clone(store.design);
      store.design = clone(next);
      if (record) push(label, before);
      changed(label);
    },

    /* ---- history ---- */
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get undoLabel() { return past.length ? past[past.length - 1].label : ''; },
    get redoLabel() { return future.length ? future[future.length - 1].label : ''; },
    history() { return past.map((e) => e.label); },
    undo() {
      if (!past.length) return null;
      const entry = past.pop();
      future.push({ label: entry.label, state: clone(store.design) });
      store.design = entry.state;
      changed('Undo · ' + entry.label);
      return entry.label;
    },
    redo() {
      if (!future.length) return null;
      const entry = future.pop();
      past.push({ label: entry.label, state: clone(store.design) });
      store.design = entry.state;
      changed('Redo · ' + entry.label);
      return entry.label;
    },

    /* ---- saved state ---- */
    get dirty() { return dirty; },
    markSaved() { dirty = false; store.emit('saved'); },
    snapshot() { return clone(store.design); },
  };

  function push(label, before) {
    past.push({ label, state: before });
    if (past.length > LIMIT) past.shift();
    future.length = 0;
  }
  function changed(label, live) {
    dirty = true;
    store.emit('design', { label, live: !!live });
    if (!live) store.emit('history');
  }

  return store;
}

/* Which named parameters differ between two designs, and by how much. The
 * Compare view and the library's "changed since saved" both read this. */
export function diffDesigns(a, b) {
  const rows = [];
  for (const scope of ['flower', 'split', 'hat', 'placement']) {
    const A = a[scope] || {}, B = b[scope] || {};
    for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const va = A[key], vb = B[key];
      if (typeof va === 'number' && typeof vb === 'number') {
        if (Math.abs(va - vb) > 1e-9) rows.push({ scope, key, a: va, b: vb });
      } else if (va !== vb) {
        rows.push({ scope, key, a: va, b: vb });
      }
    }
  }
  if (a.concept !== b.concept) rows.unshift({ scope: 'design', key: 'concept', a: a.concept, b: b.concept });
  return rows;
}
