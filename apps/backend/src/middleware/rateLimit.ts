/**
 * Lightweight per-bucket sliding-window rate limiter.
 *
 * Process-local — not multi-instance safe. Adequate as a runaway-guard
 * on routes that mutate per-user state from a single backend process.
 * Replace with a shared store (Redis, Supabase RPC, etc.) before horizontal
 * scale-out matters.
 *
 * The bucket key is the caller's responsibility — typically `userId` or a
 * fallback IP/header. Each call records `now` and prunes entries outside
 * the window. Returns true when the call is allowed, false when capped.
 */

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max calls per bucket per window. */
  max: number;
}

export function createRateLimiter(opts: RateLimitOptions) {
  const windows = new Map<string, number[]>();
  // Periodically drop empty buckets so the Map doesn't grow unbounded
  // for one-shot callers. Cheap because most users are sticky.
  let lastSweep = Date.now();
  const SWEEP_INTERVAL_MS = 5 * opts.windowMs;

  return function check(bucket: string): boolean {
    const now = Date.now();
    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      for (const [k, arr] of windows) {
        const live = arr.filter((t) => now - t < opts.windowMs);
        if (live.length === 0) windows.delete(k);
        else windows.set(k, live);
      }
      lastSweep = now;
    }
    const arr = windows.get(bucket) ?? [];
    const pruned = arr.filter((t) => now - t < opts.windowMs);
    if (pruned.length >= opts.max) {
      windows.set(bucket, pruned);
      return false;
    }
    pruned.push(now);
    windows.set(bucket, pruned);
    return true;
  };
}
