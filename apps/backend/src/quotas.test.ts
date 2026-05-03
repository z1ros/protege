import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quota system tests — simulate a full beta day of usage and prove the
 * caps, the reset, the cost accumulator, and the user-facing snapshot
 * shape all behave the way the plan promises.
 *
 * Strategy: stub `getSupabase()` with an in-memory Map keyed by
 * `${user_id}:${day}`. Every quotas.ts helper calls into `getSupabase()`
 * before reading/writing, so the mock fully owns the state for the test.
 *
 * What we deliberately avoid: hitting the real Supabase, hitting the
 * real Hono app. Pure-logic tests are fast and explain failures sharply.
 */

// In-memory rows keyed by `${user_id}:${day}`.
const fakeRows = new Map<string, Record<string, unknown>>();

// Mock Supabase BEFORE importing quotas.ts. The mock implements the
// chainable query shape quotas.ts uses: from().select().eq().eq()
// .maybeSingle() | .upsert() | .update().eq().eq().
function buildMockClient() {
  const builder = (table: string) => {
    let mode: "select" | "upsert" | "update" | null = null;
    let row: Record<string, unknown> | null = null;
    let updates: Record<string, unknown> | null = null;
    const filters: Array<{ col: string; val: unknown }> = [];

    const api: any = {
      select(_cols: string) {
        mode = "select";
        return api;
      },
      upsert(payload: Record<string, unknown>) {
        mode = "upsert";
        row = payload;
        return api;
      },
      update(payload: Record<string, unknown>) {
        mode = "update";
        updates = payload;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      async maybeSingle() {
        if (mode !== "select") return { data: null, error: null };
        const userId = String(filters.find((f) => f.col === "user_id")?.val ?? "");
        const day = String(filters.find((f) => f.col === "day")?.val ?? "");
        const key = `${userId}:${day}`;
        const existing = fakeRows.get(key) ?? null;
        return { data: existing, error: null };
      },
      // Fired implicitly when an `upsert` chain isn't `.maybeSingle()`'d
      // — emulate by making the chain itself awaitable.
      then(resolve: (r: { error: unknown }) => void) {
        if (mode === "upsert" && row) {
          const userId = String(row.user_id);
          const day = String(row.day);
          const key = `${userId}:${day}`;
          fakeRows.set(key, { ...(fakeRows.get(key) ?? {}), ...row });
        } else if (mode === "update" && updates) {
          const userId = String(filters.find((f) => f.col === "user_id")?.val ?? "");
          const day = String(filters.find((f) => f.col === "day")?.val ?? "");
          const key = `${userId}:${day}`;
          const existing = fakeRows.get(key) ?? { user_id: userId, day };
          fakeRows.set(key, { ...existing, ...updates });
        }
        resolve({ error: null });
      },
    };
    return api;
  };

  return {
    from: (table: string) => builder(table),
  };
}

vi.mock("./supabase.js", () => ({
  getSupabase: () => buildMockClient(),
  isSupabaseEnabled: () => true,
}));

beforeEach(() => {
  fakeRows.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const USER = "user-42";

// Helpful: pin "today" to a known UTC date so utcDay() is stable.
function pinDate(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

function todayKey(): string {
  return `${USER}:${new Date().toISOString().slice(0, 10)}`;
}

describe("quotas — checkAndIncrement", () => {
  it("first call creates the row and increments the right counter", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { checkAndIncrement } = await import("./quotas.js");
    const result = await checkAndIncrement(USER, "scan");
    expect(result.allowed).toBe(true);
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.scan_calls).toBe(1);
  });

  it("rejects when the route counter is at its limit", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { checkAndIncrement, QUOTA_LIMITS } = await import("./quotas.js");
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-04-29",
      scan_calls: QUOTA_LIMITS.scan, // already at cap
      total_usd_estimate: 0,
    });
    const result = await checkAndIncrement(USER, "scan");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("route-cap");
      expect(result.kind).toBe("scan");
      expect(result.used).toBe(QUOTA_LIMITS.scan);
      expect(result.limit).toBe(QUOTA_LIMITS.scan);
    }
  });

  it("rejects when the daily $ ceiling is exceeded", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { checkAndIncrement, DAILY_USD_HARD_CAP } = await import(
      "./quotas.js"
    );
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-04-29",
      scan_calls: 5,
      total_usd_estimate: DAILY_USD_HARD_CAP + 0.01,
    });
    const result = await checkAndIncrement(USER, "scan");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("dollar-cap");
  });

  it("counters are independent between routes", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { checkAndIncrement } = await import("./quotas.js");
    await checkAndIncrement(USER, "scan");
    await checkAndIncrement(USER, "scan");
    await checkAndIncrement(USER, "teach");
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.scan_calls).toBe(2);
    expect(stored.teach_calls).toBe(1);
  });

  it("a counter at its cap doesn't block a different counter", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { checkAndIncrement, QUOTA_LIMITS } = await import("./quotas.js");
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-04-29",
      teach_calls: QUOTA_LIMITS.teach,
      total_usd_estimate: 0,
    });
    const teachResult = await checkAndIncrement(USER, "teach");
    expect(teachResult.allowed).toBe(false);
    const scanResult = await checkAndIncrement(USER, "scan");
    expect(scanResult.allowed).toBe(true);
  });
});

