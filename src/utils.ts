export const clamp = (n: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, n));

export const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function gaussian(meanValue = 50, stdDev = 18): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return meanValue + z * stdDev;
}

export const gene = (n: number): number => Math.round(clamp(n, 0, 99));

export function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  if (!items.length) throw new Error("weightedPick called with empty list");
  const weights = items.map((item) => Math.max(0.000001, weight(item)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export const iso = (d = new Date()): string => d.toISOString();

export function safeNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
