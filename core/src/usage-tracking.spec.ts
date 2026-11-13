import { describe, expect, it } from "vitest";

import { reportUsageForUid, workspaceUsageDocumentIds, type ReportUsageForUidInput } from "./usage-tracking.js";

function usageFixture(account: Record<string, unknown>) {
  const written: string[] = [];
  const reference = (path: string) => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => reference(`${path}/${name}/${id}`) }),
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async <T>(body: (transaction: unknown) => Promise<T>) => body({
      get: async () => ({ data: () => account }),
      update: () => undefined,
      set: (target: { path: string }) => written.push(target.path),
    }),
  };
  const report = (input: Partial<ReportUsageForUidInput>) => reportUsageForUid({
    db: db as never,
    uid: "uid-1",
    agentId: "octogee-from-agent-coach",
    usage: { model: "anthropic/claude", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0, costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
    gatewayId: "gw-1",
    log: () => undefined,
    ...input,
  });
  return { written, report };
}

describe("usage attribution", () => {
  const account = { provisioning: { openclaw: { slug: "from-account" } } };
  const workspaceOf = (paths: readonly string[]) => paths.find((path) => path.startsWith("workspaces/"))?.split("/")[1];

  it("charges the platform workspace slug without consulting the account document", async () => {
    const { written, report } = usageFixture(account);
    await report({ platformWorkspaceSlug: "from-store" });
    expect(workspaceOf(written)).toBe("from-store");
  });

  it("derives the workspace from the agent id when the platform has no slug", async () => {
    const { written, report } = usageFixture(account);
    await report({ platformWorkspaceSlug: null });
    expect(workspaceOf(written)).toBe("from-agent");
  });

  it("keeps the account document attribution for callers without a platform slug", async () => {
    const { written, report } = usageFixture(account);
    await report({});
    expect(workspaceOf(written)).toBe("from-account");
  });
});

describe("usage-tracking helpers", () => {
  it("builds stable workspace usage document ids from the model and date", () => {
    expect(workspaceUsageDocumentIds("anthropic/claude-sonnet-4-6", "2026-06-24")).toEqual({
      sessionId: "2026-06-24",
      modelId: "anthropic_claude-sonnet-4-6_2026-06-24",
      summaryId: "current",
    });
  });
});
