import { describe, it, expect } from "vitest";
import {
  RETIRED_USAGE_COLLECTIONS,
  USAGE_MODEL_TTL_MS,
  planUsageModelExpiry,
} from "../lib/usage-ledger-cleanup.js";
import {
  CLEANUP_USAGE_LEDGERS_USAGE,
  parseCleanupUsageLedgersMode,
} from "../ops/cleanup-usage-ledgers.js";

const NOW = Date.UTC(2026, 6, 7);

describe("parseCleanupUsageLedgersMode", () => {
  it("requires exactly one execution mode", () => {
    expect(parseCleanupUsageLedgersMode(["--dry-run"])).toBe("dry-run");
    expect(parseCleanupUsageLedgersMode(["--execute"])).toBe("execute");
    expect(parseCleanupUsageLedgersMode([])).toBeNull();
    expect(parseCleanupUsageLedgersMode(["--dry-run", "--execute"])).toBeNull();
    expect(CLEANUP_USAGE_LEDGERS_USAGE).toContain("--dry-run");
  });
});

describe("RETIRED_USAGE_COLLECTIONS", () => {
  it("retires exactly the two dead ledgers (usage_models survives)", () => {
    expect([...RETIRED_USAGE_COLLECTIONS]).toEqual(["usage_sessions", "usage_summary"]);
  });
});

describe("planUsageModelExpiry", () => {
  it("skips a doc that already carries expiresAt (idempotent)", () => {
    expect(planUsageModelExpiry({ expiresAt: new Date() }, NOW)).toBeNull();
  });

  it("stamps 180d after lastUsedAt (admin Timestamp shape)", () => {
    const last = Date.UTC(2026, 6, 1);
    const out = planUsageModelExpiry({ lastUsedAt: { _seconds: last / 1000, _nanoseconds: 0 } }, NOW);
    expect(out?.getTime()).toBe(last + USAGE_MODEL_TTL_MS);
  });

  it("stamps 180d after lastUsedAt (live Date)", () => {
    const last = new Date(Date.UTC(2026, 5, 1));
    const out = planUsageModelExpiry({ lastUsedAt: last }, NOW);
    expect(out?.getTime()).toBe(last.getTime() + USAGE_MODEL_TTL_MS);
  });

  it("falls back to the doc's date string when lastUsedAt is absent", () => {
    const out = planUsageModelExpiry({ date: "2026-01-15" }, NOW);
    expect(out?.getTime()).toBe(Date.UTC(2026, 0, 15) + USAGE_MODEL_TTL_MS);
  });

  it("falls back to now when neither lastUsedAt nor date is usable", () => {
    const out = planUsageModelExpiry({ model: "x" }, NOW);
    expect(out?.getTime()).toBe(NOW + USAGE_MODEL_TTL_MS);
  });

  it("a doc last used >180d ago gets a past expiresAt (TTL drains it promptly)", () => {
    const out = planUsageModelExpiry({ date: "2025-01-01" }, NOW);
    expect(out!.getTime()).toBeLessThan(NOW);
  });
});
