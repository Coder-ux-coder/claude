// Writes the canonical JSON Schema 2020-12 documents to jarvis/schemas/ from the
// zod definitions, so other languages (C# helpers, workers) share one contract.
// `--check` fails if the committed files are out of date.
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../src/index.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas");
const entries: Record<string, z.ZodType> = {
  "event/Event": S.JarvisEvent, "event/Correlation": S.Correlation, "event/EvidenceRecord": S.EvidenceRecord,
  "event/ArtifactRef": S.ArtifactRef, "event/ToolInvocation": S.ToolInvocation, "event/ResourceLease": S.ResourceLease,
  "event/UsageReport": S.UsageReport,
  "task/TaskContract": S.TaskContract, "task/PlanStep": S.PlanStep, "task/SuccessCriterion": S.SuccessCriterion,
  "task/Constraint": S.ConstraintSchema, "task/BudgetEnvelope": S.BudgetEnvelope, "task/AuthorizationEnvelope": S.AuthorizationEnvelope,
  "capability/CapabilityDescriptor": S.CapabilityDescriptor, "capability/CapabilityHealth": S.CapabilityHealth,
  "capability/ToolResult": S.ToolResult, "capability/StructuredError": S.StructuredError,
  "worker/WorkOrder": S.WorkOrder, "worker/WorkerResult": S.WorkerResult,
  "memory/MemoryRecord": S.MemoryRecord, "memory/OwnerProfile": S.OwnerProfile, "memory/Project": S.Project, "memory/Commitment": S.Commitment,
  "memory/Entity": S.Entity, "memory/Relationship": S.Relationship, "memory/Conversation": S.Conversation, "memory/Message": S.Message,
  "memory/ExperienceRecord": S.ExperienceRecord, "memory/MemoryCorrection": S.MemoryCorrection, "memory/DerivedSummary": S.DerivedSummary,
  "memory/MemoryProposal": S.MemoryProposal,
  "policy/OwnerRule": S.OwnerRule, "policy/AuthorizationDecision": S.AuthorizationDecision, "policy/DecisionRequest": S.DecisionRequest,
  "capability/ServicePolicy": S.ServicePolicy, "capability/ProcessRequest": S.ProcessRequest,
  "budget/Budget": S.Budget, "budget/UsageLedgerEntry": S.UsageLedgerEntry, "schedule/ScheduledJob": S.ScheduledJob,
  "nep/NepInvoke": S.NepInvoke, "nep/NepEvent": S.NepEvent, "nep/NepCancel": S.NepCancel,
  ...((S as unknown as { EXTRA_SCHEMAS?: Record<string, z.ZodType> }).EXTRA_SCHEMAS ?? {}),
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, schema] of Object.entries(entries)) {
  const doc = { $id: `https://jarvis.local/schemas/${name}.json`, title: name.split("/")[1], ...z.toJSONSchema(schema, { unrepresentable: "any" }) };
  const text = JSON.stringify(doc, null, 2) + "\n";
  const file = join(out, `${name}.json`);
  if (check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) { console.error(`stale: schemas/${name}.json`); stale++; }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
if (check && stale) { console.error(`${stale} schema file(s) out of date: run npm run schemas`); process.exit(1); }
console.log(check ? "schemas up to date" : `wrote ${Object.keys(entries).length} schemas to ${out}`);
