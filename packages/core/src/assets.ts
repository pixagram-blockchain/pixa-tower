// Asset parsing for the Pixa chain.
// Amounts are kept as integers in the asset's smallest unit:
// PIXA and PXS have 3 decimals, VESTS has 6.
// The chain and the public gateway return amounts in two forms:
//   legacy string  "1.000 PIXA"
//   NAI object     {"amount":"1000","precision":3,"nai":"@@000000021"}
// The gateway may also rewrite Hive's symbols, so both families are accepted.

export type AssetSymbol = "PIXA" | "PXS" | "VESTS";

export interface Amount {
  amount: number; // integer, smallest unit
  asset: AssetSymbol;
}

const NAI: Record<string, AssetSymbol> = {
  "@@000000021": "PIXA",
  "@@000000013": "PXS",
  "@@000000037": "VESTS",
};

const SYMBOL: Record<string, AssetSymbol> = {
  PIXA: "PIXA",
  PXS: "PXS",
  VESTS: "VESTS",
  HIVE: "PIXA",
  STEEM: "PIXA",
  TESTS: "PIXA",
  HBD: "PXS",
  SBD: "PXS",
  TBD: "PXS",
};

export const PRECISION: Record<AssetSymbol, number> = { PIXA: 3, PXS: 3, VESTS: 6 };

function decimalToInt(text: string, precision: number): number {
  const neg = text.startsWith("-");
  const clean = neg ? text.slice(1) : text;
  const [whole, frac = ""] = clean.split(".");
  const padded = (frac + "0".repeat(precision)).slice(0, precision);
  const value = Number(whole) * 10 ** precision + Number(padded || "0");
  return neg ? -value : value;
}

/** Parse any amount form. Returns null for anything that is not an amount. */
export function parseAmount(raw: unknown): Amount | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s+([A-Z]+)$/);
    if (!m) return null;
    const asset = SYMBOL[m[2]];
    if (!asset) return null;
    return { amount: decimalToInt(m[1], PRECISION[asset]), asset };
  }
  if (Array.isArray(raw) && raw.length === 3) {
    // [amount, precision, nai] legacy array form
    const asset = NAI[String(raw[2])];
    if (!asset) return null;
    return { amount: Number(raw[0]), asset };
  }
  if (typeof raw === "object") {
    const o = raw as { amount?: unknown; nai?: unknown; precision?: unknown };
    if (o.amount === undefined || o.nai === undefined) return null;
    const asset = NAI[String(o.nai)];
    if (!asset) return null;
    return { amount: Number(o.amount), asset };
  }
  return null;
}

/** Amount of a given asset, or 0 when absent or of another asset. */
export function amountOf(raw: unknown, asset: AssetSymbol): number {
  const a = parseAmount(raw);
  return a && a.asset === asset ? a.amount : 0;
}

/** Convert a smallest-unit integer to a decimal number for display. */
export function toUnits(amount: number, asset: AssetSymbol): number {
  return amount / 10 ** PRECISION[asset];
}

export interface Price {
  base: Amount;
  quote: Amount;
}

export function parsePrice(raw: unknown): Price | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { base?: unknown; quote?: unknown };
  const base = parseAmount(o.base);
  const quote = parseAmount(o.quote);
  if (!base || !quote || base.amount === 0) return null;
  return { base, quote };
}

/** PIXA per PXS from a feed price (base PXS, quote PIXA; either orientation accepted). */
export function pixaPerPxs(price: Price): number {
  if (price.base.asset === "PXS" && price.quote.asset === "PIXA") {
    return toUnits(price.quote.amount, "PIXA") / toUnits(price.base.amount, "PXS");
  }
  if (price.base.asset === "PIXA" && price.quote.asset === "PXS") {
    return toUnits(price.base.amount, "PIXA") / toUnits(price.quote.amount, "PXS");
  }
  return NaN;
}

/** Pick the first present key: the gateway renames some fields (hbd → pxs, hive → pixa). */
export function pick<T = unknown>(obj: Record<string, unknown> | undefined | null, keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k] as T;
  }
  return undefined;
}
