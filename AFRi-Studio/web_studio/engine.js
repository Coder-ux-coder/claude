/* AFRi Studio -- browser geometry engine.
 *
 * A direct port of design_engine/* from NumPy to plain JavaScript typed
 * arrays, so the master marigold and the two-piece split can be computed live
 * in a browser with no server, no Python and no Blender.
 *
 * The algorithms are the same ones the production pipeline runs: the same
 * layer schedule, the same closed-solid petals, and the same exact
 * per-triangle plane clipping with shared crossing vertices. What is NOT
 * ported is Blender -- rendering, materials and lighting stay server side.
 *
 * One deliberate difference: numpy's PCG64 generator cannot be reproduced
 * here, so the per-petal random jitter (organic_variation) and the organic
 * split's fractal wander draw from a different, also-deterministic generator.
 * With organic_variation = 0 the two engines agree to float precision; that
 * is what tests/parity checks.
 */

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */
export function linspace(a, b, n) {
  const out = new Float64Array(n);
  if (n === 1) { out[0] = a; return out; }
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + step * i;
  return out;
}

export function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/* np.interp against a uniformly spaced xp = linspace(0, 1, n). */
function interpUnit(q, fp) {
  const n = fp.length;
  if (q <= 0) return fp[0];
  if (q >= 1) return fp[n - 1];
  const pos = q * (n - 1);
  const i = Math.floor(pos);
  const t = pos - i;
  return fp[i] + (fp[i + 1] - fp[i]) * t;
}

/* np.interp against arbitrary strictly increasing xp, with clamping. */
export function interpSorted(q, xp, fp) {
  const n = xp.length;
  if (q <= xp[0]) return fp[0];
  if (q >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= q) lo = mid; else hi = mid;
  }
  const span = xp[hi] - xp[lo];
  const t = span === 0 ? 0 : (q - xp[lo]) / span;
  return fp[lo] + (fp[hi] - fp[lo]) * t;
}

/* Deterministic PRNG (sfc32) with a normal draw, standing in for numpy's
 * default_rng. Same seed always gives the same flower. */
export function makeRng(seed) {
  let a = 0x9e3779b9, b = seed >>> 0, c = 0x243f6a88, d = 0x85a308d3;
  function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ (b >>> 9);
    b = c + (c << 3) | 0;
    c = (c << 21) | (c >>> 11);
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  }
  for (let i = 0; i < 16; i++) next();
  let spare = null;
  return {
    uniform(lo, hi) { return lo + (hi - lo) * next(); },
    normal(mu, sigma) {
      if (spare !== null) { const s = spare; spare = null; return mu + sigma * s; }
      let u = 0, v = 0, s = 0;
      do { u = next() * 2 - 1; v = next() * 2 - 1; s = u * u + v * v; }
      while (s >= 1 || s === 0);
      const f = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * f;
      return mu + sigma * u * f;
    },
  };
}

/* Deterministic smooth 1-D fractal value noise in roughly [-1, 1]. */
export function valueNoise1D(x, seed, octaves = 3, roughness = 0.5, baseFreq = 1.0) {
  let total = 0, amp = 1.0, freq = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const rng = makeRng((seed * 7919 + o * 104729) >>> 0);
    const nKnots = Math.max(4, Math.floor(8 * freq)) + 1;
    const knots = new Float64Array(nKnots);
    for (let k = 0; k < nKnots; k++) knots[k] = rng.uniform(-1, 1);
    const pos = x * freq;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = knots[((i0 % nKnots) + nKnots) % nKnots];
    const b = knots[(((i0 + 1) % nKnots) + nKnots) % nKnots];
    const sm = frac * frac * (3 - 2 * frac);
    total += amp * (a * (1 - sm) + b * sm);
    norm += amp;
    amp *= roughness;
    freq *= 2;
  }
  return total / Math.max(norm, 1e-9);
}

/* ------------------------------------------------------------------ *
 * Mesh: flat typed arrays. verts = Float64Array(V*3), faces = Int32Array(F*3),
 * parts = Int32Array(F).
 * ------------------------------------------------------------------ */
export const PART_BASE = 1000000;
export const PART_CENTER = 2000000;
export const PART_PETAL = 3000000;
export const PART_BOUNDARY = 4000000;

export function petalPartId(layer, index) { return PART_PETAL + layer * 10000 + index; }

export function partKind(pid) {
  if (pid >= PART_BOUNDARY) return 'boundary';
  if (pid >= PART_PETAL) return 'petal';
  if (pid >= PART_CENTER) return 'center';
  return 'base';
}

export function mesh(verts, faces, parts, name = 'mesh') {
  return { verts, faces, parts, name, nVerts: verts.length / 3, nFaces: faces.length / 3 };
}

