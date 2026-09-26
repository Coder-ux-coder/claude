import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sha256, JarvisError, type NepInvoke, type ResourceSelector } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";

/** Resolves symlinks and junctions before scope checks, so a link cannot escape an allowed folder (05 §11.11). */
export function realTarget(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs);
  let dir = dirname(abs);
  const tail = [basename(abs)];
  while (!existsSync(dir) && dirname(dir) !== dir) { tail.unshift(basename(dir)); dir = dirname(dir); }
  return join(existsSync(dir) ? realpathSync.native(dir) : dir, ...tail);
}

/**
 * File executor (T1): read, list, write (snapshot to the recovery bin before any
 * overwrite), move, and delete to a recoverable trash (the Recycle Bin through the
 * Exec Host on Windows). Writes are atomic: temporary name, then rename.
 */
export class FilesExecutor implements Executor {
  id = "exec:files"; version = "0.1.0";
  capabilities = ["tool:files.read", "tool:files.list", "tool:files.write", "tool:files.move", "tool:files.delete"];
  constructor(private recoveryBin: string, private trash: string) {}

  targets(_cap: string, params: Record<string, unknown>): ResourceSelector[] {
    return ["path", "from", "to"].filter(k => typeof params[k] === "string").map(k => ({ path_prefix: realTarget(params[k] as string) }));
  }

  fields(_cap: string, params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(["path", "from", "to"].filter(k => typeof params[k] === "string").map(k => [k, realTarget(params[k] as string)]));
  }

  private snapshot(path: string): string {
    mkdirSync(this.recoveryBin, { recursive: true });
    const dest = join(this.recoveryBin, `${Date.now()}-${sha256(path).slice(0, 8)}-${basename(path)}`);
    copyFileSync(path, dest);
    writeFileSync(dest + ".json", JSON.stringify({ original: path, at: new Date().toISOString() }));
    return dest;
  }

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const cap = nep.capability.split("@")[0];
    const params = ectx.resolvePlaceholders(nep.params) as Record<string, string>;
    const ev = (claim: string, data: Record<string, unknown>) => ectx.evidence.add({ type: "file_check", claim, task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
      source: { capability_id: cap!, executor: this.id }, data });
    switch (cap) {
      case "tool:files.read": {
        const p = realTarget(params.path!);
        if (!existsSync(p)) throw new JarvisError("invalid_input", "file not found");
        const buf = readFileSync(p);
        const max = Number(params.max_bytes ?? 200_000);
        return { status: "ok", effect_state: "none", output: { path: p, sha256: sha256(buf), size: buf.length, truncated: buf.length > max, text: buf.subarray(0, max).toString("utf8") }, evidence: [] };
      }
      case "tool:files.list": {
        const p = realTarget(params.path!);
        const items = readdirSync(p, { withFileTypes: true }).slice(0, 5000).map(d => ({ name: d.name, dir: d.isDirectory() }));
        return { status: "ok", effect_state: "none", output: { path: p, items }, evidence: [] };
      }
      case "tool:files.write": {
        const p = realTarget(params.path!);
        const existed = existsSync(p);
        if (existed && params.mode === "create") throw new JarvisError("conflict", "file already exists");
        if (existed && params.expected_sha256 && sha256(readFileSync(p)) !== params.expected_sha256)
          throw new JarvisError("precondition_changed", "the file changed since it was read; not overwriting your edits");
        const snap = existed ? this.snapshot(p) : undefined;
        mkdirSync(dirname(p), { recursive: true });
        const tmp = `${p}.jarvis-tmp`;
        writeFileSync(tmp, params.content ?? "");
        renameSync(tmp, p);
        const after = sha256(readFileSync(p));
        const e = ev(`wrote ${basename(p)}`, { path_hash: sha256(p), sha256: after, matches: after === sha256(params.content ?? ""), recovery_snapshot: !!snap });
        return { status: "ok", effect_state: "complete", output: { path: p, sha256: after, recovery_snapshot: snap ?? null }, evidence: [ectx.evidence.ref(e)], observed_fields: { path: params.path } };
      }
      case "tool:files.move": {
        const from = realTarget(params.from!), to = realTarget(params.to!);
        if (!existsSync(from)) throw new JarvisError("invalid_input", "source not found");
        if (existsSync(to)) throw new JarvisError("conflict", "destination exists");
        const h = statSync(from).isFile() ? sha256(readFileSync(from)) : null;
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        const ok = existsSync(to) && !existsSync(from) && (h === null || sha256(readFileSync(to)) === h);
        const e = ev(`moved ${basename(from)}`, { matches: ok, sha256: h });
        return { status: "ok", effect_state: "complete", output: { from, to }, evidence: [ectx.evidence.ref(e)], observed_fields: { from: params.from, to: params.to } };
      }
      case "tool:files.delete": {
        const p = realTarget(params.path!);
        if (!existsSync(p)) throw new JarvisError("invalid_input", "not found");
        mkdirSync(this.trash, { recursive: true });
        const dest = join(this.trash, `${Date.now()}-${basename(p)}`);
        renameSync(p, dest);
        writeFileSync(dest + ".restore.json", JSON.stringify({ original: p, at: new Date().toISOString() }));
        const e = ev(`moved ${basename(p)} to the recoverable trash`, { matches: !existsSync(p) && existsSync(dest) });
        return { status: "ok", effect_state: "complete", output: { path: p, recoverable_at: dest }, evidence: [ectx.evidence.ref(e)], observed_fields: { path: params.path } };
      }
    }
    throw new JarvisError("unsupported_operation", `files executor cannot ${cap}`);
  }
}
