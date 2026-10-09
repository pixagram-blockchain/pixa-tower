// Pure formulas used by the metrics. No I/O, unit-tested.

/** 2·min(U,D)/(U+D): 0 = unanimous, 1 = perfect split. */
export function controversy(up: number, down: number): number | null {
  const total = up + down;
  if (total <= 0) return null;
  return (2 * Math.min(up, down)) / total;
}

/** Gini coefficient of non-negative values (0 = equal, → 1 = one holder has all). */
export function gini(values: number[]): number | null {
  const xs = values.filter((x) => x > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  let weighted = 0;
  xs.forEach((x, i) => (weighted += (i + 1) * x));
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

/** Smallest number of holders whose combined share exceeds `threshold` of the total. */
export function nakamoto(values: number[], threshold = 0.5): number | null {
  const xs = values.filter((x) => x > 0).sort((a, b) => b - a);
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    acc += xs[i];
    if (acc / total > threshold) return i + 1;
  }
  return xs.length;
}

/** Share of the total held by the top `k` values. */
export function topShare(values: number[], k: number): number | null {
  const xs = values.filter((x) => x > 0).sort((a, b) => b - a);
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return xs.slice(0, k).reduce((a, b) => a + b, 0) / total;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** Shannon entropy in bits of a count distribution. */
export function entropy(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return -counts.filter((c) => c > 0).reduce((h, c) => h + (c / total) * Math.log2(c / total), 0);
}

/** Log-scale PXP buckets for the distribution chart. */
export const PXP_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0", min: 0, max: 0 },
  { label: "<1", min: Number.MIN_VALUE, max: 1 },
  { label: "1-10", min: 1, max: 10 },
  { label: "10-100", min: 10, max: 100 },
  { label: "100-1k", min: 100, max: 1_000 },
  { label: "1k-10k", min: 1_000, max: 10_000 },
  { label: "10k-100k", min: 10_000, max: 100_000 },
  { label: "100k-1M", min: 100_000, max: 1_000_000 },
  { label: "1M+", min: 1_000_000, max: Infinity },
];

export function pxpBucket(pxp: number): string {
  if (pxp <= 0) return "0";
  for (const b of PXP_BUCKETS.slice(1)) if (pxp >= b.min && pxp < b.max) return b.label;
  return "1M+";
}
