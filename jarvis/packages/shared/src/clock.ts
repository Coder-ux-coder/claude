/** All time in the core goes through a Clock so tests can simulate it (F18). */
export interface Clock {
  now(): number;               // epoch ms
  iso(): string;
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
  iso(): string { return new Date().toISOString(); }
}

export class SimClock implements Clock {
  private t: number;
  constructor(start: string | number = "2026-01-05T09:00:00Z") {
    this.t = typeof start === "number" ? start : Date.parse(start);
    if (Number.isNaN(this.t)) throw new Error(`invalid start time: ${start}`);
  }
  now(): number { return this.t; }
  iso(): string { return new Date(this.t).toISOString(); }
  set(iso: string | number): void { this.t = typeof iso === "number" ? iso : Date.parse(iso); }
  advance(ms: number): void { this.t += ms; }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** ISO 8601 duration (PnDTnHnMnS subset) to milliseconds. */
export function parseDuration(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m || d === "P" || d.endsWith("T")) throw new Error(`invalid ISO 8601 duration: ${d}`);
  return (Number(m[1] ?? 0) * DAY) + (Number(m[2] ?? 0) * HOUR) + (Number(m[3] ?? 0) * MINUTE) + Math.round(Number(m[4] ?? 0) * 1000);
}
