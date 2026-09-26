import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DevResult, JarvisError, type DevWorkOrder, type StructuredError, type UsageReport } from "@jarvis/shared";
import type { SandboxRunner } from "./sandbox.js";
import { wsPaths } from "./sandbox.js";

export type DevEvent =
  | { kind: "progress"; phase: "analyzing" | "implementing" | "testing" | "packaging"; note: string }
  | { kind: "question"; question: string; why: string; blocking: boolean }
  | { kind: "artifact"; path: string; artifact: "patch" | "package" | "report" }
  | { kind: "test_results"; suite: string; passed: number; failed: number }
  | { kind: "dependency_change"; changes: string }
  | { kind: "risk"; note: string };

export interface WorkerBuildInput {
  order: DevWorkOrder;
  root: string;                                  // workshop host root (the runner's hostRoot)
  runner: SandboxRunner;
  onEvent(e: DevEvent): void;
  signal: AbortSignal;
  mcp?: { url: string; token: string };
  /** Findings from a failed validation: the builder fixes them and rebuilds (fix loop). */
  feedback?: string;
}
export interface BuildOutcome { result: DevResult | null; usage: UsageReport; session_ref?: string; error?: StructuredError }

/** A coding worker adapter (06 §11.18). Workers never touch the live system; they build in the workspace. */
export interface CodingWorker {
  readonly id: string;
  available(runner: SandboxRunner): Promise<{ ok: boolean; reason?: string }>;
  build(i: WorkerBuildInput): Promise<BuildOutcome>;
}

export const DEV_RESULT_JSON_SCHEMA = z.toJSONSchema(DevResult, { unrepresentable: "any" }) as Record<string, unknown>;

export const WORKER_FRAMING = [
  "You are a JARVIS Workshop builder. Build exactly what CONTEXT.md specifies, in this workspace only.",
  "Rules: write the package into out/; keep tests in out/test/*.test.mjs (node:test); use only the synthetic fixtures in fixtures/;",
  "no personal data; no network except what CONTEXT.md allows; never read or write outside this directory.",
  "If something material is unclear, call the ask_boss tool. Do not ask the owner directly.",
  "Finish with the DevResult JSON. Your own test results are not trusted: JARVIS reruns everything and runs holdout tests you cannot see.",
].join("\n");

/**
 * Claude Code Worker (06 §11.18): `claude -p` inside the W1 distro, with the invocation
 * hygiene the spec requires — user settings only, hooks disabled, JARVIS's MCP config,
 * a JSON result schema, a dedicated CLAUDE_CONFIG_DIR, and no permission prompts. The
 * Claude Code sandbox runs in strict mode on top of the Workshop's own isolation.
 */
export class ClaudeCodeWorker implements CodingWorker {
  readonly id = "claude_code";
  constructor(private o: { binary?: string; configDir?: string; model?: string; allowedDomains?: string[]; timeoutMs?: number } = {}) {}

