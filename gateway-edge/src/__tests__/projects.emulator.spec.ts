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

const mockCreateProjectGiteaRepo = vi.fn();
const mockGiteaWriteFile = vi.fn();
const mockGiteaWriteFiles = vi.fn();
const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: unknown[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: (...args: unknown[]) => mockCreateProjectGiteaRepo(...args),
  giteaWriteFile: (...args: unknown[]) => mockGiteaWriteFile(...args),
  giteaWriteFiles: (...args: unknown[]) => mockGiteaWriteFiles(...args),
}));

import { createApp } from "../index.js";

const CALLER_UID = "caller-uid";

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

interface ProjectPairMattermostFixture {
  primaryId: string;
  primaryName: string;
  activityId?: string;
  existingPrimary?: boolean;
  primaryType?: "P" | "O";
  teamId?: string;
}

function mockProjectPairMattermost(options: ProjectPairMattermostFixture): void {
  const teamId = options.teamId ?? "team-abc";
  const activityId = options.activityId ?? `${options.primaryId}-activity`;
  const activityName = `${options.primaryName}-activity`;
  const primaryMembers = new Set<string>();
  const activityMembers = new Set<string>();
  let primaryExists = options.existingPrimary ?? false;
  let primaryType = options.primaryType ?? "P";
  let activityExists = false;

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
    if (verb === "GET" && path === `/teams/${teamId}/channels/name/${options.primaryName}`) {
      if (!primaryExists) throw notFound(path);
      return channel(options.primaryId, options.primaryName, primaryType);
    }
    if (verb === "GET" && path === `/teams/${teamId}/channels/name/${activityName}`) {
      if (!activityExists) throw notFound(path);
      return channel(activityId, activityName, primaryType);
    }
    if (verb === "GET" && path === `/channels/${options.primaryId}`) {
      if (!primaryExists) throw notFound(path);
      return channel(options.primaryId, options.primaryName, primaryType);
    }
    if (verb === "GET" && path === `/channels/${activityId}`) {
      if (!activityExists) throw notFound(path);
      return channel(activityId, activityName, primaryType);
    }
    if (verb === "GET" && path === `/channels/${options.primaryId}/members?page=0&per_page=200`) {
      return [...primaryMembers].map((userId) => ({ user_id: userId }));
    }
    if (verb === "GET" && path === `/channels/${activityId}/members?page=0&per_page=200`) {
      return [...activityMembers].map((userId) => ({ user_id: userId }));
    }
    if (verb === "POST" && path === "/channels") {
      if (body?.name === options.primaryName && !primaryExists) {
        primaryExists = true;
        primaryType = body.type === "O" ? "O" : "P";
        return channel(options.primaryId, options.primaryName, primaryType);
      }
      if (body?.name === activityName && !activityExists) {
        activityExists = true;
        return channel(activityId, activityName, primaryType);
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
    if (verb === "POST" && path === `/channels/${activityId}/members`) {
      if (typeof body?.user_id !== "string") throw new Error("activity member user_id is required");
      activityMembers.add(body.user_id);
      return { user_id: body.user_id, channel_id: activityId, roles: "channel_user" };
    }
    throw new Error(`Unexpected MM call: ${verb} ${path}`);
  });
}

setupEmulatorTest();
beforeEach(async () => {
  mockMmApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  mockCreateProjectGiteaRepo.mockReset();
  mockCreateProjectGiteaRepo.mockResolvedValue(undefined);
  mockGiteaWriteFile.mockReset();
  mockGiteaWriteFile.mockResolvedValue(undefined);
  mockGiteaWriteFiles.mockReset();
  mockGiteaWriteFiles.mockResolvedValue(undefined);
  mockGiteaApi.mockReset();
});

