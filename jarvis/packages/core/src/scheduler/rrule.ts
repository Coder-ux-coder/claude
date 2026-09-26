import { JarvisError } from "@jarvis/shared";
import { formatLocal, toLocal, type LocalParts } from "./tz.js";

/**
 * RFC 5545 recurrence, the subset JARVIS schedules use, evaluated in LOCAL wall time
 * (floating schedules keep 08:30 across DST): FREQ=DAILY|WEEKLY|MONTHLY|YEARLY,
 * INTERVAL, BYDAY (MO..SU, with ±n for MONTHLY), BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE,
 * COUNT, UNTIL (local). Unsupported parts are rejected, never ignored.
 */
export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number;
  byday?: { wd: number; n?: number }[]; bymonthday?: number[]; bymonth?: number[]; byhour?: number[]; byminute?: number[];
  count?: number; until?: string;               // until: local "YYYY-MM-DDTHH:MM" (inclusive)
  wkst: number;                                  // week start (0 = Sunday); RFC 5545 default Monday
}
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ALLOWED = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL", "WKST"]);

/**
 * Parses a rule. `tz` converts a UTC UNTIL ("…Z") to local wall time; a date-only UNTIL
 * includes that whole day.
 */
export function parseRRule(s: string, tz = "UTC"): RRule {
  const parts = Object.fromEntries(s.replace(/^RRULE:/i, "").split(";").filter(Boolean).map(kv => { const [k, v] = kv.split("="); return [k!.toUpperCase(), v ?? ""]; }));
  for (const k of Object.keys(parts)) if (!ALLOWED.has(k)) throw new JarvisError("invalid_input", `unsupported RRULE part ${k}`);
  const freq = parts.FREQ as RRule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) throw new JarvisError("invalid_input", `unsupported FREQ ${parts.FREQ}`);
  const nums = (v?: string, lo = -Infinity, hi = Infinity) => v ? v.split(",").map(x => { const n = Number(x); if (!Number.isInteger(n) || n < lo || n > hi) throw new JarvisError("invalid_input", `bad RRULE value ${x}`); return n; }) : undefined;
  const wkst = parts.WKST ? DAYS.indexOf(parts.WKST.toUpperCase()) : 1;
  if (wkst < 0) throw new JarvisError("invalid_input", `bad WKST ${parts.WKST}`);
  const r: RRule = { freq, interval: Number(parts.INTERVAL ?? 1), wkst };
  if (!Number.isInteger(r.interval) || r.interval < 1) throw new JarvisError("invalid_input", "bad INTERVAL");
  if (parts.BYDAY) r.byday = parts.BYDAY.split(",").map(t => { const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(t.toUpperCase()); if (!m) throw new JarvisError("invalid_input", `bad BYDAY ${t}`); return { wd: DAYS.indexOf(m[2]!), ...(m[1] ? { n: Number(m[1]) } : {}) }; });
  const bmd = nums(parts.BYMONTHDAY, -31, 31); if (bmd) r.bymonthday = bmd;
  const bm = nums(parts.BYMONTH, 1, 12); if (bm) r.bymonth = bm;
  const bh = nums(parts.BYHOUR, 0, 23); if (bh) r.byhour = bh;
  const bmi = nums(parts.BYMINUTE, 0, 59); if (bmi) r.byminute = bmi;
  if (parts.COUNT) { r.count = Number(parts.COUNT); if (!Number.isInteger(r.count) || r.count < 1) throw new JarvisError("invalid_input", "bad COUNT"); }
  if (parts.UNTIL) r.until = normalizeUntil(parts.UNTIL, tz);
  if (r.count !== undefined && r.until) throw new JarvisError("invalid_input", "COUNT and UNTIL can't both be set");
  return r;
}

