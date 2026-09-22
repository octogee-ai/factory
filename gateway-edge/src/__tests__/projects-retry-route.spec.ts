import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Project = Record<string, unknown>;
type ProjectUpdate = Record<string, unknown>;

const h = vi.hoisted(() => ({
  uid: "owner-1",
  wid: "mira",
  pid: "orbit",
  project: {
    ownerUid: "owner-1",
    name: "Orbit",
    visibility: "private",
    pendingVisibility: "public",
    provisioningState: "failed",
  } as Project,
  projectUpdates: [] as ProjectUpdate[],
  channelWrites: [] as Array<{ path: string; data: ProjectUpdate; options?: ProjectUpdate }>,
  generalChannel: undefined as ProjectUpdate | undefined,
  userData: { username: "mira" } as ProjectUpdate,
  mmContext: {
    teamId: "team-1",
    userId: "owner-mm",
    coachUserId: "agent-mm",
  } as ProjectUpdate | null,
  mmApi: vi.fn(),
  provisionProjectRepo: vi.fn(),
  provisionProjectAgent: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

function projectRef() {
  return {
    path: `workspaces/${h.wid}/projects/${h.pid}`,
    get: async () => ({ exists: true, data: () => h.project }),
    update: async (data: ProjectUpdate) => {
      h.projectUpdates.push(data);
    },
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: h.generalChannel !== undefined,
          data: () => h.generalChannel,
        }),
        set: async (data: ProjectUpdate, options?: ProjectUpdate) => {
          h.channelWrites.push({ path: `${name}/${id}`, data, options });
          h.generalChannel = data;
        },
      }),
    }),
  };
}

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => {
    next();
  },
}));

vi.mock("../lib/withProject.js", () => ({
  withProject: async (
    req: { uid?: string },
    _res: unknown,
    wid: string,
    pid: string,
    _opts: unknown,
    handler: (ctx: Record<string, unknown>) => Promise<void>,
  ) => {
    req.uid = h.uid;
    await handler({
      projectRef: projectRef(),
      project: h.project,
      uid: h.uid,
      wid,
      pid,
    });
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    runTransaction: async (handler: (transaction: unknown) => Promise<unknown>) => handler({
      get: (ref: { get(): Promise<unknown> }) => ref.get(),
      update: (_ref: unknown, data: ProjectUpdate) => {
        h.projectUpdates.push(data);
        Object.assign(h.project, data);
      },
    }),
    doc: (path: string) => {
      if (path !== `users/${h.uid}`) throw new Error(`unexpected doc ${path}`);
      return {
        get: async () => ({
          data: () => h.userData,
        }),
      };
    },
  },
  FieldValue: {
    serverTimestamp: () => "SERVER_TS",
    delete: () => "DELETE_FIELD",
  },
}));

vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: (..._args: unknown[]) => h.mmContext,
}));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../routes/projects/provisioning.js", () => ({
  provisionProjectRepo: (...args: unknown[]) => h.provisionProjectRepo(...args),
}));

vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: (...args: unknown[]) => h.provisionProjectAgent(...args),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

const { default: retryRoutes } = await import("../routes/projects/retry.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/projects", retryRoutes);
  return a;
}

beforeEach(() => {
  h.uid = "owner-1";
  h.wid = "mira";
  h.pid = "orbit";
  h.project = {
    ownerUid: "owner-1",
    name: "Orbit",
    tagline: "Ship it",
    projectType: "web",
    visibility: "private",
    pendingVisibility: "public",
    provisioningState: "failed",
  };
  h.projectUpdates.length = 0;
  h.channelWrites.length = 0;
  h.generalChannel = undefined;
  h.userData = { username: "mira" };
  h.mmContext = {
    teamId: "team-1",
    userId: "owner-mm",
    coachUserId: "agent-mm",
  };
  h.mmApi.mockReset().mockImplementation(async (path: string, method?: string) => {
    if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-1/channels/name/")) {
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === "POST" && path === "/channels/channel-1/members") return { ok: true };
    throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
  });
  h.provisionProjectRepo.mockReset().mockResolvedValue(null);
  h.provisionProjectAgent.mockReset().mockResolvedValue({ status: 200, body: { success: true } });
  h.logger.error.mockReset();
  h.logger.info.mockReset();
});