  async available(runner: SandboxRunner): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await runner.run([this.o.binary ?? "claude", "--version"], { cwd: runner.hostRoot, timeoutMs: 20_000, env: this.env() });
      return r.code === 0 ? { ok: true } : { ok: false, reason: `claude --version exited ${r.code}` };
    } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }

  private env(): Record<string, string> {
    return { CLAUDE_CONFIG_DIR: this.o.configDir ?? "/home/worker/.claude-jarvis" };
  }

  /** The exact argv, exposed for tests and for the Phase 0 verification kit. */
  argv(i: WorkerBuildInput, mcpConfigSandboxPath: string): string[] {
    const settings = {
      disableAllHooks: true,
      // Strict sandbox (08 §13.3): sandboxed commands only, and only allowlisted domains.
      sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: this.o.allowedDomains ?? i.order.dev.environment_constraints.network.allowlist ?? [] } },
      permissions: { allow: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] },
    };
    const prompt = i.feedback
      ? `Validation of your previous package failed. Read VALIDATION.md, fix the problems, and rebuild out/. Then reply with the DevResult JSON.`
      : `Read CONTEXT.md and the files in spec/ and fixtures/, then build the package into out/ exactly as specified. Reply with the DevResult JSON.`;
    return [this.o.binary ?? "claude", "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--json-schema", JSON.stringify(DEV_RESULT_JSON_SCHEMA),
      "--setting-sources", "user",
      "--settings", JSON.stringify(settings),
      "--mcp-config", mcpConfigSandboxPath,
      "--append-system-prompt", WORKER_FRAMING,
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      ...(this.o.model ? ["--model", this.o.model] : [])];
  }

  async build(i: WorkerBuildInput): Promise<BuildOutcome> {
    const ws = wsPaths(i.root, i.order.work_order_id);
    const mcpPath = join(ws.base, ".jarvis-mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: i.mcp ? { jarvis: { type: "http", url: i.mcp.url, headers: { Authorization: `Bearer ${i.mcp.token}` } } } : {} }), { mode: 0o600 });
    if (i.feedback) writeFileSync(join(ws.base, "VALIDATION.md"), i.feedback);
    let final: Record<string, unknown> | null = null;
    i.onEvent({ kind: "progress", phase: "analyzing", note: "Reading the specification" });
    const r = await i.runner.run(this.argv(i, i.runner.toSandboxPath(mcpPath)), {
      cwd: ws.base, timeoutMs: this.o.timeoutMs ?? 60 * 60_000, env: this.env(), signal: i.signal, network: "allowed",
      onStdoutLine: line => {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "result") final = ev;
        else if (ev.type === "assistant") {
          const content = ((ev.message as { content?: { type: string; name?: string }[] } | undefined)?.content ?? []);
          const tool = content.find(c => c.type === "tool_use")?.name;
          if (tool) i.onEvent({ kind: "progress", phase: tool === "Bash" ? "testing" : "implementing", note: `Using ${tool}` });
        }
      },
    });
    const res = final as Record<string, unknown> | null;
    const usageRaw = (res?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    const cost = typeof res?.total_cost_usd === "number" ? res.total_cost_usd : undefined;
    // total_cost_usd is a client-side estimate (06 §11.18): never recorded as actual.
    const usage: UsageReport = { duration_ms: Number(res?.duration_ms ?? 0), ...(usageRaw.input_tokens !== undefined ? { tokens: { input: usageRaw.input_tokens, output: usageRaw.output_tokens ?? 0 } } : {}),
      ...(cost !== undefined ? { cost: { amount: { amount: cost, currency: "USD" }, kind: "estimated", basis: "claude -p total_cost_usd (client-side estimate)" } } : {}) };
    const session_ref = typeof res?.session_id === "string" ? res.session_id : undefined;
    if (r.timed_out) return { result: null, usage, ...(session_ref ? { session_ref } : {}), error: new JarvisError("timeout", "the coding worker ran out of time").structured };
    if (i.signal.aborted) return { result: null, usage, error: new JarvisError("cancelled", "cancelled").structured };
    if (!res || res.is_error === true) {
      const msg = String(res?.result ?? r.stderr.split("\n").filter(Boolean).pop() ?? `claude exited ${r.code}`).slice(0, 300);
      const code = /rate.?limit|usage limit|quota/i.test(msg) ? "rate_limited" : /auth|log ?in|credential/i.test(msg) ? "auth_required" : "transient_service_error";
      return { result: null, usage, ...(session_ref ? { session_ref } : {}), error: new JarvisError(code, msg).structured };
    }
    const structured = res.structured_output ?? (() => { try { return JSON.parse(String(res.result ?? "")); } catch { return null; } })();
    const parsed = DevResult.safeParse(structured);
    if (!parsed.success) return { result: null, usage, ...(session_ref ? { session_ref } : {}), error: new JarvisError("internal_error", "the worker's final answer was not a DevResult").structured };
    i.onEvent({ kind: "progress", phase: "packaging", note: "Package ready for validation" });
    return { result: parsed.data, usage, ...(session_ref ? { session_ref } : {}) };
  }
}
