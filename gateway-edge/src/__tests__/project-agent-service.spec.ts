import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  sets: [] as Array<{ path: string; data: Record<string, unknown>; options?: Record<string, unknown> }>,
  updates: [] as Array<{ path: string; data: Record<string, unknown> }>,
  updateFailures: new Map<string, Error>(),
  deletes: [] as string[],
  mmApi: vi.fn(),
  addChannelMember: vi.fn(),
  createProjectAgentBot: vi.fn(),
  retireProjectAgentBot: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
    update: async (data: Record<string, unknown>) => {
      const failure = h.updateFailures.get(path);
      if (failure) throw failure;
      h.updates.push({ path, data });
    },
    delete: async () => {
      h.deletes.push(path);
      h.docs.delete(path);
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
  FieldValue: {
    serverTimestamp: () => "SERVER_TS",
    arrayUnion: (...values: unknown[]) => ({ arrayUnion: values }),
    arrayRemove: (...values: unknown[]) => ({ arrayRemove: values }),
  },
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../lib/channel-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channel-lifecycle.js")>();
  return {
    ...actual,
    addChannelMember: (...args: unknown[]) => h.addChannelMember(...args),
  };
});

vi.mock("@octogee/core/mattermost/project-agent", () => ({
  createProjectAgentBot: (...args: unknown[]) => h.createProjectAgentBot(...args),
  retireProjectAgentBot: (...args: unknown[]) => h.retireProjectAgentBot(...args),
  projectAgentSecretDocId: (pid: string) => `projectAgentMattermost-${pid}`,
}));

const { provisionProjectAgent, retireProjectAgentForDeletion } = await import(
  "../lib/project-agent-service.js"
);

function actor(overrides: Record<string, unknown> = {}) {
  return { uid: "owner-1", workspaceId: "mira", ...overrides };
}

const PROJECT_PATH = "workspaces/mira/projects/orbit";

function projectAgentStateWrite(
  status: "provisioning" | "ready" | "error",
  { lastError = null }: { lastError?: string | null } = {},
) {
  return {
    path: PROJECT_PATH,
    data: {
      agent: {
        status,
        activationId: null,
        lastError,
        updatedAt: "SERVER_TS",
      },
    },
    options: { merge: true },
  };
}

const ROSTER_UNION = {
  path: "users/owner-1",
  data: {
    "provisioning.openclaw.agentIds": { arrayUnion: ["octogee-mira-proj-orbit-coach"] },
  },
};

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
  h.updates.length = 0;
  h.updateFailures.clear();
  h.deletes.length = 0;
  h.mmApi.mockReset();
  h.addChannelMember.mockReset().mockResolvedValue(undefined);
  h.createProjectAgentBot.mockReset().mockResolvedValue({ mmUserId: "bot-1", token: "pat-1" });
  h.retireProjectAgentBot.mockReset().mockResolvedValue(undefined);
  h.logger.error.mockReset();
  h.logger.info.mockReset();
  h.logger.warn.mockReset();
});

