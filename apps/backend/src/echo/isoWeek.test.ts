import { describe, expect, it } from "vitest";
import { isoWeek } from "../store.js";

describe("isoWeek", () => {
  it("2026-04-22 (Wed, project today) → 2026-W17", () => {
    expect(isoWeek(new Date(Date.UTC(2026, 3, 22)))).toBe("2026-W17");
  });

  it("2026-01-01 (Thu) → 2026-W01", () => {
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-W01");
  });

  it("2024-12-30 (Mon) → 2025-W01 (ISO year boundary rolls forward)", () => {
    expect(isoWeek(new Date(Date.UTC(2024, 11, 30)))).toBe("2025-W01");
  });

  it("2022-01-01 (Sat) → 2021-W52 (ISO year boundary rolls back)", () => {
    expect(isoWeek(new Date(Date.UTC(2022, 0, 1)))).toBe("2021-W52");
  });

  it("2020-12-31 (Thu) → 2020-W53 (53-week ISO year)", () => {
    expect(isoWeek(new Date(Date.UTC(2020, 11, 31)))).toBe("2020-W53");
  });
});
