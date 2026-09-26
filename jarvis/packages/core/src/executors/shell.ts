import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, win32 } from "node:path";
import { sha256, JarvisError, ProcessRequest, type EffectClass, type NepInvoke, type ResourceSelector } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";

/** Program/subcommand catalog → effect classes (05 §11.10). Unknown programs are execute_code. */
export function classifyCommand(program: string, args: string[]): EffectClass[] {
  const prog = win32.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const sub = (args[0] ?? "").toLowerCase();
  const table: Record<string, Record<string, EffectClass[]> & { "*"?: EffectClass[] }> = {
    git: { status: ["read.local"], log: ["read.local"], diff: ["read.local"], show: ["read.local"], branch: ["read.local"], "rev-parse": ["read.local"],
      add: ["write.local"], commit: ["write.local"], checkout: ["write.local"], switch: ["write.local"], merge: ["write.local"], restore: ["write.local"], stash: ["write.local"],
      push: ["communicate", "publish"], fetch: ["read.account"], pull: ["read.account", "write.local"], clone: ["read.account", "write.local"], "*": ["execute_code"] },
    ls: { "*": ["read.local"] }, cat: { "*": ["read.local"] }, head: { "*": ["read.local"] }, wc: { "*": ["read.local"] }, echo: { "*": ["read.local"] },
    pwd: { "*": ["read.local"] }, find: { "*": ["read.local"] }, grep: { "*": ["read.local"] }, whoami: { "*": ["read.local"] },
    npm: { install: ["install", "execute_code"], ci: ["install", "execute_code"], i: ["install", "execute_code"], test: ["execute_code"], run: ["execute_code"], "*": ["execute_code"] },
    pnpm: { install: ["install", "execute_code"], add: ["install", "execute_code"], "*": ["execute_code"] },
    pip: { install: ["install", "execute_code"], "*": ["execute_code"] },
    winget: { list: ["read.local"], search: ["read.account"], show: ["read.account"], install: ["install", "admin"], upgrade: ["install"], uninstall: ["install", "delete.local"], "*": ["install"] },
    schtasks: { "*": ["admin"] }, sc: { "*": ["admin"] }, reg: { query: ["read.local"], "*": ["admin"] },
  };
  const t = table[prog];
  if (!t) return ["execute_code"];
  return t[sub] ?? t["*"] ?? ["execute_code"];
}

/**
 * Shell executor (T1 development path). Structured argv, never a command string;
 * explicit cwd; env allowlist; secrets only as that process's env; bounded,
 * redacted output; the whole process group is killed on timeout or cancel. On
 * Windows, production routes this through the Exec Host's Job Objects (NEP).
 */
export class ShellExecutor implements Executor {
  id = "exec:shell"; version = "0.1.0";
  capabilities = ["tool:shell.run"];

  classify(_cap: string, params: Record<string, unknown>): EffectClass[] {
    return classifyCommand(String(params.program ?? ""), (params.args as string[] | undefined) ?? []);
  }
  targets(_cap: string, params: Record<string, unknown>): ResourceSelector[] {
    return typeof params.cwd === "string" ? [{ path_prefix: params.cwd }] : [];
  }
  fields(_cap: string, params: Record<string, unknown>): Record<string, unknown> {
    const args = (params.args as string[] | undefined) ?? [];
    return { program: params.program, subcommand: args[0] ?? null, cwd: params.cwd };
  }

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    const req = ProcessRequest.parse(ectx.resolvePlaceholders(nep.params));
    if (req.tier !== "T1") throw new JarvisError("unsupported_operation", `${req.tier} runs through the Workshop or an elevated batch, not this executor`);
    if (!isAbsolute(req.program)) throw new JarvisError("invalid_input", "program must be a resolved absolute path");
    if (!existsSync(req.program)) throw new JarvisError("invalid_input", "program not found");
    if (req.script_hash) {
      // For script files the grant binds the script's content hash (05 §11.10).
      const script = req.args.find(a => existsSync(a) && statSync(a).isFile());
      if (!script || sha256(readFileSync(script)) !== req.script_hash) throw new JarvisError("precondition_changed", "the script changed since it was approved");
    }
    const env: Record<string, string> = {};
    for (const k of req.env_allowlist) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    for (const inj of req.env_inject ?? []) await ectx.vault.use(inj.secret_ref, `env for ${basename(req.program)}`, s => { env[inj.name] = s; });
    const started = Date.now();
    const max = req.max_output_bytes;
    // Bounded capture: everything while under the cap; beyond it, the first and last halves.
    const chunks: Buffer[] = []; let total = 0; let tail = Buffer.alloc(0);
    const onData = (b: Buffer) => {
      const before = total; total += b.length;
      if (before < max) chunks.push(b.subarray(0, Math.max(0, max - before)));
      tail = Buffer.concat([tail, b]).subarray(-Math.floor(max / 2));
    };
    const child = spawn(req.program, req.args, { cwd: req.cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const killTree = () => { try { if (child.pid) process.platform === "win32" ? child.kill() : process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(killTree, req.timeout_s * 1000);
    const onAbort = () => killTree();
    ectx.signal.addEventListener("abort", onAbort);
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    const code: number | null = await new Promise((res, rej) => { child.on("error", rej); child.on("close", c => res(c)); });
    clearTimeout(timer); ectx.signal.removeEventListener("abort", onAbort);
    const timedOut = Date.now() - started >= req.timeout_s * 1000 - 5;
    const all = Buffer.concat(chunks);
    const raw = total > max ? `${all.subarray(0, Math.floor(max / 2)).toString("utf8")}\n…[${total - Math.floor(max / 2) - tail.length} bytes truncated]…\n${tail.toString("utf8")}` : all.toString("utf8");
    const output = ectx.redactor.redact(raw);
    const e = ectx.evidence.add({ type: "process_exit", claim: `${basename(req.program)} exited ${code}`, task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
      source: { capability_id: "tool:shell.run", executor: this.id }, data: { exit_code: code, duration_ms: Date.now() - started, output_sha256: sha256(output), total_bytes: total, passed: code === 0 } });
    if (ectx.signal.aborted) throw new JarvisError("cancelled", "cancelled; process tree killed");
    if (timedOut && code !== 0) throw new JarvisError("timeout", `timed out after ${req.timeout_s}s; process tree killed`);
    return { status: code === 0 ? "ok" : "error", effect_state: code === 0 ? "complete" : "unknown", output: { exit_code: code, output, truncated: total > max },
      ...(code === 0 ? {} : { error: new JarvisError("external_refusal", `exit code ${code}`, { effect_state: "unknown" }).structured }), evidence: [ectx.evidence.ref(e)] };
  }
}
