import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../lib/db.js";
import {
  setupEmulatorTest,

  getIdTokenForUid,
} from "@octogee/test-helpers/firestore-emulator";

const mockMmApi = vi.fn();
vi.mock("../lib/mattermost", () => ({
  mmApi: (...args: unknown[]) => mockMmApi(...args),
}));

const mockGetWorkspaceMmContext = vi.fn();
vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: (...args: unknown[]) => mockGetWorkspaceMmContext(...args),
}));

const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: unknown[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: vi.fn(),
  giteaWriteFile: vi.fn(),
  giteaWriteFiles: vi.fn(),
}));

const mockAddChannelMember = vi.fn();
const mockRemoveChannelMember = vi.fn();
vi.mock("../lib/channel-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channel-lifecycle")>();
  return {
    ...actual,
    addChannelMember: (...args: unknown[]) => mockAddChannelMember(...args),
    removeChannelMember: (...args: unknown[]) => mockRemoveChannelMember(...args),
  };
});

import { createApp } from "../index.js";
import projectJoinLeaveRoutes from "../routes/projects/join-leave.js";
import projectMembersRoutes from "../routes/projects/members.js";

const CALLER_UID = "caller-uid";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function routeSignatures(router: unknown): string[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      if (!route) throw new Error("expected route layer");
      const methods = Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase())
        .sort()
        .join(",");
      return `${methods} ${route.path}`;
    });
}

async function authHeader(uid: string = CALLER_UID): Promise<{ Authorization: string }> {
  const token = await getIdTokenForUid(uid);
  return { Authorization: `Bearer ${token}` };
}

async function seedCaller(uid: string, username = "bob", mmUserId = "mm-bob"): Promise<void> {
  await db.collection("users").doc(uid).set({
    username,
    mattermost: { userId: mmUserId },
    subscription: { tier: "personal", status: "active" },
  });
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set({ role: "user" });
}

async function seedPublicAliceGame(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await db
    .collection("workspaces")
    .doc("alice")
    .collection("projects")
    .doc("game")
    .set({
      id: "game",
      ownerUid: "alice-uid",
      workspaceId: "alice",
      slug: "game",
      name: "Game",
      visibility: "public",
      provisioningState: "active",
      giteaRepoName: "alice-proj-game",
      memberCount: 2,
      ...overrides,
    });
  await db
    .collection("workspaces")
    .doc("alice")
    .collection("projects")
    .doc("game")
    .collection("channels")
    .doc("general")
    .set({
      id: "general",
      kind: "general",
      name: "general",
      mattermost: { channelId: "ch-alice-game" },
    });
  await db.collection("users").doc("alice-uid").set({
    username: "alice",
    mattermost: { userId: "mm-alice" },
    subscription: { tier: "personal", status: "active" },
  });
}

async function seedProjectActivityChannel(): Promise<void> {
  await db
    .collection("workspaces")
    .doc("alice")
    .collection("projects")
    .doc("game")
    .collection("channels")
    .doc("general")
    .set({
      mattermost: {
        channelId: "ch-alice-game",
        activityChannelId: "ch-alice-game-activity",
      },
    }, { merge: true });
}

async function getProjectDoc(): Promise<Record<string, unknown> | undefined> {
  const snap = await db
    .collection("workspaces")
    .doc("alice")
    .collection("projects")
    .doc("game")
    .get();
  return snap.data();
}

async function getMemberDoc(uid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db
    .collection("workspaces")
    .doc("alice")
    .collection("projects")
    .doc("game")
    .collection("members")
    .doc(uid)
    .get();
  return snap.data();
}

async function getStarDoc(id: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection("stars").doc(id).get();
  return snap.data();
}

setupEmulatorTest();
beforeEach(async () => {
  mockMmApi.mockReset();
  mockGiteaApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  mockAddChannelMember.mockReset().mockResolvedValue(undefined);
  mockRemoveChannelMember.mockReset().mockResolvedValue(undefined);
  mockGetWorkspaceMmContext.mockResolvedValue({ teamId: "team-alice" });
  await seedCaller(CALLER_UID);
});

