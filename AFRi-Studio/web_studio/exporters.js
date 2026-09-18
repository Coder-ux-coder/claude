/* AFRi Studio -- everything that leaves the page.
 *
 * Binary STL, a ZIP container, the build report, a manufacturing spec sheet
 * and a high-resolution still. No dependencies: the ZIP is written here with
 * the store method, which keeps the output byte-for-byte deterministic.
 */

import { CONCEPTS, MATERIALS, fmt } from './schema.js';

/* ---------- binary STL, millimetres ---------- */
export function stlBinary(piece, MM, title) {
  const pos = piece.pos, idx = piece.flowerIdx, wall = piece.wallIdx;
  const n = (idx.length + wall.length) / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = (title || 'AFRi Studio piece - binary STL - millimetres').slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  const S = 1 / MM;                       // scene units -> millimetres
  const emit = (arr) => {
    for (let t = 0; t < arr.length; t += 3) {
      const a = arr[t] * 3, b = arr[t + 1] * 3, c = arr[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      o += 12;
      for (const p of [a, b, c]) {
        dv.setFloat32(o, pos[p] * S, true);
        dv.setFloat32(o + 4, pos[p + 1] * S, true);
        dv.setFloat32(o + 8, pos[p + 2] * S, true);
        o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
  };
  emit(idx); emit(wall);
  return new Uint8Array(buf);
}

/* ---------- ZIP (store method) ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();

export function zip(entries) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nb = enc.encode(name);
    const crc = CRC(data);
    const local = new Uint8Array(30 + nb.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
    local.set(nb, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

/* ---------- the spec model ----------
 * One structured description of the design, read by both the on-screen tech
 * pack and the file it exports. Two renderings, one source of numbers. */
export function specModel(design, metrics, name) {
  const concept = CONCEPTS.find((c) => c.key === design.concept);
  const material = MATERIALS.find((m) => m.key === design.material) || MATERIALS[0];
  const m = metrics || {};
  const checks = [
    ['Piece A is a closed solid', m.open_edges_a === 0, m.open_edges_a + ' open edges'],
    ['Piece B is a closed solid', m.open_edges_b === 0, m.open_edges_b + ' open edges'],
    ['Every cut face capped', m.cap_failures === 0, m.cap_failures + ' failures'],
    ['A + B reconstruct the master', m.volume_error_pct < 1e-3,
      m.volume_error_pct < 1e-9 ? '0.000000 %' : Number(m.volume_error_pct).toExponential(2) + ' %'],
  ];
  const sections = [
    { title: 'Measured geometry', rows: [
      ['Overall diameter', fmt(m.diameter_mm, 2) + ' mm'],
      ['Overall height', fmt(m.height_mm, 2) + ' mm'],
      ['Petal count', m.petals + ' in ' + m.rows + ' rows'],
      ['Petal thickness', fmt(design.flower.thickness_mm, 2) + ' mm'],
      ['Base disc thickness', fmt(design.flower.base_thickness_mm, 2) + ' mm'],
      ['Base disc diameter', fmt(design.flower.base_disc_ratio * design.flower.diameter_mm, 2) + ' mm'],
      ['Height : diameter', (m.height_mm / Math.max(1e-6, m.diameter_mm)).toFixed(3)],
    ] },
    { title: 'Division', rows: [
      ['Curve family', String(m.path_kind || design.split.type).replace(/_/g, ' ')],
      ['Material balance A : B', (m.balance * 100).toFixed(1) + ' : ' + ((1 - m.balance) * 100).toFixed(1)],
      ['Bodies the curve divides', m.bodies_divided + ' of ' + m.bodies_total],
      ['Cut-wall triangles', String(m.cap_triangles)],
      ['Boundary caps built', String(m.caps_built)],
      ['Path perturbation', fmt(m.path_perturbation_mm, 5) + ' mm'],
    ] },
    { title: 'Bill of geometry', rows: [
      ['Master triangles', String(m.triangles)],
      ['Piece A triangles', String(m.triangles_a)],
      ['Piece B triangles', String(m.triangles_b)],
      ['Added by the split', String(m.triangles_a + m.triangles_b - m.triangles)],
      ['Bodies in master', String(m.bodies_master)],
      ['Bodies in A / B', m.bodies_a + ' / ' + m.bodies_b],
    ] },
  ];
  if (m.hat) {
    sections.push({ title: 'Hat and fit', rows: [
      ['Silhouette', String(m.hat.style).replace(/_/g, ' ')],
      ['Head circumference', fmt(design.hat.head_circumference_mm, 0) + ' mm'],
      ['Overall hat diameter', fmt(m.hat.overall_diameter_mm, 1) + ' mm'],
      ['Brim width', fmt(m.hat.brim_width_mm, 1) + ' mm'],
      ['Accessory seated at radius', fmt(m.hat.seated_radius_mm, 1) + ' mm'],
      ['Standoff from surface', fmt(design.placement.surface_offset_mm, 2) + ' mm'],
      ['Tilt / roll', fmt(design.placement.tilt_deg, 0) + '° / ' + fmt(design.placement.roll_deg, 0) + '°'],
    ] });
  }
  sections.push({ title: 'Finish', rows: [
    ['Specified finish', material.name],
    ['Process note', material.note],
    ['Cut wall', 'Shows raw material; not decorated in this specification.'],
  ] });
  return {
    name: name || 'Untitled marigold',
    concept: concept ? concept.key + ' — ' + concept.name : (design.concept || ''),
    generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    sections, checks,
    parameters: {
      flower: design.flower, split: design.split,
      hat: design.hat, placement: design.placement,
    },
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* A standalone tech-pack document. Deliberately plain: it has to survive being
 * emailed, printed and pinned to a workshop wall. */
export function specHTML(model) {
  const sec = (s) => '<section><h2>' + esc(s.title) + '</h2><table>' +
    s.rows.map((r) => '<tr' + (String(r[1]).length > 26 ? ' class="long"' : '') + '><th>' +
      esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('') +
    '</table></section>';
  const checks = model.checks.map((c) =>
    '<tr><th>' + esc(c[0]) + '</th><td class="' + (c[1] ? 'ok' : 'bad') + '">' +
    esc(c[2]) + '</td></tr>').join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(model.name) + ' — specification</title><style>' +
    'body{margin:0;background:#fff;color:#1C1E17;font:14px/1.55 "Helvetica Neue",Arial,sans-serif;' +
    '-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.wrap{max-width:760px;margin:0 auto;padding:40px 24px 64px}' +
    'header{border-bottom:2px solid #1C1E17;padding-bottom:14px;margin-bottom:26px}' +
    '.mark{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#A96405;font-weight:700}' +
    'h1{font-size:26px;margin:6px 0 4px;font-weight:600}' +
    '.meta{font-size:12px;color:#5D6154;display:flex;gap:18px;flex-wrap:wrap}' +
    'h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#5D6154;' +
    'margin:0 0 8px;font-weight:600}' +
    'section{margin-bottom:24px;break-inside:avoid}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{text-align:left;font-weight:400;color:#3A3D34;padding:5px 0;border-bottom:1px solid #E6E7DE;width:58%}' +
    'td{text-align:right;padding:5px 0;border-bottom:1px solid #E6E7DE;font-variant-numeric:tabular-nums;' +
    'font-family:ui-monospace,Menlo,monospace;font-size:12.5px}' +
    'tr.long{display:block;padding:5px 0;border-bottom:1px solid #E6E7DE}' +
    'tr.long th,tr.long td{display:block;width:auto;border:none;padding:0;text-align:left}' +
    'tr.long td{margin-top:2px;color:#1C1E17}' +
    'td.ok{color:#3F6B36}td.bad{color:#A6402C;font-weight:700}' +
    'pre{background:#F4F5EE;border:1px solid #E6E7DE;padding:12px;font-size:11px;overflow-x:auto;' +
    'white-space:pre-wrap;word-break:break-word}' +
    '.note{font-size:11.5px;color:#5D6154;border-left:3px solid #A96405;padding-left:12px;margin-top:22px}' +
    '@media print{.wrap{padding:0}}' +
    '</style></head><body><div class="wrap"><header>' +
    '<div class="mark">AFRi · Marigold Studio</div>' +
    '<h1>' + esc(model.name) + '</h1>' +
    '<div class="meta"><span>Concept ' + esc(model.concept) + '</span>' +
    '<span>Generated ' + esc(model.generated) + '</span>' +
    '<span>Units: millimetres</span></div></header>' +
    model.sections.map(sec).join('') +
    '<section><h2>Split verification</h2><table>' + checks + '</table></section>' +
    '<section><h2>Parameters as built</h2><pre>' +
    esc(JSON.stringify(model.parameters, null, 2)) + '</pre></section>' +
    '<p class="note"><strong>Provisional.</strong> Every value in this document is a studio ' +
    'assumption. AFRi has supplied no reference deck, brand palette or size chart, and nothing ' +
    'here has been reviewed by a maker or approved for production.</p>' +
    '</div></body></html>';
}

/* ---------- the plain-text build report that rides in the STL zip ---------- */
export function buildReport(design, metrics, name) {
  const m = metrics;
  const c = CONCEPTS.find((x) => x.key === design.concept);
  return [
    'AFRi Studio - marigold two-piece accessory', '',
    'Design         ' + (name || 'Untitled marigold'),
    'Concept        ' + design.concept + ' ' + (c ? c.name : ''),
    'Curve family   ' + m.path_kind,
    'Finish         ' + ((MATERIALS.find((x) => x.key === design.material) || MATERIALS[0]).name),
    'Generated      ' + new Date().toISOString(),
    'Engine         browser JavaScript port of design_engine',
    '',
    'MEASURED',
    '  diameter          ' + fmt(m.diameter_mm, 2) + ' mm',
    '  height            ' + fmt(m.height_mm, 2) + ' mm',
    '  petals            ' + m.petals + ' in ' + m.rows + ' rows',
    '',
    'TRIANGLE COUNT',
    '  master            ' + m.triangles,
    '  piece A           ' + m.triangles_a,
    '  piece B           ' + m.triangles_b,
    '  A + B             ' + (m.triangles_a + m.triangles_b),
    '  added by split    ' + (m.triangles_a + m.triangles_b - m.triangles),
    '  of which cut wall ' + m.cap_triangles + ' (both walls)',
    '',
    '  The pieces do not sum to the master, and should not. Every triangle the',
    '  curve crosses is subdivided into several, and each piece is then given a',
    '  cut wall of its own that did not exist before.',
    '',
    'COMPONENTS',
    '  master bodies     ' + m.bodies_master,
    '  piece A bodies    ' + m.bodies_a,
    '  piece B bodies    ' + m.bodies_b,
    '',
    '  This browser build ships the flower as built: overlapping closed shells,',
    '  one per petal plus the base and centre. It renders identically to the',
    '  consolidated solid but is not yet a manufacturable part. The desktop',
    '  pipeline boolean-unions them into one body per piece before export.',
    '',
    'SPLIT VERIFICATION',
    '  open edges A      ' + m.open_edges_a,
    '  open edges B      ' + m.open_edges_b,
    '  cap failures      ' + m.cap_failures,
    '  volume error      ' + Number(m.volume_error_pct).toExponential(3) + ' %',
    '  balance A:B       ' + (m.balance * 100).toFixed(2) + ' : ' + ((1 - m.balance) * 100).toFixed(2),
    '  bodies divided    ' + m.bodies_divided + ' of ' + m.bodies_total,
    '',
    'UNITS  STL vertices are millimetres.',
    '',
    'NOTE   These are provisional studio concepts. No client reference, brand',
    '       palette or size chart has been supplied. Nothing here is approved',
    '       for production.', '',
    'CONFIGURATION',
    JSON.stringify({ flower: design.flower, split: design.split,
                     hat: design.hat, placement: design.placement }, null, 2),
  ].join('\n');
}

/* ---------- handing a file to the viewer ---------- */
export async function offer(downloads, filename, data) {
  if (!downloads) return { ok: false, message: 'Saving files is not available on this page.' };
  try {
    await downloads.save({ filename, data });
    return { ok: true, message: 'Saved ' + filename };
  } catch (e) {
    const code = e && e.code;
    return { ok: false, message:
      code === 'declined' ? 'Save cancelled.'
      : code === 'rate_limited' ? 'One save at a time — try again in a moment.'
      : code === 'too_large' ? 'That file is too large for this destination.'
      : code === 'rejected_extension' ? 'That file type cannot be saved here.'
      : 'Could not save the file (' + (code || 'unknown') + ').' };
  }
}

/* A data: URL back into bytes, for saving a captured still. */
export function dataURLToBlob(url) {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const isB64 = /;base64$/i.test(meta);
  const type = meta.replace(/;base64$/i, '') || 'application/octet-stream';
  const body = url.slice(comma + 1);
  if (!isB64) return new Blob([decodeURIComponent(body)], { type });
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type });
}

export function slug(s) {
  return String(s || 'design').trim().replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 48) || 'design';
}
