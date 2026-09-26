import { JarvisError } from "@jarvis/shared";
/**
 * Local ↔ UTC conversion in an IANA zone with the DST rules of 10 §15.2:
 * a local time that does not exist (spring-forward gap) shifts forward to the first valid
 * instant; a local time that occurs twice (fall back) resolves to its first occurrence
 * unless "second" is requested. Uses only Intl, so the OS/ICU timezone database applies.
 */
export interface LocalParts { y: number; mo: number; d: number; h: number; mi: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidZone(tz: string): boolean { try { fmt(tz); return true; } catch { return false; } }

/** Wall-clock parts of an instant in a zone. */
export function toLocal(epochMs: number, tz: string): LocalParts & { s: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(epochMs)).map(x => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** Offset (ms) of the zone at an instant: local wall time minus UTC. */
export function offsetAt(epochMs: number, tz: string): number {
  const l = toLocal(epochMs, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(epochMs / 1000) * 1000;
}

export type Resolution = { utc: number; kind: "normal" | "shifted_forward" | "ambiguous_first" | "ambiguous_second" } | { utc: null; kind: "skipped" };

/** Resolves a wall-clock time in a zone to UTC under the DST policy. */
export function localToUtc(l: LocalParts, tz: string, policy: { nonexistent: "shift_forward" | "skip"; ambiguous: "first" | "second" } = { nonexistent: "shift_forward", ambiguous: "first" }): Resolution {
  const naive = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  // Candidate offsets: the zone's offsets a day either side cover every transition.
  const offs = [...new Set([offsetAt(naive - 86_400_000, tz), offsetAt(naive, tz), offsetAt(naive + 86_400_000, tz)])];
  const matches = offs.map(o => naive - o).filter(u => { const x = toLocal(u, tz); return x.y === l.y && x.mo === l.mo && x.d === l.d && x.h === l.h && x.mi === l.mi; });
  const uniq = [...new Set(matches)].sort((a, b) => a - b);
  if (uniq.length === 1) return { utc: uniq[0]!, kind: "normal" };
  if (uniq.length >= 2) return policy.ambiguous === "first" ? { utc: uniq[0]!, kind: "ambiguous_first" } : { utc: uniq[uniq.length - 1]!, kind: "ambiguous_second" };
  if (policy.nonexistent === "skip") return { utc: null, kind: "skipped" };
  // In the gap: the first valid instant after it (e.g. 02:30 on a spring-forward night → 03:00 local).
  for (let m = 1; m <= 180; m++) {
    const probe = { ...l, mi: l.mi + m };
    const n2 = Date.UTC(probe.y, probe.mo - 1, probe.d, probe.h, probe.mi);
    const cand = [...new Set([offsetAt(n2 - 86_400_000, tz), offsetAt(n2 + 86_400_000, tz)])].map(o => n2 - o)
      .filter(u => { const x = toLocal(u, tz); const t = new Date(n2); return x.y === t.getUTCFullYear() && x.mo === t.getUTCMonth() + 1 && x.d === t.getUTCDate() && x.h === t.getUTCHours() && x.mi === t.getUTCMinutes(); });
    if (cand.length) return { utc: Math.min(...cand), kind: "shifted_forward" };
  }
  return { utc: null, kind: "skipped" };
}

export function parseLocal(s: string): LocalParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) throw new JarvisError("invalid_input", `bad local time ${s}`);
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! };
}
export function formatLocal(l: LocalParts): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(l.y, 4)}-${p(l.mo)}-${p(l.d)}T${p(l.h)}:${p(l.mi)}`;
}
