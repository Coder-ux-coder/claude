import { randomBytes } from "node:crypto";

/** Prefixes for every stable ID in the system (docs/jarvis/README.md ID table). */
export const ID_PREFIXES = [
  "tsk", "stp", "act", "att", "wo", "ev", "evd", "art", "inv", "lse", "dev", "imp", "rls",
  "mem", "ent", "rel", "prj", "cmt", "cnv", "msg", "exp", "rul", "grt", "dec", "cap", "acc",
  "sch", "fire", "mon", "sug", "skr", "gap", "cand", "dwo", "usg", "prop", "cor", "bkp", "pld", "node", "ckp", "sum", "ctx", "cred", "bud", "use",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Time-sortable unique ID (ULID layout: 48-bit ms time + 80-bit randomness),
 * monotonic within the same millisecond. Example: tsk_01J9Z3K8Q2W5X7Y9A1B3C5D7E9
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRandom.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i]! < 31) { rand[i]!++; break; }
      rand[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from({ length: 16 }, (_, i) => bytes[i]! & 31);
  }
  lastTime = now; lastRandom = rand;
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = ENCODING[t % 32] + time; t = Math.floor(t / 32); }
  return `${prefix}_${time}${rand.map(n => ENCODING[n]).join("")}`;
}

export function idPrefix(id: string): string | undefined {
  const i = id.indexOf("_");
  return i > 0 ? id.slice(0, i) : undefined;
}

export function isId(id: unknown, prefix: IdPrefix): id is string {
  return typeof id === "string" && /^[a-z]+_[0-9A-Z]{26}$/.test(id) && idPrefix(id) === prefix;
}
