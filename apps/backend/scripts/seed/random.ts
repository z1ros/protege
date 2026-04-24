/**
 * Seeded pseudo-random number generator (mulberry32). Deterministic: same
 * seed produces identical output across runs. ~10 lines of entropy, fine
 * for fixture generation.
 */
export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  float(minInclusive: number, maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
  hex(length: number): string;
  bool(pTrue: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number =>
    Math.floor(next() * (hi - lo + 1)) + lo;
  const float = (lo: number, hi: number): number => lo + next() * (hi - lo);
  const pick = <T,>(arr: readonly T[]): T => arr[int(0, arr.length - 1)];
  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const hex = (length: number): string => {
    const chars = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < length; i += 1) s += chars[int(0, 15)];
    return s;
  };
  const bool = (p: number): boolean => next() < p;
  return { next, int, float, pick, shuffle, hex, bool };
}
