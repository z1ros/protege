import { describe, it, expect, vi } from "vitest";

// chatSessions.ts imports `vscode` for ExtensionContext typing + the
// protegeClient module pulls vscode for window/secrets. Stub both so
// the pure-helper exports load without a real extension host.
vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));
vi.mock("../user/protegeClient.js", () => ({
  authedFetch: vi.fn(async () => new Response("{}", { status: 200 })),
  BACKEND_URL: "http://localhost:0",
  currentUserIdOrNull: () => null,
}));
vi.mock("../log.js", () => ({ log: () => {} }));

import {
  deriveSessionTitle,
  newSessionId,
  legacySessionIdFor,
} from "./chatSessions.js";

describe("deriveSessionTitle", () => {
  it("uses the first user message, trimmed", () => {
    expect(deriveSessionTitle("How does the useState hook re-render?")).toBe(
      "How does the useState hook re-render?",
    );
  });

  it("strips fenced code blocks", () => {
    expect(
      deriveSessionTitle("Fix this:\n```js\nconst x = 1\n```\nthanks!"),
    ).toBe("Fix this: [code] thanks!");
  });

  it("strips inline backticks but keeps the contents", () => {
    expect(deriveSessionTitle("Why is `foo()` returning undefined?")).toBe(
      "Why is foo() returning undefined?",
    );
  });

  it("truncates to 60 chars with an ellipsis", () => {
    const long = "x".repeat(120);
    const result = deriveSessionTitle(long);
    // Truncated at 60 + an ellipsis. JS string length counts the
    // ellipsis as one code unit, so the resulting string should be 61.
    expect(result.length).toBe(61);
    expect(result.endsWith("…")).toBe(true);
  });

  it("falls back to 'New chat' for empty input", () => {
    expect(deriveSessionTitle("")).toBe("New chat");
    expect(deriveSessionTitle("   ")).toBe("New chat");
  });
});

describe("newSessionId", () => {
  it("starts with the s_ prefix", () => {
    expect(newSessionId().startsWith("s_")).toBe(true);
  });
  it("returns unique IDs across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe("legacySessionIdFor", () => {
  it("produces a deterministic id per user", () => {
    expect(legacySessionIdFor("123")).toBe("legacy-123");
    expect(legacySessionIdFor("foo")).toBe("legacy-foo");
  });
});
