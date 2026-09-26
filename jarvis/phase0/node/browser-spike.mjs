// Phase 0 spike: can JARVIS drive its OWN browser profile reliably?
// Uses a dedicated profile folder under JarvisPhase0 (never your normal
// Edge/Chrome profile), a local test page (no internet needed), and checks:
// launch with installed Edge/Chrome, accessibility snapshot, form fill,
// persistence across restarts, and that a second launch on the same profile
// is refused (profile lock). Writes results/browser.json.
//
//   node browser-spike.mjs [--channel msedge|chrome] [--headed] [--delay 500]
//                          [--executable <path>]   (testing on a PC without Edge/Chrome)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resultsDir, saveResult } from "./lib/results.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const headed = args.includes("--headed");
const slowMo = Number(opt("delay", headed ? 300 : 0));
const executablePath = opt("executable", undefined);
const channels = executablePath ? [undefined] : (opt("channel") ? [opt("channel")] : ["msedge", "chrome"]);

const page_html = `<!doctype html><html><head><title>JARVIS Phase 0 test page</title></head><body>
<main><h1>Book a table (HYPOTHETICAL)</h1>
<form id="f"><label>Name <input name="name"></label>
<label>Party size <select name="size"><option>1</option><option>2</option><option>4</option></select></label>
<label><input type="checkbox" name="window"> Window seat</label>
<button type="submit">Reserve</button></form><p id="out" role="status"></p></main>
<script>
document.getElementById('f').addEventListener('submit', e => { e.preventDefault();
  const d = new FormData(e.target); document.getElementById('out').textContent = 'Reserved for ' + d.get('name') + ', ' + d.get('size');
  localStorage.setItem('p0', 'persisted'); document.cookie = 'p0=1; max-age=3600'; });
document.getElementById('out').textContent = localStorage.getItem('p0') ? 'Welcome back' : '';
</script></body></html>`;
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page_html); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profileDir = join(resultsDir, "..", "browser-profile");
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

const checks = [];
const record = (name, ok, extra = {}) => { checks.push({ name, status: ok ? "pass" : "fail", ...extra }); console.log(`${ok ? "pass" : "fail"}  ${name}${extra.error ? "  " + extra.error : ""}`); };

let usedChannel = null, ctx = null, launchErrors = [];
for (const channel of channels) {
  try {
    ctx = await chromium.launchPersistentContext(profileDir, { channel, executablePath, headless: !headed, slowMo });
    usedChannel = channel ?? "custom-executable";
    break;
  } catch (e) { launchErrors.push({ channel, error: String(e.message).split("\n")[0] }); }
}
record("launch_persistent_context", !!ctx, { channel: usedChannel, errors: launchErrors });

if (ctx) {
  try {
    const browserVersion = ctx.browser()?.version() ?? null;
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(url);
    const snapshot = await page.locator("main").ariaSnapshot();
    record("aria_snapshot", /textbox "Name"/.test(snapshot) && /button "Reserve"/.test(snapshot), { browser_version: browserVersion, snapshot_chars: snapshot.length });

    await page.getByRole("textbox", { name: "Name" }).fill("HYPOTHETICAL Guest");
    await page.getByRole("combobox", { name: "Party size" }).selectOption("4");
    await page.getByRole("checkbox", { name: "Window seat" }).check();
    await page.getByRole("button", { name: "Reserve" }).click();
    const status = await page.getByRole("status").textContent();
    record("form_fill_by_role", status === "Reserved for HYPOTHETICAL Guest, 4", { status_text: status });

    // Profile lock: a second launch on the same folder must fail.
    let secondLaunchRefused = false, lockError = null;
    try {
      const c2 = await chromium.launchPersistentContext(profileDir, { channel: channels[0], executablePath, headless: true, timeout: 20000 });
      await c2.close();
    } catch (e) { secondLaunchRefused = true; lockError = String(e.message).split("\n")[0]; }
    record("profile_lock_refuses_second_launch", secondLaunchRefused, { detail: lockError });

    await ctx.close();
    const ctx2 = await chromium.launchPersistentContext(profileDir, { channel: usedChannel === "custom-executable" ? undefined : usedChannel, executablePath, headless: !headed, slowMo });
    const p2 = ctx2.pages()[0] ?? await ctx2.newPage();
    await p2.goto(url);
    const welcome = await p2.getByRole("status").textContent();
    const cookies = await ctx2.cookies(url);
    record("state_persists_across_restart", welcome === "Welcome back" && cookies.some(c => c.name === "p0"));
    await ctx2.close();
  } catch (e) {
    record("browser_flow", false, { error: String(e.message).split("\n")[0] });
    await ctx.close().catch(() => {});
  }
}
server.close();
rmSync(profileDir, { recursive: true, force: true });

const status = checks.every(c => c.status === "pass") ? "pass" : "fail";
saveResult("browser", { status, channel: usedChannel, headed, checks });
console.log(`BROWSER: ${status}`);
