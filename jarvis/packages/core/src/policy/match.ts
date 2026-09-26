import type { PolicyCondition, ResourceSelector } from "@jarvis/shared";

/** Dotted-path field lookup: "recipient.relationship" in { recipient: { relationship: [...] } }. */
export function getField(fields: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  let cur: unknown = fields;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
}

function hhmm(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Evaluates a PolicyCondition. Returns "unknown" when a referenced field is missing or
 * mistyped, so callers fail closed: a deny rule treats unknown as a match, a standing
 * permission treats it as no match.
 */
export function evalCondition(c: PolicyCondition, fields: Record<string, unknown>): boolean | "unknown" {
  if ("all" in c) { let unk = false; for (const x of c.all) { const r = evalCondition(x, fields); if (r === false) return false; if (r === "unknown") unk = true; } return unk ? "unknown" : true; }
  if ("any" in c) { let unk = false; for (const x of c.any) { const r = evalCondition(x, fields); if (r === true) return true; if (r === "unknown") unk = true; } return unk ? "unknown" : false; }
  if ("not" in c) { const r = evalCondition(c.not, fields); return r === "unknown" ? "unknown" : !r; }
  const { found, value } = getField(fields, c.field);
  if (!found) return "unknown";
  const arr = (x: unknown) => Array.isArray(x) ? x : [x];
  switch (c.op) {
    case "==": return JSON.stringify(value) === JSON.stringify(c.value);
    case "!=": return JSON.stringify(value) !== JSON.stringify(c.value);
    case "<": case "<=": case ">": case ">=": {
      if (typeof value !== "number" || typeof c.value !== "number") return "unknown";
      return c.op === "<" ? value < c.value : c.op === "<=" ? value <= c.value : c.op === ">" ? value > c.value : value >= c.value;
    }
    case "in": return arr(value).some(v => (c.value as unknown[] ?? []).some(x => JSON.stringify(x) === JSON.stringify(v)));
    case "not_in": return !arr(value).some(v => (c.value as unknown[] ?? []).some(x => JSON.stringify(x) === JSON.stringify(v)));
    case "matches": return typeof value === "string" && typeof c.value === "string" ? new RegExp(c.value).test(value) : "unknown";
    case "within": {
      const w = c.value as { from?: string; to?: string } | null;
      const v = hhmm(value), f = hhmm(w?.from), t = hhmm(w?.to);
      if (v === null || f === null || t === null) return "unknown";
      return f <= t ? v >= f && v < t : v >= f || v < t;   // windows may wrap midnight
    }
  }
}

/** Checks a condition's structure: ops and value types (04 §10.4 step 3). */
export function typeCheckCondition(c: PolicyCondition): string[] {
  const errs: string[] = [];
  const walk = (x: PolicyCondition) => {
    if ("all" in x) return x.all.forEach(walk);
    if ("any" in x) return x.any.forEach(walk);
    if ("not" in x) return walk(x.not);
    if (!x.field) errs.push("condition without a field");
    if ((x.op === "in" || x.op === "not_in") && !Array.isArray(x.value)) errs.push(`${x.field}: "${x.op}" needs a list`);
    if (["<", "<=", ">", ">="].includes(x.op) && typeof x.value !== "number") errs.push(`${x.field}: "${x.op}" needs a number`);
    if (x.op === "within") { const w = x.value as { from?: string; to?: string }; if (hhmm(w?.from) === null || hhmm(w?.to) === null) errs.push(`${x.field}: "within" needs { from: "HH:MM", to: "HH:MM" }`); }
    if (x.op === "matches") { try { new RegExp(String(x.value)); } catch { errs.push(`${x.field}: invalid pattern`); } }
  };
  walk(c);
  return errs;
}

/** Capability pattern: "tool:gmail.send", "tool:gdrive.permissions.*", "skill:travel.book_rail@^1", "tool:x@1.2.0". */
export function capabilityMatches(pattern: string, capability: string): boolean {
  const [pid, prange] = pattern.split("@") as [string, string | undefined];
  const [cid, cver] = capability.split("@") as [string, string | undefined];
  const re = new RegExp("^" + pid.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  if (!re.test(cid)) return false;
  if (!prange) return true;
  if (!cver) return false;
  const [maj, min] = cver.split(".").map(Number);
  if (prange.startsWith("^")) return maj === Number(prange.slice(1).split(".")[0]);
  if (prange.startsWith("~")) { const [a, b] = prange.slice(1).split(".").map(Number); return maj === a && min === b; }
  return prange === cver;
}

export function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+/g, "\\").toLowerCase();
}

/** Does a target resource fall under a rule's selector? Paths are compared normalized and case-insensitive. */
export function resourceMatches(rule: ResourceSelector, target: ResourceSelector): boolean {
  if ("path_prefix" in rule && "path_prefix" in target) {
    const r = normPath(rule.path_prefix), t = normPath(target.path_prefix);
    return t === r || t.startsWith(r.endsWith("\\") ? r : r + "\\");
  }
  if ("site" in rule && "site" in target) { const r = rule.site.toLowerCase(), t = target.site.toLowerCase(); return t === r || t.endsWith("." + r); }
  if ("account" in rule && "account" in target) return rule.account === target.account;
  if ("entity" in rule && "entity" in target) return rule.entity === target.entity;
  if ("app" in rule && "app" in target) return rule.app.toLowerCase() === target.app.toLowerCase();
  if ("recipient_set" in rule && "recipient_set" in target) return rule.recipient_set === target.recipient_set;
  return false;
}

/** Local wall time "HH:MM" in an IANA zone. */
export function localTime(epochMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(epochMs));
  return `${parts.find(p => p.type === "hour")!.value}:${parts.find(p => p.type === "minute")!.value}`;
}
