import { createHmac } from "node:crypto";
import { canonicalJson, sha256, JarvisError, NEP_PROTOCOL_VERSION, type EvidenceRef, type NepInvoke, type StructuredError } from "@jarvis/shared";
import type { Executor, ExecutorContext, ExecResult } from "../broker/types.js";
import { classifyCommand } from "../executors/shell.js";
import { realTarget } from "../executors/files.js";
import { NdjsonRpc } from "./rpc.js";

/** Grant signature for the NEP transport, matching Jarvis.Contracts.GrantSignature exactly. */
export function nepSignature(key: Buffer, nep: NepInvoke, paramsJson: string): string {
  const payload = [nep.invocation_id, nep.capability, sha256(paramsJson), nep.grant?.expires_at ?? "", nep.idempotency_key, nep.task_revision, nep.policy_revision].join("\n");
  return createHmac("sha256", key).update(payload).digest("hex");
}

/** Authenticated client for jarvis-exec: hello with the Launcher's session secret, then configure the grant key. */
export class ExecHostClient {
  private constructor(private rpc: NdjsonRpc, readonly info: { host: string; version: string; platform: string; job_objects: boolean }) {}

  /**
   * Connects and says hello. With `grantKey`, also configures grant checking; without it,
   * only DPAPI is usable until `configure` (the master key is unwrapped through DPAPI first).
   */
  static async connect(path: string, sessionSecret: string, grantKey?: Buffer): Promise<ExecHostClient> {
    const rpc = await NdjsonRpc.connect(path);
    const info = await rpc.call<ExecHostClient["info"]>("hello", { protocol_version: NEP_PROTOCOL_VERSION, component: "core", secret: sessionSecret });
    const c = new ExecHostClient(rpc, info);
    if (grantKey) await c.configure(grantKey);
    return c;
  }
  configure(grantKey: Buffer): Promise<unknown> { return this.rpc.call("configure", { grant_key_hex: grantKey.toString("hex") }); }
  get closed(): boolean { return this.rpc.closed; }

  /** Invokes with the params embedded byte-for-byte as signed. */
  invoke(nep: NepInvoke, paramsJson: string, secrets: Record<string, string>): Promise<{ status: "ok" | "error" | "partial"; effect_state: ExecResult["effect_state"]; output?: unknown; error?: StructuredError; evidence: Record<string, unknown>[] }> {
    const { params: _p, ...rest } = nep;
    const head = JSON.stringify({ ...rest, secrets });
    return this.rpc.callRaw("nep.invoke", `${head.slice(0, -1)},"params":${paramsJson}}`, 24 * 3_600_000);
  }
  cancel(invocationId: string): Promise<unknown> { return this.rpc.call("nep.cancel", { invocation_id: invocationId, mode: "kill" }); }
  status(invocationId: string): Promise<{ state: string; result?: unknown }> { return this.rpc.call("nep.status", { invocation_id: invocationId }); }
  dpapiProtect(data: Buffer): Promise<Buffer> { return this.rpc.call<{ data_b64: string }>("dpapi.protect", { data_b64: data.toString("base64") }).then(r => Buffer.from(r.data_b64, "base64")); }
  dpapiUnprotect(blob: Buffer): Promise<Buffer> { return this.rpc.call<{ data_b64: string }>("dpapi.unprotect", { data_b64: blob.toString("base64") }).then(r => Buffer.from(r.data_b64, "base64")); }
  close(): void { this.rpc.close(); }
}

/**
 * Routes shell runs and deletes to the native Exec Host over NEP (Job Objects,
 * Recycle Bin). The Coordinator re-signs the Broker's grant for the exact param bytes;
 * the Exec Host verifies it before running anything.
 */
export class RemoteExecHostExecutor implements Executor {
  id = "exec:jarvis-exec"; version = "0.1.0";
  capabilities = ["tool:shell.run", "tool:files.delete"];
  constructor(private client: ExecHostClient, private nepKey: Buffer) {}

  classify(cap: string, params: Record<string, unknown>) {
    return cap === "tool:shell.run" ? classifyCommand(String(params.program ?? ""), (params.args as string[] | undefined) ?? []) : [];
  }
  targets(cap: string, params: Record<string, unknown>) {
    if (cap === "tool:shell.run") return typeof params.cwd === "string" ? [{ path_prefix: params.cwd }] : [];
    return typeof params.path === "string" ? [{ path_prefix: realTarget(params.path) }] : [];
  }
  fields(cap: string, params: Record<string, unknown>) {
    return cap === "tool:shell.run" ? { program: params.program, subcommand: ((params.args as string[] | undefined) ?? [])[0] ?? null, cwd: params.cwd } : { path: typeof params.path === "string" ? realTarget(params.path) : undefined };
  }

  async invoke(nep: NepInvoke, ectx: ExecutorContext): Promise<ExecResult> {
    if (!nep.grant) throw new JarvisError("missing_permission", "no grant for a native invocation");
    const resolved = ectx.resolvePlaceholders(nep.params) as Record<string, unknown>;
    const { env_inject, ...forHost } = resolved as { env_inject?: { name: string; secret_ref: string }[] } & Record<string, unknown>;
    const paramsJson = canonicalJson(forHost);
    const signed: NepInvoke = { ...nep, grant: { ...nep.grant, signature: nepSignature(this.nepKey, nep, paramsJson) } };
    // Secrets are released from the vault only for the duration of the call, as that process's environment.
    const withSecrets = async (i: number, acc: Record<string, string>): Promise<Awaited<ReturnType<ExecHostClient["invoke"]>>> => {
      const inj = env_inject?.[i];
      if (!inj) return this.client.invoke(signed, paramsJson, acc);
      return ectx.vault.use(inj.secret_ref, `env for ${String(forHost.program)}`, s => withSecrets(i + 1, { ...acc, [inj.name]: s }));
    };
    const onAbort = () => { void this.client.cancel(nep.invocation_id).catch(() => undefined); };
    ectx.signal.addEventListener("abort", onAbort);
    try {
      const r = await withSecrets(0, {});
      const evidence: EvidenceRef[] = r.evidence.map(e => {
        const type = e.type === "file_check" ? "file_check" : "process_exit";
        const rec = ectx.evidence.add({ type, claim: type === "process_exit" ? `exited ${String(e.exit_code)}` : "recycled", task_id: ectx.task_id, ...(ectx.action_id ? { action_id: ectx.action_id } : {}),
          source: { capability_id: nep.capability.split("@")[0]!, executor: this.id }, data: { ...e, passed: type === "process_exit" ? e.exit_code === 0 : e.gone === true } });
        return ectx.evidence.ref(rec);
      });
      const output = r.output && typeof r.output === "object" && "output" in (r.output as object)
        ? { ...(r.output as object), output: ectx.redactor.redact(String((r.output as { output: string }).output)) } : r.output;
      return { status: r.status, effect_state: r.effect_state, ...(output !== undefined ? { output } : {}), ...(r.error ? { error: r.error } : {}), evidence };
    } finally { ectx.signal.removeEventListener("abort", onAbort); }
  }
}
