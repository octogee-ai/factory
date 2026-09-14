import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockInternalFetch = vi.fn();
vi.mock("../lib/internal-fetch", () => ({
  internalFetch: (...args: unknown[]) => mockInternalFetch(...args),
}));

const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: unknown[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: vi.fn(),
  giteaWriteFile: vi.fn(),
  giteaWriteFiles: vi.fn(),
  giteaDeleteVerifiedRepo: vi.fn(),
}));

import { createApp } from "../index.js";

const CALLER_UID = "caller-uid";
const ORIGINAL_FLEET_BROKER_URL = process.env.FLEET_BROKER_URL;

async function authHeader(uid: string = CALLER_UID): Promise<{ Authorization: string }> {
  const token = await getIdTokenForUid(uid);
  return { Authorization: `Bearer ${token}` };
}

async function seedCaller(uid: string, username = "alice", workspaceId = "alice"): Promise<void> {
  await db.collection("users").doc(uid).set({
    username,
    workspaceId,
    // A paid tier (unlimited projects) so these provisioning-mechanics tests
    // clear the maxProjects gate; the gate itself is covered in
    // project-create-service.spec.ts.
    subscription: { tier: "personal_pro_max", status: "active" },
    provisioning: { openclaw: { slug: workspaceId } },
  });
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set({ role: "user" });
}

async function seedProject(
  wid: string,
  pid: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.collection("workspaces").doc(wid).collection("projects").doc(pid).set(data);
}

async function getProject(wid: string, pid: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection("workspaces").doc(wid).collection("projects").doc(pid).get();
  return snap.data();
}

async function getProjectChannel(
  wid: string,
  pid: string,
  channelId: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await db
    .collection("workspaces")
    .doc(wid)
    .collection("projects")
    .doc(pid)
    .collection("channels")
    .doc(channelId)
    .get();
  return snap.data();
}

function projectRepoProvisionInput(): Record<string, unknown> {
  const call = mockInternalFetch.mock.calls.find(([url]) => (
    String(url).endsWith("/internal/gitea/provision-project-repo")
  ));
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}

interface ProjectMattermostFixture {
  primaryId: string;
  primaryName: string;
  existingPrimary?: boolean;
  primaryType?: "P" | "O";
  teamId?: string;
  archivedRemnantId?: string;
}

const remnantOps: string[] = [];

