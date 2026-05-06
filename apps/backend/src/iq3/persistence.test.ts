import { describe, it, expect } from "vitest";
import { supabaseRepo, type SupabaseClientLike } from "./persistence.js";

function mockClient(loadReturn: { data: any; error: any }): SupabaseClientLike {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => loadReturn,
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  };
}

describe("supabaseRepo error handling", () => {
  it("returns null for PGRST116 (no rows)", async () => {
    const repo = supabaseRepo(
      mockClient({
        data: null,
        error: { code: "PGRST116", message: "Results contain 0 rows" },
      }),
    );
    expect(await repo.load("u1")).toBeNull();
  });

  it("returns null when data is null with no error", async () => {
    const repo = supabaseRepo(mockClient({ data: null, error: null }));
    expect(await repo.load("u1")).toBeNull();
  });

  it("THROWS for any other error code", async () => {
    const repo = supabaseRepo(
      mockClient({
        data: null,
        error: { code: "42P01", message: "relation does not exist" },
      }),
    );
    await expect(repo.load("u1")).rejects.toThrow(
      /load failed.*relation does not exist/,
    );
  });

  it("THROWS for network-shaped error (no code)", async () => {
    const repo = supabaseRepo(
      mockClient({ data: null, error: { message: "fetch failed" } }),
    );
    await expect(repo.load("u1")).rejects.toThrow(/fetch failed/);
  });

  it("returns shaped state when row present", async () => {
    const repo = supabaseRepo(
      mockClient({
        data: {
          user_id: "u1",
          traits: { readsBeforeWrites: { low: 0.3, mid: 0.4, high: 0.3 } },
          field_vector: { web: 1.0 },
          event_count: 5,
          ai_event_count: 2,
          schema_version: 1,
          updated_at: "2026-05-06T00:00:00.000Z",
        },
        error: null,
      }),
    );
    const s = await repo.load("u1");
    expect(s?.userId).toBe("u1");
    expect(s?.eventCount).toBe(5);
    expect(s?.aiEventCount).toBe(2);
    expect(s?.field).toEqual({ web: 1.0 });
  });
});
