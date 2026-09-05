/**
 * Browser test for the web analyser.
 *
 * Loads the page in Chromium, drives every demo voice through the real
 * analysis path, and asserts the verdicts match what the Python pipeline
 * produces on the same synthetic voices. Also screenshots both themes so the
 * layout is inspected, not assumed.
 *
 *   node tests/web_test.js [--shots DIR]
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/favicon.ico') { rq.writeHead(204); return rq.end(); }
      const p = path.join(ROOT, rel);
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rq.writeHead(404); return rq.end(); }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rq);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

const CASES = [
  { demo: 'male',       expect: 'MALE',          note: 'canonical adult male, 120 Hz' },
  { demo: 'female',     expect: 'FEMALE',        note: 'canonical adult female, 210 Hz' },
  { demo: 'borderline', expect: 'MALE',          note: '175 Hz male inside the overlap band — resonance must carry it' },
  { demo: 'child',      expect: 'INDETERMINATE', note: 'pre-pubertal — the child gate must fire' },
];

(async () => {
  const shotsIdx = process.argv.indexOf('--shots');
  const shots = shotsIdx > -1 ? process.argv[shotsIdx + 1] : null;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/web/index.html`;
  // The environment ships Chromium at a fixed path; never download another.
  const EXEC = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .find(p => fs.existsSync(p));
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url, { waitUntil: 'networkidle' });
  console.log('='.repeat(74));
  console.log('  WEB ANALYSER TEST');
  console.log('='.repeat(74));

  let pass = 0, fail = 0;

  // priors must have survived the JS generation intact
  const pw = await page.evaluate(() => {
    const f = window.__vg.PRIORS.features;
    return { n: Object.keys(f).length, sum: Object.values(f).reduce((s, v) => s + v.weight, 0) };
  });
  const priorsOk = pw.n === 13 && Math.abs(pw.sum - 1) < 1e-9;
  console.log(`\n  priors loaded: ${pw.n} features, weights sum ${pw.sum.toFixed(6)}  ${priorsOk ? 'PASS' : 'FAIL'}`);
  priorsOk ? pass++ : fail++;

  console.log('\n  demo voices through the full in-browser analysis path');
  console.log('  ' + '-'.repeat(70));
  console.log(`  ${'case'.padEnd(13)}${'expect'.padStart(14)}${'got'.padStart(16)}${'p(female)'.padStart(11)}${'conf'.padStart(11)}`);
  console.log('  ' + '-'.repeat(70));

  for (const c of CASES) {
    await page.click(`[data-demo="${c.demo}"]`);
    await page.waitForFunction(() => window.__last !== undefined, { timeout: 60000 });
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => ({
      decision: window.__last.res.decision,
      p: window.__last.res.p_female,
      conf: window.__last.res.confidence,
      cov: window.__last.res.evidence_coverage,
      gates: window.__last.res.gates_triggered,
      rows: window.__last.res.rows.length,
      f0: window.__last.f.pitch.f0_mean_hz,
      vtl: window.__last.f.resonance.vtl_estimate_cm,
    }));
    const ok = r.decision === c.expect;
    ok ? pass++ : fail++;
    console.log(`  ${c.demo.padEnd(13)}${c.expect.padStart(14)}${r.decision.padStart(16)}`
      + `${(r.p ?? NaN).toFixed(3).padStart(11)}${String(r.conf).padStart(11)}   ${ok ? 'PASS' : 'FAIL'}`);
    console.log(`       ${c.note}`);
    console.log(`       F0 ${r.f0} Hz · VTL ${r.vtl} cm · ${r.rows} cues scored · coverage ${(r.cov * 100).toFixed(0)}%`
      + (r.gates.length ? ` · gates: ${r.gates.join(', ')}` : ''));

    // every chart must have actually drawn something
    const drawn = await page.evaluate(() => ['#gauge', '#ledger', '#pitch', '#formants']
      .map(s => [s, document.querySelector(s).childElementCount]));
    const empty = drawn.filter(([, n]) => n === 0);
    if (empty.length) { fail++; console.log(`       FAIL empty charts: ${empty.map(e => e[0]).join(', ')}`); }
    else pass++;
  }
  console.log('  ' + '-'.repeat(70));

  if (shots) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => {
        document.documentElement.setAttribute('data-theme', t);
        if (window.__last) window.dispatchEvent(new Event('resize'));
      }, theme);
      await page.click('[data-demo="borderline"]');
      await page.waitForTimeout(400);
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(250);
      const p = path.join(shots, `analyser-${theme}.png`);
      await page.screenshot({ path: p, fullPage: true });
      console.log(`  screenshot: ${p}`);
    }
  }

  // horizontal overflow is a hard fail -- the page must never scroll sideways
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const oOk = overflow <= 1;
  console.log(`\n  horizontal overflow: ${overflow}px  ${oOk ? 'PASS' : 'FAIL'}`);
  oOk ? pass++ : fail++;

  if (errors.length) { fail++; console.log('\n  PAGE ERRORS:'); errors.slice(0, 12).forEach(e => console.log('   ' + e)); }
  else { pass++; console.log('  no page errors  PASS'); }

  console.log('\n' + '='.repeat(74));
  console.log(`  RESULT   ${pass} passed, ${fail} failed`);
  console.log('='.repeat(74));

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
