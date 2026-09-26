import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { CapabilityDescriptor, JarvisError, type DevWorkOrder } from "@jarvis/shared";

/**
 * A generated capability package (contract "jarvis.capability/1"). The runtime protocol for
 * a node T2 tool: `node <entry>` reads the params as JSON on stdin and writes one JSON line
 * on stdout: {"status":"ok","output":…} or {"status":"error","error":{"code":…,"message":…}}.
 */
export const PackageManifest = z.object({
  schema: z.literal("jarvis.package/1"),
  id: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtime: z.literal("node"),
  entry: z.string().regex(/^[A-Za-z0-9_./-]+\.(m?js|cjs)$/),
  tests: z.string().default("test"),
  descriptor: CapabilityDescriptor.partial(),
}).strict();
export type PackageManifest = z.infer<typeof PackageManifest>;

export const MANIFEST_FILE = "jarvis-package.json";
const MAX_FILES = 2000, MAX_BYTES = 50 * 1024 * 1024;

/** Files of a package (relative, sorted); symlinks are refused so nothing points outside it. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  let bytes = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new JarvisError("invalid_input", `symbolic link in package: ${relative(dir, p)}`);
      if (st.isDirectory()) { if (name !== ".git") walk(p); continue; }
      out.push(relative(dir, p).split(sep).join("/"));
      bytes += st.size;
      if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new JarvisError("invalid_input", "package too large");
    }
  };
  walk(dir);
  return out;
}

/** Content address: sha256 over every relative path and its bytes. */
export function packageHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of listFiles(dir)) { h.update(f); h.update("\0"); h.update(readFileSync(join(dir, f))); h.update("\0"); }
  return `sha256:${h.digest("hex")}`;
}

export function readManifest(dir: string): PackageManifest {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")); }
  catch (e) { throw new JarvisError("invalid_input", `${MANIFEST_FILE}: ${(e as Error).message}`); }
  const r = PackageManifest.safeParse(raw);
  if (!r.success) throw new JarvisError("invalid_input", `${MANIFEST_FILE}: ${r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/**
 * The full descriptor for a candidate: the builder's draft, constrained by the work order.
 * The builder never decides its own tier, lifecycle, provenance or hash.
 */
export function candidateDescriptor(m: PackageManifest, wo: DevWorkOrder, hash: string): CapabilityDescriptor {
  const d = { ...wo.dev.interface_contract.descriptor_draft, ...m.descriptor };
  return CapabilityDescriptor.parse({
    ...d,
    id: m.id, version: m.version, kind: "tool",
    package: { id: m.id.replace(/^tool:/, "pkg."), version: m.version, hash, provenance_ref: `workshop:${wo.work_order_id}` },
    input_schema: d.input_schema ?? wo.dev.interface_contract.input_schema,
    output_schema: d.output_schema ?? wo.dev.interface_contract.output_schema,
    isolation_tier: "T2", lifecycle: "under_test", admin_state: "enabled",
    environment: { node_kinds: ["windows_desktop"], requires_signed_in_session: false, requires_unlocked_desktop: false, ...(d.environment ?? {}),
      network: wo.dev.environment_constraints.network.runtime === "none" ? "none" : "internet" },
    prerequisites: d.prerequisites ?? {}, auth: d.auth ?? { type: "none", account_binding: "none" }, policy_scopes: d.policy_scopes ?? [],
    cost: d.cost ?? { kind: "free" }, cancellation: d.cancellation ?? "immediate", timeouts: d.timeouts ?? { default_s: 60, max_s: 300 },
    evidence_emitted: d.evidence_emitted ?? [], known_limitations: d.known_limitations ?? [],
  });
}

export function isText(file: string): boolean {
  return /\.(m?js|cjs|ts|json|md|txt|ya?ml|csv|html|css|sh|py|toml|ini|lock)$/i.test(file) || !/\.[a-z0-9]+$/i.test(file);
}

export const fileSize = (p: string) => statSync(p).size;