describe("POST /api/projects/:wid/:pid/retry-provisioning", () => {
  it("recreates the project primary channel, reconciles the repo, and activates the project", async () => {
    const res = await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(200);

    expect(res.body).toEqual({ success: true, channelId: "channel-1" });
    expect(h.mmApi).toHaveBeenCalledWith("/teams/team-1/channels/name/mira-proj-orbit-general");
    expect(h.mmApi).toHaveBeenCalledWith("/channels", "POST", {
      team_id: "team-1",
      name: "mira-proj-orbit-general",
      display_name: "Orbit",
      type: "P",
    });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "owner-mm" });
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels/channel-1/members", "POST", { user_id: "agent-mm" });
    expect(h.provisionProjectAgent).toHaveBeenCalledWith({ uid: "owner-1", workspaceId: "mira" }, "orbit");
    expect(h.provisionProjectRepo).toHaveBeenCalledWith({
      workspaceId: "mira",
      slug: "orbit",
      name: "Orbit",
      tagline: "Ship it",
      projectType: "web",
      visibility: "public",
      githubBacked: false,
      recipe: "static-site",
    });
    expect(h.channelWrites).toEqual([
      {
        path: "channels/general",
        data: {
          id: "general",
          kind: "general",
          name: "general",
          mattermost: {
            channelId: "channel-1",
          },
          createdAt: "SERVER_TS",
        },
        options: { merge: true },
      },
    ]);
    expect(h.projectUpdates.at(-1)).toEqual({
      provisioningState: "active",
      provisioningError: null,
      visibility: "public",
      pendingVisibility: null,
      giteaRepoName: "orbit",
      updatedAt: "SERVER_TS",
    });
  });

  it.each([
    { provisioningState: "provisioning" },
    { provisioningState: "failed", provisioningCleanup: { status: "in_progress" } },
  ])("rejects a retry while setup or cleanup is running: %j", async (state) => {
    Object.assign(h.project, state);

    await request(app()).post("/api/projects/mira/orbit/retry-provisioning").expect(409);

    expect(h.projectUpdates).toEqual([]);
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.provisionProjectRepo).not.toHaveBeenCalled();
  });

  it("rejects retrying an active project with its primary channel already recorded", async () => {
    h.project.provisioningState = "active";
    h.generalChannel = { mattermost: { channelId: "channel-1" } };

    await request(app()).post("/api/projects/mira/orbit/retry-provisioning").expect(409);

    expect(h.projectUpdates).toEqual([]);
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("retains repair of an active project whose primary channel document is missing", async () => {
    h.project.provisioningState = "active";

    await request(app()).post("/api/projects/mira/orbit/retry-provisioning").expect(200);

    expect(h.projectUpdates[0]).toMatchObject({ provisioningState: "provisioning" });
    expect(h.projectUpdates.at(-1)).toMatchObject({ provisioningState: "active" });
    expect(h.generalChannel).toMatchObject({ mattermost: { channelId: "channel-1" } });
  });

  it("preserves GitHub-backed provisioning so retry does not seed the wrong Board", async () => {
    h.project.repoSource = { provider: "github", owner: "octogee-ai", repo: "demo" };

    await request(app()).post("/api/projects/mira/orbit/retry-provisioning").expect(200);

    expect(h.provisionProjectRepo).toHaveBeenCalledWith(expect.objectContaining({ githubBacked: true }));
  });

  it("returns an unexpectedly interrupted retry to failed so the owner can try again", async () => {
    h.provisionProjectRepo.mockRejectedValueOnce(new Error("broker connection reset"));

    await request(app()).post("/api/projects/mira/orbit/retry-provisioning").expect(500);

    expect(h.projectUpdates.at(-1)).toMatchObject({
      provisioningState: "failed", provisioningError: "broker connection reset",
    });
  });

  it("marks retry failed when the workspace has no Mattermost team context", async () => {
    h.mmContext = null;

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(502, { error: "Retry failed — workspace chat is not ready" });

    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.projectUpdates).toEqual([
      {
        provisioningState: "provisioning",
        provisioningError: null,
        provisioningCleanup: null,
        updatedAt: "SERVER_TS",
      },
      {
        provisioningState: "failed",
        provisioningError: "Workspace has no Mattermost team context",
        updatedAt: "SERVER_TS",
      },
    ]);
  });

  it("converts a legacy public Mattermost channel to private before retrying", async () => {
    h.mmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-1/channels/name/")) {
        return { id: "legacy-channel", type: "O" };
      }
      if (method === "PUT" && path === "/channels/legacy-channel/privacy") return { ok: true };
      if (method === "POST" && path === "/channels/legacy-channel/members") return { ok: true };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(200);

    expect(h.mmApi).toHaveBeenCalledWith("/channels/legacy-channel/privacy", "PUT", { privacy: "P" });
    expect(h.provisionProjectRepo).toHaveBeenCalled();
  });

  it("reseeds against the recipe the project already carries", async () => {
    h.project.recipe = "astro-static";

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(200);

    expect(h.provisionProjectRepo).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: "astro-static" }),
    );
  });

  it("falls back to the type default when the project doc carries no usable recipe", async () => {
    h.project.projectType = "game";
    h.project.recipe = "node-service";

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(200);

    expect(h.provisionProjectRepo).toHaveBeenCalledWith(
      expect.objectContaining({ projectType: "game", recipe: "vite-static" }),
    );
  });

  it("keeps the project failed when repository reconciliation reports an error", async () => {
    h.provisionProjectRepo.mockResolvedValueOnce("Gitea unreachable");

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(502, { error: "Retry failed — could not reconcile code repo" });

    expect(h.projectUpdates.at(-1)).toEqual({
      provisioningState: "failed",
      provisioningError: "Gitea unreachable",
      updatedAt: "SERVER_TS",
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "[projects] Gitea reconcile failed for mira/orbit: Gitea unreachable",
    );
  });

  it("restores the verified archived primary recorded by failed provisioning", async () => {
    h.generalChannel = {
      mattermost: {
        channelId: "archived-channel",
      },
    };
    h.mmApi.mockImplementation(async (path: string, method?: string) => {
      if (path === "/channels/archived-channel" && method === undefined) {
        return {
          id: "archived-channel",
          name: "mira-proj-orbit-general",
          team_id: "team-1",
          type: "P",
          delete_at: 1,
        };
      }
      if (path === "/channels/archived-channel/restore" && method === "POST") return { ok: true };
      if (method === "POST" && path === "/channels/archived-channel/members") return { ok: true };
      throw new Error(`unexpected Mattermost call: ${method ?? "GET"} ${path}`);
    });

    await request(app())
      .post("/api/projects/mira/orbit/retry-provisioning")
      .expect(200, { success: true, channelId: "archived-channel" });

    expect(h.mmApi).toHaveBeenCalledWith("/channels/archived-channel/restore", "POST");
    expect(h.mmApi).not.toHaveBeenCalledWith(
      "/teams/team-1/channels/name/mira-proj-orbit-general",
    );
    expect(h.mmApi).not.toHaveBeenCalledWith("/channels", "POST", expect.anything());
    expect(h.channelWrites[0]?.data).toMatchObject({
      mattermost: { channelId: "archived-channel" },
    });
  });
});
