/**
 * Unit tests for formatUsageLogLine() — the `✓ usage: ...` line emitted
 * per turn by the gateway provisioner. Phase 0 adds the `key=` suffix
 * so every line attributes the turn to a specific API key fingerprint.
 *
 * Pure function; no Firebase, no filesystem.
 */
import { test, expect, describe } from "vitest";
import { formatUsageLogLine } from "../../scripts/lib/usage-log-line";

describe("formatUsageLogLine", () => {
  const base = {
    totalTokens: 1800,
    costUsd: 0.0168,
    role: "coach",
    model: "anthropic/claude-sonnet-4-6",
    uid: "abc12345defg",
    workspaceId: "smile-wring-011b",
    keyFingerprint: "sk-ant…9f2a",
  };

  test("canonical turn line: tokens, cost, role/model, uid, workspace, key", () => {
    expect(formatUsageLogLine(base)).toBe(
      "✓ usage: 1800 tokens ($0.0168) [coach/anthropic/claude-sonnet-4-6] uid:abc12345 ws:smile-wring-011b key=sk-ant…9f2a",
    );
  });

  test("workspaceId omitted: no ws: segment, key still present", () => {
    expect(formatUsageLogLine({ ...base, workspaceId: null })).toBe(
      "✓ usage: 1800 tokens ($0.0168) [coach/anthropic/claude-sonnet-4-6] uid:abc12345 key=sk-ant…9f2a",
    );
  });

  test("uid truncated to first 8 chars", () => {
    const line = formatUsageLogLine({ ...base, uid: "0123456789abcdef" });
    expect(line).toContain("uid:01234567 ");
    expect(line).not.toContain("89abcdef");
  });

  test("cost formatted to four decimals, always", () => {
    expect(formatUsageLogLine({ ...base, costUsd: 0 })).toContain("($0.0000)");
    expect(formatUsageLogLine({ ...base, costUsd: 1 })).toContain("($1.0000)");
    expect(formatUsageLogLine({ ...base, costUsd: 0.123456 })).toContain("($0.1235)");
  });

  test("key fingerprint always present, even when 'none'", () => {
    expect(formatUsageLogLine({ ...base, keyFingerprint: "none" })).toContain(
      "key=none",
    );
  });

  test("line never contains raw secret material", () => {
    const line = formatUsageLogLine({
      ...base,
      keyFingerprint: "sk-ant…9f2a", // already a fingerprint; caller is
                                      // responsible for redacting before call
    });
    expect(line).not.toMatch(/sk-ant-api\d+/); // no full-form key patterns
  });

  test("alternative role (e.g. alex) renders inline", () => {
    expect(formatUsageLogLine({ ...base, role: "alex" })).toContain(
      "[alex/anthropic/claude-sonnet-4-6]",
    );
  });
});
