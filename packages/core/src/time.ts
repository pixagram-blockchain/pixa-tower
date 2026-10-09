// Time helpers. All times are UTC Unix seconds. Weeks start Monday (ISO 8601).

export type Grain = "hour" | "day" | "week" | "month";
export const GRAINS: Grain[] = ["hour", "day", "week", "month"];

/** Chain timestamps come without a zone ("2026-10-09T12:18:48") and are UTC. */
export function chainTime(ts: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + "Z";
  return Math.floor(Date.parse(iso) / 1000);
}

export function isoTime(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

export function bucketStart(sec: number, grain: Grain): number {
  const d = new Date(sec * 1000);
  switch (grain) {
    case "hour":
      return sec - (sec % 3600);
    case "day":
      return sec - (sec % 86400);
    case "week": {
      const day = sec - (sec % 86400);
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      return day - dow * 86400;
    }
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
}

export function bucketEnd(start: number, grain: Grain): number {
  switch (grain) {
    case "hour":
      return start + 3600;
    case "day":
      return start + 86400;
    case "week":
      return start + 7 * 86400;
    case "month": {
      const d = new Date(start * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
    }
  }
}

/** All bucket starts of a grain that intersect [from, to). */
export function bucketsBetween(from: number, to: number, grain: Grain): number[] {
  const out: number[] = [];
  for (let b = bucketStart(from, grain); b < to; b = bucketEnd(b, grain)) out.push(b);
  return out;
}

/** Parse an API time argument: ISO date/time or Unix seconds. */
export function parseTimeArg(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{9,11}$/.test(value)) return Number(value);
  const t = Date.parse(/T/.test(value) && !/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value + "Z" : value);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export const HOUR = 3600;
export const DAY = 86400;
