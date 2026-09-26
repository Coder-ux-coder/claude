import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Deterministic JSON: object keys sorted, undefined dropped. Used for hashes and fingerprints. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(x => (x === undefined ? null : sortValue(x)));
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortValue(x);
    }
    return out;
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function hmac(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
