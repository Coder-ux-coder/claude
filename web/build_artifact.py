#!/usr/bin/env python3
"""Generate the publishable artifact page from web/index.html.

The artifact host wraps the file in its own <!doctype>/<head>/<body>, serves it
from a single file with no siblings, and enforces a CSP. So the local page
cannot be published as-is; this applies the differences and nothing else, so
there is one source of truth rather than two pages drifting apart.

    python3 web/build_artifact.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web/index.html"
PRIORS_JS = ROOT / "web/priors.gen.js"
DST = ROOT / "web/artifact.html"

src = SRC.read_text()

title = re.search(r"<title>(.*?)</title>", src, re.S).group(1)
style = re.search(r"<style>(.*?)</style>", src, re.S).group(1)
body = re.search(r"<body>(.*?)</body>", src, re.S).group(1).strip()

# --- 1. No sibling files exist, so the module import must become a literal.
priors = PRIORS_JS.read_text()
priors = re.sub(r"^//.*$", "", priors, flags=re.M).strip()
priors = priors.replace("export const PRIORS =", "const PRIORS =")
body = body.replace(
    "<script type=\"module\">\nimport { PRIORS } from './priors.gen.js';",
    "<script type=\"module\">\n" + priors)
assert "priors.gen.js" not in body, "priors import survived"

# --- 2. Typography. IBM Plex was drawn for technical documentation and its
# sans/mono pair share a skeleton, which matters on a page where a hundred
# aligned numerals sit beside running prose. Google Fonts is the one font host
# the artifact CSP admits.
style = style.replace(
    '--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;',
    '--mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;')
style = style.replace(
    '--sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '--sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;')

# --- 3. Accessibility the local page did not need.
style += """
/* Keyboard focus must be visible on every control. */
button:focus-visible, .drop:focus-visible, summary:focus-visible {
  outline: 2px solid var(--male); outline-offset: 2px; border-radius: 6px;
}
@media (prefers-reduced-motion: reduce) {
  .rec.on .dot { animation: none; opacity: .8; }
  * { scroll-behavior: auto !important; }
}
.samplebar {
  display: flex; gap: 7px; align-items: baseline; flex-wrap: wrap;
  font-size: 12.5px; line-height: 1.6; color: var(--text-2);
  border-left: 2.5px solid var(--male); padding: 2px 0 2px 12px;
  margin: 16px 2px 0; max-width: 78ch;
}
.samplebar b { color: var(--text-1); font-weight: 600; }
"""

# --- 4. A tool must open in a working state. An upload prompt shows nothing;
# a real analysis on screen shows what the instrument does, and is what a
# thumbnail and a shared link capture.
body = body.replace(
    '<div id="empty" class="card empty">\n    Record or upload a voice sample to begin. All analysis runs locally in your browser —\n    no audio is uploaded anywhere.\n  </div>',
    '<div id="empty" class="card empty">\n    Loading a worked example…\n  </div>')
body = body.replace('  <div class="card">\n    <h2>Verdict</h2>',
"""  <div class="samplebar" id="sampleCard" hidden>
    <b>Worked example.</b>
    <span>This page opens on a synthesised 175&nbsp;Hz male voice — pitch sitting inside
    the 160–190&nbsp;Hz band where the sexes overlap, which is the case the weighting
    exists to resolve. Record or upload above to analyse a real voice.</span>
  </div>

  <div class="card">
    <h2>Verdict</h2>""")

# --- 5. Microphone. A sandboxed frame may withhold it; say what to do instead
# rather than reporting a bare failure.
body = body.replace(
    """    setStatus(e.name === 'NotAllowedError'
      ? 'Microphone permission denied. Allow access, or upload a file instead.'
      : 'Could not open the microphone: ' + e.message, true);""",
    """    setStatus(e.name === 'NotAllowedError' || e.name === 'NotFoundError'
      ? 'The microphone is not available here — a shared page may not be granted it. '
        + 'Upload a file or try a synthesised voice below; both run the identical analysis.'
      : 'Could not open the microphone: ' + e.message, true);""")

# --- 6. Auto-run the example once the page is painted.
body = body.replace(
    "window.__vg = { analyse, score, synthVoice, PRIORS, polyRoots, levinson, formantsFrame };  // for the parity test",
    """window.__vg = { analyse, score, synthVoice, PRIORS, polyRoots, levinson, formantsFrame };

// Open on a real analysis rather than an empty shell.
requestAnimationFrame(() => {
  const d = DEMOS.borderline;
  runAnalysis(synthVoice(d.f0, d.F, { breath: d.breath, seed: d.f0 }), SR, d.label, true)
    .then(() => { const c = document.getElementById('sampleCard'); if (c) c.hidden = false; });
});""")

# scrollIntoView is right when a person presses a button, wrong on page load.
body = body.replace("async function runAnalysis(samples, sr, label) {",
                    "async function runAnalysis(samples, sr, label, isSample = false) {")
body = body.replace("    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });",
                    "    if (!isSample) $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });")
body = body.replace("""document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => {
  const d = DEMOS[b.dataset.demo];""",
"""document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => {
  const sc = document.getElementById('sampleCard'); if (sc) sc.hidden = true;
  const d = DEMOS[b.dataset.demo];""")
for trigger in ["async function handleFile(file) {\n  if (!file) return;",
                "async function startRec() {"]:
    body = body.replace(trigger, trigger + "\n  { const sc = document.getElementById('sampleCard'); if (sc) sc.hidden = true; }")

# --- 7. The host supplies the tab icon from the publish call, not a <link>.
body = re.sub(r'<link rel="icon".*?>\n?', '', body, flags=re.S)

out = (f"<title>{title}</title>\n"
       '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
       '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
       'family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600'
       '&display=swap">\n'
       f"<style>{style}</style>\n\n{body}\n")

# The host supplies the document shell. Match real tags only -- a bare
# substring check flags <header>, which is legitimate page content.
for bad in (r"<!doctype", r"<html[\s>]", r"<head[\s>]", r"<body[\s>]",
            r"</html>", r"</head>", r"</body>"):
    assert not re.search(bad, out, re.I), f"artifact must not contain {bad}"
DST.write_text(out)
print(f"wrote {DST.relative_to(ROOT)}  ({len(out.splitlines())} lines, {len(out)/1024:.0f} KB)")
