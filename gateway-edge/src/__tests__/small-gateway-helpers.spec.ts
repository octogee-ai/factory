import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  update: vi.fn(),
  collection: vi.fn((_name: string) => ({
    doc: vi.fn((_uid: string) => ({ update: m.update })),
  })),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
  info: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  db: {
    collection: (name: string) => m.collection(name),
  },
  FieldValue: {
    serverTimestamp: () => m.serverTimestamp(),
  },
}));

vi.mock("../middleware/logging.js", () => ({
  logger: {
    info: (...args: unknown[]) => m.info(...args),
  },
}));

import {
  WORKSPACE_REPO,
  SYSTEM_CONFIG_REPO,
  giteaUsername,
  projectRepoName,
  systemConfigRepoName,
  workspaceGiteaOrg,
  workspaceRepoName,
} from "../lib/gitea-naming.js";
import { initializeUsage } from "../billing/token-usage.js";

beforeEach(() => {
  m.update.mockReset().mockResolvedValue(undefined);
  m.collection.mockClear();
  m.serverTimestamp.mockClear();
  m.info.mockClear();
});

describe("small gateway helpers", () => {
  it("derives gitea org, repo, and service user names", () => {
    expect(WORKSPACE_REPO).toBe("workspace");
    expect(SYSTEM_CONFIG_REPO).toBe("system_config");
    expect(workspaceGiteaOrg("mira")).toBe("mira");
    expect(workspaceRepoName()).toBe("workspace");
    expect(systemConfigRepoName()).toBe("system_config");
    expect(projectRepoName("orbit")).toBe("orbit");
    expect(giteaUsername("mira")).toBe("ws-mira");
  });

  it("initializes usage counters from the selected billing tier", async () => {
    await initializeUsage("uid-1", "hobby");

    expect(m.collection).toHaveBeenCalledWith("users");
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "usage.windowTokensUsed": 0,
        "usage.totalTokensUsed": 0,
        "usage.interactionCount": 0,
        "usage.weeklyBudget": expect.any(Number),
        "usage.windowSize": expect.any(Number),
        "usage.windowStartedAt": { __serverTimestamp: true },
        "usage.lastUpdated": { __serverTimestamp: true },
      }),
    );
    expect(m.info).toHaveBeenCalledWith("Initialized usage for uid-1 (hobby)");
  });
});
