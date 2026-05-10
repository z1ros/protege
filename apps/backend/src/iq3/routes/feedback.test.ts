import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * /iq/feedback contract tests.
 *
 * Anonymous "found something weird?" feedback on Code IQ scoring.
 * Endpoint is auth-gated to prevent spam, but the persisted row holds
 * only the text + a server-stamped timestamp. No userId is stored, even
 * though the caller is authenticated.
 *
 * Strategy mirrors `iq.test.ts`:
 *   - PROTEGE_AUTH_REQUIRED=true forces real githubAuth gating.
 *   - Global fetch is stubbed to return a deterministic GitHub id.
 *   - node:fs is mocked so the local-JSON storage branch is hermetic.
 */

const VERIFIED_USER = "77777";
const TOKEN = "test-bearer-token";
const STORE_PATH = "./.protege-store-iq3-feedback.json";

const writtenFeedback: Array<Record<string, unknown>> = [];
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === STORE_PATH) return false;
      return actual.existsSync(path);
    },
    readFileSync: (path: unknown, enc: unknown) => {
      if (path === STORE_PATH) return "[]";
      return (actual.readFileSync as (p: unknown, e: unknown) => unknown)(
        path,
        enc,
      );
    },
    writeFileSync: (path: unknown, data: unknown) => {
      if (path === STORE_PATH) {
        writtenFeedback.length = 0;
        const parsed = JSON.parse(String(data)) as Array<Record<string, unknown>>;
        writtenFeedback.push(...parsed);
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
  const feedbackMod = await import("./feedback.js");
  const app = new Hono();
  app.route("/iq/feedback", feedbackMod.default);
  return app;
}

beforeEach(async () => {
  writtenFeedback.length = 0;
  process.env.PROTEGE_AUTH_REQUIRED = "true";
  delete process.env.PROTEGE_ALLOW_DEV_USER;
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

describe("/iq/feedback", () => {
  it("401 without Authorization header", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Score feels wrong" }),
    });
    expect(res.status).toBe(401);
    expect(writtenFeedback.length).toBe(0);
  });

  it("400 when text is empty", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
    expect(writtenFeedback.length).toBe(0);
  });

  it("400 when text is missing", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(writtenFeedback.length).toBe(0);
  });

  it("400 when text exceeds max length", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(1001) }),
    });
    expect(res.status).toBe(400);
    expect(writtenFeedback.length).toBe(0);
  });

  it("200 persists text + server timestamp, never the userId", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      // Adversarially include userId — it MUST NOT be persisted.
      body: JSON.stringify({ text: "Senior pillar feels too low", userId: VERIFIED_USER }),
    });
    expect(res.status).toBe(200);
    expect(writtenFeedback.length).toBe(1);
    expect(writtenFeedback[0].text).toBe("Senior pillar feels too low");
    expect(typeof writtenFeedback[0].submittedAt).toBe("string");
    expect(writtenFeedback[0]).not.toHaveProperty("userId");
    expect(writtenFeedback[0]).not.toHaveProperty("user_id");
  });

  it("200 trims text and rejects whitespace-only as empty", async () => {
    const app = await buildApp();
    const res = await app.request("/iq/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "   \n\t  " }),
    });
    expect(res.status).toBe(400);
    expect(writtenFeedback.length).toBe(0);
  });
});
