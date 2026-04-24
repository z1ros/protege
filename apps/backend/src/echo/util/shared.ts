/**
 * Shared helpers for echo widget aggregators. Keep this file pure — no I/O,
 * no globals. Each widget's aggregator composes these utilities on top of
 * the rows it reads from the store.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** yyyy-mm-dd → epoch ms at UTC midnight of that day. */
export function dateKeyToMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Inclusive sorted list of yyyy-mm-dd strings from start..end. */
export function rangeDates(startMs: number, endMs: number): string[] {
  if (endMs < startMs) return [];
  const startUtc = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate()
  );
  const endUtc = Date.UTC(
    new Date(endMs).getUTCFullYear(),
    new Date(endMs).getUTCMonth(),
    new Date(endMs).getUTCDate()
  );
  const out: string[] = [];
  for (let cursor = startUtc; cursor <= endUtc; cursor += DAY_MS) {
    out.push(dateKey(cursor));
  }
  return out;
}

/** Subtract N days (ms-aligned) and return a new ms. */
export function minusDays(ms: number, days: number): number {
  return ms - days * DAY_MS;
}

export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Format a minute count as "1h 42m" / "42m" / "0m". */
export function humanMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export { DAY_MS };
