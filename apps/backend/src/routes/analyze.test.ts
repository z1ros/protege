import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * /analyze route — daily cost-cap enforcement contract.
 *
 * This file tests the SAVE-tier code-review endpoint's interaction with
 * the daily $ ceiling. Covered:
 *   - Each successful POST bumps `total_usd_estimate` by the cheap-tier
 *     cost of the LLM call's reported tokens.
 *   - Once today's row is at >= DAILY_USD_HARD_CAP, the route returns 429
 *     BEFORE invoking the LLM.
 *   - resolveUserId mismatch (body claims a different userId than the
 *     authenticated session) is rejected 403 with no LLM call and no
 *     cost bump.
 *   - Zero-token-usage responses do not bump the meter.
 *
 * Strategy mirrors `quotas.test.ts`: an in-memory Map stands in for
 * Supabase and is keyed by `${user_id}:${day}`. `callOneShot` is
 * intercepted with `vi.spyOn` so per-test return values + invocation
 * counts can be asserted.
 *
 * Auth: PROTEGE_AUTH_REQUIRED=true forces the route to actually use
 * `githubAuth` middleware. We stub global fetch so the GitHub token
 * lookup returns a deterministic numeric id, giving us a verified
 * userId on the request context for resolveUserId / enforceCostCapOnly.
 */

// ---------------------------------------------------------------------------
// In-memory Supabase mock — same chainable shape quotas.ts expects.
// ---------------------------------------------------------------------------
const fakeRows = new Map<string, Record<string, unknown>>();

