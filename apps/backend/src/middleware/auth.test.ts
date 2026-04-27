import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import {
  githubAuth,
  getAuthenticatedUserId,
  isAuthRequired,
  _resetAuthCacheForTests,
} from "./auth.js";

function buildApp() {
  const app = new Hono();
  app.use("*", githubAuth());
  app.get("/probe", (c) => c.json({ uid: getAuthenticatedUserId(c) }));
  return app;
}

function makeFetchOk(id: number | string) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function makeFetchFail(status: number) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ message: "bad" }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

beforeEach(() => {
  // Auth is now ON by default; tests that want dev-mode behavior must
  // opt out explicitly. Setting "false" here means "dev mode / auth not
  // required" describe blocks inherit the right default.
  process.env.PROTEGE_AUTH_REQUIRED = "false";
  // Login-first hardening: `resolveUserId` refuses the local-dev fallback
  // unless this opt-in is set. The test harness is the canonical caller
  // of that path, so we set it here.
  process.env.PROTEGE_ALLOW_DEV_USER = "true";
  _resetAuthCacheForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.PROTEGE_AUTH_REQUIRED;
  delete process.env.PROTEGE_ALLOW_DEV_USER;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------
describe("dev mode / auth not required", () => {
  it("T1: no Bearer → 200, uid null", async () => {
    // Counterfactual: would fail if no-token dev mode returned 401.
    const app = buildApp();
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBeNull();
  });

  it("T2: valid Bearer → 200, uid set", async () => {
    // Counterfactual: would fail if dev mode skipped fetching and left uid null even for valid tokens.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer validtoken" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBe("67890");
  });

  it("T3: invalid Bearer (GitHub 401) → 200, uid null", async () => {
    // Counterfactual: would fail if an invalid token caused a 401 in dev mode.
    vi.stubGlobal("fetch", makeFetchFail(401));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer badtoken" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enforcing mode
// ---------------------------------------------------------------------------
describe("enforcing mode / PROTEGE_AUTH_REQUIRED=true", () => {
  beforeEach(() => {
    process.env.PROTEGE_AUTH_REQUIRED = "true";
  });

  it("T4: no Authorization header → 401", async () => {
    // Counterfactual: would fail if missing auth was allowed through.
    const app = buildApp();
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("authentication required");
  });

  it("T5: Basic scheme Authorization → 401", async () => {
    // Counterfactual: would fail if middleware accepted any Authorization header without checking Bearer scheme.
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("authentication required");
  });

  it("T6: GitHub returns 401 → middleware returns 401 with invalid token message", async () => {
    // Counterfactual: would fail if a 4xx from GitHub was swallowed and the request allowed through.
    vi.stubGlobal("fetch", makeFetchFail(401));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer expiredtoken" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid or expired token");
  });

  it("T7: GitHub returns 200 but JSON has no id → 401", async () => {
    // Counterfactual: would fail if middleware trusted any 2xx from GitHub without checking response shape.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ login: "someone" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer sometoken" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid or expired token");
  });

  it("T8: valid token, no claimed userId → 200, uid matches", async () => {
    // Counterfactual: would fail if no-claim path was rejected.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer goodtoken" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBe("67890");
  });

  it("T9: valid token, matching x-user-id → 200", async () => {
    // Counterfactual: would fail if the middleware rejected a correctly matching x-user-id.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: {
        Authorization: "Bearer goodtoken",
        "x-user-id": "67890",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBe("67890");
  });

  it("T10: valid token, mismatched x-user-id → 403", async () => {
    // Counterfactual: would fail if the middleware returned the claimed id instead of checking it.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: {
        Authorization: "Bearer goodtoken",
        "x-user-id": "99999",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/x-user-id/);
  });

  it("T11: valid token, mismatched ?userId= query → 403", async () => {
    // Counterfactual: would fail if query-param userId mismatch was not checked.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe?userId=99999", {
      headers: { Authorization: "Bearer goodtoken" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/userId/);
  });

  it("T12: numeric id in GitHub response is coerced to string", async () => {
    // Counterfactual: catches a regression where id stored as number causes "67890" !== 67890 mismatch.
    vi.stubGlobal("fetch", makeFetchOk(67890));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: {
        Authorization: "Bearer goodtoken",
        "x-user-id": "67890",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBe("67890");
    expect(typeof body.uid).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Token caching
// ---------------------------------------------------------------------------
describe("token caching", () => {
  it("T13: same token used 3 times → fetch called exactly 1 time", async () => {
    // Counterfactual: would fail if the cache was not implemented.
    const mockFetch = makeFetchOk(67890);
    vi.stubGlobal("fetch", mockFetch);
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await app.request("/probe", {
        headers: { Authorization: "Bearer sametoken" },
      });
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("T14: two different tokens → fetch called exactly 2 times", async () => {
    // Counterfactual: would fail if the cache key was not per-token.
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 67890 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);
    const app = buildApp();
    await app.request("/probe", {
      headers: { Authorization: "Bearer tokenA" },
    });
    await app.request("/probe", {
      headers: { Authorization: "Bearer tokenB" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("T15: after _resetAuthCacheForTests(), same token re-fetches", async () => {
    // Counterfactual: would fail if _resetAuthCacheForTests() didn't clear the cache.
    const mockFetch = makeFetchOk(67890);
    vi.stubGlobal("fetch", mockFetch);
    const app = buildApp();
    await app.request("/probe", {
      headers: { Authorization: "Bearer sametoken" },
    });
    _resetAuthCacheForTests();
    await app.request("/probe", {
      headers: { Authorization: "Bearer sametoken" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Fetch failure / network error
// ---------------------------------------------------------------------------
describe("fetch failure", () => {
  it("T16: GitHub fetch throws in enforcing mode → 401", async () => {
    // Counterfactual: would fail if a network error was treated as success.
    process.env.PROTEGE_AUTH_REQUIRED = "true";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer sometoken" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid or expired token");
  });

  it("T17: GitHub fetch throws in dev mode → 200, uid null", async () => {
    // Counterfactual: would fail if a network error in dev mode caused a 500 or 401.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const app = buildApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer sometoken" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAuthRequired()
// ---------------------------------------------------------------------------
describe("isAuthRequired()", () => {
  it("T18: returns false ONLY for explicit 'false' or '0'", () => {
    // Counterfactual: would fail if any other string was treated as a disable.
    for (const val of ["false", "0"]) {
      process.env.PROTEGE_AUTH_REQUIRED = val;
      expect(isAuthRequired()).toBe(false);
    }
  });

  it("T19: returns true for unset, 'true', '1', '', 'yes', mixed case — default ON", () => {
    // Counterfactual: would fail if absence or any non-disable value was treated as off.
    for (const val of [undefined, "true", "1", "", "yes", "TRUE", "True"]) {
      if (val === undefined) {
        delete process.env.PROTEGE_AUTH_REQUIRED;
      } else {
        process.env.PROTEGE_AUTH_REQUIRED = val;
      }
      expect(isAuthRequired()).toBe(true);
    }
  });
});