export function meshVolume(m) {
  const { verts: V, faces: F } = m;
  let vol = 0;
  for (let f = 0; f < F.length; f += 3) {
    const a = F[f] * 3, b = F[f + 1] * 3, c = F[f + 2] * 3;
    const ax = V[a], ay = V[a + 1], az = V[a + 2];
    const bx = V[b], by = V[b + 1], bz = V[b + 2];
    const cx = V[c], cy = V[c + 1], cz = V[c + 2];
    // a . (b x c)
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

export function meshArea(m) {
  const { verts: V, faces: F } = m;
  let area = 0;
  for (let f = 0; f < F.length; f += 3) {
    const a = F[f] * 3, b = F[f + 1] * 3, c = F[f + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return area * 0.5;
}

export function meshBounds(m) {
  const V = m.verts;
  if (V.length === 0) return [[0, 0, 0], [0, 0, 0]];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = V[i + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  return [lo, hi];
}

function triArea2(V, i, j, k) {
  const a = i * 3, b = j * 3, c = k * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

export function dropDegenerate(m, eps = 1e-10) {
  const { verts: V, faces: F, parts: P } = m;
  const keep = [];
  for (let f = 0, fi = 0; f < F.length; f += 3, fi++) {
    if (triArea2(V, F[f], F[f + 1], F[f + 2]) > eps) keep.push(fi);
  }
  if (keep.length === F.length / 3) return m;
  const nf = new Int32Array(keep.length * 3);
  const np = new Int32Array(keep.length);
  for (let i = 0; i < keep.length; i++) {
    const f = keep[i] * 3;
    nf[i * 3] = F[f]; nf[i * 3 + 1] = F[f + 1]; nf[i * 3 + 2] = F[f + 2];
    np[i] = P[keep[i]];
  }
  return mesh(V, nf, np, m.name);
}

/* Merge vertices within tol by quantised hashing, then drop degenerates. */
export function weld(m, tol = 1e-5) {
  const { verts: V, faces: F, parts: P } = m;
  const nv = V.length / 3;
  if (nv === 0) return m;
  const map = new Map();
  const inverse = new Int32Array(nv);
  const kept = [];
  for (let i = 0; i < nv; i++) {
    const qx = Math.round(V[i * 3] / tol);
    const qy = Math.round(V[i * 3 + 1] / tol);
    const qz = Math.round(V[i * 3 + 2] / tol);
    const key = qx + ',' + qy + ',' + qz;
    let idx = map.get(key);
    if (idx === undefined) { idx = kept.length; map.set(key, idx); kept.push(i); }
    inverse[i] = idx;
  }
  const nvOut = kept.length;
  const newV = new Float64Array(nvOut * 3);
  for (let i = 0; i < nvOut; i++) {
    const s = kept[i] * 3;
    newV[i * 3] = V[s]; newV[i * 3 + 1] = V[s + 1]; newV[i * 3 + 2] = V[s + 2];
  }
  const newF = new Int32Array(F.length);
  for (let i = 0; i < F.length; i++) newF[i] = inverse[F[i]];
  return dropDegenerate(mesh(newV, newF, P.slice(), m.name));
}

/* Globally consistent winding with outward normals: BFS across shared edges
 * per connected component, then flip any component with negative volume. */
export function orient(m) {
  const { verts: V, parts: P } = m;
  const F = m.faces.slice();
  const nf = F.length / 3;
  if (nf === 0) return m;
  const nv = V.length / 3;

  // edge key -> packed (faceIndex * 3 + slot) entries
  const edges = new Map();
  const edgeKey = (x, y) => (x < y ? x * nv + y : y * nv + x);
  for (let fi = 0; fi < nf; fi++) {
    const a = F[fi * 3], b = F[fi * 3 + 1], c = F[fi * 3 + 2];
    const pairs = [[a, b], [b, c], [c, a]];
    for (let slot = 0; slot < 3; slot++) {
      const k = edgeKey(pairs[slot][0], pairs[slot][1]);
      let bucket = edges.get(k);
      if (bucket === undefined) { bucket = []; edges.set(k, bucket); }
      bucket.push(fi * 3 + slot);
    }
  }

  const visited = new Uint8Array(nf);
  const comps = [];
  const stack = new Int32Array(nf);
  for (let start = 0; start < nf; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    let sp = 0;
    stack[sp++] = start;
    const comp = [start];
    while (sp > 0) {
      const fi = stack[--sp];
      const a = F[fi * 3], b = F[fi * 3 + 1], c = F[fi * 3 + 2];
      const pairs = [[a, b], [b, c], [c, a]];
      for (let s = 0; s < 3; s++) {
        const x = pairs[s][0], y = pairs[s][1];
        const bucket = edges.get(edgeKey(x, y));
        if (bucket === undefined) continue;
        for (let e = 0; e < bucket.length; e++) {
          const fj = (bucket[e] / 3) | 0;
          const slot = bucket[e] % 3;
          if (fj === fi || visited[fj]) continue;
          const p2 = F[fj * 3 + slot], q2 = F[fj * 3 + ((slot + 1) % 3)];
          // traversing the shared edge the same way means fj is wound backwards
          if (p2 === x && q2 === y) {
            const t = F[fj * 3]; F[fj * 3] = F[fj * 3 + 2]; F[fj * 3 + 2] = t;
          }
          visited[fj] = 1;
          stack[sp++] = fj;
          comp.push(fj);
        }
      }
    }
    comps.push(comp);
  }

  for (const comp of comps) {
    let vol = 0;
    for (const fi of comp) {
      const a = F[fi * 3] * 3, b = F[fi * 3 + 1] * 3, c = F[fi * 3 + 2] * 3;
      const ax = V[a], ay = V[a + 1], az = V[a + 2];
      const bx = V[b], by = V[b + 1], bz = V[b + 2];
      const cx = V[c], cy = V[c + 1], cz = V[c + 2];
      vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    if (vol < 0) {
      for (const fi of comp) {
        const t = F[fi * 3]; F[fi * 3] = F[fi * 3 + 2]; F[fi * 3 + 2] = t;
      }
    }
  }
  return mesh(V, F, P, m.name);
}

/* Connected-component label per face, by union-find over shared vertices.
 * Reported rather than fixed: the browser cannot run the boolean that fuses
 * the flower into one solid, so it says how many bodies there actually are. */
export function componentLabels(m) {
  const nv = m.nVerts;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const F = m.faces;
  for (let f = 0; f < F.length; f += 3) {
    const ra = find(F[f]), rb = find(F[f + 1]), rc = find(F[f + 2]);
    if (ra !== rb) parent[rb] = ra;
    const r2 = find(ra);
    if (r2 !== rc) parent[rc] = r2;
  }
  const out = new Int32Array(m.nFaces);
  for (let i = 0; i < m.nFaces; i++) out[i] = find(F[i * 3]);
  return out;
}

export function countBodies(m) {
  const lab = componentLabels(m);
  const seen = new Set();
  for (let i = 0; i < lab.length; i++) seen.add(lab[i]);
  return seen.size;
}

export function translated(m, vec) {
  const V = m.verts, out = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    out[i] = V[i] + vec[0]; out[i + 1] = V[i + 1] + vec[1]; out[i + 2] = V[i + 2] + vec[2];
  }
  return mesh(out, m.faces, m.parts, m.name);
}

export function rotatedZ(m, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const V = m.verts, out = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    const x = V[i], y = V[i + 1];
    out[i] = x * c - y * s; out[i + 1] = x * s + y * c; out[i + 2] = V[i + 2];
  }
  return mesh(out, m.faces, m.parts, m.name);
}

/* Concatenate meshes, reporting each source's vertex/face range so the split
 * kernel can address one closed body at a time without a global scan. */
export function concat(meshes, name = 'mesh') {
  const list = meshes.filter((m) => m && m.nFaces > 0);
  if (!list.length) {
    return { mesh: mesh(new Float64Array(0), new Int32Array(0), new Int32Array(0), name), bodies: [] };
  }
  let tv = 0, tf = 0;
  for (const m of list) { tv += m.verts.length; tf += m.faces.length; }
  const V = new Float64Array(tv);
  const F = new Int32Array(tf);
  const P = new Int32Array(tf / 3);
  const bodies = [];
  let vo = 0, fo = 0;
  for (const m of list) {
    V.set(m.verts, vo);
    const off = vo / 3;
    for (let i = 0; i < m.faces.length; i++) F[fo + i] = m.faces[i] + off;
    P.set(m.parts, fo / 3);
    bodies.push({
      vertStart: off, vertEnd: off + m.nVerts,
      faceStart: fo / 3, faceEnd: fo / 3 + m.nFaces,
      partId: m.parts[0],
    });
    vo += m.verts.length;
    fo += m.faces.length;
  }
  return { mesh: mesh(V, F, P, name), bodies };
}

/* Triangulate a (nu x nv) vertex grid indexed as i*nv + j. */
export function gridFaces(nu, nv, flip, offset) {
  const quads = (nu - 1) * (nv - 1);
  const out = new Int32Array(quads * 6);
  let p = 0;
  // first triangle of every quad, then second -- matching the NumPy ordering
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j + offset, b = i * nv + j + 1 + offset;
      const c = (i + 1) * nv + j + 1 + offset;
      if (flip) { out[p++] = a; out[p++] = c; out[p++] = b; }
      else { out[p++] = a; out[p++] = b; out[p++] = c; }
    }
  }
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j + offset;
      const c = (i + 1) * nv + j + 1 + offset, d = (i + 1) * nv + j + offset;
      if (flip) { out[p++] = a; out[p++] = d; out[p++] = c; }
      else { out[p++] = a; out[p++] = c; out[p++] = d; }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Petal outline families
 * ------------------------------------------------------------------ */
export function widthProfile(u, family, ruffleAmp, ruffleFreq, phase) {
  let base;
  if (family === 'spoon') base = 0.16 + 0.84 * smoothstep(0.0, 0.70, u);
  else if (family === 'strap') base = 0.62 + 0.38 * smoothstep(0.0, 0.30, u);
  else base = 0.22 + 0.78 * Math.pow(clamp(u, 0, 1), 0.50);
  if (ruffleAmp > 0) {
    base *= 1.0 + 0.10 * ruffleAmp * Math.sin(ruffleFreq * 2 * Math.PI * u + phase);
  }
  return Math.max(base, 0);
}

export function tipLengthProfile(v, notch) {
  const rounding = Math.sqrt(clamp(1.0 - 0.88 * v * v, 0, 1));
  if (notch <= 0) return rounding;
  const dip = 0.16 * notch * Math.exp(-Math.pow(v / 0.40, 2));
  return rounding - dip;
}

/* ------------------------------------------------------------------ *
 * One petal, as a closed solid shell
 * ------------------------------------------------------------------ */
export function buildPetal(opts) {
  const {
    length, width, thickness,
    segmentsU = 14, segmentsV = 9, curl = 0.5, cup = 0.4,
    ruffleAmp = 0.3, ruffleFreq = 3.6, notch = 0.2, twist = 0.0,
    tilt = 0.0, family = 'obovate', phase = 0.0, partId = 0, name = 'petal',
  } = opts;

  const nu = Math.max(5, segmentsU | 0);
  const nv = Math.max(3, segmentsV | 0);
  const u = linspace(0, 1, nu);
  const vv = linspace(-1, 1, nv);

  // centreline: integrate a turning tangent
  const bend = curl * (105.0 * Math.PI / 180);
  const phi = new Float64Array(nu);
  for (let i = 0; i < nu; i++) phi[i] = tilt + bend * Math.pow(u[i], 1.25);
  const du = 1.0 / (nu - 1);
  const cx = new Float64Array(nu), cz = new Float64Array(nu);
  let accX = 0, accZ = 0;
  cx[0] = 0; cz[0] = 0;
  for (let i = 1; i < nu; i++) {
    accX += Math.cos(phi[i - 1]) * du;
    accZ += Math.sin(phi[i - 1]) * du;
    cx[i] = accX * length; cz[i] = accZ * length;
  }

  const halfW = new Float64Array(nu);
  for (let i = 0; i < nu; i++) {
    halfW[i] = widthProfile(u[i], family, ruffleAmp, ruffleFreq, phase) * (width * 0.5);
  }
  const tipScale = new Float64Array(nv);
  for (let j = 0; j < nv; j++) tipScale[j] = tipLengthProfile(vv[j], notch);

  const n = nu * nv;
  const mid = new Float64Array(n * 3);
  const Ueff = new Float64Array(n);

  for (let i = 0; i < nu; i++) {
    const Uv = u[i];
    const notchRegion = Math.pow(clamp((Uv - 0.55) / 0.45, 0, 1), 1.1);
    for (let j = 0; j < nv; j++) {
      const idx = i * nv + j;
      const V0 = vv[j];
      const ue = Uv * (1.0 - notchRegion * (1.0 - tipScale[j]));
      Ueff[idx] = ue;
      const X = interpUnit(ue, cx);
      let Z = interpUnit(ue, cz);
      const W = interpUnit(ue, halfW);
      const Y = V0 * W;
      // crosswise cupping: lift the edges into a channel
      Z += cup * W * (V0 * V0 - 0.30);
      // edge ruffle: a travelling wave strongest at the rim
      if (ruffleAmp > 0) {
        Z += ruffleAmp * 0.30 * width * Math.pow(Math.abs(V0), 2.1)
           * Math.sin(ruffleFreq * 2 * Math.PI * ue + phase + 1.7 * V0);
      }
      mid[idx * 3] = X; mid[idx * 3 + 1] = Y; mid[idx * 3 + 2] = Z;
    }
  }

  // twist about the petal's own long axis
  if (Math.abs(twist) > 1e-6) {
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const idx = i * nv + j;
        const ang = twist * Ueff[idx];
        const Yc = mid[idx * 3 + 1], Zc = mid[idx * 3 + 2];
        const zBase = interpUnit(Ueff[idx], cz);
        const dz = Zc - zBase;
        mid[idx * 3 + 1] = Yc * Math.cos(ang) - dz * Math.sin(ang);
        mid[idx * 3 + 2] = zBase + Yc * Math.sin(ang) + dz * Math.cos(ang);
      }
    }
  }

  // surface normals from the parametric tangents (np.gradient, unit spacing)
  const N = new Float64Array(n * 3);
  const nlen = new Float64Array(n);
  const g = (i, j, k) => mid[(i * nv + j) * 3 + k];
  let zSum = 0;
  for (let i = 0; i < nu; i++) {
    const im = i === 0 ? 0 : i - 1;
    const ip = i === nu - 1 ? nu - 1 : i + 1;
    const iScale = (i === 0 || i === nu - 1) ? 1.0 : 0.5;
    for (let j = 0; j < nv; j++) {
      const jm = j === 0 ? 0 : j - 1;
      const jp = j === nv - 1 ? nv - 1 : j + 1;
      const jScale = (j === 0 || j === nv - 1) ? 1.0 : 0.5;
      const du0 = (g(ip, j, 0) - g(im, j, 0)) * iScale;
      const du1 = (g(ip, j, 1) - g(im, j, 1)) * iScale;
      const du2 = (g(ip, j, 2) - g(im, j, 2)) * iScale;
      const dv0 = (g(i, jp, 0) - g(i, jm, 0)) * jScale;
      const dv1 = (g(i, jp, 1) - g(i, jm, 1)) * jScale;
      const dv2 = (g(i, jp, 2) - g(i, jm, 2)) * jScale;
      const nx = du1 * dv2 - du2 * dv1;
      const ny = du2 * dv0 - du0 * dv2;
      const nz = du0 * dv1 - du1 * dv0;
      const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const idx = i * nv + j;
      nlen[idx] = L;
      const d = L < 1e-12 ? 1.0 : L;
      N[idx * 3] = nx / d; N[idx * 3 + 1] = ny / d; N[idx * 3 + 2] = nz / d;
      zSum += nz / d;
    }
  }
  const flipSign = zSum > 0 ? 1 : (zSum < 0 ? -1 : 1);
  for (let i = 0; i < n; i++) {
    if (nlen[i] < 1e-9) { N[i * 3] = 0; N[i * 3 + 1] = 0; N[i * 3 + 2] = 1; }
    else { N[i * 3] *= flipSign; N[i * 3 + 1] *= flipSign; N[i * 3 + 2] *= flipSign; }
  }

  const h = thickness * 0.5;
  const verts = new Float64Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      verts[i * 3 + k] = mid[i * 3 + k] + N[i * 3 + k] * h;
      verts[(n + i) * 3 + k] = mid[i * 3 + k] - N[i * 3 + k] * h;
    }
  }

  const fTop = gridFaces(nu, nv, false, 0);
  const fBot = gridFaces(nu, nv, true, n);
  const rim = [];
  const ti = (i, j) => i * nv + j;
  const bi = (i, j) => n + i * nv + j;
  const quad = (a, b, c, d) => { rim.push(a, b, c, a, c, d); };
  for (let i = 0; i < nu - 1; i++) quad(ti(i, 0), bi(i, 0), bi(i + 1, 0), ti(i + 1, 0));
  for (let i = 0; i < nu - 1; i++) quad(ti(i, nv - 1), ti(i + 1, nv - 1), bi(i + 1, nv - 1), bi(i, nv - 1));
  for (let j = 0; j < nv - 1; j++) quad(ti(0, j), ti(0, j + 1), bi(0, j + 1), bi(0, j));
  for (let j = 0; j < nv - 1; j++) quad(ti(nu - 1, j), bi(nu - 1, j), bi(nu - 1, j + 1), ti(nu - 1, j + 1));

  const F = new Int32Array(fTop.length + fBot.length + rim.length);
  F.set(fTop, 0); F.set(fBot, fTop.length); F.set(rim, fTop.length + fBot.length);
  const P = new Int32Array(F.length / 3).fill(partId);

  let m = dropDegenerate(mesh(verts, F, P, name), 1e-12);
  // The tip can collapse to a point; weld before orienting or the pinch reads
  // as a hole rather than a cone point.
  return orient(weld(m, 1e-5));
}