describe("quotas — addCostUsd", () => {
  it("accumulates across calls", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd, checkAndIncrement } = await import("./quotas.js");
    await checkAndIncrement(USER, "teach"); // create the row
    await addCostUsd(USER, 0.0008);
    await addCostUsd(USER, 0.0012);
    await addCostUsd(USER, 0.005);
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.total_usd_estimate).toBeCloseTo(0.007, 6);
  });

  it("ignores non-positive deltas", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd, checkAndIncrement } = await import("./quotas.js");
    await checkAndIncrement(USER, "teach");
    await addCostUsd(USER, 0);
    await addCostUsd(USER, -1);
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.total_usd_estimate ?? 0).toBe(0);
  });
});

describe("quotas — counter helpers create the row when missing", () => {
  // Regression — addCostUsd / addToolCalls / addVoiceMinutes used to do
  // an UPDATE without a prior row, which silently no-op'd. That made
  // the panel show 0/100 forever when PROTEGE_QUOTAS was off (gate
  // path didn't pre-create the row). They're now UPSERTs.
  it("addCostUsd creates the row + sets the cost when none exists", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.0042);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.total_usd_estimate).toBeCloseTo(0.0042, 6);
  });
  it("addToolCalls creates the row + sets the count when none exists", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addToolCalls } = await import("./quotas.js");
    await addToolCalls(USER, 3);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.tool_calls).toBe(3);
  });
  it("addVoiceMinutes creates the row + sets the minutes when none exists", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addVoiceMinutes } = await import("./quotas.js");
    await addVoiceMinutes(USER, 1.25);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.voice_minutes).toBeCloseTo(1.25, 4);
  });
  it("addChatMinutes creates the row + accumulates fractional minutes", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addChatMinutes } = await import("./quotas.js");
    await addChatMinutes(USER, 0.5);
    await addChatMinutes(USER, 0.75);
    await addChatMinutes(USER, 1.0);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.chat_minutes).toBeCloseTo(2.25, 4);
  });
});

describe("quotas — addToolCalls", () => {
  it("accumulates tool-call counts in the user_quotas row", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addToolCalls, checkAndIncrement } = await import("./quotas.js");
    // Need a row to exist before addToolCalls can update it. The chat
    // route normally goes through checkAndIncrement first which creates
    // the row; reproduce that here.
    await checkAndIncrement(USER, "teach");

    await addToolCalls(USER, 3);
    await addToolCalls(USER, 2);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.tool_calls).toBe(5);
  });
});

