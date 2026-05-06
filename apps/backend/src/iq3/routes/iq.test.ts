import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * /iq/* auth contract tests — Codex Finding F1 (IDOR).
 *
 * Before this fix the routes read x-user-id / ?userId= / body.userId
 * directly. The fix routes everything through `githubAuth()` +
 * `resolveUserId()` (the same pattern /echo, /analyze, /notes use), with
 * the sole exception of GET /iq/taxonomy which is static schema.
 *
 * What we cover:
 *   - GET  /iq/me          → 401 without Bearer
 *   - GET  /iq/me          → uses verified token id even if ?userId=other
 *   - GET  /iq/me          → 403 if x-user-id disagrees with token
 *   - POST /iq/onboarding  → 401 without Bearer; 403 on userId mismatch
 *   - POST /iq/self-rating → 401 without Bearer
 *   - POST /iq/self-rating → persists token's userId, NOT body.userId
 *   - GET  /iq/taxonomy    → 200 without Bearer (public)
 *
 * Strategy mirrors `routes/analyze.test.ts`:
 *   - PROTEGE_AUTH_REQUIRED=true forces real githubAuth gating.
 *   - Global fetch is stubbed to return a deterministic GitHub id.
 *   - The iq3 user-state repo is replaced with an in-memory stub.
 */

import type { Iq3UserState } from "@protege/types";

const VERIFIED_USER = "77777";
const TOKEN = "test-bearer-token";

// In-memory iq3 user-state repo used to assert which userId was
// persisted by the onboarding handler.
const memStates = new Map<string, Iq3UserState>();
const memRepo = {
  async load(userId: string): Promise<Iq3UserState | null> {
    return memStates.get(userId) ?? null;
  },
  async save(state: Iq3UserState): Promise<void> {
    memStates.set(state.userId, state);
  },
};

// In-memory selfRating store. selfRating.ts writes to either Supabase
// or a local JSON file; the test env has neither var set, so it falls
// through to the JSON-file branch. We stub node:fs so the test stays
// hermetic and we can read what was written.
const writtenSelfRatings: Array<Record<string, unknown>> = [];
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === "./.protege-store-iq3-self-ratings.json") return false;
      return actual.existsSync(path);
    },
    readFileSync: (path: unknown, enc: unknown) => {
      if (path === "./.protege-store-iq3-self-ratings.json") return "[]";
      // selfRating writes to ./.protege-store-iq3-self-ratings.json,
      // and iq.ts reads taxonomy files. Don't intercept those.
      return (actual.readFileSync as (p: unknown, e: unknown) => unknown)(
        path,
        enc,
      );
    },
    writeFileSync: (path: unknown, data: unknown) => {
      if (path === "./.protege-store-iq3-self-ratings.json") {
        writtenSelfRatings.length = 0;
        const parsed = JSON.parse(String(data)) as Array<Record<string, unknown>>;
        writtenSelfRatings.push(...parsed);
        return;
      }
      return (actual.writeFileSync as (p: unknown, d: unknown) => unknown)(
        path,
        data,
      );
    },
  };
});

async function buildApp() {
  // Imported lazily so the node:fs mock above is in effect when
  // selfRating.ts captures its `node:fs` dynamic import.
  const iqMod = await import("./iq.js");
  const selfRatingMod = await import("./selfRating.js");
  iqMod.setIq3UserStateRepo(memRepo);

  const app = new Hono();
  app.route("/iq", iqMod.default);
  app.route("/iq/self-rating", selfRatingMod.default);
  return app;
}

beforeEach(async () => {
  memStates.clear();
  writtenSelfRatings.length = 0;
  process.env.PROTEGE_AUTH_REQUIRED = "true";
  delete process.env.PROTEGE_ALLOW_DEV_USER;
  // Make sure selfRating.ts falls into the local-JSON branch, not
  // Supabase — we don't want the test to hit a real network even by
  // mistake.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ id: Number(VERIFIED_USER) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  const { _resetAuthCacheForTests } = await import("../../middleware/auth.js");
  _resetAuthCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PROTEGE_AUTH_REQUIRED;
});

describe("/iq/me — auth + IDOR", () => {
  it("401 without Authorization header", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/me");
    expect(res.status).toBe(401);
  });

  it("uses verified token id, ignoring ?userId= override", async () => {
    const app = await buildApp();
    // Counterfactual: pre-fix this would persist+read state for "victim".
    const res = await app.request(
      `/iq/me?userId=${VERIFIED_USER}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    // Repo should now have a row keyed by the verified id, not "victim".
    expect(memStates.has(VERIFIED_USER)).toBe(true);
    expect(memStates.has("victim")).toBe(false);
  });

  it("403 when ?userId= disagrees with the token's verified id", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/me?userId=victim", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("403 when x-user-id disagrees with the token", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/me", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "x-user-id": "victim",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("/iq/onboarding — auth + IDOR", () => {
  it("401 without Authorization header", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchKeys: [], userId: "victim" }),
    });
    expect(res.status).toBe(401);
  });

  it("403 when body.userId disagrees with the token", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/onboarding", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "victim", matchKeys: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("persists state under verified id when body.userId is omitted", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/onboarding", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ matchKeys: ["foo"] }),
    });
    expect(res.status).toBe(200);
    expect(memStates.has(VERIFIED_USER)).toBe(true);
  });
});

describe("/iq/self-rating — auth + IDOR", () => {
  it("401 without Authorization header", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/self-rating", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "victim",
        rating: 7,
        ratedAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(401);
    expect(writtenSelfRatings.length).toBe(0);
  });

  it("403 when body.userId disagrees with the token", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/self-rating", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "victim",
        rating: 7,
        ratedAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(403);
    expect(writtenSelfRatings.length).toBe(0);
  });

  it("persists the verified userId, not whatever client sent (no body.userId case)", async () => {
    const app = await buildApp();
    const ratedAt = new Date().toISOString();
    const res = await app.request("/iq/self-rating", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rating: 7,
        ratedAt,
        note: "ok",
      }),
    });
    expect(res.status).toBe(200);
    expect(writtenSelfRatings.length).toBe(1);
    expect(writtenSelfRatings[0].userId).toBe(VERIFIED_USER);
    expect(writtenSelfRatings[0].rating).toBe(7);
  });
});

describe("/iq/taxonomy — public", () => {
  it("200 without Authorization header (no PII, static schema)", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/taxonomy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taxonomy?: unknown; tags?: unknown };
    expect(body.taxonomy).toBeDefined();
    expect(body.tags).toBeDefined();
  });
});