/* ------------------------------------------------------------------ *
 * Structural base disc and domed centre boss
 * ------------------------------------------------------------------ */
function ringFaces(rings, segments, offset, flip) {
  const out = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const jn = (j + 1) % segments;
      const a = offset + i * segments + j;
      const b = offset + i * segments + jn;
      const c = offset + (i + 1) * segments + jn;
      const d = offset + (i + 1) * segments + j;
      if (flip) out.push(a, c, b, a, d, c);
      else out.push(a, b, c, a, c, d);
    }
  }
  return out;
}

/* rootProfile is [radiusAscending, rootZ] from the layer schedule. With it the
 * dome is built to follow the petal roots, so every row is physically embedded
 * in the structure. Without it the inner rows float clear of the base with
 * nothing holding them -- measured on the old defaults, rows 4 and 5 sat
 * 0.64 mm and 1.61 mm above it. */
export function buildBaseDisc(radius, thickness, domeHeight, segments = 64, rings = 10,
                              rootProfile = null) {
  segments = Math.max(12, segments | 0);
  rings = Math.max(3, rings | 0);
  const n = rings * segments;
  const verts = new Float64Array(n * 2 * 3);
  for (let i = 0; i < rings; i++) {
    const R = rings === 1 ? 0 : i / (rings - 1);
    const zTop = rootProfile
      ? Math.max(thickness, interpSorted(R * radius, rootProfile[0], rootProfile[1]))
      : domeHeight * Math.pow(Math.cos(clamp(R, 0, 1) * Math.PI * 0.5), 1.5) + thickness;
    for (let j = 0; j < segments; j++) {
      const T = 2 * Math.PI * j / segments;
      const idx = i * segments + j;
      const x = R * radius * Math.cos(T), y = R * radius * Math.sin(T);
      verts[idx * 3] = x; verts[idx * 3 + 1] = y; verts[idx * 3 + 2] = zTop;
      verts[(n + idx) * 3] = x; verts[(n + idx) * 3 + 1] = y; verts[(n + idx) * 3 + 2] = 0;
    }
  }
  const f = ringFaces(rings, segments, 0, false).concat(ringFaces(rings, segments, n, true));
  for (let j = 0; j < segments; j++) {
    const jn = (j + 1) % segments;
    const t0 = (rings - 1) * segments + j, t1 = (rings - 1) * segments + jn;
    f.push(t0, n + t0, n + t1, t0, n + t1, t1);
  }
  const F = Int32Array.from(f);
  const P = new Int32Array(F.length / 3).fill(PART_BASE);
  return orient(weld(mesh(verts, F, P, 'base_disc'), 1e-5));
}