describe("project membership route modules", () => {
  it("exports the join, leave, and guest-removal endpoints covered by this suite", () => {
    expect(routeSignatures(projectJoinLeaveRoutes)).toEqual([
      "POST /:wid/:pid/join",
      "POST /:wid/:pid/leave",
    ]);
    expect(routeSignatures(projectMembersRoutes)).toEqual([
      "DELETE /:wid/:pid/members/:guestUid",
    ]);
  });
});

describe("POST /api/projects/:wid/:pid/join", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).post("/api/projects/alice/game/join").send({});
    expect(res.status).toBe(401);
  });

  it("returns 401 on a malformed Bearer token", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/join")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when the caller is the project owner", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already own/i);
  });

  it("returns 403 when the project is private", async () => {
    await seedPublicAliceGame({ visibility: "private" });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invite/i);
  });

  it("short-circuits with alreadyMember:true when the member doc exists", async () => {
    await seedPublicAliceGame();
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("game")
      .collection("members")
      .doc(CALLER_UID)
      .set({ id: CALLER_UID, role: "member" });

    const beforeMemberCount = (await getProjectDoc())?.memberCount;
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, alreadyMember: true });
    expect((await getProjectDoc())?.memberCount).toBe(beforeMemberCount);
  });

  it("adds the caller as a member + increments memberCount on first join", async () => {
    await seedPublicAliceGame();
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (path === "/users/mm-bob" && (!method || method === "GET")) return { id: "mm-bob", delete_at: 0 };
      if (method === "POST" && path === "/teams/team-alice/members") return { ok: true };
      if (method === "POST" && path.includes("/channels/ch-alice-game/members")) return { ok: true };
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await getMemberDoc(CALLER_UID)).toMatchObject({
      id: CALLER_UID,
      role: "member",
    });
    expect((await getProjectDoc())?.memberCount).toBe(3);
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice",
      "game/collaborators/ws-bob",
      "PUT",
      { permission: "read" },
    );
  });

  it("adds the caller to the primary project channel on first join", async () => {
    await seedPublicAliceGame();
    await seedProjectActivityChannel();
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (path === "/users/mm-bob" && (!method || method === "GET")) return { id: "mm-bob", delete_at: 0 };
      return { ok: true };
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(mockAddChannelMember).toHaveBeenCalledWith(
      "workspaces/alice/projects/game/channels/general",
      "mm-bob",
    );
  });

  it("returns 422 and leaves the caller unjoined when the Mattermost identity is missing", async () => {
    await seedPublicAliceGame();
    await seedProjectActivityChannel();
    const { MattermostIdentityMissingError } = await import("../lib/channel-lifecycle.js");
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/teams/team-alice/members") return { ok: true };
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    mockAddChannelMember.mockRejectedValueOnce(
      new MattermostIdentityMissingError("Mattermost user mm-bob was not found"),
    );

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/chat account|identity/i);
    expect(await getMemberDoc(CALLER_UID)).toBeUndefined();
  });

  it("resolves the caller's Mattermost identity before adding them to the chat team", async () => {
    await seedPublicAliceGame();
    await seedProjectActivityChannel();
    const teamAddCalls: string[] = [];
    mockMmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/users/mm-bob" && method === "GET") {
        const err = new Error("not found") as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      if (path.includes("/teams/") && path.includes("/members")) teamAddCalls.push(`${method} ${path}`);
      return { ok: true };
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(422);
    expect(teamAddCalls).toHaveLength(0);
    expect(mockAddChannelMember).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:wid/:pid/leave", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).post("/api/projects/alice/game/leave").send({});
    expect(res.status).toBe(401);
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/leave")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when the caller is the project owner", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot leave/i);
  });

  it("short-circuits with notAMember:true when the member doc is absent", async () => {
    await seedPublicAliceGame();
    const beforeMemberCount = (await getProjectDoc())?.memberCount;
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, notAMember: true });
    expect((await getProjectDoc())?.memberCount).toBe(beforeMemberCount);
  });

  it("removes the member doc + decrements memberCount on the happy path", async () => {
    await seedPublicAliceGame();
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("game")
      .collection("members")
      .doc(CALLER_UID)
      .set({ id: CALLER_UID, role: "member" });
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await getMemberDoc(CALLER_UID)).toBeUndefined();
    expect((await getProjectDoc())?.memberCount).toBe(1);
    expect(mockRemoveChannelMember).toHaveBeenCalledWith(
      "workspaces/alice/projects/game/channels/general",
      "mm-bob",
    );
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice",
      "game/collaborators/ws-bob",
      "DELETE",
    );
  });

  it("removes the caller from the primary project channel on leave", async () => {
    await seedPublicAliceGame();
    await seedProjectActivityChannel();
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("game")
      .collection("members")
      .doc(CALLER_UID)
      .set({ id: CALLER_UID, role: "member" });
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(mockRemoveChannelMember).toHaveBeenCalledWith(
      "workspaces/alice/projects/game/channels/general",
      "mm-bob",
    );
  });
});

