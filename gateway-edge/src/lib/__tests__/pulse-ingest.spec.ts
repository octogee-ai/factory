import { describe, it, expect } from "vitest";
import { weekRanges } from "../pulse-ingest.js";

describe("weekRanges", () => {
  it("returns rolling 7-day windows, most-recent first, as YYYY-MM-DD", () => {
    const now = Date.parse("2026-06-26T12:00:00Z");
    expect(weekRanges(now, 2)).toEqual([
      { since: "2026-06-19", until: "2026-06-26" },
      { since: "2026-06-12", until: "2026-06-19" },
    ]);
  });

  it("chains windows so each since is the prior until", () => {
    const r = weekRanges(Date.parse("2026-06-26T00:00:00Z"), 4);
    expect(r).toHaveLength(4);
    for (let i = 1; i < r.length; i += 1) expect(r[i].until).toBe(r[i - 1].since);
  });
});