function buildMockClient() {
  const builder = (_table: string) => {
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
      limit(_n: number) {
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

vi.mock("../supabase.js", () => ({
  getSupabase: () => buildMockClient(),
  isSupabaseEnabled: () => true,
}));

// ---------------------------------------------------------------------------
// callOneShot stub — controllable usage / text per test.
// ---------------------------------------------------------------------------
interface StubOneShotResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  modelUsed: string;
  providerUsed: "openai" | "anthropic";
}

const oneShotStub = vi.fn(
  async (..._args: unknown[]): Promise<StubOneShotResult> => ({
    text: '{"findings":[]}',
    usage: { inputTokens: 1000, outputTokens: 200 },
    modelUsed: "gpt-5-nano",
    providerUsed: "openai",
  })
);

vi.mock("../llm.js", () => ({
  callOneShot: (...args: unknown[]) => oneShotStub(...args),
}));

// ---------------------------------------------------------------------------
// Constants + helpers.
// ---------------------------------------------------------------------------
const VERIFIED_USER = "55555";
const TOKEN = "test-bearer-token";

/** Today's UTC day, computed the same way quotas.ts computes it. We
 *  read it freshly per test rather than pinning fake timers — fake
 *  timers interact badly with `setTimeout`-based microtask flushes
 *  used to wait on the route's fire-and-forget cost write. */
function currentDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function rowKey(userId: string = VERIFIED_USER): string {
  return `${userId}:${currentDay()}`;
}

/** Yield long enough for the route's `void addCostUsd(...)` write to
 *  drain. Two macrotask hops cover read→upsert in the in-memory mock. */
async function flushAsyncWrites(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function seedRow(patch: Record<string, unknown>, userId: string = VERIFIED_USER) {
  const key = rowKey(userId);
  fakeRows.set(key, {
    user_id: userId,
    day: currentDay(),
    scan_calls: 0,
    teach_calls: 0,
    tts_calls: 0,
    stt_calls: 0,
    verify_calls: 0,
    classify_calls: 0,
    tool_calls: 0,
    voice_minutes: 0,
    chat_minutes: 0,
    total_usd_estimate: 0,
    ...(fakeRows.get(key) ?? {}),
    ...patch,
  });
}

/**
 * Build a fresh Hono app with the analyze route mounted at /analyze.
 * Mirrors how `index.ts` wires the route in production.
 */
async function buildApp() {
  const { analyzeRoute } = await import("./analyze.js");
  const app = new Hono();
  app.route("/analyze", analyzeRoute);
  return app;
}

function analyzeBody(overrides: Record<string, unknown> = {}) {
  return {
    file: {
      path: "src/foo.ts",
      language: "typescript",
      content: "console.log('hi')",
    },
    ...overrides,
  };
}

beforeEach(async () => {
  fakeRows.clear();
  oneShotStub.mockClear();
  oneShotStub.mockImplementation(async () => ({
    text: '{"findings":[]}',
    usage: { inputTokens: 1000, outputTokens: 200 },
    modelUsed: "gpt-5-nano",
    providerUsed: "openai",
  }));

  // Quotas must enforce, otherwise enforceCostCapOnly always allows.
  process.env.PROTEGE_QUOTAS = "on";
  // Auth must be required so githubAuth populates authenticatedUserId
  // and resolveUserId compares body.userId against the verified id.
  process.env.PROTEGE_AUTH_REQUIRED = "true";
  delete process.env.PROTEGE_ALLOW_DEV_USER;

  // Stub GitHub user-verification fetch. Returns the canonical verified
  // userId for any token presented. Individual tests can override.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ id: Number(VERIFIED_USER) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  // The auth middleware caches verified tokens for 5 min. Clear so no
  // bleed-over between tests.
  const { _resetAuthCacheForTests } = await import("../middleware/auth.js");
  _resetAuthCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PROTEGE_QUOTAS;
  delete process.env.PROTEGE_AUTH_REQUIRED;
});

// ---------------------------------------------------------------------------
// Happy path — first call under the cap creates / bumps the cost row.
// ---------------------------------------------------------------------------
describe("/analyze — happy path under cap", () => {
  it("bumps total_usd_estimate by the cheap-tier cost of reported tokens", async () => {
    const app = await buildApp();
    const { estimateCallCostUsd } = await import("../quotas.js");

    const inputTokens = 1500;
    const outputTokens = 250;
    oneShotStub.mockImplementationOnce(async () => ({
      text: '{"findings":[]}',
      usage: { inputTokens, outputTokens },
      modelUsed: "gpt-5-nano",
      providerUsed: "openai",
    }));

    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[] };
    expect(Array.isArray(body.findings)).toBe(true);

    expect(oneShotStub).toHaveBeenCalledTimes(1);
    // Pin assertion: the route MUST request cheap-tier so callOneShot
    // routes through OpenAI's gpt-5-nano (when OPENAI_API_KEY is set)
    // regardless of AI_PROVIDER. Dropping this flag silently bills
    // gpt-5-mini (or Haiku on Anthropic deploys) while addCostUsd
    // labels the call cheap-tier — under-billing by ~6×.
    const oneShotArgs = oneShotStub.mock.calls[0]?.[0] as { cheap?: boolean };
    expect(oneShotArgs.cheap).toBe(true);

    // The cost write is fire-and-forget (`void addCostUsd(...)`). Yield
    // a microtask so the floating promise resolves before we read state.
    await flushAsyncWrites();

    const expected = estimateCallCostUsd("cheap", inputTokens, outputTokens);
    const stored = fakeRows.get(rowKey()) as Record<string, number> | undefined;
    expect(stored).toBeDefined();
    expect(stored!.total_usd_estimate).toBeCloseTo(expected, 8);
  });
});

// ---------------------------------------------------------------------------
// Cap-tripped — pre-populated at >= DAILY_USD_HARD_CAP.
// ---------------------------------------------------------------------------
describe("/analyze — cap already tripped", () => {
  it("returns 429 BEFORE invoking the LLM when total_usd_estimate >= DAILY_USD_HARD_CAP", async () => {
    const { DAILY_USD_HARD_CAP } = await import("../quotas.js");
    seedRow({ total_usd_estimate: DAILY_USD_HARD_CAP });

    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(429);
    // Critically: gate must fire BEFORE billing.
    expect(oneShotStub).not.toHaveBeenCalled();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("daily quota exceeded");
    expect(body.reason).toBe("dollar-cap");
  });

  it("returns 429 even when total_usd_estimate is just over the cap", async () => {
    const { DAILY_USD_HARD_CAP } = await import("../quotas.js");
    seedRow({ total_usd_estimate: DAILY_USD_HARD_CAP + 0.01 });

    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(429);
    expect(oneShotStub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cap-near — at the boundary the call still goes through and the meter ticks.
// ---------------------------------------------------------------------------
describe("/analyze — cap-adjacent call", () => {
  it("allows the call when current spend is just under the cap, and the meter still ticks", async () => {
    const { DAILY_USD_HARD_CAP, estimateCallCostUsd } = await import("../quotas.js");
    const seedAmount = DAILY_USD_HARD_CAP - 0.01;
    seedRow({ total_usd_estimate: seedAmount });

    const inputTokens = 800;
    const outputTokens = 150;
    oneShotStub.mockImplementationOnce(async () => ({
      text: '{"findings":[]}',
      usage: { inputTokens, outputTokens },
      modelUsed: "gpt-5-nano",
      providerUsed: "openai",
    }));

    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(200);
    expect(oneShotStub).toHaveBeenCalledTimes(1);

    // Wait for the fire-and-forget cost write.
    await flushAsyncWrites();

    const expectedDelta = estimateCallCostUsd(
      "cheap",
      inputTokens,
      outputTokens
    );
    const stored = fakeRows.get(rowKey()) as Record<string, number>;
    expect(stored.total_usd_estimate).toBeCloseTo(
      seedAmount + expectedDelta,
      8
    );
  });
});

// ---------------------------------------------------------------------------
// Zero-usage no-op — short-circuit error path should not bump the meter.
// ---------------------------------------------------------------------------
describe("/analyze — zero-token-usage no-op", () => {
  it("does not bump total_usd_estimate when usage.inputTokens === 0 && outputTokens === 0", async () => {
    oneShotStub.mockImplementationOnce(async () => ({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      modelUsed: "gpt-5-nano",
      providerUsed: "openai",
    }));

    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(200);
    expect(oneShotStub).toHaveBeenCalledTimes(1);

    // Yield in case any (incorrect) write was scheduled.
    await flushAsyncWrites();

    const stored = fakeRows.get(rowKey()) as Record<string, number> | undefined;
    // Either no row was written, or the row exists with zero cost.
    expect(stored?.total_usd_estimate ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// userId spoofing — body claims a different userId than the verified one.
// ---------------------------------------------------------------------------
describe("/analyze — userId mismatch is rejected", () => {
  it("rejects with 403 when body.userId disagrees with the authenticated identity, no LLM call, no cost bump", async () => {
    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(analyzeBody({ userId: "user-B-not-the-real-one" })),
    });

    expect(res.status).toBe(403);
    expect(oneShotStub).not.toHaveBeenCalled();

    // Wait for any pending writes (there should be none).
    await flushAsyncWrites();

    // No row should have been created for either the verified or the
    // claimed userId — the request died at resolveUserId before any
    // billing path ran.
    expect(fakeRows.get(rowKey(VERIFIED_USER))).toBeUndefined();
    expect(fakeRows.get(rowKey("user-B-not-the-real-one"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Authentication required — no Bearer header → 401.
// ---------------------------------------------------------------------------
describe("/analyze — unauthenticated request", () => {
  it("returns 401 when no Authorization header is present, no LLM call, no cost bump", async () => {
    const app = await buildApp();
    const res = await app.request("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(analyzeBody({ userId: VERIFIED_USER })),
    });

    expect(res.status).toBe(401);
    expect(oneShotStub).not.toHaveBeenCalled();

    await flushAsyncWrites();
    expect(fakeRows.get(rowKey(VERIFIED_USER))).toBeUndefined();
  });
});
