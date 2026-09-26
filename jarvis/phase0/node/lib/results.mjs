// Shared result writer: same folder and envelope as the PowerShell kit
// (%LOCALAPPDATA%\JarvisPhase0\results, or ~/.jarvis-phase0/results elsewhere).
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

export const resultsDir = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "JarvisPhase0", "results")
  : join(homedir(), ".jarvis-phase0", "results");

function redact(text) {
  let out = text;
  for (const s of [userInfo().username, hostname(), process.env.USERDOMAIN]) {
    if (s && s.length >= 3) out = out.split(s).join("<redacted>");
  }
  return out;
}

export function saveResult(spike, results) {
  mkdirSync(resultsDir, { recursive: true });
  const doc = { spike, kit_version: "0.1.0", recorded_at: new Date().toISOString(), results };
  const path = join(resultsDir, `${spike}.json`);
  writeFileSync(path, redact(JSON.stringify(doc, null, 2)));
  console.log(`Saved ${path}`);
  return path;
}
