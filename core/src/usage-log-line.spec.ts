import { describe, expect, it } from "vitest";
import { formatUsageLogLine } from "./usage-log-line.js";

describe("formatUsageLogLine", () => {
  it("formats usage totals, rounded cost, role/model, uid prefix, and workspace slug", () => {
    const line = formatUsageLogLine({
      totalTokens: 12345,
      costUsd: 0.123456,
      role: "coach",
      model: "claude",
      uid: "uid-abcdef-123",
      workspaceId: "acme",
    });

    expect(line).toContain("usage: 12345 tokens ($0.1235)");
    expect(line).toContain("[coach/claude] uid:uid-abcd slug:acme");
  });

  it("omits the slug segment outside a workspace", () => {
    const line = formatUsageLogLine({
      totalTokens: 10,
      costUsd: 1,
      role: "system",
      model: "router",
      uid: "1234567890",
      workspaceId: null,
    });

    expect(line).toContain("usage: 10 tokens ($1.0000)");
    expect(line).toContain("[system/router] uid:12345678");
    expect(line).not.toContain("slug:");
  });
});