describe("quotas — addVoiceMinutes + checkVoiceMinutesLimit", () => {
  it("accumulates fractional minutes and trips at the cap", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addVoiceMinutes, checkVoiceMinutesLimit, USER_FACING_LIMITS } =
      await import("./quotas.js");
    const { checkAndIncrement } = await import("./quotas.js");
    await checkAndIncrement(USER, "teach");

    expect((await checkVoiceMinutesLimit(USER)).allowed).toBe(true);
    // Push the user up to ~95% of the cap, then over.
    await addVoiceMinutes(USER, USER_FACING_LIMITS.voice_minutes * 0.95);
    expect((await checkVoiceMinutesLimit(USER)).allowed).toBe(true);
    // One more push past the cap.
    await addVoiceMinutes(USER, USER_FACING_LIMITS.voice_minutes * 0.1);
    const blocked = await checkVoiceMinutesLimit(USER);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.used).toBeGreaterThanOrEqual(USER_FACING_LIMITS.voice_minutes);
    }
  });
});

describe("quotas — daily reset", () => {
  it("a new UTC day creates a fresh row with zero counters", async () => {
    pinDate("2026-04-29T23:59:30Z");
    const { checkAndIncrement, getTodayQuota } = await import("./quotas.js");

    // Day 1 — accumulate a few calls.
    await checkAndIncrement(USER, "scan");
    await checkAndIncrement(USER, "teach");
    const day1 = await getTodayQuota(USER);
    expect(day1?.scan_calls).toBe(1);
    expect(day1?.teach_calls).toBe(1);
    const day1Key = todayKey();

    // Cross midnight.
    vi.setSystemTime(new Date("2026-04-30T00:00:30Z"));
    const day2 = await getTodayQuota(USER);
    // Different day → different key → row not found → zero defaults.
    expect(day2?.scan_calls ?? 0).toBe(0);
    expect(day2?.teach_calls ?? 0).toBe(0);

    // Day 1's row is still untouched in storage (we don't delete history).
    expect(fakeRows.get(day1Key)).toBeDefined();
    // Day 2's row doesn't exist yet until the first call lands.
    expect(fakeRows.has(todayKey())).toBe(false);

    // First call on day 2 creates the new row at 1, not 2.
    await checkAndIncrement(USER, "scan");
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.scan_calls).toBe(1);
  });

  it("nextResetMs lands at the next midnight UTC", async () => {
    pinDate("2026-04-29T15:30:00Z");
    const { nextResetMs } = await import("./quotas.js");
    const expected = new Date("2026-04-30T00:00:00Z").getTime();
    expect(nextResetMs()).toBe(expected);
  });
});

describe("quotas — snapshotFromRow user-facing shape", () => {
  it("exposes the 3 user-facing categories with the right limits", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { snapshotFromRow, USER_FACING_LIMITS, DAILY_USD_HARD_CAP } =
      await import("./quotas.js");
    const snap = snapshotFromRow(USER, {
      user_id: USER,
      day: "2026-04-29",
      scan_calls: 200, // not exposed in user-facing
      teach_calls: 32,
      tts_calls: 5,
      stt_calls: 3,
      verify_calls: 100, // not exposed
      classify_calls: 100, // not exposed
      tool_calls: 7,
      voice_minutes: 6.4,
      total_usd_estimate: 0.84,
    } as never);
    expect(snap.usage.chat_messages).toEqual({
      used: 32,
      limit: USER_FACING_LIMITS.chat_messages,
    });
    expect(snap.usage.tool_calls).toEqual({
      used: 7,
      limit: USER_FACING_LIMITS.tool_calls,
    });
    // voice_minutes is rounded to 1 decimal in the public snapshot.
    expect(snap.usage.voice_minutes).toEqual({
      used: 6.4,
      limit: USER_FACING_LIMITS.voice_minutes,
    });
    expect(snap.usage.cost).toEqual({ used: 0.84, limitUsd: DAILY_USD_HARD_CAP });
    // The internal-only counters are NOT on the user-facing shape.
    expect((snap.usage as Record<string, unknown>).scan_calls).toBeUndefined();
    expect((snap.usage as Record<string, unknown>).verify_calls).toBeUndefined();
    expect((snap.usage as Record<string, unknown>).classify_calls).toBeUndefined();
  });

  it("returns zeroed snapshot for a user with no row yet", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { snapshotFromRow, USER_FACING_LIMITS } = await import("./quotas.js");
    const snap = snapshotFromRow(USER, null);
    expect(snap.usage.chat_messages.used).toBe(0);
    expect(snap.usage.chat_messages.limit).toBe(USER_FACING_LIMITS.chat_messages);
    expect(snap.usage.tool_calls.used).toBe(0);
    expect(snap.usage.voice_minutes.used).toBe(0);
    expect(snap.usage.cost.used).toBe(0);
  });

  it("rounds voice minutes to 1 decimal so the panel reads cleanly", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { snapshotFromRow } = await import("./quotas.js");
    const snap = snapshotFromRow(USER, {
      user_id: USER,
      day: "2026-04-29",
      scan_calls: 0,
      teach_calls: 0,
      tts_calls: 0,
      stt_calls: 0,
      verify_calls: 0,
      classify_calls: 0,
      tool_calls: 0,
      voice_minutes: 6.42857,
      total_usd_estimate: 0,
    } as never);
    expect(snap.usage.voice_minutes.used).toBe(6.4);
  });
});