export function buildCenter(radius, height, floretRings = 5, segments = 72) {
  segments = Math.max(12, segments | 0);
  const rings = 20;
  const n = rings * segments;
  const verts = new Float64Array(n * 2 * 3);
  const ripplePeriod = Math.max(10, Math.floor(segments / 3));
  for (let i = 0; i < rings; i++) {
    const R = i / (rings - 1);
    for (let j = 0; j < segments; j++) {
      const T = 2 * Math.PI * j / segments;
      const idx = i * segments + j;
      let z = height * Math.cos(clamp(R, 0, 1) * Math.PI * 0.5);
      let x = R * radius * Math.cos(T), y = R * radius * Math.sin(T);
      if (floretRings > 0) {
        // A marigold centre is a mass of tiny tubular florets, not a button.
        const petalRipple = Math.sin(T * ripplePeriod);
        const ringRipple = Math.sin(R * Math.PI * floretRings * 2.0);
        const falloff = Math.pow(Math.sin(clamp(R, 0, 1) * Math.PI), 0.6);
        z += ringRipple * petalRipple * falloff * height * 0.30;
        z += Math.sin(T * 7 + R * Math.PI * 5) * falloff * height * 0.12;
        const bump = 1.0 + 0.055 * ringRipple * petalRipple;
        x *= bump; y *= bump;
      }
      verts[idx * 3] = x; verts[idx * 3 + 1] = y; verts[idx * 3 + 2] = z;
      verts[(n + idx) * 3] = x; verts[(n + idx) * 3 + 1] = y; verts[(n + idx) * 3 + 2] = 0;
    }
  }
  const f = ringFaces(rings, segments, 0, false).concat(ringFaces(rings, segments, n, true));
  for (let j = 0; j < segments; j++) {
    const jn = (j + 1) % segments;
    const t0 = (rings - 1) * segments + j, t1 = (rings - 1) * segments + jn;
    f.push(t0, n + t0, n + t1, t0, n + t1, t1);
  }
  const F = Int32Array.from(f);
  const P = new Int32Array(F.length / 3).fill(PART_CENTER);
  return orient(weld(mesh(verts, F, P, 'center'), 1e-5));
}

/* ------------------------------------------------------------------ *
 * The canonical master marigold
 * ------------------------------------------------------------------ */
export const MM = 0.1;   // 1 scene unit == 10 mm

export const FLOWER_DEFAULTS = {
  diameter_mm: 90.0, relief_depth_mm: 18.0, thickness_mm: 1.1,
  layer_count: 7, petal_count_base: 21, petal_density: 1.25,
  petal_length_ratio: 0.46, petal_width_ratio: 1.02, petal_overlap: 0.34,
  petal_curvature: 0.62, petal_cup: 0.45, petal_ruffle_amp: 0.24, dome_gain: 0.40,
  petal_ruffle_freq: 3.6, petal_notch: 0.16, layer_tilt_gain: 0.62,
  center_diameter_ratio: 0.22, center_dome_height: 0.30, center_floret_rings: 5,
  base_disc_ratio: 0.40, base_thickness_mm: 1.8,
  organic_variation: 0.35, seed: 20260916,
  petal_segments_u: 18, petal_segments_v: 11,
};

export const SPLIT_DEFAULTS = {
  type: 's_river', position: 0.0, orientation_deg: 0.0,
  amplitude: 0.30, smoothness: 0.65, control_points: null,
  organic_octaves: 3, organic_roughness: 0.45, organic_seed: 7,
  separation_mm: 14.0, boundary_tolerance_mm: 0.05, cap_boundary: true,
};

export function layerSchedule(cfg) {
  const R = cfg.diameter_mm * 0.5 * MM;
  const relief = cfg.relief_depth_mm * MM;
  const centerR = cfg.center_diameter_ratio * R;
  const L = Math.max(1, cfg.layer_count | 0);
  const outerLen = cfg.petal_length_ratio * R;
  // The outer row must reach the nominal radius, allowing for the fact that a
  // curled petal does not project its full length radially.
  const rOuter = Math.max(centerR * 1.05, R - outerLen * 0.88);

  const layers = [];
  for (let i = 0; i < L; i++) {
    const f = i / Math.max(1, L - 1);            // 0 outer -> 1 inner
    let r = rOuter * (1 - f) + centerR * 1.02 * f;
    r = r * (1.0 - cfg.petal_overlap * 0.16 * f);
    const length = outerLen * (1.0 - 0.40 * Math.pow(f, 1.1));
    const circumferenceFactor = 0.55 + 0.45 * (r / Math.max(rOuter, 1e-6));
    const count = Math.max(5, Math.round(cfg.petal_count_base * cfg.petal_density * circumferenceFactor));
    const slot = 2 * Math.PI * Math.max(r, 1e-6) / count;
    const width = slot * cfg.petal_width_ratio * (1.0 + cfg.petal_overlap);
    // Outer rows lie flat; inner rows stand up. Curling the outer row is what
    // turns the flower into a bowl.
    const tilt = (4.0 * Math.PI / 180) + cfg.layer_tilt_gain * (62.0 * Math.PI / 180) * Math.pow(f, 0.95);
    const curl = cfg.petal_curvature * (0.28 + 0.72 * Math.pow(f, 0.85));
    const z = relief * cfg.dome_gain * Math.pow(f, 1.15);
    // Golden increment so rows never re-align at any depth.
    const phase = (Math.PI / count) * (i % 2) + i * 2 * Math.PI * 0.381966 / Math.max(count, 1);
    layers.push({ index: i, radius: r, count, length, width, tilt, curl, z, phase, f });
  }
  return layers;
}

