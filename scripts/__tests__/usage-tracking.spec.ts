import { describe, expect, it } from "vitest";

import { workspaceUsageDocumentIds } from "../lib/usage-tracking.js";

describe("usage-tracking helpers", () => {
  it("builds stable workspace usage document ids from the model and date", () => {
    expect(workspaceUsageDocumentIds("anthropic/claude-sonnet-4-6", "2026-06-24")).toEqual({
      sessionId: "2026-06-24",
      modelId: "anthropic_claude-sonnet-4-6_2026-06-24",
      summaryId: "current",
    });
  });
});