describe("quotas — full beta-day simulation", () => {
  it("realistic day: 50 scans + 12 chat turns + 8 tool calls + 4 min voice — all under cap", async () => {
    pinDate("2026-04-29T09:00:00Z");
    const { checkAndIncrement, addToolCalls, addCostUsd, addVoiceMinutes, getTodayQuota } =
      await import("./quotas.js");

    // 50 Live Review scans (cheap-tier /chat scans)
    for (let i = 0; i < 50; i++) {
      const r = await checkAndIncrement(USER, "scan");
      expect(r.allowed).toBe(true);
      await addCostUsd(USER, 0.0003); // ~mini per scan
    }
    // 12 chat turns, each does ~0.7 tool calls on average — 8 total
    for (let i = 0; i < 12; i++) {
      const r = await checkAndIncrement(USER, "teach");
      expect(r.allowed).toBe(true);
      await addCostUsd(USER, 0.012); // premium-tier teach
    }
    await addToolCalls(USER, 8);
    // 4 min of voice
    await addVoiceMinutes(USER, 4);

    const row = await getTodayQuota(USER);
    expect(row?.scan_calls).toBe(50);
    expect(row?.teach_calls).toBe(12);
    expect(row?.tool_calls).toBe(8);
    expect(row?.voice_minutes).toBe(4);
    // 50 * 0.0003 + 12 * 0.012 = 0.015 + 0.144 = 0.159
    expect(row?.total_usd_estimate).toBeCloseTo(0.159, 4);
    // Well under the 2.0 cap.
    expect(row?.total_usd_estimate).toBeLessThan(2);
  });

  it("hostile day: hits the chat cap, recovers across midnight", async () => {
    pinDate("2026-04-29T09:00:00Z");
    const { checkAndIncrement, USER_FACING_LIMITS } = await import("./quotas.js");

    // Drive the chat counter all the way to the cap.
    for (let i = 0; i < USER_FACING_LIMITS.chat_messages; i++) {
      const r = await checkAndIncrement(USER, "teach");
      expect(r.allowed).toBe(true);
    }
    // The next attempt should be blocked.
    const blocked = await checkAndIncrement(USER, "teach");
    expect(blocked.allowed).toBe(false);

    // Cross into a new UTC day.
    vi.setSystemTime(new Date("2026-04-30T00:00:30Z"));
    // First call on the new day — fresh row, allowed.
    const fresh = await checkAndIncrement(USER, "teach");
    expect(fresh.allowed).toBe(true);
  });
});

// ============================================================
// Tests added against the documented spec for ship-blocker-fixes.
// Spec: addCostUsd should clamp NaN/Infinity/negatives to safe values
// before writing them to the row. Token columns must always be finite,
// non-negative numbers. The function is a no-op when all inputs are
// zero/missing.
// ============================================================