export function buildMasterFlower(cfg, onProgress) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const R = cfg.diameter_mm * 0.5 * MM;
  const relief = cfg.relief_depth_mm * MM;
  const thickness = cfg.thickness_mm * MM;
  const rng = makeRng(cfg.seed >>> 0);
  const layers = layerSchedule(cfg);
  const parts = [];

  // The disc has to reach past the outermost petal roots, otherwise the outer
  // row is physically unattached and each half falls apart.
  const outerRoot = Math.max(...layers.map((l) => l.radius));
  const baseR = Math.max(cfg.base_disc_ratio * R, outerRoot * 1.07);
  const rootR = Float64Array.from(layers.map((l) => l.radius).reverse());
  const rootZ = Float64Array.from(layers.map((l) => l.z).reverse());
  parts.push(buildBaseDisc(baseR, cfg.base_thickness_mm * MM, relief * 0.16, 96, 18,
                           [rootR, rootZ]));
  if (onProgress) onProgress('base disc built', 1, layers.length + 3);

  let totalPetals = 0;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    for (let k = 0; k < layer.count; k++) {
      const ang = layer.phase + 2 * Math.PI * k / layer.count;
      const jitter = cfg.organic_variation;
      const dAng = rng.normal(0, 0.30 / layer.count * 2 * Math.PI) * jitter;
      const dLen = 1.0 + rng.normal(0, 0.11) * jitter;
      const dWid = 1.0 + rng.normal(0, 0.10) * jitter;
      const dTilt = rng.normal(0, 7.0 * Math.PI / 180) * jitter;
      const dCurl = 1.0 + rng.normal(0, 0.16) * jitter;
      const twist = rng.normal(0, 0.28) * jitter;
      const phase = rng.uniform(0, 2 * Math.PI);

      let petal = buildPetal({
        length: layer.length * Math.max(0.45, dLen),
        width: layer.width * Math.max(0.45, dWid),
        thickness,
        segmentsU: cfg.petal_segments_u,
        segmentsV: cfg.petal_segments_v,
        curl: clamp(layer.curl * dCurl, 0, 1.3),
        cup: cfg.petal_cup,
        ruffleAmp: cfg.petal_ruffle_amp,
        ruffleFreq: cfg.petal_ruffle_freq,
        notch: cfg.petal_notch,
        twist,
        tilt: layer.tilt + dTilt,
        phase,
        partId: petalPartId(li, k),
        name: 'petal_L' + li + '_' + k,
      });
      petal = rotatedZ(translated(petal, [layer.radius, 0, layer.z]), ang + dAng);
      parts.push(petal);
      totalPetals++;
    }
    if (onProgress) onProgress('petal row ' + (li + 1) + '/' + layers.length + ' (' + layer.count + ' petals)', li + 2, layers.length + 3);
  }

  const centerR = cfg.center_diameter_ratio * R;
  if (centerR > 1e-4) {
    let centre = buildCenter(centerR, relief * cfg.center_dome_height, cfg.center_floret_rings, 56);
    parts.push(translated(centre, [0, 0, relief * cfg.dome_gain]));
  }
  if (onProgress) onProgress('centre built', layers.length + 2, layers.length + 3);

  const { mesh: m, bodies } = concat(parts, 'master_flower');
  const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const b = meshBounds(m);
  const stats = {
    verts: m.nVerts, faces: m.nFaces,
    area: meshArea(m), volume: meshVolume(m),
    petal_count: totalPetals, layer_count: layers.length,
    diameter_mm: Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) / MM,
    height_mm: (b[1][2] - b[0][2]) / MM,
    build_seconds: dt / 1000,
  };
  if (onProgress) onProgress('master flower complete: ' + totalPetals + ' petals, ' + m.nFaces + ' triangles', layers.length + 3, layers.length + 3);
  return { mesh: m, bodies, layers, stats };
}

/* ------------------------------------------------------------------ *
 * Split paths.
 *
 * Every path is x = f(y) -- a function of y, never an arbitrary parametric
 * curve. That restriction is what guarantees the path divides the plane into
 * exactly two simply-connected regions, so sign(x - f(y)) is a sound two-way
 * classifier with no self-intersection ambiguity.
 * ------------------------------------------------------------------ */
const PATH_SAMPLES = 512;

/* Catmull-Rom interpolation of x over a strictly increasing y. Interpolating
 * in y keeps the result a function of y by construction. */
function catmullRom1D(ys, xs, query, tension) {
  const n = ys.length;
  if (n < 3) {
    const out = new Float64Array(query.length);
    for (let i = 0; i < query.length; i++) out[i] = interpSorted(query[i], ys, xs);
    return out;
  }
  // Phantom endpoints so the first and last spans are shaped, not linear.
  const Y = new Float64Array(n + 2), X = new Float64Array(n + 2);
  Y[0] = 2 * ys[0] - ys[1]; X[0] = 2 * xs[0] - xs[1];
  for (let i = 0; i < n; i++) { Y[i + 1] = ys[i]; X[i + 1] = xs[i]; }
  Y[n + 1] = 2 * ys[n - 1] - ys[n - 2]; X[n + 1] = 2 * xs[n - 1] - xs[n - 2];

  const out = new Float64Array(query.length);
  for (let k = 0; k < query.length; k++) {
    const q = clamp(query[k], ys[0], ys[n - 1]);
    // searchsorted(ys, q, 'right') - 1, clipped to [0, n-2]
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ys[mid] <= q) lo = mid + 1; else hi = mid; }
    const idx = clamp(lo - 1, 0, n - 2);
    const i = idx + 1;
    const y0 = Y[i], y1 = Y[i + 1];
    const span = (y1 - y0) === 0 ? 1.0 : (y1 - y0);
    const t = (q - y0) / span;
    const p0 = X[i - 1], p1 = X[i], p2 = X[i + 1], p3 = X[i + 2];
    const m1 = tension * (p2 - p0), m2 = tension * (p3 - p1);
    const t2 = t * t, t3 = t2 * t;
    out[k] = (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1
           + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
  }
  return out;
}

