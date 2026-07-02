import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  sets: [] as Array<{ path: string; data: Record<string, unknown>; options?: Record<string, unknown> }>,
  mmApi: vi.fn(),
  createProjectAgentBot: vi.fn(),
  retireProjectAgentBot: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}));

function docRef(path: string) {
  return {
    get: async () => {
      const data = h.docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
      h.sets.push({ path, data, options });
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    get: async () => ({
      docs: [...h.docs.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && p.slice(path.length + 1).split("/").length === 1)
        .map(([p, data]) => ({ id: p.split("/").at(-1)!, data: () => data })),
    }),
  };
}

vi.mock("../lib/db.js", () => ({
  db: { doc: (path: string) => docRef(path), collection: (name: string) => collectionRef(name) },
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("@octogee/core/mattermost/project-agent", () => ({
  createProjectAgentBot: (...args: unknown[]) => h.createProjectAgentBot(...args),
  retireProjectAgentBot: (...args: unknown[]) => h.retireProjectAgentBot(...args),
  projectAgentSecretDocId: (pid: string) => `projectAgentMattermost-${pid}`,
}));

const { setProjectAgentEnabled } = await import("../lib/project-agent-service.js");

function actor(overrides: Record<string, unknown> = {}) {
  return {
    uid: "owner-1",
    userData: { username: "mira", subscription: { tier: "pro" } },
    workspaceId: "mira",
    ...overrides,
  };
}

const PROJECT_PATH = "workspaces/mira/projects/orbit";

function seedProject(extra: Record<string, unknown> = {}) {
  h.docs.set(PROJECT_PATH, { id: "orbit", ownerUid: "owner-1", ...extra });
  h.docs.set("workspaces/mira", { ownerUid: "owner-1", mattermost: { teamId: "team-1" } });
  h.docs.set("agents/owner-1", { name: "BenderEcho", avatarEmoji: "🤖" });
  h.docs.set(`${PROJECT_PATH}/channels/general`, {
    kind: "general",
    mattermost: { channelId: "po-1" },
  });
}

beforeEach(() => {
  h.docs.clear();
  h.sets.length = 0;
  h.mmApi.mockReset();
  h.createProjectAgentBot.mockReset().mockResolvedValue({ mmUserId: "bot-1", token: "pat-1" });
  h.retireProjectAgentBot.mockReset().mockResolvedValue(undefined);
  h.logger.error.mockReset();
  h.logger.info.mockReset();
});

describe("setProjectAgentEnabled — enable", () => {
  it("gates enable on paid-ness from the shared tier config — trial, free (expired trial), and unknown tiers are all blocked", async () => {
    seedProject();
    for (const userData of [
      { username: "mira", selectedTier: "trial" },
      { username: "mira", tier: "free", selectedTier: "free" },
      { username: "mira", selectedTier: "enterprise-legacy" },
      { username: "mira" },
    ]) {
      const result = await setProjectAgentEnabled(actor({ userData }), "orbit", true);
      expect(result).toEqual({
        status: 402,
        body: { error: "Project agents are available on paid plans" },
      });
    }
    expect(h.sets).toEqual([]);
  });

  it("an active paid subscription wins over a stale free selection (billing precedence)", async () => {
    seedProject();
    const result = await setProjectAgentEnabled(
      actor({ userData: { username: "mira", selectedTier: "free", subscription: { tier: "hobby" } } }),
      "orbit",
      true,
    );
    expect(result.status).toBe(200);
  });

  it("502s when the workspace has no MM teamId, keeping the flag for retry", async () => {
    seedProject();
    h.docs.set("workspaces/mira", { ownerUid: "owner-1" });

    const result = await setProjectAgentEnabled(actor(), "orbit", true);

    expect(result).toEqual({
      status: 502,
      body: { error: "Agent enabled, but provisioning failed - toggle again to retry" },
    });
    expect(h.sets.some((s) => s.path === PROJECT_PATH)).toBe(true);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("403s when the caller is not the project owner", async () => {
    seedProject({ ownerUid: "someone-else" });

    const result = await setProjectAgentEnabled(actor(), "orbit", true);

    expect(result).toEqual({
      status: 403,
      body: { error: "Only the project owner can manage its agent" },
    });
    expect(h.sets).toEqual([]);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("404s for a missing project and 400s for an invalid id", async () => {
    await expect(setProjectAgentEnabled(actor(), "orbit", true)).resolves.toEqual({
      status: 404,
      body: { error: "Project not found" },
    });
    await expect(setProjectAgentEnabled(actor(), "Bad!", true)).resolves.toEqual({
      status: 400,
      body: { error: "Invalid project" },
    });
  });

  it("writes the flag, mints the bot into the project's channels, and reports active", async () => {
    seedProject();

    const result = await setProjectAgentEnabled(actor(), "orbit", true);

    expect(h.sets).toContainEqual({
      path: PROJECT_PATH,
      data: { agent: { enabled: true, updatedAt: "SERVER_TS" } },
      options: { merge: true },
    });
    expect(h.createProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      username: "mira",
      project: "orbit",
      teamId: "team-1",
      displayName: "BenderEcho",
      projectChannelIds: ["po-1"],
    });
    expect(result).toEqual({
      status: 200,
      body: { success: true, enabled: true, provisioned: true },
    });
  });

  it("keeps the flag but reports 502 when minting fails (retry re-mints idempotently)", async () => {
    seedProject();
    h.createProjectAgentBot.mockRejectedValue(new Error("MM down"));

    const result = await setProjectAgentEnabled(actor(), "orbit", true);

    expect(h.sets.some((s) => s.path === PROJECT_PATH)).toBe(true);
    expect(result).toEqual({
      status: 502,
      body: { error: "Agent enabled, but provisioning failed - toggle again to retry" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe("setProjectAgentEnabled — disable", () => {
  it("writes the flag and retires the minted bot", async () => {
    seedProject();
    h.docs.set("users/owner-1/secrets/projectAgentMattermost-orbit", {
      mmUserId: "bot-1",
      personalToken: "pat-1",
    });

    const result = await setProjectAgentEnabled(actor(), "orbit", false);

    expect(h.sets).toContainEqual({
      path: PROJECT_PATH,
      data: { agent: { enabled: false, updatedAt: "SERVER_TS" } },
      options: { merge: true },
    });
    expect(h.retireProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      project: "orbit",
      mmUserId: "bot-1",
    });
    expect(result).toEqual({
      status: 200,
      body: { success: true, enabled: false, provisioned: false },
    });
  });

  it("disable works on trial (no paid gate for turning things off) and without a minted bot", async () => {
    seedProject();

    const result = await setProjectAgentEnabled(
      actor({ userData: { username: "mira", selectedTier: "trial" } }),
      "orbit",
      false,
    );

    expect(h.retireProjectAgentBot).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 200,
      body: { success: true, enabled: false, provisioned: false },
    });
  });
});