function normalizeUntil(v: string, tz: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?(Z)?)?$/.exec(v.trim());
  if (!m) throw new JarvisError("invalid_input", `bad UNTIL ${v}`);
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined) return `${y}-${mo}-${d}T23:59`;
  if (z) return formatLocal(toLocal(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!), tz));
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

const dow = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
const dim = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function dayMatches(r: RRule, y: number, mo: number, d: number): boolean {
  if (r.bymonth && !r.bymonth.includes(mo)) return false;
  if (r.bymonthday && !r.bymonthday.some(x => (x > 0 ? x : dim(y, mo) + 1 + x) === d)) return false;
  if (r.byday) {
    const wd = dow(y, mo, d);
    const ok = r.byday.some(b => {
      if (b.wd !== wd) return false;
      if (b.n === undefined) return true;
      const nth = Math.ceil(d / 7), fromEnd = -Math.ceil((dim(y, mo) - d + 1) / 7);
      return b.n === nth || b.n === fromEnd;
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * All occurrences (local wall times) after `afterLocal` (exclusive), anchored at `startLocal`
 * for INTERVAL and COUNT. Returns at most `limit` items.
 */
export function occurrences(r: RRule, startLocal: LocalParts, afterLocal: string | null, limit = 1, maxDays = 366 * 5): string[] {
  const out: string[] = [];
  const hours = r.byhour ?? [startLocal.h], minutes = r.byminute ?? [startLocal.mi];
  const startKey = formatLocal(startLocal);
  let emitted = 0;
  const base = Date.UTC(startLocal.y, startLocal.mo - 1, startLocal.d);
  // Without COUNT, start near the cursor (a rule never stops after `maxDays`); with COUNT, from the start.
  const afterDay = afterLocal ? Date.UTC(+afterLocal.slice(0, 4), +afterLocal.slice(5, 7) - 1, +afterLocal.slice(8, 10)) : base;
  const first = r.count === undefined ? Math.max(0, Math.floor((afterDay - base) / 86_400_000) - 1) : 0;
  const startWeekday = (dow(startLocal.y, startLocal.mo, startLocal.d) - (r.wkst ?? 1) + 7) % 7;
  for (let i = first; i < first + maxDays * (r.freq === "YEARLY" ? 3 : 1); i++) {
    const t = new Date(base + i * 86_400_000);
    const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate();
    // INTERVAL: period index from the start.
    const period = r.freq === "DAILY" ? i : r.freq === "WEEKLY" ? Math.floor((i + startWeekday) / 7)
      : r.freq === "MONTHLY" ? (y - startLocal.y) * 12 + (mo - startLocal.mo) : y - startLocal.y;
    if (period % r.interval !== 0) continue;
    let matches: boolean;
    if (r.freq === "DAILY") matches = dayMatches(r, y, mo, d);
    else if (r.freq === "WEEKLY") matches = r.byday ? dayMatches(r, y, mo, d) : dow(y, mo, d) === dow(startLocal.y, startLocal.mo, startLocal.d) && dayMatches({ ...r, byday: undefined } as RRule, y, mo, d);
    else if (r.freq === "MONTHLY") matches = r.byday || r.bymonthday ? dayMatches(r, y, mo, d) : d === startLocal.d;
    else matches = r.byday || r.bymonthday || r.bymonth ? dayMatches({ ...r, bymonth: r.bymonth ?? [startLocal.mo] }, y, mo, d) && (r.bymonthday || r.byday ? true : d === startLocal.d) : mo === startLocal.mo && d === startLocal.d;
    if (!matches) continue;
    for (const h of [...hours].sort((a, b) => a - b)) for (const mi of [...minutes].sort((a, b) => a - b)) {
      const key = formatLocal({ y, mo, d, h, mi });
      if (key < startKey) continue;
      if (r.until && key > r.until) return out;
      emitted++;
      if (r.count !== undefined && emitted > r.count) return out;
      if (afterLocal === null || key > afterLocal) { out.push(key); if (out.length >= limit) return out; }
    }
  }
  return out;
}