export function buildSplitPath(cfg, radius) {
  // The path is extended well beyond the flower so every triangle is classified.
  const extent = radius * 1.35;
  const y = linspace(-extent, extent, PATH_SAMPLES);
  const pos = cfg.position * radius;
  const tension = 0.12 + 0.83 * cfg.smoothness;
  let x, kind;

  if (cfg.control_points && cfg.control_points.length >= 2) {
    const cys = Float64Array.from(cfg.control_points, (p) => p.y * extent);
    const cxs = Float64Array.from(cfg.control_points, (p) => p.x * radius);
    x = catmullRom1D(cys, cxs, y, tension);
    kind = cfg.type + ':custom';
  } else if (cfg.type === 'balanced') {
    // Straight, or gently sheared by a small fraction of the amplitude.
    x = new Float64Array(PATH_SAMPLES);
    for (let i = 0; i < PATH_SAMPLES; i++) x[i] = pos + (cfg.amplitude * 0.30 * radius) * (y[i] / extent);
    kind = 'balanced';
  } else if (cfg.type === 's_river') {
    // A single river meander: swing to one bank, cross, swing to the other.
    const amp = cfg.amplitude * radius;
    const cys = Float64Array.from([-1.0, -0.55, 0.0, 0.55, 1.0], (v) => v * extent);
    const cxs = Float64Array.from([0.0, -1.0, 0.0, 1.0, 0.0], (v) => pos + v * amp);
    x = catmullRom1D(cys, cxs, y, tension);
    kind = 's_river';
  } else if (cfg.type === 'organic') {
    // A gentler spine, plus seeded fractal wander that makes the division
    // irregular and asymmetric rather than merely wavy.
    // A deliberate gesture first, texture second: one long dominant sweep
    // answered by a shorter counter-curve, placed off-centre so the halves are
    // unequal on purpose. The wander is subordinate to that and enveloped to
    // nothing at both ends, so the curve meets the silhouette at two clean
    // points instead of fraying across it.
    const amp = cfg.amplitude * radius;
    const cys = Float64Array.from([-1.0, -0.52, 0.06, 0.62, 1.0], (v) => v * extent);
    const cxs = Float64Array.from([0.28, -0.92, -0.10, 0.74, 0.30], (v) => pos + v * amp);
    const spine = catmullRom1D(cys, cxs, y, tension);
    x = new Float64Array(PATH_SAMPLES);
    for (let i = 0; i < PATH_SAMPLES; i++) {
      const yn = y[i] / extent;
      const envelope = Math.pow(Math.sin(clamp((yn + 1) * 0.5, 0, 1) * Math.PI), 0.75);
      const noise = valueNoise1D(yn * 1.15 + 3.0, cfg.organic_seed,
        Math.max(1, cfg.organic_octaves - 1),
        0.28 + 0.34 * cfg.organic_roughness, 1.15);
      x[i] = spine[i] + noise * amp * envelope * (0.16 + 0.30 * cfg.organic_roughness);
    }
    kind = 'organic';
  } else {
    throw new Error('unknown split type ' + cfg.type);
  }

  const arc = new Float64Array(PATH_SAMPLES);
  for (let i = 1; i < PATH_SAMPLES; i++) {
    const dx = x[i] - x[i - 1], dy = y[i] - y[i - 1];
    arc[i] = arc[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return {
    y, x, arclength: arc, kind, extent, orientation_deg: 0.0,
    f(q) { return interpSorted(q, this.y, this.x); },
    tOfY(q) { return interpSorted(q, this.y, this.arclength); },
    /* Average in-plane normal -- the separation direction. */
    meanNormal() {
      const n = this.y.length;
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) {
        const im = i === 0 ? 0 : i - 1, ip = i === n - 1 ? n - 1 : i + 1;
        const s = (i === 0 || i === n - 1) ? 1.0 : 0.5;
        const dy = (this.y[ip] - this.y[im]) * s;
        const dx = (this.x[ip] - this.x[im]) * s;
        const L = Math.hypot(dy, dx);
        if (L > 1e-12) { mx += dy / L; my += -dx / L; }
      }
      mx /= n; my /= n;
      const L = Math.hypot(mx, my);
      return L > 1e-9 ? [mx / L, my / L] : [1, 0];
    },
  };
}

/* ------------------------------------------------------------------ *
 * The split kernel.
 *
 * Exact per-triangle clipping against the vertical surface swept by the path.
 * No CSG, no booleans. Crossing vertices are computed once per undirected edge
 * and shared, which makes the two cut boundaries complementary by construction
 * rather than by luck. The master is a collection of disjoint closed solids,
 * and the kernel splits one body at a time: a cut through a single petal
 * yields simple loops that cap reliably.
 * ------------------------------------------------------------------ */

/* Sutherland-Hodgman clip of a polygon against the half-space s >= 0. */
function clipPolygon(idx, s, keepPositive, crossings, pool, eps) {
  const sign = keepPositive ? 1 : -1;
  const out = [];
  const n = idx.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = s[i] * sign, sj = s[j] * sign;
    const vi = idx[i], vj = idx[j];
    if (si >= -eps) out.push(vi);
    if ((si > eps && sj < -eps) || (si < -eps && sj > eps)) {
      const a = vi < vj ? vi : vj, b = vi < vj ? vj : vi;
      const key = a * 4294967296 + b;
      let hit = crossings.get(key);
      if (hit === undefined) {
        // Interpolate in a canonical direction so clipping the same edge from
        // the other side returns a bitwise-identical point.
        const sa = (vi === a) ? s[i] : s[j];
        const sb = (vi === a) ? s[j] : s[i];
        const denom = sa - sb;
        const t = Math.abs(denom) < 1e-30 ? 0 : clamp(sa / denom, 0, 1);
        hit = pool.length / 3;
        for (let k = 0; k < 3; k++) {
          const pa = pool[a * 3 + k], pb = pool[b * 3 + k];
          pool.push(pa + (pb - pa) * t);
        }
        crossings.set(key, hit);
      }
      out.push(hit);
    }
  }
  const dedup = [];
  for (let k = 0; k < out.length; k++) {
    if (out[k] !== out[(k - 1 + out.length) % out.length]) dedup.push(out[k]);
  }
  return dedup.length >= 3 ? dedup : [];
}

