import { spawn } from "node:child_process";
import { join, relative, sep, posix, win32 } from "node:path";
import { JarvisError } from "@jarvis/shared";

export interface RunResult { code: number | null; stdout: string; stderr: string; timed_out: boolean; killed: boolean }
export interface RunOptions {
  cwd: string;                               // a HOST path inside the workshop root
  stdin?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  network?: "none" | "allowed";
  onStdoutLine?: (line: string) => void;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/**
 * Where Workshop code runs (08 §13.3). The host sees the workshop through `hostRoot`; the
 * sandbox sees the same files at `sandboxRoot`. Commands are argv arrays (no shell).
 */
export interface SandboxRunner {
  readonly id: string;
  readonly hostRoot: string;
  readonly sandboxRoot: string;
  /** True when the sandbox is a real isolation boundary (W1/W2), false for the local development runner. */
  readonly isolated: boolean;
  toSandboxPath(hostPath: string): string;
  run(argv: string[], o: RunOptions): Promise<RunResult>;
}

const MAX_OUT = 8 * 1024 * 1024;

function exec(cmd: string, args: string[], o: RunOptions & { spawnCwd?: string; spawnEnv: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: o.spawnCwd, env: o.spawnEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let stdout = "", stderr = "", buf = "", timedOut = false, killed = false;
    const cap = o.maxOutputBytes ?? MAX_OUT;
    const kill = () => {
      killed = true;
      try { if (process.platform !== "win32" && p.pid) process.kill(-p.pid, "SIGTERM"); else p.kill("SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { if (process.platform !== "win32" && p.pid) process.kill(-p.pid, "SIGKILL"); else p.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref();
    };
    const t = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    const onAbort = () => kill();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      if (stdout.length < cap) stdout += d;
      if (o.onStdoutLine) { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) o.onStdoutLine(line); } }
    });
    p.stderr.on("data", (d: string) => { if (stderr.length < cap) stderr += d; });
    p.once("error", e => { clearTimeout(t); reject(new JarvisError("unsupported_operation", `cannot start ${cmd}: ${e.message}`)); });
    p.once("close", code => {
      clearTimeout(t); o.signal?.removeEventListener("abort", onAbort);
      if (o.onStdoutLine && buf.trim()) o.onStdoutLine(buf);
      resolve({ code, stdout, stderr, timed_out: timedOut, killed });
    });
    p.stdin.on("error", () => { /* child closed stdin early */ });
    p.stdin.end(o.stdin ?? "");
  });
}

/**
 * Development and test runner: a child process with a minimal environment inside the
 * workshop root. NOT an isolation boundary (isolated = false); the Workshop refuses to
 * run coding workers with it unless explicitly allowed for development.
 */
export class LocalProcessRunner implements SandboxRunner {
  readonly id = "local-dev";
  readonly isolated = false;
  readonly sandboxRoot: string;
  constructor(readonly hostRoot: string) { this.sandboxRoot = hostRoot; }
  toSandboxPath(hostPath: string): string { return hostPath; }
  run(argv: string[], o: RunOptions): Promise<RunResult> {
    assertInside(this.hostRoot, o.cwd);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.cwd, NODE_OPTIONS: "", ...(o.env ?? {}) };
    if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return exec(argv[0]!, argv.slice(1), { ...o, spawnCwd: o.cwd, spawnEnv: env });
  }
}

/**
 * W1: the jarvis-workshop WSL2 distro (08 §13.3). Commands run as the unprivileged `worker`
 * user with a clean environment; `network: "none"` runs them in a fresh network namespace
 * (unshare), so generated tools and tests have no network at all. The host reaches the
 * distro's files through \\wsl.localhost\<distro>\… [I: verified by the Phase 0 kit].
 */
export class WslRunner implements SandboxRunner {
  readonly id: string;
  readonly isolated = true;
  readonly hostRoot: string;
  constructor(readonly distro = "jarvis-workshop", readonly sandboxRoot = "/home/worker/ws", private user = "worker", private wslExe = "wsl.exe") {
    this.id = `wsl:${distro}`;
    this.hostRoot = `\\\\wsl.localhost\\${distro}${sandboxRoot.replace(/\//g, "\\")}`;
  }
  /** Host paths here are always Windows UNC paths, so win32 path rules apply on any platform. */
  toSandboxPath(hostPath: string): string {
    const rel = win32.relative(this.hostRoot, hostPath);
    if (rel.startsWith("..") || win32.isAbsolute(rel) || rel.split(win32.sep).includes("..")) throw new JarvisError("missing_permission", `${hostPath} is outside the workshop`);
    const r = rel.split(win32.sep).join(posix.sep);
    return r ? posix.join(this.sandboxRoot, r) : this.sandboxRoot;
  }
  run(argv: string[], o: RunOptions): Promise<RunResult> {
    const cwd = this.toSandboxPath(o.cwd);
    const envArgs = Object.entries({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: `/home/${this.user}`, LANG: "C.UTF-8", ...(o.env ?? {}) }).map(([k, v]) => `${k}=${v}`);
    const netWrap = o.network === "none" ? ["unshare", "--map-root-user", "--net", "--"] : [];
    const args = ["-d", this.distro, "-u", this.user, "--cd", cwd, "--", "env", "-i", ...envArgs, ...netWrap, ...argv];
    return exec(this.wslExe, args, { ...o, spawnEnv: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "" } });
  }
}

export function assertInside(root: string, p: string): void {
  const rel = relative(root, p);
  if (rel.startsWith("..") || (rel !== "" && /^[a-zA-Z]:/.test(rel)) || rel.split(sep).includes("..")) throw new JarvisError("missing_permission", `${p} is outside the workshop`);
}

export const wsPaths = (root: string, woId: string) => {
  const base = join(root, woId);
  return { base, repo: join(base, "repo"), spec: join(base, "spec"), fixtures: join(base, "fixtures"), out: join(base, "out"), context: join(base, "CONTEXT.md") };
};
