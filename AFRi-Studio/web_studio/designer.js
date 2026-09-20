/* AFRi Studio -- Claude at the bench.
 *
 * The assistant does not write code and cannot reach the filesystem. It is
 * handed two page functions: one that moves named parameters within their
 * declared bounds, and one that reads back what the geometry kernel then
 * actually measured. That loop is the whole point -- it can ask for a 90 mm
 * flower under 40 mm tall, see what it got, and correct itself, instead of
 * guessing once and stopping.
 *
 * Every change it makes is an ordinary undoable step, so a bad suggestion
 * costs one press of Undo.
 */

import { PARAMS, CURVE_FAMILIES, HAT_STYLES } from './schema.js';

const FAMILIES = CURVE_FAMILIES.map((f) => f[0]);
const STYLES = HAT_STYLES.map((s) => s[0]);

export function createDesigner({ store, apply, describe }) {
  let sample = null;
  let limits = null;
  let ctl = null;

  async function connect() {
    try { sample = (await window.claude?.use?.('sample')) || null; }
    catch (_) { sample = null; }
    if (sample) {
      try { limits = await sample.limits(); } catch (_) { limits = null; }
    }
    return !!sample;
  }

  /* ---- the allow-list ----
   * A change is applied only if the parameter exists in the schema and the
   * value sits inside the bounds the schema declares. Nothing else is
   * reachable from a reply. */
  function validate(list) {
    const applied = [], rejected = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      const name = String((raw && (raw.parameter || raw.param)) || '');
      const reason = raw && raw.reason ? String(raw.reason).slice(0, 140) : '';
      if (name === 'split.type') {
        if (FAMILIES.includes(raw.value)) applied.push({ name, value: raw.value, reason });
        else rejected.push(name + ' — not a curve family');
        continue;
      }
      if (name === 'hat.style') {
        if (STYLES.includes(raw.value)) applied.push({ name, value: raw.value, reason });
        else rejected.push(name + ' — not a hat silhouette');
        continue;
      }
      const spec = PARAMS.get(name);
      if (!spec) { rejected.push(name + ' — not a parameter'); continue; }
      const v = Number(raw.value);
      if (!Number.isFinite(v)) { rejected.push(name + ' — not a number'); continue; }
      if (v < spec.lo || v > spec.hi) {
        rejected.push(name + ' = ' + v + ' — outside ' + spec.lo + '…' + spec.hi);
        continue;
      }
      applied.push({ name, value: spec.step >= 1 ? Math.round(v) : v, reason });
    }
    return { applied, rejected };
  }

  function parameterTable() {
    const rows = [];
    for (const [name, spec] of PARAMS) {
      const cur = (store.design[spec.scope] || {})[spec.key];
      rows.push(name + ' [' + spec.lo + '…' + spec.hi + '] = ' + cur);
    }
    rows.push('split.type {' + FAMILIES.join('|') + '} = ' + store.design.split.type);
    rows.push('hat.style {' + STYLES.join('|') + '} = ' + store.design.hat.style);
    return rows.join('\n');
  }

  const SYSTEM =
    'You are the design assistant inside AFRi Studio, a parametric tool for a two-piece ' +
    'marigold flower accessory that mounts on a hat. You change a design only by moving ' +
    'named parameters. You cannot run code, read files or reach the network.\n\n' +
    'The flower is built from concentric rows of closed-solid petals on a structural base ' +
    'disc, then cut in two by an exact per-triangle clipping kernel along a curve x = f(y). ' +
    'Petal density, length ratio and overlap decide how full it reads; dome gain and layer ' +
    'tilt decide whether it is a flat rosette or a pompon; the split amplitude and smoothness ' +
    'decide how the dividing line draws across the face.\n\n' +
    'All dimensions are millimetres. Keep changes minimal and purposeful: move what the ' +
    'request needs and leave the rest alone.';

  function toolset(onRound) {
    return [
      {
        name: 'adjust_design',
        description:
          'Move one or more named parameters. Values outside a parameter\'s declared bounds ' +
          'are rejected and reported back. Returns which changes were applied, which were ' +
          'rejected, and the geometry the kernel measured afterwards (diameter, height, ' +
          'petal count, split verification). Use it to check your work, not only to act.',
        inputSchema: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              description: 'The parameter changes to apply.',
              items: {
                type: 'object',
                properties: {
                  parameter: { type: 'string', description: 'Exact name, e.g. flower.petal_density' },
                  value: { description: 'Number, or the string value for split.type / hat.style' },
                  reason: { type: 'string', description: 'Six words on why.' },
                },
                required: ['parameter', 'value'],
              },
            },
          },
          required: ['changes'],
        },
        async execute(input, context) {
          const { applied, rejected } = validate(input && input.changes);
          if (!applied.length) return { applied: [], rejected, note: 'Nothing was changed.' };
          if (onRound) onRound(applied, rejected);
          const measured = await apply(applied);
          if (context.signal.aborted) return { applied, rejected, note: 'Stopped by the user.' };
          return { applied: applied.map((a) => a.name + '=' + a.value), rejected, measured };
        },
      },
      {
        name: 'read_design',
        description:
          'Read the design as it stands: every parameter with its current value and bounds, ' +
          'plus the geometry last measured by the kernel. Takes no arguments.',
        execute() { return { parameters: parameterTable(), measured: describe() }; },
      },
    ];
  }

  async function ask(question, { onText, onRound } = {}) {
    if (!sample) throw { code: 'not_granted', message: 'Claude is not available on this page.' };
    ctl = new AbortController();
    const hasTools = !!(limits && limits.tools);
    const prompt =
      SYSTEM + '\n\nParameters you may move, with bounds and current values:\n' +
      parameterTable() + '\n\nGeometry as last measured:\n' +
      JSON.stringify(describe()) + '\n\n' +
      (hasTools
        ? 'Use adjust_design to make the change, then judge the measurements it returns and ' +
          'correct yourself if they miss what was asked. Use at most five adjust_design calls. ' +
          'Finish with two or three sentences: what you changed and what it measured.'
        : 'Reply with ONLY a JSON object: {"changes":[{"parameter":"flower.petal_density",' +
          '"value":1.7,"reason":"fuller rosette"}],"note":"one short sentence"}. Use the exact ' +
          'names above and keep every value inside its bounds.') +
      '\n\nRequest: ' + question;

    try {
      if (hasTools) {
        const res = await sample(prompt, {
          signal: ctl.signal, modelTier: 'default',
          tools: toolset(onRound), onText,
        });
        return { kind: 'agentic', text: (res && res.text) || '' };
      }
      const res = await sample.json(prompt, { signal: ctl.signal, modelTier: 'default', cache: false });
      const { applied, rejected } = validate(res && res.changes);
      if (applied.length) { if (onRound) onRound(applied, rejected); await apply(applied); }
      return { kind: 'single', text: (res && res.note) || '', applied, rejected };
    } finally {
      ctl = null;
    }
  }

  return {
    connect,
    get available() { return !!sample; },
    get agentic() { return !!(limits && limits.tools); },
    ask,
    stop() { if (ctl) ctl.abort(); },
    get busy() { return !!ctl; },
    message(code) {
      return code === 'cancelled' ? 'Stopped.'
        : code === 'not_granted' || code === 'not_declared' ? 'Claude is not enabled for this page on your account.'
        : code === 'rate_limited' ? 'Rate limited — try again shortly.'
        : code === 'invalid_json' ? 'The reply was not usable parameter JSON. Try rephrasing.'
        : code === 'prompt_too_large' ? 'That request was too long to send.'
        : code === 'refused' ? 'Claude declined that request.'
        : 'Could not reach Claude (' + (code || 'unknown') + ').';
    },
  };
}