/* Edges used by exactly one face -- the open boundary. */
export function boundaryEdges(faceList, stride) {
  const counts = new Map();
  const n = faceList.length;
  for (let f = 0; f < n; f += stride) {
    const tri = stride === 3 ? [faceList[f], faceList[f + 1], faceList[f + 2]] : faceList[f];
    for (let e = 0; e < 3; e++) {
      const x = tri[e], y = tri[(e + 1) % 3];
      const key = x < y ? x * 4294967296 + y : y * 4294967296 + x;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const out = [];
  for (const [key, c] of counts) {
    if (c === 1) out.push([Math.floor(key / 4294967296), key % 4294967296]);
  }
  return out;
}

/* Break a chain that revisits a vertex into simple cycles.
 *
 * Petal tips and the centre dome apex are cone points: many grid vertices weld
 * to one. A cut through such a point makes two loops meet there, and the walk
 * traces them as a single figure-eight, which ear-clips into a cap whose
 * outline is not the hole's outline -- leaving the piece open. */
function splitSelfTouching(chain) {
  const out = [];
  const stack = [];
  const seen = new Map();
  for (const v of chain) {
    if (seen.has(v)) {
      const start = seen.get(v);
      const cycle = stack.slice(start);
      if (cycle.length >= 3) out.push(cycle);
      for (const w of stack.slice(start)) seen.delete(w);
      stack.length = start;
    }
    seen.set(v, stack.length);
    stack.push(v);
  }
  if (stack.length >= 3) out.push(stack.slice());
  return out;
}

/* Chain undirected boundary edges into simple closed loops. */
export function chainLoops(edges) {
  const adj = new Map();
  const unused = new Set();
  for (const [a, b] of edges) {
    if (a === b) continue;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
    unused.add(a < b ? a * 4294967296 + b : b * 4294967296 + a);
  }
  const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  function step(cur, prev) {
    const cands = adj.get(cur);
    if (!cands) return null;
    for (const cand of cands) {
      if (cand === prev) continue;
      const k = ekey(cur, cand);
      if (unused.has(k)) { unused.delete(k); return cand; }
    }
    return null;
  }
  const loops = [];
  while (unused.size) {
    const key = unused.values().next().value;
    unused.delete(key);
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    const chain = [a, b];
    let closed = false;
    for (;;) {
      const nxt = step(chain[chain.length - 1], chain[chain.length - 2]);
      if (nxt === null) break;
      if (nxt === chain[0]) { closed = true; break; }
      chain.push(nxt);
    }
    if (!closed) {
      for (;;) {
        const nxt = step(chain[0], chain.length > 1 ? chain[1] : null);
        if (nxt === null) break;
        if (nxt === chain[chain.length - 1]) { closed = true; break; }
        chain.unshift(nxt);
      }
    }
    if (chain.length >= 3) {
      for (const simple of splitSelfTouching(chain)) loops.push([simple, closed]);
    }
  }
  return loops;
}

/* Ear-clipping triangulation of a simple polygon given as flat (x, y) pairs.
 *
 * When no strictly valid ear exists the largest convex candidate is clipped
 * anyway: cut cross-sections through thin petals are sliver-like, and a purely
 * strict test stalls on them, leaving a partly triangulated cap -- which is a
 * hole in the piece. */
export function earclip(poly) {
  const n = poly.length / 2;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = poly[i * 2], y = poly[i * 2 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!(scale > 0)) return [];
  const tol = 1e-10 * scale * scale;

  const cross = (o, a, b) => (poly[a * 2] - poly[o * 2]) * (poly[b * 2 + 1] - poly[o * 2 + 1])
                           - (poly[a * 2 + 1] - poly[o * 2 + 1]) * (poly[b * 2] - poly[o * 2]);
  const strictlyInside = (a, b, c, p) =>
    cross(a, b, p) > tol && cross(b, c, p) > tol && cross(c, a, p) > tol;

  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const tris = [];
  while (idx.length > 3) {
    let best = null, convexBest = null, anyBest = null;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k - 1 + idx.length) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      const conv = cross(a, b, c);
      if (anyBest === null || Math.abs(conv) > anyBest[0]) anyBest = [Math.abs(conv), k, [a, b, c]];
      if (conv <= tol) continue;
      if (convexBest === null || conv > convexBest[0]) convexBest = [conv, k, [a, b, c]];
      let blocked = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (strictlyInside(a, b, c, p)) { blocked = true; break; }
      }
      if (blocked) continue;
      best = [k, [a, b, c]];
      break;
    }
    let k, tri;
    if (best !== null) { k = best[0]; tri = best[1]; }
    else if (convexBest !== null) { k = convexBest[1]; tri = convexBest[2]; }
    else if (anyBest !== null) {
      // Nothing convex left: the remainder is a near-collinear sliver. Clip the
      // least degenerate corner anyway -- the triangle it emits has almost no
      // area, but stopping here would leave a real hole in the piece.
      k = anyBest[1]; tri = anyBest[2];
    } else break;
    tris.push(tri);
    idx.splice(k, 1);
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/* Triangulate the open boundary of a clipped body on the flattened cut wall.
 * The cut runs along a ruled vertical surface, which is developable, so it
 * flattens exactly to 2-D as (arclength, z). */
function capFaces(pool, faces, path, outwardSign) {
  const stats = { caps: 0, cap_triangles: 0, open_chains: 0, loops: 0 };
  if (!faces.length) return [[], stats];
  const edges = boundaryEdges(faces, 1);
  if (!edges.length) return [[], stats];
  const loops = chainLoops(edges);
  stats.loops = loops.length;
  const newFaces = [];
  for (const [loop, closed] of loops) {
    if (!closed) { stats.open_chains++; continue; }
    const poly2 = new Float64Array(loop.length * 2);
    for (let i = 0; i < loop.length; i++) {
      poly2[i * 2] = path.tOfY(pool[loop[i] * 3 + 1]);
      poly2[i * 2 + 1] = pool[loop[i] * 3 + 2];
    }
    let tris = earclip(poly2);
    if (!tris.length) { stats.open_chains++; continue; }
    // chainLoops walks the boundary undirected, so a loop comes back in an
    // arbitrary rotational direction and some caps would be wound backwards.
    // Decide the facing once per cap from its area-weighted normal: a single
    // sliver is too noisy to trust. An inverted cap renders as a hole and makes
    // the piece's volume wrong, and it is invisible to a check that only tests
    // volume(A) + volume(B) against the master, because the two pieces' caps
    // are exact negatives and the error cancels in the sum.
    let nx = 0;
    for (const [a, b, c] of tris) {
      const ia = loop[a] * 3, ib = loop[b] * 3, ic = loop[c] * 3;
      const uy = pool[ib + 1] - pool[ia + 1], uz = pool[ib + 2] - pool[ia + 2];
      const vy = pool[ic + 1] - pool[ia + 1], vz = pool[ic + 2] - pool[ia + 2];
      nx += uy * vz - uz * vy;
    }
    if (nx * outwardSign < 0) tris = tris.map(([a, b, c]) => [c, b, a]);
    for (const [a, b, c] of tris) newFaces.push([loop[a], loop[b], loop[c]]);
    stats.caps++;
  }
  stats.cap_triangles = newFaces.length;
  return [newFaces, stats];
}

export function splitFlower(master, bodies, cfg, radius, onProgress, eps = 1e-9) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // An angled split is handled by rotating into the split's own frame, cutting
  // there, and rotating back -- so no special-casing is needed.
  const theta = cfg.orientation_deg * Math.PI / 180;
  const work = Math.abs(theta) > 1e-9 ? rotatedZ(master, -theta) : master;

  if (onProgress) onProgress('building split path', 1, 5);
  const path = buildSplitPath(cfg, radius);

  const V = work.verts;
  const nv = work.nVerts;
  const sAll = new Float64Array(nv);
  for (let i = 0; i < nv; i++) sAll[i] = V[i * 3] - path.f(V[i * 3 + 1]);

  // Symbolic perturbation: if the path runs exactly through a mesh vertex,
  // several cut segments meet at one point and the boundary loops stop being
  // simple. A sub-micron nudge removes the coincidence -- far below any
  // manufacturing tolerance, and it does not move the visible boundary.
  let nudge = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    let hit = false;
    for (let i = 0; i < nv; i++) { if (Math.abs(sAll[i] - nudge) < 1e-7) { hit = true; break; } }
    if (!hit) break;
    nudge = 1.3e-5 * (attempt + 1);
  }
  if (nudge !== 0) for (let i = 0; i < nv; i++) sAll[i] -= nudge;

  if (onProgress) onProgress('clipping ' + work.nFaces + ' triangles across ' + bodies.length + ' bodies', 2, 5);

  const meshesA = [], meshesB = [];
  let nClippedBodies = 0, nClippedTris = 0;
  const capStats = { caps: 0, cap_triangles: 0, open_chains: 0, loops: 0 };
  const F = work.faces;
  const stamp = new Int32Array(nv);
  let gen = 0;

  for (const body of bodies) {
    gen++;
    // Vertices actually referenced by this body's faces, in ascending order.
    for (let f = body.faceStart; f < body.faceEnd; f++) {
      stamp[F[f * 3]] = gen; stamp[F[f * 3 + 1]] = gen; stamp[F[f * 3 + 2]] = gen;
    }
    const used = [];
    const remap = new Map();
    for (let i = body.vertStart; i < body.vertEnd; i++) {
      if (stamp[i] === gen) { remap.set(i, used.length); used.push(i); }
    }
    const nb = used.length;
    const bverts = new Float64Array(nb * 3);
    const bs = new Float64Array(nb);
    let allPos = true, allNeg = true;
    for (let i = 0; i < nb; i++) {
      const s = used[i] * 3;
      bverts[i * 3] = V[s]; bverts[i * 3 + 1] = V[s + 1]; bverts[i * 3 + 2] = V[s + 2];
      bs[i] = sAll[used[i]];
      if (!(bs[i] > eps)) allPos = false;
      if (!(bs[i] < -eps)) allNeg = false;
    }
    const nf = body.faceEnd - body.faceStart;
    const bf = new Int32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      for (let k = 0; k < 3; k++) bf[f * 3 + k] = remap.get(F[(body.faceStart + f) * 3 + k]);
    }

    if (allPos || allNeg) {
      const m = mesh(bverts, bf, new Int32Array(nf).fill(body.partId));
      (allPos ? meshesA : meshesB).push(m);
      continue;
    }

    nClippedBodies++;
    // ---- clip this body ------------------------------------------------
    const pool = Array.from(bverts);
    const crossings = new Map();
    const facesA = [], facesB = [];
    for (let f = 0; f < nf; f++) {
      const tri = [bf[f * 3], bf[f * 3 + 1], bf[f * 3 + 2]];
      const ss = [bs[tri[0]], bs[tri[1]], bs[tri[2]]];
      let anyPos = false, anyNeg = false;
      for (let k = 0; k < 3; k++) { if (ss[k] > eps) anyPos = true; if (ss[k] < -eps) anyNeg = true; }
      if (!anyNeg) { facesA.push(tri); continue; }
      if (!anyPos) { facesB.push(tri); continue; }
      nClippedTris++;
      for (const [keepPositive, bucket] of [[true, facesA], [false, facesB]]) {
        const poly = clipPolygon(tri, ss, keepPositive, crossings, pool, eps);
        for (let k = 1; k < poly.length - 1; k++) bucket.push([poly[0], poly[k], poly[k + 1]]);
      }
    }
    const poolArr = Float64Array.from(pool);

    // Piece A is the region s > 0, so at the cut its material faces toward -x
    // in the split frame; piece B is the mirror of that.
    for (const [faceList, bucket, outward] of [[facesA, meshesA, -1], [facesB, meshesB, 1]]) {
      if (!faceList.length) continue;
      let faces = faceList;
      const pidList = new Array(faceList.length).fill(body.partId);
      if (cfg.cap_boundary) {
        const [caps, st] = capFaces(poolArr, faceList, path, outward);
        for (const k of ['caps', 'cap_triangles', 'open_chains', 'loops']) capStats[k] += st[k];
        if (caps.length) {
          faces = faceList.concat(caps);
          for (let i = 0; i < caps.length; i++) pidList.push(PART_BOUNDARY);
        }
      }
      // compact to the vertices this piece actually uses
      const seen = new Map();
      const outF = new Int32Array(faces.length * 3);
      const outVerts = [];
      for (let i = 0; i < faces.length; i++) {
        for (let k = 0; k < 3; k++) {
          const v = faces[i][k];
          let nvIdx = seen.get(v);
          if (nvIdx === undefined) {
            nvIdx = outVerts.length / 3;
            seen.set(v, nvIdx);
            outVerts.push(poolArr[v * 3], poolArr[v * 3 + 1], poolArr[v * 3 + 2]);
          }
          outF[i * 3 + k] = nvIdx;
        }
      }
      bucket.push(mesh(Float64Array.from(outVerts), outF, Int32Array.from(pidList)));
    }
  }

  if (onProgress) onProgress('capping ' + nClippedBodies + ' divided bodies', 3, 5);

  // Make the winding globally consistent before handing the pieces back.
  // Orienting each cap by its area-weighted normal gets the net facing right,
  // which is what a volume check sees, but it does not guarantee every cap
  // triangle agrees with the surface it seals along their shared edge:
  // measured on the shipped flower, 52 directed edges out of ~690,000 were
  // traversed the same way by both faces, putting the reported volume out by
  // 0.04% and making an exact boolean kernel reject the mesh outright.
  let pieceA = orient(concat(meshesA, 'piece_a').mesh);
  let pieceB = orient(concat(meshesB, 'piece_b').mesh);

  if (Math.abs(theta) > 1e-9) {
    pieceA = rotatedZ(pieceA, theta);
    pieceB = rotatedZ(pieceB, theta);
    // The path stays in the split frame; record the rotation so anything
    // testing world-space points can get back here.
    path.orientation_deg = cfg.orientation_deg;
  }
  if (onProgress) onProgress('split complete', 4, 5);

  const metadata = {
    triangles_in: master.nFaces,
    bodies_total: bodies.length,
    bodies_divided: nClippedBodies,
    triangles_clipped: nClippedTris,
    path_perturbation: nudge,
    boundary_loops: capStats.loops,
    caps_built: capStats.caps,
    cap_triangles: capStats.cap_triangles,
    cap_failures: capStats.open_chains,
    residual_open_edges_a: boundaryEdges(pieceA.faces, 3).length,
    residual_open_edges_b: boundaryEdges(pieceB.faces, 3).length,
    split_seconds: ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 1000,
    path_kind: path.kind,
    orientation_deg: cfg.orientation_deg,
  };
  return { pieceA, pieceB, path, master, metadata };
}

