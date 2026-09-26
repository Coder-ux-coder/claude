import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { MasterKeyProvider, PlainFileWrapper } from "./crypto/keys.js";
import { JarvisCore } from "./runtime.js";
import { CoordinatorServer } from "./ipc/coordinator-server.js";
import { SessionBridge } from "./nep/session-bridge.js";
import { ExecHostClient, RemoteExecHostExecutor } from "./nep/exec-host.js";
import { componentPipe, pipePath } from "./nep/rpc.js";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { LocalProcessRunner, WslRunner } from "./workshop/sandbox.js";
import { ClaudeCodeWorker } from "./workshop/worker.js";
import type { JarvisOptions } from "./runtime.js";

/** Names of installed WSL distros (`wsl.exe -l -q` prints UTF-16LE). */
export function parseWslList(out: Buffer): string[] {
  const text = out.includes(0) ? out.toString("utf16le") : out.toString("utf8");
  return text.split(/\r?\n/).map(l => l.replace(/\0/g, "").trim()).filter(Boolean);
}

/**
 * The Workshop, when it's set up (08 §13.3): the jarvis-workshop WSL distro on Windows; or,
 * for development elsewhere, an explicitly requested local runner (not isolation).
 * The MCP gateway binds to loopback only; WSL reaches it with mirrored networking.
 */
export function detectWorkshop(dataDir: string, env: NodeJS.ProcessEnv = process.env): JarvisOptions["workshop"] | undefined {
  const workers = [new ClaudeCodeWorker({ ...(env.JARVIS_CLAUDE_BIN ? { binary: env.JARVIS_CLAUDE_BIN } : {}) })];
  if (env.JARVIS_WORKSHOP_LOCAL === "1") {
    const root = `${dataDir}/workshop`; mkdirSync(root, { recursive: true });
    return { runner: new LocalProcessRunner(root), workers, allowUnisolated: true, mcp: { host: "127.0.0.1" } };
  }
  if (process.platform !== "win32") return undefined;
  try {
    const distros = parseWslList(execFileSync("wsl.exe", ["-l", "-q"], { timeout: 15_000, windowsHide: true }));
    if (!distros.includes("jarvis-workshop")) return undefined;
    return { runner: new WslRunner(), workers, mcp: { host: "127.0.0.1" } };
  } catch { return undefined; }
}

/**
 * The Coordinator process (01 §3–4). Started by the Launcher, which writes the per-boot
 * session secret as the first line of stdin; closing stdin asks it to shut down.
 *
 *   node main.js [--data-dir DIR] [--safe-mode]
 *
 * Development without the Launcher: set JARVIS_DEV_SESSION_SECRET (32+ characters).
 */
export interface MainArgs { dataDir: string; safeMode: boolean }

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): MainArgs {
  const i = argv.indexOf("--data-dir");
  const dataDir = i >= 0 && argv[i + 1] ? argv[i + 1]! : env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Jarvis") : join(homedir(), ".jarvis");
  return { dataDir, safeMode: argv.includes("--safe-mode") };
}

async function readSecret(): Promise<{ secret: string; stdinEnded: Promise<void> }> {
  const dev = process.env.JARVIS_DEV_SESSION_SECRET;
  const rl = createInterface({ input: process.stdin });
  const stdinEnded = new Promise<void>(r => rl.once("close", () => r()));
  if (dev) return { secret: dev, stdinEnded: new Promise(() => {}) };
  const secret = await new Promise<string>((resolve, reject) => {
    rl.once("line", l => resolve(l.trim()));
    rl.once("close", () => reject(new Error("stdin closed before the session secret")));
  });
  return { secret, stdinEnded };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const { secret, stdinEnded } = await readSecret();
  if (secret.length < 32) { process.stderr.write("jarvis-core: missing session secret\n"); process.exit(2); }

  // On Windows the master key is wrapped with DPAPI through the Exec Host (04 §10.12).
  let exec: ExecHostClient | null = null;
  try { exec = await ExecHostClient.connect(pipePath(componentPipe("exec")), secret); }
  catch (e) { process.stderr.write(`jarvis-core: Exec Host unavailable (${(e as Error).message}); local actions that need it are disabled\n`); }
  const keyPath = join(args.dataDir, "vault", "master.key");
  const keys = exec && process.platform === "win32"
    ? await MasterKeyProvider.fromFileAsync(keyPath, { kind: "dpapi_current_user", wrap: k => exec!.dpapiProtect(k), unwrap: b => exec!.dpapiUnprotect(b) })
    : MasterKeyProvider.fromFile(keyPath, new PlainFileWrapper());
  if (process.platform === "win32" && !exec) process.stderr.write("jarvis-core: WARNING master key is not DPAPI-protected (Exec Host missing)\n");

  const workshop = detectWorkshop(args.dataDir);
  if (!workshop) process.stderr.write("jarvis-core: Workshop not set up (no jarvis-workshop WSL distro); capability gaps will be reported, not built\n");
  const core = new JarvisCore({ dataDir: args.dataDir, keys, runScheduler: true, ...(workshop ? { workshop } : {}) });
  const recovery = core.start();
  await core.startServices();
  if (args.safeMode) core.broker.safeMode = true;
  if (exec) {
    const nepKey = keys.dataKey("nep_grants");
    await exec.configure(nepKey);
    core.broker.registerExecutor(new RemoteExecHostExecutor(exec, nepKey));
  }
  const bridge = new SessionBridge(core.ctx, core.registry, core.leases, core.broker, {
    onResume: () => { core.scheduler.recomputeAll(); core.scheduler.tick(); },
  });
  const server = new CoordinatorServer(core, { path: pipePath(componentPipe("core")), secret, sessionBridge: bridge });
  await server.listen();                   // the pipe existing is the Launcher's readiness signal
  core.ctx.events.append({ type: "core.started", summary: `data ${args.dataDir}`, data: { safe_mode: core.broker.safeMode, exec_host: !!exec, resumed_tasks: recovery.resumed_tasks.length, uncertain_actions: recovery.uncertain_actions.length } });

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return; stopping = true;
    core.ctx.events.append({ type: "core.stopping", summary: why, data: {} });
    await server.close();
    await core.shutdown();
    exec?.close();
    process.exit(0);
  };
  void stdinEnded.then(() => stop("launcher closed stdin"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

// Run when executed directly (node main.js), not when imported by tests.
if (process.argv[1] && /main\.(js|ts)$/.test(process.argv[1])) {
  main().catch(e => { process.stderr.write(`jarvis-core: fatal: ${(e as Error).stack ?? e}\n`); process.exit(1); });
}