describe("quotas — addCostUsd robustness against malformed inputs", () => {
  it("happy path — finite delta + tokens stored as expected sums", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.01, { prompt: 100, completion: 50 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.total_usd_estimate).toBeCloseTo(0.01, 6);
    expect(stored?.prompt_tokens).toBe(100);
    expect(stored?.completion_tokens).toBe(50);
    expect(stored?.total_tokens).toBe(150);
  });

  it("NaN deltaUsd with valid tokens — row written, total_usd_estimate is NOT NaN", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, Number.NaN, { prompt: 200, completion: 100 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored).toBeDefined();
    // Must be a finite number — not NaN.
    expect(Number.isFinite(stored?.total_usd_estimate)).toBe(true);
    expect(stored?.total_usd_estimate).toBeGreaterThanOrEqual(0);
    // Tokens still recorded normally.
    expect(stored?.prompt_tokens).toBe(200);
    expect(stored?.completion_tokens).toBe(100);
    expect(stored?.total_tokens).toBe(300);
  });

  it("NaN prompt token with valid completion — prompt_tokens + total_tokens are finite", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.005, { prompt: Number.NaN, completion: 50 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored).toBeDefined();
    expect(Number.isFinite(stored?.prompt_tokens)).toBe(true);
    expect(stored?.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stored?.total_tokens)).toBe(true);
    expect(stored?.total_tokens).toBeGreaterThanOrEqual(0);
    // completion still recorded
    expect(stored?.completion_tokens).toBe(50);
  });

  it("Infinity prompt — not stored as Infinity", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.005, { prompt: Number.POSITIVE_INFINITY, completion: 25 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored).toBeDefined();
    expect(Number.isFinite(stored?.prompt_tokens)).toBe(true);
    expect(stored?.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(stored?.prompt_tokens).not.toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(stored?.total_tokens)).toBe(true);
  });

  it("negative deltaUsd with no tokens — no row written (no-op)", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, -1);
    const stored = fakeRows.get(todayKey());
    expect(stored).toBeUndefined();
  });

  it("two consecutive calls accumulate prompt_tokens", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.01, { prompt: 50, completion: 10 });
    await addCostUsd(USER, 0.01, { prompt: 30, completion: 5 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.prompt_tokens).toBe(80);
    expect(stored?.completion_tokens).toBe(15);
    expect(stored?.total_tokens).toBe(95);
  });

  it("negative tokens are clamped to 0 (not persisted as negatives)", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addCostUsd } = await import("./quotas.js");
    await addCostUsd(USER, 0.005, { prompt: -100, completion: 50 });
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored).toBeDefined();
    expect(stored?.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(stored?.completion_tokens).toBe(50);
  });
});

