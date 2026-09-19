/* AFRi Studio -- the design library.
 *
 * Saved designs live in the artifact's own document store, so a design saved
 * on one machine opens on another and the whole team sees the same shelf. Each
 * viewer also gets a private workspace document: the design they had open when
 * they closed the tab, restored when they come back.
 *
 * Every call here works when the store is absent. `available` is false, the
 * shelf reads empty, and the studio carries on as a tool that does not
 * remember -- which is exactly what it was before this module existed.
 */

const COLLECTION = 'designs';
const MAX_SHELF = 60;

export function createLibrary() {
  let db = null, user = null;
  let uid = null;
  let me = null;
  let writeAllowed = null;       // null = the platform said nothing
  let unsubscribe = null;
  let docs = [];
  let lastError = '';
  const listeners = new Set();
  const writeQueue = new Map();  // path -> promise chain, one write at a time

  async function grab(name) {
    try { return (await window.claude?.use?.(name)) || null; }
    catch (_) { return null; }
  }

  async function connect() {
    [db, user] = await Promise.all([grab('db'), grab('user')]);
    if (user) {
      try { me = await user.me(); uid = me.id; } catch (_) { me = null; uid = null; }
      try { writeAllowed = await user.can('data.write'); } catch (_) { writeAllowed = null; }
    }
    if (db) watch();
    return { db: !!db, user: !!user, uid };
  }

  function watch() {
    if (unsubscribe) unsubscribe();
    try {
      unsubscribe = db.collection(COLLECTION)
        .orderBy('updatedAt', 'desc').limit(MAX_SHELF)
        .onSnapshot((snap) => {
          docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
          lastError = '';
          fire();
        }, (err) => {
          // A dead subscription is terminal: say so once and leave the shelf
          // showing whatever it last held.
          lastError = err && err.code === 'revoked'
            ? 'The library is no longer available on this page.'
            : 'The library stopped updating (' + ((err && err.code) || 'unknown') + ').';
          fire();
        });
    } catch (e) {
      lastError = 'The library could not be opened.';
    }
  }

  function fire() { for (const fn of [...listeners]) { try { fn(docs, lastError); } catch (e) { console.error(e); } } }

  /* Serialize writes per document: the store is last-writer-wins, and two
   * overlapping writes to one design are how a rename loses a thumbnail. */
  function serial(path, job) {
    const prev = writeQueue.get(path) || Promise.resolve();
    const next = prev.then(job, job);
    writeQueue.set(path, next.catch(() => {}));
    return next;
  }

  const api = {
    get available() { return !!db; },
    get error() { return lastError; },
    get me() { return me; },
    get uid() { return uid; },
    /* null means the platform did not say. Keep the control, let a refused
     * write be the answer -- that is what the store's own guidance asks for. */
    get writable() { return writeAllowed !== false; },
    get designs() { return docs; },

    connect,
    subscribe(fn) { listeners.add(fn); fn(docs, lastError); return () => listeners.delete(fn); },

    async save(entry) {
      if (!db) throw { code: 'unavailable', message: 'No library on this page.' };
      const id = entry.id || newId();
      const now = new Date().toISOString();
      const existing = docs.find((d) => d.id === id);
      const body = {
        name: String(entry.name || 'Untitled marigold').slice(0, 120),
        concept: String(entry.design.concept || ''),
        design: entry.design,
        summary: entry.summary || {},
        thumb: entry.thumb || (existing && existing.thumb) || '',
        authorId: (existing && existing.authorId) || uid || '',
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now,
      };
      await serial(COLLECTION + '/' + id, () => db.collection(COLLECTION).doc(id).set(body));
      return id;
    },

    async rename(id, name) {
      if (!db) return;
      await serial(COLLECTION + '/' + id, () => db.collection(COLLECTION).doc(id)
        .update({ name: String(name).slice(0, 120), updatedAt: new Date().toISOString() }));
    },

    async remove(id) {
      if (!db) return;
      await serial(COLLECTION + '/' + id, () => db.collection(COLLECTION).doc(id).delete());
    },

    /* Names are other people's input and differ per viewer, so they are never
     * stored -- only ids are -- and they are resolved again on every render. */
    async profiles(ids) {
      if (!user || !ids.length) return {};
      try { return await user.profiles([...new Set(ids.filter(Boolean))]); }
      catch (_) { return {}; }
    },

    /* ---- private workspace: where this viewer left off ---- */
    workspaceReady() { return !!(db && uid); },
    async loadWorkspace() {
      if (!db || !uid) return null;
      try {
        const snap = await db.doc('data/users/' + uid + '/workspace').get();
        return snap.exists ? snap.data() : null;
      } catch (_) { return null; }
    },
    async saveWorkspace(payload) {
      if (!db || !uid) return;
      const path = 'data/users/' + uid + '/workspace';
      await serial(path, () => db.doc(path).set({ ...payload, updatedAt: new Date().toISOString() }));
    },
  };

  return api;
}

/* A sortable, collision-resistant id: milliseconds first so ids sort by
 * creation even before a query orders them. */
export function newId() {
  const t = Date.now().toString(36);
  let r = '';
  const bytes = new Uint8Array(6);
  (window.crypto || {}).getRandomValues
    ? window.crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  for (const b of bytes) r += b.toString(36).padStart(2, '0');
  return t + '-' + r.slice(0, 8);
}

/* Human "3 minutes ago" for the shelf. */
export function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 50) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
