/* Generation worker. Keeps the ~0.4 s build off the main thread so the
 * viewport stays responsive and progress can be reported per petal row.
 * index.html falls back to calling generateDesign directly if workers are
 * unavailable in the host. */
import { generateDesign } from './engine.js';

self.onmessage = (ev) => {
  const { id, flower, split } = ev.data;
  try {
    const out = generateDesign(flower, split,
      (stage, i, n) => self.postMessage({ id, type: 'progress', stage, i, n }));
    self.postMessage({ id, type: 'done', ...out }, [
      out.A.pos.buffer, out.A.flowerIdx.buffer, out.A.wallIdx.buffer,
      out.B.pos.buffer, out.B.flowerIdx.buffer, out.B.wallIdx.buffer,
      out.curve.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