function mockProjectMattermost(options: ProjectMattermostFixture): void {
  const teamId = options.teamId ?? "team-abc";
  const primaryMembers = new Set<string>();
  let primaryExists = options.existingPrimary ?? false;
  let primaryType = options.primaryType ?? "P";
  let remnant = options.archivedRemnantId
    ? { id: options.archivedRemnantId, name: options.primaryName, deleteAt: 1_700_000_000_000 }
    : null;
  const nameTaken = () => {
    const error = new Error(
      'MM API 400: {"id":"store.sql_channel.save_channel.exists.app_error","message":"A channel with that name already exists on the same team."}',
    ) as Error & { status: number };
    error.status = 400;
    return error;
  };

  const channel = (id: string, name: string, type: "P" | "O") => ({
    id,
    name,
    team_id: teamId,
    type,
    delete_at: 0,
  });
  const notFound = (path: string) => {
    const error = new Error(`MM API 404: ${path} not found`) as Error & { status: number };
    error.status = 404;
    return error;
  };

  mockMmApi.mockImplementation(async (
    path: string,
    method?: string,
    body?: Record<string, unknown>,
  ) => {
    const verb = method ?? "GET";
    if (verb === "GET" && path === `/teams/${teamId}/channels/name/${options.primaryName}?include_deleted=true`) {
      if (remnant && remnant.name === options.primaryName) {
        return { id: remnant.id, name: remnant.name, team_id: teamId, type: "P", delete_at: remnant.deleteAt };
      }
      if (primaryExists) return channel(options.primaryId, options.primaryName, primaryType);
      throw notFound(path);
    }
    if (remnant && verb === "POST" && path === `/channels/${remnant.id}/restore`) {
      remnantOps.push("restore");
      remnant.deleteAt = 0;
      return { id: remnant.id };
    }
    if (remnant && verb === "PUT" && path === `/channels/${remnant.id}/patch`) {
      remnantOps.push(`rename:${String(body?.name)}`);
      remnant = { ...remnant, name: String(body?.name) };
      return { id: remnant.id, name: remnant.name };
    }
    if (remnant && verb === "DELETE" && path === `/channels/${remnant.id}`) {
      remnantOps.push("archive");
      remnant.deleteAt = 1_700_000_000_000;
      return {};
    }
    if (verb === "GET" && path === `/teams/${teamId}/channels/name/${options.primaryName}`) {
      if (!primaryExists) throw notFound(path);
      return channel(options.primaryId, options.primaryName, primaryType);
    }
    if (verb === "GET" && path === `/channels/${options.primaryId}`) {
      if (!primaryExists) throw notFound(path);
      return channel(options.primaryId, options.primaryName, primaryType);
    }
    if (verb === "GET" && path === `/channels/${options.primaryId}/members?page=0&per_page=200`) {
      return [...primaryMembers].map((userId) => ({ user_id: userId }));
    }
    if (verb === "POST" && path === "/channels") {
      if (body?.name === options.primaryName && remnant && remnant.name === options.primaryName) {
        remnantOps.push("create:taken");
        throw nameTaken();
      }
      if (body?.name === options.primaryName && !primaryExists) {
        primaryExists = true;
        primaryType = body.type === "O" ? "O" : "P";
        return channel(options.primaryId, options.primaryName, primaryType);
      }
    }
    if (
      verb === "PUT"
      && path === `/channels/${options.primaryId}/privacy`
      && body?.privacy === "P"
    ) {
      primaryType = "P";
      return channel(options.primaryId, options.primaryName, primaryType);
    }
    if (verb === "POST" && path === `/channels/${options.primaryId}/members`) {
      if (typeof body?.user_id !== "string") throw new Error("primary member user_id is required");
      primaryMembers.add(body.user_id);
      return { user_id: body.user_id, channel_id: options.primaryId, roles: "channel_user" };
    }
    throw new Error(`Unexpected MM call: ${verb} ${path}`);
  });
}

setupEmulatorTest();
beforeEach(async () => {
  mockMmApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  mockGiteaApi.mockReset();
  mockInternalFetch.mockReset();
  mockInternalFetch.mockImplementation(async (
    url: RequestInfo | URL,
    init?: RequestInit,
    options?: { internalServiceKey?: string },
  ) => {
    if (String(url).endsWith("/internal/gitea/provision-project-repo")) {
      return new Response(JSON.stringify({ created: true }), { status: 200 });
    }
    const headers = new Headers(init?.headers);
    const internalServiceKey = options?.internalServiceKey ?? process.env.INTERNAL_SERVICE_KEY;
    if (internalServiceKey) headers.set("X-Internal-Service-Key", internalServiceKey);
    return globalThis.fetch(url, { ...init, headers });
  });
  process.env.FLEET_BROKER_URL = "http://octogee-api.test:3001";
});

afterEach(() => {
  if (ORIGINAL_FLEET_BROKER_URL === undefined) delete process.env.FLEET_BROKER_URL;
  else process.env.FLEET_BROKER_URL = ORIGINAL_FLEET_BROKER_URL;
});

