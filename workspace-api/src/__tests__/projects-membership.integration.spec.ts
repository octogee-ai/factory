/**
 * Integration tests for the project membership endpoints — join, leave,
 * star, and remove-guest. All four used to be untested before the
 * per-endpoint file split made them obvious holes.
 *
 * Scope:
 * - POST   /api/projects/:wid/:pid/join  — auth state transitions,
 *     visibility gate, owner self-join rejection, idempotent re-join.
 * - POST   /api/projects/:wid/:pid/leave — owner self-leave rejection,
 *     no-op-on-not-a-member, member-count decrement.
 * - POST   /api/projects/:wid/:pid/star  — toggle semantics (two calls
 *     → starred then unstarred), 404 for missing project.
 * - DELETE /api/projects/:wid/:pid/members/:guestUid — owner-only guard,
 *     can't remove the owner, member-count decrement, idempotent unknown-
 *     member case.
 *
 * The Firestore + MM + Gitea mocks match the pattern established in
 * projects.integration.spec.ts (same in-memory `firestoreData` store,
 * same mmApi / giteaApi vi.fn spies).
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Firestore mock state ────────────────────────────────────────────────────

const firestoreData: Record<string, any> = {};
const mockSet = vi.fn(async (_path: string, _data: any) => undefined);
const mockUpdate = vi.fn(async (_path: string, _data: any) => undefined);
const mockDelete = vi.fn(async (_path: string) => undefined);

function resetFirestoreMocks() {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  mockSet.mockClear();
  mockUpdate.mockClear();
  mockDelete.mockClear();
}

vi.mock("../lib/db", () => {
  const makeDocRef = (path: string): any => ({
    get: async () => {
      const data = firestoreData[path];
      return { exists: !!data, data: () => data };
    },
    set: async (data: any) => {
      firestoreData[path] = { ...(firestoreData[path] || {}), ...data };
      mockSet(path, data);
    },
    update: async (data: any) => {
      firestoreData[path] = { ...(firestoreData[path] || {}), ...data };
      mockUpdate(path, data);
    },
    delete: async () => {
      delete firestoreData[path];
      mockDelete(path);
    },
    collection: (sub: string) => ({
      doc: (subId: string) => makeDocRef(`${path}/${sub}/${subId}`),
    }),
  });

  return {
    auth: {
      verifyIdToken: vi.fn().mockResolvedValue({ uid: "caller-uid" }),
    },
    db: {
      doc: (path: string) => makeDocRef(path),
      collection: (name: string) => ({
        doc: (id: string) => makeDocRef(`${name}/${id}`),
      }),
    },
    FieldValue: {
      serverTimestamp: () => ({ __op: "serverTimestamp" }),
      increment: (n: number) => ({ __op: "increment", value: n }),
    },
  };
});

const mockMmApi = vi.fn();
vi.mock("../lib/mattermost", () => ({
  mmApi: (...args: any[]) => mockMmApi(...args),
}));

const mockGetWorkspaceMmContext = vi.fn();
vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: (...args: any[]) => mockGetWorkspaceMmContext(...args),
}));

const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: any[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: vi.fn(),
  giteaWriteFile: vi.fn(),
}));

import { createApp } from "../index";

function authHeaders() {
  return { Authorization: "Bearer valid-token" };
}

// Shared fixture: an Alice-owned public project with Bob as a pre-existing
// member. Individual tests mutate `firestoreData` to get the shape they
// want (private visibility, missing member, etc.).
function seedPublicAliceGame() {
  firestoreData["workspaces/alice/projects/game"] = {
    id: "game",
    ownerUid: "alice-uid",
    workspaceId: "alice",
    slug: "game",
    name: "Game",
    visibility: "public",
    provisioningState: "active",
    giteaRepoName: "alice-proj-game",
    memberCount: 2,
  };
  firestoreData["workspaces/alice/projects/game/channels/general"] = {
    id: "general",
    kind: "general",
    name: "general",
    mattermost: { channelId: "ch-alice-game" },
  };
  firestoreData["users/caller-uid"] = {
    username: "bob",
    mattermost: { userId: "mm-bob" },
  };
  firestoreData["users/alice-uid"] = {
    username: "alice",
    mattermost: { userId: "mm-alice" },
  };
}

beforeEach(() => {
  resetFirestoreMocks();
  mockMmApi.mockReset();
  mockGiteaApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  // Sensible default — owner's workspace has an MM team.
  mockGetWorkspaceMmContext.mockResolvedValue({ teamId: "team-alice" });
});

// ─── POST /:wid/:pid/join ────────────────────────────────────────────────────

describe("POST /api/projects/:wid/:pid/join", () => {
  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/join")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when the caller is the project owner", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].ownerUid = "caller-uid";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already own/i);
  });

  it("returns 403 when the project is private", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].visibility = "private";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invite/i);
  });

  it("short-circuits with alreadyMember:true when the member doc exists", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game/members/caller-uid"] = {
      id: "caller-uid",
      role: "member",
    };
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/join")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, alreadyMember: true });
    // Didn't bump memberCount on the no-op path.
    expect(mockUpdate).not.toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.anything() }),
    );
  });

  it("adds the caller as a member + increments memberCount on first join", async () => {
    seedPublicAliceGame();
    // MM team-membership check: 404 means "not a member yet, add them".
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
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(firestoreData["workspaces/alice/projects/game/members/caller-uid"]).toMatchObject({
      id: "caller-uid",
      role: "member",
    });
    // MemberCount bumped.
    expect(mockUpdate).toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.objectContaining({ __op: "increment", value: 1 }) }),
    );
    // Gitea read-access grant fired.
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice-proj-game/collaborators/ws-bob",
      "PUT",
      { permission: "read" },
    );
  });
});

// ─── POST /:wid/:pid/leave ───────────────────────────────────────────────────

describe("POST /api/projects/:wid/:pid/leave", () => {
  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/leave")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when the caller is the project owner", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].ownerUid = "caller-uid";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot leave/i);
  });

  it("short-circuits with notAMember:true when the member doc is absent", async () => {
    seedPublicAliceGame();
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, notAMember: true });
    // No memberCount change on the no-op path.
    expect(mockUpdate).not.toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.anything() }),
    );
  });

  it("removes the member doc + decrements memberCount on the happy path", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game/members/caller-uid"] = {
      id: "caller-uid",
      role: "member",
    };
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/leave")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(firestoreData["workspaces/alice/projects/game/members/caller-uid"]).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.objectContaining({ __op: "increment", value: -1 }) }),
    );
    // MM channel leave attempted.
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-alice-game/members/mm-bob",
      "DELETE",
    );
    // Gitea access revoke attempted.
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice-proj-game/collaborators/ws-bob",
      "DELETE",
    );
  });
});

// ─── POST /:wid/:pid/star — toggle ───────────────────────────────────────────

describe("POST /api/projects/:wid/:pid/star", () => {
  it("returns 404 when the project does not exist (first star attempt)", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/star")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(404);
  });

  it("creates the star doc + bumps starCount on first call", async () => {
    seedPublicAliceGame();
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/star")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ starred: true });
    expect(firestoreData["stars/caller-uid_alice_game"]).toMatchObject({
      starrerUid: "caller-uid",
      workspaceId: "alice",
      projectSlug: "game",
      projectOwnerUid: "alice-uid",
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ starCount: expect.objectContaining({ __op: "increment", value: 1 }) }),
    );
  });

  it("removes the star doc + decrements starCount when toggled off", async () => {
    seedPublicAliceGame();
    firestoreData["stars/caller-uid_alice_game"] = {
      starrerUid: "caller-uid",
      workspaceId: "alice",
      projectSlug: "game",
      projectOwnerUid: "alice-uid",
    };
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/game/star")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ starred: false });
    expect(firestoreData["stars/caller-uid_alice_game"]).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ starCount: expect.objectContaining({ __op: "increment", value: -1 }) }),
    );
  });
});

// ─── DELETE /:wid/:pid/members/:guestUid ─────────────────────────────────────

describe("DELETE /api/projects/:wid/:pid/members/:guestUid", () => {
  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/ghost/members/guest-uid")
      .set(authHeaders());
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not the project owner", async () => {
    seedPublicAliceGame();
    // caller-uid is bob, owner is alice-uid — so caller isn't the owner.
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/guest-uid")
      .set(authHeaders());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the project owner/i);
  });

  it("returns 400 when the caller tries to remove the owner", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].ownerUid = "caller-uid";
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/caller-uid")
      .set(authHeaders());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot remove the project owner/i);
  });

  it("short-circuits with notAMember:true when the guest has no member doc", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].ownerUid = "caller-uid";
    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/ghost-guest")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, notAMember: true });
    expect(mockUpdate).not.toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.anything() }),
    );
  });

  it("removes the guest, decrements memberCount, and revokes MM+Gitea access", async () => {
    seedPublicAliceGame();
    firestoreData["workspaces/alice/projects/game"].ownerUid = "caller-uid";
    firestoreData["workspaces/alice/projects/game/members/guest-uid"] = {
      id: "guest-uid",
      role: "member",
    };
    firestoreData["users/guest-uid"] = {
      username: "guesty",
      mattermost: { userId: "mm-guest" },
    };
    mockMmApi.mockResolvedValue({ ok: true });
    mockGiteaApi.mockResolvedValue({ ok: true });

    const app = createApp();
    const res = await request(app)
      .delete("/api/projects/alice/game/members/guest-uid")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(firestoreData["workspaces/alice/projects/game/members/guest-uid"]).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith(
      "workspaces/alice/projects/game",
      expect.objectContaining({ memberCount: expect.objectContaining({ __op: "increment", value: -1 }) }),
    );
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-alice-game/members/mm-guest",
      "DELETE",
    );
    expect(mockGiteaApi).toHaveBeenCalledWith(
      "alice-proj-game/collaborators/ws-guesty",
      "DELETE",
    );
  });
});
