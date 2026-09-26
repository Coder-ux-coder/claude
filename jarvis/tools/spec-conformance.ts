// Review tool: compares the field names of every `interface X { ... }` in the
// specification (docs/jarvis/*.md) with the zod schema of the same name.
// Reports fields missing from the code and fields the spec doesn't have.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as S from "../packages/shared/src/index.js";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "jarvis");
const text = readdirSync(docs).filter(f => f.endsWith(".md")).map(f => readFileSync(join(docs, f), "utf8")).join("\n");

function specFields(name: string): string[] | null {
  const re = new RegExp(`interface ${name}\\s*(?:extends [^{]+)?\\{`, "g");
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, body = "";
  while (i < text.length && depth > 0) { const c = text[i]!; if (c === "{") depth++; if (c === "}") depth--; if (depth > 0) body += c; i++; }
  // Only top-level keys: drop nested braces/brackets/parens content.
  let top = "", d = 0;
  for (const c of body) { if ("{[(".includes(c)) d++; if (d === 0) top += c; if ("}])".includes(c)) d--; }
  top = top.replace(/\/\/[^\n]*/g, "");
  const keys = [...top.matchAll(/(?:^|[;\n,])\s*([a-z_][a-z0-9_]*)\??\s*:/gi)].map(x => x[1]!);
  return [...new Set(keys)];
}

const pairs: Record<string, z.ZodType> = (globalThis as any).__PAIRS ?? {
  TaskContract: S.TaskContract, SuccessCriterion: S.SuccessCriterion, Constraint: S.ConstraintSchema, TaskOverride: S.TaskOverride,
  BudgetEnvelope: S.BudgetEnvelope, PlanStep: S.PlanStep, AuthorizationEnvelope: S.AuthorizationEnvelope,
  Correlation: S.Correlation, Event: S.JarvisEvent, EvidenceRecord: S.EvidenceRecord, ArtifactRef: S.ArtifactRef,
  ToolInvocation: S.ToolInvocation, ResourceLease: S.ResourceLease, UsageReport: S.UsageReport,
  CapabilityDescriptor: S.CapabilityDescriptor, CapabilityHealth: S.CapabilityHealth, ToolResult: S.ToolResult,
  StructuredError: S.StructuredError, WorkOrder: S.WorkOrder, WorkerResult: S.WorkerResult, NepInvoke: S.NepInvoke,
  Money: S.Money, Retention: S.Retention, Provenance: S.Provenance, SourceRef: S.SourceRef, RecordTimes: S.RecordTimes,
  ...((S as any).SPEC_PAIRS ?? {}),
};

let problems = 0;
for (const [name, schema] of Object.entries(pairs)) {
  const spec = specFields(name);
  if (!spec) { console.log(`?  ${name}: no interface in spec`); continue; }
  const shape = (schema as any).shape ?? (schema as any)._zod?.def?.shape;
  if (!shape) { console.log(`?  ${name}: schema has no object shape`); continue; }
  const code = Object.keys(shape);
  const missing = spec.filter(k => !code.includes(k));
  const extra = code.filter(k => !spec.includes(k));
  if (missing.length || extra.length) { problems++; console.log(`X  ${name}: missing [${missing}] extra [${extra}]`); }
  else console.log(`ok ${name} (${code.length} fields)`);
}
console.log(problems ? `${problems} mismatch(es)` : "all interfaces match the specification");
process.exit(problems ? 1 : 0);