describe("POST /internal/project/publish (octogee_publish tool endpoint, no-auth in-pod)", () => {
  const ORIG_BUILD_URL = process.env.SITE_BUILD_API_URL;
  const ORIG_KEY = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(async () => {
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: "owner-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    });
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
  });

  afterEach(() => {
    if (ORIG_BUILD_URL === undefined) delete process.env.SITE_BUILD_API_URL;
    else process.env.SITE_BUILD_API_URL = ORIG_BUILD_URL;
    if (ORIG_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = ORIG_KEY;
  });

  it("400 on invalid slug/projectSlug", async () => {
    const res = await request(createApp())
      .post("/internal/project/publish")
      .send({ slug: "Bad Slug", projectSlug: "ok" });
    expect(res.status).toBe(400);
  });

  it("503 when SITE_BUILD_API_URL / INTERNAL_SERVICE_KEY are unset", async () => {
    delete process.env.SITE_BUILD_API_URL;
    delete process.env.INTERNAL_SERVICE_KEY;
    const res = await request(createApp())
      .post("/internal/project/publish")
      .send({ slug: "alice", projectSlug: "mygame" });
    expect(res.status).toBe(503);
  });

  it("404 when the project does not exist in the slug's workspace", async () => {
    const res = await request(createApp())
      .post("/internal/project/publish")
      .send({ slug: "alice", projectSlug: "ghost" });
    expect(res.status).toBe(404);
  });

  it("200 + persists publishedUrl + forwards slug/projectSlug/projectName to site-build-api", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://gateway.local:3001/api/project/publish");
      expect(new Headers(init?.headers).get("X-Internal-Service-Key")).toBe("secret");
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toMatchObject({ slug: "alice", projectSlug: "mygame", projectName: "My Game" });
      return new Response(
        JSON.stringify({ success: true, publishedUrl: "https://octogee-alice-mygame.web.app" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const res = await request(createApp())
        .post("/internal/project/publish")
        .send({ slug: "alice", projectSlug: "mygame" });
      expect(res.status).toBe(200);
      expect(res.body.publishedUrl).toBe("https://octogee-alice-mygame.web.app");
      const proj = await getProject("alice", "mygame");
      expect(proj?.publishedUrl).toBe("https://octogee-alice-mygame.web.app");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("POST /api/projects/:wid/:pid/publish", () => {
  const ORIG_BUILD_URL = process.env.SITE_BUILD_API_URL;
  const ORIG_INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(async () => {
    await seedCaller(CALLER_UID);
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: CALLER_UID,
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    });
  });

  afterEach(() => {
    if (ORIG_BUILD_URL === undefined) delete process.env.SITE_BUILD_API_URL;
    else process.env.SITE_BUILD_API_URL = ORIG_BUILD_URL;
    if (ORIG_INTERNAL_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = ORIG_INTERNAL_KEY;
  });

  it("returns 401 when unauthenticated", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/publish")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 503 when SITE_BUILD_API_URL or INTERNAL_SERVICE_KEY is unset", async () => {
    delete process.env.SITE_BUILD_API_URL;
    delete process.env.INTERNAL_SERVICE_KEY;

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/publish")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it("returns 404 when the project does not exist", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/publish")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not the project owner", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    await seedProject("alice", "mygame", {
      id: "mygame",
      ownerUid: "someone-else",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    });
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/publish")
      .set(await authHeader())
      .send({});
    expect(res.status).toBe(403);
  });

  it("writes publishedUrl on success + forwards slug/projectSlug/projectName in the body", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://gateway.local:3001/api/project/publish");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Internal-Service-Key")).toBe("secret");
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toMatchObject({ slug: "alice", projectSlug: "mygame", projectName: "My Game" });
      return new Response(
        JSON.stringify({ success: true, publishedUrl: "https://octogee-alice-mygame.web.app" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/publish")
        .set(await authHeader())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.publishedUrl).toBe("https://octogee-alice-mygame.web.app");
      const proj = await getProject("alice", "mygame");
      expect(proj?.publishedUrl).toBe("https://octogee-alice-mygame.web.app");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 + leaves publishedUrl unchanged when site-build-api fails", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("mygame")
      .set({ publishedUrl: null }, { merge: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("Build failed", { status: 500 });
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/publish")
        .set(await authHeader())
        .send({});
      expect(res.status).toBe(502);
      const proj = await getProject("alice", "mygame");
      expect(proj?.publishedUrl).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 504 when the upstream fetch aborts (AbortError / TimeoutError)", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    await db
      .collection("workspaces")
      .doc("alice")
      .collection("projects")
      .doc("mygame")
      .set({ publishedUrl: null }, { merge: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted") as Error & { name: string };
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/publish")
        .set(await authHeader())
        .send({});
      expect(res.status).toBe(504);
      expect(res.body.error).toMatch(/timed out/i);
      const proj = await getProject("alice", "mygame");
      expect(proj?.publishedUrl).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 404 for malformed workspace + project slugs before any upstream call", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const app = createApp();
      const r = await request(app)
        .post("/api/projects/-bad/My-Bad/publish")
        .set(await authHeader())
        .send({});
      expect(r.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
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

  it("rejects slugs with uppercase letters", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=MyGame")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("rejects reserved slugs", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=settings")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/reserved/);
  });

  it("rejects too-long slugs (>16 chars)", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=seventeencharsxxx")
      .set(await authHeader());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
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
    mockProjectPairMattermost({
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
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels/ch-new-123/members",
      "POST",
      { user_id: "mock-mm-coach" },
    );
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice",
      "mygame",
      expect.any(String),
      false,
    );
    expect(mockGiteaWriteFile).toHaveBeenCalledWith(
      "alice",
      "mygame",
      "README.md",
      expect.stringContaining("My Game"),
      expect.any(String),
    );
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
    mockProjectPairMattermost({
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
    expect(await getProjectChannel("alice", "mygame", "general")).toBeUndefined();
  });

  it("returns 502 + marks failed when callerCtx.coachUserId is null (agent not provisioned)", async () => {
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
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (method === "POST" && path === "/channels") return { id: "ch-noagent-1" };
      if (method === "POST" && /^\/channels\/[^/]+\/members$/.test(path)) {
        return { user_id: "ok" };
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/channel members/i);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/agent has no Mattermost userId/i);
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

  it("passes private=true to Gitea when the requested visibility is private", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user", username: "alice-mm", coachUserId: "mock-mm-coach",
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockProjectPairMattermost({
      primaryId: "ch-priv-1",
      primaryName: "alice-proj-privthing-general",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(await authHeader())
      .send({ name: "Private Thing", slug: "privthing", visibility: "private" });

    expect(res.status).toBe(200);
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice",
      "privthing",
      expect.any(String),
      true,
    );
  });

  it("returns 502 + marks failed when Gitea repo creation throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: "alice",
      teamId: "team-abc",
      userId: "mock-mm-user", username: "alice-mm", coachUserId: "mock-mm-coach",
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockProjectPairMattermost({
      primaryId: "ch-new-999",
      primaryName: "alice-proj-mygame-general",
    });
    mockCreateProjectGiteaRepo.mockRejectedValue(new Error("Gitea down"));

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
    mockProjectPairMattermost({
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
        activityChannelId: expect.any(String),
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
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice",
      "mygame",
      expect.any(String),
      false,
    );
    expect(mockGiteaWriteFile).toHaveBeenCalledWith(
      "alice",
      "mygame",
      "README.md",
      expect.any(String),
      expect.any(String),
    );
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
    mockProjectPairMattermost({
      primaryId: "ch-retry-gitea-fail",
      primaryName: "alice-proj-mygame-general",
    });
    mockCreateProjectGiteaRepo.mockRejectedValue(new Error("Gitea unreachable"));

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
    mockProjectPairMattermost({
      primaryId: "ch-existing-999",
      primaryName: "alice-proj-mygame-general",
      activityId: "ch-activity-existing-999",
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
        activityChannelId: "ch-activity-existing-999",
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
    expect(mockMmApi).toHaveBeenCalledWith(
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
    mockProjectPairMattermost({
      primaryId: "ch-legacy-O",
      primaryName: "alice-proj-mygame-general",
      activityId: "ch-activity-legacy",
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

  it("returns 502 + keeps state as failed when callerCtx.coachUserId is null on retry", async () => {
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
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-abc/channels/name/")) {
        return { id: "ch-active-1", type: "P" };
      }
      if (method === "POST" && /^\/channels\/[^/]+\/members$/.test(path)) {
        return { user_id: "ok" };
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(await authHeader())
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/channel members/i);
    const doc = await getProject("alice", "mygame");
    expect(doc?.provisioningState).toBe("failed");
    expect(String(doc?.provisioningError)).toMatch(/agent has no Mattermost userId/i);
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
    mockProjectPairMattermost({
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
