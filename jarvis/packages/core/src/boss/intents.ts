import { z } from "zod";
import { EFFECT_CLASSES } from "@jarvis/shared";

// Structured output of the Intent Interpreter (02 §7.1, §7.3). Validated deterministically.

export const IntentBound = z.object({
  field: z.string().describe("what is bounded, e.g. amount.amount, recipients, date, destination"),
  op: z.enum(["<=", ">=", "==", "in", "not_in", "between", "matches"]),
  value: z.unknown(),
  quote: z.string().describe("the exact words from the owner's message this bound comes from"),
});

export const IntentCriterion = z.object({
  description: z.string(),
  check_kind: z.enum(["file_exists", "file_content", "service_readback", "confirmation_captured", "tests_pass", "postcondition", "model_judgement", "owner_confirmation"]),
  spec: z.record(z.string(), z.unknown()),
  required: z.boolean(),
});

export const Intent = z.object({
  kind: z.enum(["reply", "new_task", "steer_task", "control", "remember", "correct_memory", "set_rule", "schedule", "question", "save_skill"]),
  text: z.string().describe("reply text, question, or the owner's words for this intent"),
  // new_task / steer_task
  objective: z.string().optional(),
  mode: z.enum(["advise", "plan", "research", "draft", "prepare", "execute", "monitor", "build"]).optional(),
  effects: z.array(z.enum(EFFECT_CLASSES)).optional(),
  is_example_or_requirement: z.boolean().optional().describe("true when the owner describes something JARVIS should be able to do, rather than asking for it now"),
  bounds: z.array(IntentBound).optional(),
  scope_paths: z.array(z.string()).optional(),
  success_criteria: z.array(IntentCriterion).optional(),
  open_questions: z.array(z.object({ question: z.string(), why_material: z.string() })).optional(),
  assumptions: z.array(z.object({ text: z.string(), material: z.boolean() })).optional(),
  entity_names: z.array(z.string()).optional(),
  deadline: z.string().optional(),
  task_ref: z.string().optional(),
  // control
  op: z.enum(["pause", "resume", "cancel"]).optional(),
  // remember / correct_memory
  memory: z.object({
    type: z.enum(["fact", "preference"]), statement: z.string(), key: z.string().describe("predicate for facts, domain for preferences"), value: z.unknown(),
    preference_kind: z.enum(["taste", "requirement"]).optional(), scope: z.enum(["global", "entity", "project"]), scope_entity_names: z.array(z.string()).optional(),
    sensitivity: z.enum(["normal", "personal", "sensitive", "restricted"]).optional(),
    generalization_limit: z.string().optional(), target_hint: z.string().optional(),
  }).optional(),
  // set_rule
  rule: z.object({
    kind: z.enum(["guidance", "constraint", "standing_permission", "exception"]), effects: z.array(z.enum(EFFECT_CLASSES)),
    decision: z.enum(["allow", "deny", "require_decision", "require_presence"]), path_prefixes: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(), max_amount: z.object({ amount: z.number(), currency: z.string() }).optional(),
    interpretation: z.string(), vague: z.boolean(),
  }).optional(),
  // schedule
  schedule: z.object({ kind: z.enum(["alarm", "reminder", "task"]), text: z.string(), at_local: z.string().optional(), rrule: z.string().optional(), tz: z.string().optional() }).optional(),
  // save_skill ("save this as a skill"): which literal values in the task become parameters
  skill: z.object({ name: z.string(), description: z.string(),
    parameters: z.array(z.object({ name: z.string().describe("snake_case"), value: z.string().describe("the exact literal from the task to replace"), description: z.string().optional() })) }).optional(),
});
export type Intent = z.infer<typeof Intent>;

export const Intents = z.object({ intents: z.array(Intent).min(1) });
export type Intents = z.infer<typeof Intents>;

export const PlanProposal = z.object({
  steps: z.array(z.object({
    id: z.string(), kind: z.enum(["tool", "skill", "worker", "ask_owner", "reason", "verify", "wait"]),
    description: z.string(), capability: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(),
    missing_capability: z.object({ intent: z.string(), inputs: z.string(), outputs: z.string(), effects: z.array(z.enum(EFFECT_CLASSES)) }).optional()
      .describe('only with capability "gap": the capability this step needs that does not exist yet'),
    depends_on: z.array(z.string()), criteria_ids: z.array(z.string()).optional(), resources: z.array(z.string()).optional(),
  })).min(1),
});
export type PlanProposal = z.infer<typeof PlanProposal>;

export const jsonOf = (s: z.ZodType) => z.toJSONSchema(s, { unrepresentable: "any" }) as Record<string, unknown>;