describe("GET /api/projects/:wid/:pid/readme (public)", () => {
  it("returns the rendered README for a public project (no auth header required)", async () => {
    await seedProject("alice", "mygame", {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "README.md",
    });
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Hello from repo", "utf-8").toString("base64"),
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# Hello from repo");
    expect(res.body.path).toBe("README.md");
    expect(mockGiteaApi).toHaveBeenCalledWith("alice", "mygame/contents/README.md");
  });

  it("returns 404 for private projects (visibility leak guard)", async () => {
    await seedProject("alice", "secret", {
      visibility: "private",
      giteaRepoName: "alice-proj-secret",
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/secret/readme");

    expect(res.status).toBe(404);
    expect(mockGiteaApi).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/ghost/readme");
    expect(res.status).toBe(404);
  });

  it("allows unlisted projects to read via direct URL", async () => {
    await seedProject("alice", "soft", {
      visibility: "unlisted",
      giteaRepoName: "alice-proj-soft",
    });
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Unlisted is fine", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/soft/readme");
    expect(res.status).toBe(200);
    expect(res.body.content).toContain("Unlisted is fine");
  });

  it("returns empty content (not 500) when the Gitea repo 404s on the file", async () => {
    await seedProject("alice", "fresh", {
      visibility: "public",
      giteaRepoName: "alice-proj-fresh",
    });
    const err = new Error("Gitea API 404") as Error & { status: number };
    err.status = 404;
    mockGiteaApi.mockRejectedValue(err);

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/fresh/readme");
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("");
  });

  it("returns 404 for malformed workspace + project slugs (no Firestore read)", async () => {
    const app = createApp();
    const r1 = await request(app).get("/api/projects/-alice/mygame/readme");
    expect(r1.status).toBe(404);
    const r2 = await request(app).get("/api/projects/alice/MY-GAME/readme");
    expect(r2.status).toBe(404);
    expect(mockGiteaApi).not.toHaveBeenCalled();
  });

  it("falls back to README.md when canvasFile contains a path traversal", async () => {
    await seedProject("alice", "mygame", {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "../../../../etc/passwd",
    });
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Safe content", "utf-8").toString("base64"),
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("README.md");
    expect(mockGiteaApi).toHaveBeenCalledWith("alice", "mygame/contents/README.md");
  });

  it("falls back to README.md when canvasFile is an absolute path", async () => {
    await seedProject("alice", "mygame", {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "/etc/passwd",
    });
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("hi", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("README.md");
  });

  it("honors a legitimate nested canvasFile path", async () => {
    await seedProject("alice", "mygame", {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "docs/INTRO.md",
    });
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Intro", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("docs/INTRO.md");
    expect(mockGiteaApi).toHaveBeenCalledWith("alice", "mygame/contents/docs/INTRO.md");
  });
});

describe("GET /api/projects/slug-available", () => {
  beforeEach(async () => {
    await seedCaller(CALLER_UID);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app).get("/api/projects/slug-available?slug=mygame");
    expect(res.status).toBe(401);
  });

  it("rejects slugs containing hyphens", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=my-game")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/no hyphens/i);
  });

  it.each([
    ["uppercase letters", "MyGame", undefined],
    ["a reserved name", "settings", /reserved/],
    ["more than 16 characters", "seventeencharsxxx", undefined],
  ])("rejects a slug containing %s", async (_, slug, reason) => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/projects/slug-available?slug=${slug}`)
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    if (reason) expect(res.body.reason).toMatch(reason);
  });

  it("returns available=true for a valid, unclaimed slug", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=mygame")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it("returns available=false when a project with that slug already exists in the workspace", async () => {
    await seedProject("alice", "mygame", { id: "mygame" });
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=mygame")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("uses the server-managed workspace slug, not forged mutable username/workspaceId fields", async () => {
    await db.collection("users").doc(CALLER_UID).set({
      username: "victim",
      workspaceId: "victim",
      provisioning: { openclaw: { slug: "alice" } },
    });
    await seedProject("victim", "mygame", { id: "mygame" });
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=mygame")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });
});

describe("POST /api/projects — MM channel failure is hard-failure", () => {
  beforeEach(async () => {
    await seedCaller(CALLER_UID);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "My Game", slug: "mygame", visibility: "public" });
    expect(res.status).toBe(401);
  });

  it("returns 502 and marks provisioningState:failed when MM channel POST throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockRejectedValue(new Error("MM unreachable"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/provisioning/i);
    const doc = await getProject("alice", "mygame");
    expect(doc).toBeDefined();
    expect(doc?.provisioningState).toBe("failed");
    expect(doc?.provisioningError).toBeTruthy();
    expect(await getProjectChannel("alice", "mygame", "general")).toBeUndefined();
    expect(doc?.visibility).toBe("private");
    expect(doc?.pendingVisibility).toBe("public");
    expect(doc?.giteaRepoName).toBe("mygame");
  });

  it("returns 502 when teamId is missing (no MM workspace context)", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: null,
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("succeeds with 200 + provisioningState:active when MM channel creation succeeds", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-new-123",
      primaryName: "alice-proj-mygame-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.channelId).toBe("ch-new-123");
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("active");
    expect(doc?.visibility).toBe("public");
    expect(doc?.pendingVisibility).toBeNull();
    expect(doc?.giteaRepoName).toBe("mygame");
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      kind: "general",
      mattermost: { channelId: "ch-new-123" },
    });
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels",
      "POST",
      expect.objectContaining({ type: "P" }),
    );
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-new-123/members",
      "POST",
      { user_id: "mock-mm-user" },
    );
    expect(mockMmApi).not.toHaveBeenCalledWith(
      "/channels/ch-new-123/members",
      "POST",
      { user_id: "mock-mm-coach" },
    );
    expect(projectRepoProvisionInput()).toMatchObject({
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
    });
  });

  it("frees an archived channel that still holds the name, then creates fresh", async () => {
    remnantOps.length = 0;
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-fresh-1",
      primaryName: "alice-proj-mygame-general",
      archivedRemnantId: "ch-old-deleted",
    });
    const res = await request(createApp())
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "private" });
    expect(res.status).toBe(200);
    expect(res.body.channelId).toBe("ch-fresh-1");
    expect(remnantOps).toEqual([
      "create:taken",
      "restore",
      expect.stringMatching(/^rename:alice-proj-mygame-general-x[0-9a-z]+$/),
      "archive",
    ]);
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      mattermost: { channelId: "ch-fresh-1" },
    });
  });

  it("creates under the server-managed workspace slug when mutable identity fields are forged", async () => {
    await db.collection("users").doc(CALLER_UID).set({
      username: "victim",
      workspaceId: "victim",
      subscription: { tier: "personal_pro_max", status: "active" },
      provisioning: { openclaw: { slug: "alice" } },
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-new-123",
      primaryName: "alice-proj-mygame-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(200);
    expect(await getProject("alice", "mygame")).toBeDefined();
    expect(await getProject("victim", "mygame")).toBeUndefined();
  });

  it("returns 502 + marks failed when callerCtx.userId is null (owner not provisioned)", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockResolvedValue({ id: "ch-noowner-1" });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/channel members/i);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/owner has no Mattermost userId/i);
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      mattermost: { channelId: "ch-noowner-1" },
    });
  });

  it("succeeds without a workspace coach Mattermost user", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-no-coach-1",
      primaryName: "alice-proj-mygame-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(200);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("active");
    expect(mockMmApi).not.toHaveBeenCalledWith(
      "/channels/ch-no-coach-1/members",
      "POST",
      { user_id: "mock-mm-coach" },
    );
  });

  it("returns 502 + marks failed when membership POST throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") return { id: "ch-flaky-1" };
      if (method === "POST" && /^\/channels\/[^/]+\/members$/.test(path)) {
        throw new Error("MM 502: gateway timeout on member add");
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/Add owner.*gateway timeout/i);
  });

  it("passes private visibility to the project repo broker", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user", username: "alice-mm", coachUserId: "mock-mm-coach",
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-priv-1",
      primaryName: "alice-proj-privthing-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "Private Thing", slug: "privthing", visibility: "private" });

    expect(res.status).toBe(200);
    expect(projectRepoProvisionInput()).toMatchObject({
      workspaceId: "alice",
      slug: "privthing",
      visibility: "private",
    });
  });

  it("returns 502 + marks failed when Gitea repo creation throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user", username: "alice-mm", coachUserId: "mock-mm-coach",
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-new-999",
      primaryName: "alice-proj-mygame-general",
    });
    mockInternalFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Gitea down" }), { status: 502 }));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/code repo/i);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/Gitea down/);
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      mattermost: { channelId: "ch-new-999" },
    });
  });
});

describe("POST /api/projects/:wid/:pid/retry-provisioning", () => {
  beforeEach(async () => {
    await seedCaller(CALLER_UID);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .send({});
    expect(res.status).toBe(401);
  });

  it("creates the MM channel + channels/general doc and restores requested visibility (failed → active)", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      giteaRepoName: "alice-proj-mygame",
      provisioningState: "failed",
      provisioningError: "MM unreachable",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-retry-456",
      primaryName: "alice-proj-mygame-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("active");
    expect(doc?.provisioningError).toBeNull();
    expect(doc?.visibility).toBe("public");
    expect(doc?.pendingVisibility).toBeNull();
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      kind: "general",
      mattermost: {
        channelId: "ch-retry-456",
      },
    });
    expect(mockMmApi).toHaveBeenCalledWith(
      "/teams/team-abc/channels/name/alice-proj-mygame-general",
    );
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels",
      "POST",
      expect.objectContaining({ team_id: "team-abc", name: "alice-proj-mygame-general" }),
    );
    expect(projectRepoProvisionInput()).toMatchObject({
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
    });
  });

  it("flips to failed with a Gitea-specific error when the Gitea reconcile throws during retry", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user", username: "alice-mm", coachUserId: "mock-mm-coach",
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-retry-gitea-fail",
      primaryName: "alice-proj-mygame-general",
    });
    mockInternalFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Gitea unreachable" }), { status: 502 }));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/code repo/i);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/Gitea unreachable/);
  });

  it("reuses an existing MM channel when lookup-by-name returns it (idempotent retry)", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-existing-999",
      primaryName: "alice-proj-mygame-general",
      existingPrimary: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("active");
    expect(doc?.visibility).toBe("public");
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      mattermost: {
        channelId: "ch-existing-999",
      },
    });
    const primaryCreateCalls = mockMmApi.mock.calls.filter(
      (c) => c[1] === "POST" && c[0] === "/channels" && /general$/.test(c[2]?.name ?? ""),
    );
    expect(primaryCreateCalls).toHaveLength(0);
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-existing-999/members",
      "POST",
      { user_id: "mock-mm-user" },
    );
    expect(mockMmApi).not.toHaveBeenCalledWith(
      "/channels/ch-existing-999/members",
      "POST",
      { user_id: "mock-mm-coach" },
    );
  });

  it("converts a legacy type-O channel to type-P during retry (pre-fix data)", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "active",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-legacy-O",
      primaryName: "alice-proj-mygame-general",
      existingPrimary: true,
      primaryType: "O",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-legacy-O/privacy",
      "PUT",
      { privacy: "P" },
    );
  });

  it("returns 502 + keeps state as failed when membership POST throws during retry", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-abc/channels/name/")) {
        return { id: "ch-flaky-retry", type: "P" };
      }
      if (method === "POST" && /^\/channels\/[^/]+\/members$/.test(path)) {
        throw new Error("MM 502: gateway timeout on member add");
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(502);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/Add owner.*gateway timeout/i);
  });

  it("returns 502 + marks failed when O→P conversion fails (hard requirement)", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "active",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-abc/channels/name/")) {
        return { id: "ch-stuck-O", type: "O" };
      }
      if (method === "PUT" && /^\/channels\/[^/]+\/privacy$/.test(path)) {
        const err = new Error("MM 403: insufficient privileges to convert") as Error & { status: number };
        err.status = 403;
        throw err;
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(502);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/insufficient privileges/i);
    expect(await getProjectChannel("alice", "mygame", "general")).toBeUndefined();
  });

  it("retries successfully without a workspace coach Mattermost user", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-active-1",
      primaryName: "alice-proj-mygame-general",
      existingPrimary: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("active");
    expect(mockMmApi).not.toHaveBeenCalledWith(
      "/channels/ch-active-1/members",
      "POST",
      { user_id: "mock-mm-coach" },
    );
  });

  it("repairs an active project missing the channels/general subdoc (the existing TEST data shape)", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockProjectMattermost({
      primaryId: "ch-repair-789",
      primaryName: "alice-proj-mygame-general",
      existingPrimary: true,
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(await getProjectChannel("alice", "mygame", "general")).toMatchObject({
      mattermost: { channelId: "ch-repair-789" },
    });
  });

  it("returns 403 when caller is not the project owner", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: "other-uid",
      workspaceId: "alice",
      slug: "mygame",
      provisioningState: "failed",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(403);
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(404);
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("returns 502 + keeps state as failed when MM retry itself throws", async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      provisioningState: "failed",
      provisioningError: "old error",
    });
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user",
      username: "alice-mm",
      coachUserId: "mock-mm-coach",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockRejectedValue(new Error("still broken"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(502);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/still broken/);
  });
});