/* The two pieces moved apart for the exploded view. */
export function separated(result, distance) {
  const n = result.path.meanNormal();
  const t = result.path.orientation_deg * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const nx = n[0] * c - n[1] * s, ny = n[0] * s + n[1] * c;
  const off = [nx * distance * 0.5, ny * distance * 0.5, 0];
  return [translated(result.pieceA, off), translated(result.pieceB, [-off[0], -off[1], 0])];
}

/* ------------------------------------------------------------------ *
 * One job: master flower -> split -> render-ready buffers.
 *
 * Face order is grouped so the cut wall can be drawn in its own material --
 * that is how the viewport shows the division as real geometry rather than a
 * painted line. Shared by the worker and the main-thread fallback.
 * ------------------------------------------------------------------ */
function packPiece(m) {
  const pos = new Float32Array(m.verts.length);
  for (let i = 0; i < m.verts.length; i++) pos[i] = m.verts[i];
  const flowerIdx = [], wallIdx = [];
  for (let f = 0; f < m.nFaces; f++) {
    const dst = m.parts[f] >= PART_BOUNDARY ? wallIdx : flowerIdx;
    dst.push(m.faces[f * 3], m.faces[f * 3 + 1], m.faces[f * 3 + 2]);
  }
  return {
    pos, flowerIdx: Uint32Array.from(flowerIdx), wallIdx: Uint32Array.from(wallIdx),
    volume: meshVolume(m), faces: m.nFaces, verts: m.nVerts,
  };
}

export function generateDesign(flower, split, onProgress) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const r = buildMasterFlower(flower, onProgress);
  const flowerMs = now() - t0;

  const radius = flower.diameter_mm * 0.5 * MM;
  const t1 = now();
  const s = splitFlower(r.mesh, r.bodies, split, radius, onProgress);
  const splitMs = now() - t1;

  const A = packPiece(s.pieceA);
  const B = packPiece(s.pieceB);
  const masterVol = meshVolume(r.mesh);

  // The dividing curve in world space, drawn at the rosette's crown.
  const th = s.path.orientation_deg * Math.PI / 180;
  const c = Math.cos(th), sn = Math.sin(th);
  const n = s.path.y.length;
  const curve = new Float32Array(n * 3);
  const zTop = flower.relief_depth_mm * MM * 0.62;
  for (let i = 0; i < n; i++) {
    const x = s.path.x[i], y = s.path.y[i];
    curve[i * 3] = x * c - y * sn;
    curve[i * 3 + 1] = x * sn + y * c;
    curve[i * 3 + 2] = zTop;
  }
  const mn = s.path.meanNormal();
  const sepDir = [mn[0] * c - mn[1] * sn, mn[0] * sn + mn[1] * c];
  const bounds = meshBounds(r.mesh);

  const metrics = {
    petals: r.stats.petal_count, rows: r.stats.layer_count,
    diameter_mm: r.stats.diameter_mm, height_mm: r.stats.height_mm,
    triangles: r.mesh.nFaces, triangles_a: A.faces, triangles_b: B.faces,
    volume_master: masterVol, volume_a: A.volume, volume_b: B.volume,
    bodies_a: countBodies(s.pieceA), bodies_b: countBodies(s.pieceB),
    bodies_master: r.bodies.length,
    volume_error_pct: Math.abs(A.volume + B.volume - masterVol) / Math.abs(masterVol) * 100,
    balance: A.volume / (A.volume + B.volume),
    open_edges_a: s.metadata.residual_open_edges_a,
    open_edges_b: s.metadata.residual_open_edges_b,
    cap_failures: s.metadata.cap_failures, caps_built: s.metadata.caps_built,
    bodies_total: s.metadata.bodies_total, bodies_divided: s.metadata.bodies_divided,
    triangles_clipped: s.metadata.triangles_clipped,
    cap_triangles: s.metadata.cap_triangles,
    path_perturbation_mm: s.metadata.path_perturbation / MM,
    path_kind: s.metadata.path_kind,
    flower_ms: flowerMs, split_ms: splitMs,
    radius_scene: Math.max(bounds[1][0], bounds[1][1], -bounds[0][0], -bounds[0][1]),
    height_scene: bounds[1][2] - bounds[0][2],
  };
  return { A, B, curve, sepDir, metrics };
}