describe("quotas — checkTokenLimit (2M daily ceiling, sole /chat gate)", () => {
  it("allows when no row exists yet (zero tokens used)", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { checkTokenLimit } = await import("./quotas.js");
    const r = await checkTokenLimit(USER);
    expect(r.allowed).toBe(true);
  });

  it("allows when total_tokens is below the 2M ceiling", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { checkTokenLimit, DAILY_TOKEN_DISPLAY_LIMIT } = await import("./quotas.js");
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-05-03",
      total_tokens: DAILY_TOKEN_DISPLAY_LIMIT - 1, // 1,999,999
    });
    const r = await checkTokenLimit(USER);
    expect(r.allowed).toBe(true);
  });

  it("blocks at exactly the 2M ceiling with kind:tokens + reason:token-cap", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { checkTokenLimit, DAILY_TOKEN_DISPLAY_LIMIT } = await import("./quotas.js");
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-05-03",
      total_tokens: DAILY_TOKEN_DISPLAY_LIMIT, // exactly 2M
    });
    const r = await checkTokenLimit(USER);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.kind).toBe("tokens");
      expect(r.reason).toBe("token-cap");
      expect(r.used).toBe(DAILY_TOKEN_DISPLAY_LIMIT);
      expect(r.limit).toBe(DAILY_TOKEN_DISPLAY_LIMIT);
      // resetAt must be the next 00:00 UTC.
      expect(r.resetAt).toBe(new Date("2026-05-04T00:00:00Z").getTime());
    }
  });

  it("blocks when total_tokens overshoots the cap (e.g. last call burst past 2M)", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { checkTokenLimit } = await import("./quotas.js");
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-05-03",
      total_tokens: 2_500_000,
    });
    const r = await checkTokenLimit(USER);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.used).toBe(2_500_000);
  });

  it("RESET behavior: hitting 2M today does not block tomorrow", async () => {
    pinDate("2026-05-03T23:59:30Z");
    const { checkTokenLimit, DAILY_TOKEN_DISPLAY_LIMIT } = await import("./quotas.js");

    // Today: cap maxed.
    fakeRows.set(todayKey(), {
      user_id: USER,
      day: "2026-05-03",
      total_tokens: DAILY_TOKEN_DISPLAY_LIMIT,
    });
    const blocked = await checkTokenLimit(USER);
    expect(blocked.allowed).toBe(false);

    // Cross UTC midnight — the gate now reads tomorrow's (nonexistent) row.
    vi.setSystemTime(new Date("2026-05-04T00:00:30Z"));
    const fresh = await checkTokenLimit(USER);
    expect(fresh.allowed).toBe(true);

    // Yesterday's exhausted row is still in storage (no migration needed).
    expect(
      (fakeRows.get(`${USER}:2026-05-03`) as Record<string, number>).total_tokens
    ).toBe(DAILY_TOKEN_DISPLAY_LIMIT);
    // Today's row hasn't been touched.
    expect(fakeRows.has(`${USER}:2026-05-04`)).toBe(false);
  });

  it("cap is per-user — userA hitting 2M does not block userB", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { checkTokenLimit, DAILY_TOKEN_DISPLAY_LIMIT } = await import("./quotas.js");
    fakeRows.set(`userA:2026-05-03`, {
      user_id: "userA",
      day: "2026-05-03",
      total_tokens: DAILY_TOKEN_DISPLAY_LIMIT,
    });
    const a = await checkTokenLimit("userA");
    const b = await checkTokenLimit("userB");
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
  });

  it("end-to-end: addCostUsd accumulates tokens, checkTokenLimit gates at 2M", async () => {
    pinDate("2026-05-03T12:00:00Z");
    const { addCostUsd, checkTokenLimit, DAILY_TOKEN_DISPLAY_LIMIT } = await import("./quotas.js");

    // Burn 1.9M in two chunks — still allowed.
    await addCostUsd(USER, 5.0, { prompt: 800_000, completion: 200_000 });
    await addCostUsd(USER, 5.0, { prompt: 700_000, completion: 200_000 });
    expect((await checkTokenLimit(USER)).allowed).toBe(true);

    // Push past 2M.
    await addCostUsd(USER, 1.0, { prompt: 100_000, completion: 50_000 });
    const stored = fakeRows.get(todayKey()) as Record<string, number>;
    expect(stored.total_tokens).toBeGreaterThanOrEqual(DAILY_TOKEN_DISPLAY_LIMIT);
    const blocked = await checkTokenLimit(USER);
    expect(blocked.allowed).toBe(false);
  });
});

describe("quotas — addToolCalls (post-2026-05-02 cap removal)", () => {
  it("delta = 0 is a no-op", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addToolCalls } = await import("./quotas.js");
    await addToolCalls(USER, 0);
    const stored = fakeRows.get(todayKey());
    expect(stored).toBeUndefined();
  });

  it("multiple calls accumulate without cap", async () => {
    pinDate("2026-04-29T12:00:00Z");
    const { addToolCalls } = await import("./quotas.js");
    await addToolCalls(USER, 5);
    await addToolCalls(USER, 7);
    await addToolCalls(USER, 3);
    const stored = fakeRows.get(todayKey()) as Record<string, number> | undefined;
    expect(stored?.tool_calls).toBe(15);
  });
});
