// Bundles the Console: renderer (browser IIFE), Electron main (ESM) and preload (CJS, sandboxed),
// and the dev web bridge. Also writes the tray icon.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const common = { bundle: true, sourcemap: true, logLevel: "warning", legalComments: "none" };
// Native modules and Electron stay external; the Coordinator link only needs @jarvis/core's pure-JS rpc module.
const nodeExternal = ["electron", "better-sqlite3", "sqlite-vec", "@anthropic-ai/sdk"];

await build({ ...common, entryPoints: [join(root, "src/renderer/main.tsx")], outfile: join(out, "renderer/app.js"), platform: "browser", format: "iife", target: ["chrome120"], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, minify: true });
await build({ ...common, entryPoints: [join(root, "src/main/main.ts")], outfile: join(out, "main/main.js"), platform: "node", format: "esm", target: ["node22"], external: nodeExternal,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
await build({ ...common, entryPoints: [join(root, "src/main/preload.ts")], outfile: join(out, "main/preload.cjs"), platform: "node", format: "cjs", target: ["node22"], external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "src/bridge/dev-main.ts")], outfile: join(out, "bridge/dev-main.js"), platform: "node", format: "esm", target: ["node22"], external: nodeExternal,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
mkdirSync(join(out, "renderer"), { recursive: true });
for (const f of ["index.html", "styles.css"]) copyFileSync(join(root, "src/renderer", f), join(out, "renderer", f));
writeFileSync(join(out, "renderer/icon.png"), icon(32));
console.log("console built");

/** A 32×32 PNG: a blue ring on transparent (the tray icon), encoded without image libraries. */
function icon(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5), o = y * (n * 4 + 1) + 1 + x * 4;
      const on = (d < n / 2 - 1 && d > n / 2 - 6) || d < n / 6;
      raw[o] = 0x24; raw[o + 1] = 0x58; raw[o + 2] = 0xd6; raw[o + 3] = on ? 255 : 0;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
