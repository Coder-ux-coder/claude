/**
 * Parity test: the browser analyser vs the Python pipeline.
 *
 * Two implementations of one method is a liability. This generates voices in
 * Python, writes them to WAV, analyses each file with BOTH implementations,
 * and asserts they agree.
 *
 * This is the test that earned its keep during development: it is what proved
 * the browser DSP was correct while the browser's *demo synthesiser* was not,
 * which is a distinction no single-implementation test could have drawn.
 *
 *   node tests/parity.js
 *
 * Requires python3 with numpy/scipy/soundfile, and playwright.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vgparity-'));

// Two comparisons, because there are two different questions.
//
//   PORT FIDELITY -- browser vs Python's own LPC path. Same algorithm, so
//   agreement should be tight. This is what catches a mistranslated port.
//
//   ALGORITHM DIFFERENCE -- browser vs Python's default Praat/Burg tracker.
//   Genuinely different estimators, so they are allowed to differ, and F1 is
//   where they differ most: it is vowel-dependent and biased low at high F0
//   where sparse harmonics leave the fit chasing harmonic peaks. That is the
//   documented reason F1 carries only 0.03 scoring weight and 0.10 of the VTL
//   pooling. Holding it to a tight tolerance here would assert an agreement
//   the two methods do not actually have.
const TOL_LPC   = { f0: 2.0, F1: 3.0, F2: 3.0, F3: 3.0, F4: 3.0, vtl: 3.0 };
const TOL_PRAAT = { f0: 2.0, F1: 8.0, F2: 4.0, F3: 4.0, F4: 4.0, vtl: 5.0 };

const CASES = [
  ['male_typical',    120, [500, 1500, 2540, 3450], 0.02],
  ['female_typical',  210, [590, 1720, 2980, 4020], 0.13],
  ['male_high_pitch', 175, [505, 1510, 2560, 3480], 0.03],
  ['female_low',      168, [585, 1710, 2960, 3990], 0.14],
];

const PY = `
import sys, json, numpy as np, soundfile as sf
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, '.claude/skills/voice-gender/scripts'))})
from selfcheck import synth_voice
import extract_features as ef

def measure(p):
    r = ef.analyse(p)
    return {"f0": r["pitch"]["f0_mean_hz"],
            "F": [r["resonance"][f"f{k}_hz"] for k in (1, 2, 3, 4)],
            "vtl": r["resonance"]["vtl_estimate_cm"],
            "engine": r["engines"]["formants"]}

out = {}
for name, f0, F, br in ${JSON.stringify(CASES)}:
    x = synth_voice(f0, F, dur=3.0, breath=br, seed=f0)
    p = ${JSON.stringify(TMP)} + "/" + name + ".wav"
    sf.write(p, (x / max(abs(x).max(), 1e-9) * 0.9).astype("float32"), 16000)
    had = ef.HAVE_PRAAT
    ef.HAVE_PRAAT = False
    lpc = measure(p)                 # the algorithm the browser implements
    ef.HAVE_PRAAT = had
    praat = measure(p)               # the pipeline's production default
    out[name] = {"path": p, "lpc": lpc, "praat": praat}
print(json.dumps(out))
`;

function serve() {
  return new Promise(res => {
    const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav' };
    const s = http.createServer((rq, rs) => {
      const rel = decodeURIComponent(rq.url.split('?')[0]);
      if (rel === '/favicon.ico') { rs.writeHead(204); return rs.end(); }
      const p = rel.startsWith('/audio/') ? path.join(TMP, rel.slice(7)) : path.join(ROOT, rel);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { rs.writeHead(404); return rs.end(); }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rs);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

(async () => {
  console.log('='.repeat(78));
  console.log('  PARITY: browser analyser vs Python pipeline, identical audio');
  console.log('='.repeat(78));

  const py = JSON.parse(execFileSync('python3', ['-c', PY], { encoding: 'utf8', cwd: ROOT }));
  const first = Object.values(py)[0];
  console.log(`  python engines: lpc="${first.lpc.engine}"  praat="${first.praat.engine}"\n`);

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const EXEC = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.goto(`${base}/web/index.html`, { waitUntil: 'networkidle' });

  let pass = 0, fail = 0;
  const pct = (a, b) => (a && b) ? Math.abs(a - b) / Math.abs(b) * 100 : NaN;

  for (const [name] of CASES) {
    const js = await page.evaluate(async u => {
      const ab = await (await fetch(u)).arrayBuffer();
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(ab);
      const f = window.__vg.analyse(Float64Array.from(buf.getChannelData(0)), buf.sampleRate);
      return { f0: f.pitch.f0_mean_hz, F: [1, 2, 3, 4].map(k => f.resonance[`f${k}_hz`]),
               vtl: f.resonance.vtl_estimate_cm };
    }, `${base}/audio/${name}.wav`);
    const p = py[name];

    console.log(`  ${name}`);
    let bad = 0;
    for (const [mode, ref, tol] of [['LPC  (same algorithm)', py[name].lpc, TOL_LPC],
                                    ['PRAAT(production)    ', py[name].praat, TOL_PRAAT]]) {
      const checks = [['F0', js.f0, ref.f0, tol.f0], ['VTL', js.vtl, ref.vtl, tol.vtl],
        ...[0, 1, 2, 3].map(i => [`F${i + 1}`, js.F[i], ref.F[i], tol[`F${i + 1}`]])];
      const worst = checks.map(([l, a, b, t]) => ({ l, d: pct(a, b), t, a, b }))
        .filter(c => isFinite(c.d)).sort((x, y) => (y.d / y.t) - (x.d / x.t))[0];
      const failed = checks.filter(([, a, b, t]) => { const d = pct(a, b); return isFinite(d) ? d > t : false; });
      if (failed.length) bad++;
      console.log(`    vs ${mode}  worst: ${worst.l} Δ${worst.d.toFixed(2)}% (tol ${worst.t}%)`
        + `   ${failed.length ? 'FAIL: ' + failed.map(f => f[0]).join(',') : 'ok'}`);
      for (const [l, a, b, t] of checks) {
        const d = pct(a, b);
        console.log(`      ${l.padEnd(4)} js ${String(a ?? '—').padStart(8)}  py ${String(b ?? '—').padStart(8)}`
          + `  Δ ${(isFinite(d) ? d.toFixed(2) + '%' : '—').padStart(7)}  tol ${String(t).padStart(4)}%`
          + `  ${isFinite(d) && d > t ? 'FAIL' : ''}`);
      }
    }
    bad ? fail++ : pass++;
    console.log(`    -> ${bad ? 'FAIL' : 'PASS'}\n`);
  }

  console.log('='.repeat(78));
  console.log(`  RESULT   ${pass} passed, ${fail} failed`);
  console.log('='.repeat(78));
  await browser.close(); server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
