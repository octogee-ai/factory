import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../lib/db.js";
import {
  setupEmulatorTest,

  getIdTokenForUid,
} from "@shared/test-helpers/firestore-emulator.js";

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
}));

import { createApp } from "../index.js";

const CALLER_UID = "caller-uid";

async function authHeader(uid: string = CALLER_UID): Promise<{ Authorization: string }> {
  const token = await getIdTokenForUid(uid);
  return { Authorization: `Bearer ${token}` };
}

async function seedCaller(uid: string, username = "bob", mmUserId = "mm-bob"): Promise<void> {
  await db.collection("users").doc(uid).set({
    username,
    mattermost: { userId: mmUserId },
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
  });
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
  mockGetWorkspaceMmContext.mockResolvedValue({ teamId: "team-alice" });
  await seedCaller(CALLER_UID);
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
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-alice-game/members/mm-bob",
      "DELETE",
    );
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice",
      "game/collaborators/ws-bob",
      "DELETE",
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
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-alice-game/members/mm-guest",
      "DELETE",
    );
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice",
      "game/collaborators/ws-guesty",
      "DELETE",
    );
  });
});