describe("POST /api/projects/:wid/:pid/star", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).post("/api/projects/alice/game/star").send({});
    expect(res.status).toBe(401);
  });

  it("returns 404 when the project does not exist (first star attempt)", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/star")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(404);
  });

  it("creates the typed-target star doc on first call (CF aggregator owns starCount)", async () => {
    await seedPublicAliceGame();
    const beforeStarCount = (await getProjectDoc())?.starCount;
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/star")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ starred: true });
    const star = await getStarDoc(`${CALLER_UID}_p_alice_game`);
    expect(star).toMatchObject({
      actorUid: CALLER_UID,
      target: {
        type: "project",
        workspaceSlug: "alice",
        projectSlug: "game",
        ownerUid: "alice-uid",
      },
    });
    expect((await getProjectDoc())?.starCount).toBe(beforeStarCount);
  });

  it("removes the star doc when toggled off (CF aggregator decrements)", async () => {
    await seedPublicAliceGame();
    await db.collection("stars").doc(`${CALLER_UID}_p_alice_game`).set({
      actorUid: CALLER_UID,
      target: {
        type: "project",
        workspaceSlug: "alice",
        projectSlug: "game",
        ownerUid: "alice-uid",
      },
    });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/star")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ starred: false });
    expect(await getStarDoc(`${CALLER_UID}_p_alice_game`)).toBeUndefined();
  });
});

describe("DELETE /api/projects/:wid/:pid/members/:guestUid", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).delete("/api/projects/alice/game/members/guest-uid");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/ghost/members/guest-uid")
      .set(await authHeader());
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not the project owner", async () => {
    await seedPublicAliceGame();
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/guest-uid")
      .set(await authHeader());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the project owner/i);
  });

  it("returns 400 when the caller (as owner) tries to remove the owner", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    const app = createApp();
    const res = await request(app)
      .delete(`/api/projects/alice/game/members/${CALLER_UID}`)
      .set(await authHeader());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot remove the project owner/i);
  });

  it("short-circuits with notAMember:true when the guest has no member doc", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    const beforeMemberCount = (await getProjectDoc())?.memberCount;
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/ghost-guest")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, notAMember: true });
    expect((await getProjectDoc())?.memberCount).toBe(beforeMemberCount);
  });

  it("removes the guest, decrements memberCount, and revokes MM+Gitea access", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("game")
      .collection("members")
      .doc("guest-uid")
      .set({ id: "guest-uid", role: "member" });
    await db.collection("users").doc("guest-uid").set({
      username: "guesty",
      mattermost: { userId: "mm-guest" },
    });
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/guest-uid")
      .set(await authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await getMemberDoc("guest-uid")).toBeUndefined();
    expect((await getProjectDoc())?.memberCount).toBe(1);
    expect(mockRemoveChannelMember).toHaveBeenCalledWith(
      "workspaces/alice/projects/game/channels/general",
      "mm-guest",
    );
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice",
      "game/collaborators/ws-guesty",
      "DELETE",
    );
  });

  it("removes the guest from the primary project channel", async () => {
    await seedPublicAliceGame({ ownerUid: CALLER_UID });
    await seedProjectActivityChannel();
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("game")
      .collection("members")
      .doc("guest-uid")
      .set({ id: "guest-uid", role: "member" });
    await db.collection("users").doc("guest-uid").set({
      username: "guesty",
      mattermost: { userId: "mm-guest" },
    });
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/guest-uid")
      .set(await authHeader());

    expect(res.status).toBe(200);
    expect(mockRemoveChannelMember).toHaveBeenCalledWith(
      "workspaces/alice/projects/game/channels/general",
      "mm-guest",
    );
  });
});