describe("provisionProjectAgent", () => {
  it("502s when the workspace has no MM teamId, recording the error for retry", async () => {
    seedProject();
    h.docs.set("workspaces/mira", { ownerUid: "owner-1" });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 502,
      body: { error: "Project Agent provisioning failed - retry from project settings" },
    });
    expect(h.sets).toContainEqual(projectAgentStateWrite("provisioning"));
    expect(h.sets).toContainEqual(projectAgentStateWrite("error", {
      lastError: "Project Agent provisioning failed - retry from project settings",
    }));
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("403s when the caller is not the project owner", async () => {
    seedProject({ ownerUid: "someone-else" });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 403,
      body: { error: "Only the project owner can manage its agent" },
    });
    expect(h.sets).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("does not materialize a project Agent for an archived project", async () => {
    seedProject({ commercialLifecycle: { status: "archived" } });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 409,
      body: { error: "Project is archived" },
    });
    expect(h.sets).toEqual([]);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("404s for a missing project and 400s for an invalid id", async () => {
    await expect(provisionProjectAgent(actor(), "orbit")).resolves.toEqual({
      status: 404,
      body: { error: "Project not found" },
    });
    await expect(provisionProjectAgent(actor(), "Bad!")).resolves.toEqual({
      status: 400,
      body: { error: "Invalid project" },
    });
  });

  it("mints the bot and keeps the agent provisioning until the runtime reports readiness", async () => {
    seedProject();

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.sets).toContainEqual(projectAgentStateWrite("provisioning"));
    expect(h.sets.some((write) => (write.data.agent as { status: string }).status === "ready")).toBe(false);
    expect((h.sets.at(-1)?.data.agent as { activationId: string }).activationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.createProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      username: "mira",
      project: "orbit",
      teamId: "team-1",
      displayName: "orbit",
      projectChannelIds: ["po-1"],
    });
    expect(h.addChannelMember).toHaveBeenCalledWith(
      `${PROJECT_PATH}/channels/general`,
      "bot-1",
    );
    expect(result).toEqual({
      status: 200,
      body: { success: true, status: "provisioning", provisioned: true },
    });
  });

  it("invalidates prior readiness before minting and assigns a new activation to each successful provision", async () => {
    seedProject({ agent: { status: "ready", activationId: "previous" } });
    let finishMint!: (value: { mmUserId: string; token: string }) => void;
    h.createProjectAgentBot.mockImplementationOnce(() => new Promise((resolve) => { finishMint = resolve; }));
    const enabling = provisionProjectAgent(actor(), "orbit");
    await vi.waitFor(() => expect(h.createProjectAgentBot).toHaveBeenCalled());
    expect(h.sets).toEqual([projectAgentStateWrite("provisioning")]);
    finishMint({ mmUserId: "bot-1", token: "new-pat" });
    await enabling;
    const first = (h.sets.at(-1)?.data.agent as { activationId: string }).activationId;
    await provisionProjectAgent(actor(), "orbit");
    const second = (h.sets.at(-1)?.data.agent as { activationId: string }).activationId;
    expect(second).not.toBe(first);
  });

  it("registers the agent id in the owner's provisioning roster so the byok broker will issue its tokens", async () => {
    seedProject();

    await provisionProjectAgent(actor(), "orbit");

    expect(h.updates).toEqual([ROSTER_UNION]);
  });

  it("reports 502 when minting fails (retry re-mints idempotently)", async () => {
    seedProject();
    h.createProjectAgentBot.mockRejectedValue(new Error("MM down"));

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.sets).toContainEqual(projectAgentStateWrite("provisioning"));
    expect(h.sets).toContainEqual(projectAgentStateWrite("error", {
      lastError: "Project Agent provisioning failed - retry from project settings",
    }));
    expect(h.updates).toEqual([ROSTER_UNION]);
    expect(result).toEqual({
      status: 502,
      body: { error: "Project Agent provisioning failed - retry from project settings" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("reports 502 when primary membership cannot converge", async () => {
    seedProject();
    h.addChannelMember.mockRejectedValue(new Error("primary membership mismatch"));

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.createProjectAgentBot).toHaveBeenCalled();
    expect(result).toEqual({
      status: 502,
      body: { error: "Project Agent provisioning failed - retry from project settings" },
    });
    expect(h.sets).toContainEqual(projectAgentStateWrite("error", {
      lastError: "Project Agent provisioning failed - retry from project settings",
    }));
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("maps a MattermostIdentityMissingError from primary membership to the sanitized 422 instead of the generic 502", async () => {
    seedProject();
    const { MattermostIdentityMissingError } = await import("../lib/channel-lifecycle.js");
    h.addChannelMember.mockRejectedValue(
      new MattermostIdentityMissingError("Mattermost user bot-1 was not found"),
    );

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.createProjectAgentBot).toHaveBeenCalled();
    expect(result).toEqual({
      status: 422,
      body: { error: "Your chat account could not be found. Please contact support to restore access." },
    });
    expect(h.sets).toContainEqual(projectAgentStateWrite("error", {
      lastError: "Your chat account could not be found. Please contact support to restore access.",
    }));
    expect(h.logger.error).toHaveBeenCalled();
  });
});

const SECRET_PATH = "users/owner-1/secrets/projectAgentMattermost-orbit";
const ROSTER_REMOVAL = {
  path: "users/owner-1",
  data: {
    "provisioning.openclaw.agentIds": { arrayRemove: ["octogee-mira-proj-orbit-coach"] },
  },
};

describe("retireProjectAgentForDeletion", () => {
  it("retires the minted bot, then removes the roster id", async () => {
    h.docs.set(SECRET_PATH, { mmUserId: "bot-1", personalToken: "pat-1" });

    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      project: "orbit",
      mmUserId: "bot-1",
    });
    expect(h.updates).toEqual([ROSTER_REMOVAL]);
  });

  it("removes a stale roster id even when no bot secret exists", async () => {
    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).not.toHaveBeenCalled();
    expect(h.updates).toEqual([ROSTER_REMOVAL]);
  });

  it("drops a secret without an mmUserId so config demand cannot outlive the project", async () => {
    h.docs.set(SECRET_PATH, { personalToken: "pat-1" });

    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).not.toHaveBeenCalled();
    expect(h.deletes).toEqual([SECRET_PATH]);
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.updates).toEqual([ROSTER_REMOVAL]);
  });

  it("keeps the roster id when retiring fails — the roster must stay a superset of config demand", async () => {
    h.docs.set(SECRET_PATH, { mmUserId: "bot-1", personalToken: "pat-1" });
    h.retireProjectAgentBot.mockRejectedValue(new Error("MM down"));

    await expect(retireProjectAgentForDeletion("owner-1", "mira", "orbit")).rejects.toThrow(
      "MM down",
    );

    expect(h.updates).toEqual([]);
  });
});
