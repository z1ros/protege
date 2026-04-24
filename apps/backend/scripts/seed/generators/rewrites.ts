import type { LineRewriteCounterRowStore } from "../../../src/store.js";
import type { Rng } from "../random.js";
import { FILES_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const MIN_MS = 60 * 1000;

interface Options {
  userId: string;
  nowMs: number;
  rng: Rng;
}

/**
 * Three rewrite counters — one clearly above the W10 threshold so the
 * widget lights up, two more to populate the tail.
 */
export function generateLineRewriteCounters(
  opts: Options
): LineRewriteCounterRowStore[] {
  const { userId, nowMs, rng } = opts;
  const files = rng.shuffle(LANGUAGES.flatMap((l) => FILES_BY_LANGUAGE[l])).slice(0, 3);
  const entries: Array<{ rewriteCount: number; content: string }> = [
    {
      rewriteCount: 7,
      content: "const result = await fetchUser(userId).then((u) => u ?? defaultUser);",
    },
    {
      rewriteCount: 4,
      content: "return items.filter((x) => x.active).map((x) => x.id);",
    },
    {
      rewriteCount: 3,
      content: "if (!config || !config.enabled) return null;",
    },
  ];
  return entries.map((e, i) => ({
    userId,
    filePath: files[i] ?? files[0],
    lineFingerprint: rng.hex(16),
    rewriteCount: e.rewriteCount,
    lastContent: e.content,
    lastRewriteAt: new Date(nowMs - rng.int(5, 240) * MIN_MS).toISOString(),
  }));
}
