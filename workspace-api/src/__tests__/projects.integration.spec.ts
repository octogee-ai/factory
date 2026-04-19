/**
 * Integration tests for /api/projects — v3 nested + user-named slug schema.
 *
 * Projects live at `workspaces/{wid}/projects/{pid}` with channels + members
 * subcollections (DATA-MODEL-REVIEW v3 §§6.3, 6.10, 6.11, 6.12).
 *
 * Coverage:
 * - Slug validator + availability endpoint (pure server-side guards).
 * - POST / creation: hard-fail path when MM channel can't be created
 *   (docs/PROJECTS-CANVAS-SPEC.md §D4 — no silent failures). On MM error
 *   the project doc persists with `provisioningState: 'failed'` and the
 *   endpoint returns 502 so the client can surface the state.
 * - POST /:wid/:pid/retry-provisioning: idempotent repair — creates the
 *   MM channel + `channels/general` subcollection for a project that
 *   either failed provisioning or is active-but-missing its channels doc.
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Firestore mock state ────────────────────────────────────────────────────

const firestoreData: Record<string, any> = {};

const mockSet = vi.fn(async (_path: string, _data: any) => undefined);
const mockUpdate = vi.fn(async (_path: string, _data: any) => undefined);

// Record calls to assert on side effects (channel creation, state flips).
function resetFirestoreMocks() {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  mockSet.mockClear();
  mockUpdate.mockClear();
}

// ── db mock ──────────────────────────────────────────────────────────────────

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
    delete: async () => { delete firestoreData[path]; },
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

// ── MM mock ──────────────────────────────────────────────────────────────────

const mockMmApi = vi.fn();
vi.mock("../lib/mattermost", () => ({
  mmApi: (...args: any[]) => mockMmApi(...args),
}));

// Stubbed MM context resolver — tests set the return directly to control
// whether the caller has a usable teamId without simulating the multi-doc read.
const mockGetWorkspaceMmContext = vi.fn();
vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: (...args: any[]) => mockGetWorkspaceMmContext(...args),
}));

// Mock the Gitea helpers used by the project routes (phase 5 §D12). Each
// spec overrides these as needed via `mockClear` + `mockImplementation`.
const mockCreateProjectGiteaRepo = vi.fn();
const mockGiteaWriteFile = vi.fn();
const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: any[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: (...args: any[]) => mockCreateProjectGiteaRepo(...args),
  giteaWriteFile: (...args: any[]) => mockGiteaWriteFile(...args),
}));

import { createApp } from "../index";

function authHeaders() {
  return { Authorization: "Bearer valid-token" };
}

// ── Deploy preview endpoint (phase 7 §D14) ──────────────────────────────────

describe("POST /api/projects/:wid/:pid/deploy-preview", () => {
  const ORIG_BUILD_URL = process.env.SITE_BUILD_API_URL;
  const ORIG_INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(() => {
    resetFirestoreMocks();
    firestoreData["users/caller-uid"] = { username: "alice", workspaceId: "alice" };
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    };
  });

  afterEach(() => {
    if (ORIG_BUILD_URL === undefined) delete process.env.SITE_BUILD_API_URL;
    else process.env.SITE_BUILD_API_URL = ORIG_BUILD_URL;
    if (ORIG_INTERNAL_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = ORIG_INTERNAL_KEY;
  });

  it("returns 503 when SITE_BUILD_API_URL or INTERNAL_SERVICE_KEY is unset", async () => {
    delete process.env.SITE_BUILD_API_URL;
    delete process.env.INTERNAL_SERVICE_KEY;

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/deploy-preview")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it("returns 404 when the project does not exist", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/deploy-preview")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not the project owner", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    firestoreData["workspaces/alice/projects/mygame"].ownerUid = "someone-else";
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/deploy-preview")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(403);
  });

  it("writes previewUrl on success + forwards slug/projectSlug/projectName in the body", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://gateway.local:3001/api/project-preview/deploy");
      expect(init?.headers).toMatchObject({ "X-Internal-Service-Key": "secret" });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toMatchObject({ slug: "alice", projectSlug: "mygame", projectName: "My Game" });
      return new Response(
        JSON.stringify({ success: true, previewUrl: "https://octogee-alice-mygame.web.app" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/deploy-preview")
        .set(authHeaders())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.previewUrl).toBe("https://octogee-alice-mygame.web.app");
      expect(firestoreData["workspaces/alice/projects/mygame"].previewUrl).toBe(
        "https://octogee-alice-mygame.web.app",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 + leaves previewUrl unchanged when site-build-api fails", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    firestoreData["workspaces/alice/projects/mygame"].previewUrl = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("Build failed", { status: 500 });
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/deploy-preview")
        .set(authHeaders())
        .send({});
      expect(res.status).toBe(502);
      expect(firestoreData["workspaces/alice/projects/mygame"].previewUrl).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 504 when the upstream fetch aborts (AbortError / TimeoutError)", async () => {
    process.env.SITE_BUILD_API_URL = "http://gateway.local:3001";
    process.env.INTERNAL_SERVICE_KEY = "secret";
    firestoreData["workspaces/alice/projects/mygame"].previewUrl = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted") as Error & { name: string };
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;

    try {
      const app = createApp();
      const res = await request(app)
        .post("/api/projects/alice/mygame/deploy-preview")
        .set(authHeaders())
        .send({});
      expect(res.status).toBe(504);
      expect(res.body.error).toMatch(/timed out/i);
      expect(firestoreData["workspaces/alice/projects/mygame"].previewUrl).toBeNull();
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
        .post("/api/projects/-bad/My-Bad/deploy-preview")
        .set(authHeaders())
        .send({});
      expect(r.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Public README endpoint (phase 6 §D13) ───────────────────────────────────

describe("GET /api/projects/:wid/:pid/readme (public)", () => {
  beforeEach(() => {
    resetFirestoreMocks();
    mockGiteaApi.mockReset();
  });

  it("returns the rendered README for a public project (no auth header required)", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "README.md",
    };
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Hello from repo", "utf-8").toString("base64"),
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# Hello from repo");
    expect(res.body.path).toBe("README.md");
    // Confirm no Authorization header was required — bypass requireAuth.
    expect(mockGiteaApi).toHaveBeenCalledWith("alice-proj-mygame/contents/README.md");
  });

  it("returns 404 for private projects (visibility leak guard)", async () => {
    firestoreData["workspaces/alice/projects/secret"] = {
      visibility: "private",
      giteaRepoName: "alice-proj-secret",
    };

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
    firestoreData["workspaces/alice/projects/soft"] = {
      visibility: "unlisted",
      giteaRepoName: "alice-proj-soft",
    };
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Unlisted is fine", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/soft/readme");
    expect(res.status).toBe(200);
    expect(res.body.content).toContain("Unlisted is fine");
  });

  it("returns empty content (not 500) when the Gitea repo 404s on the file", async () => {
    firestoreData["workspaces/alice/projects/fresh"] = {
      visibility: "public",
      giteaRepoName: "alice-proj-fresh",
    };
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
    // Path traversal via a malformed wid segment shouldn't even hit Gitea.
    expect(mockGiteaApi).not.toHaveBeenCalled();
  });

  it("falls back to README.md when canvasFile contains a path traversal", async () => {
    // Owners can write canvasFile directly (Firestore rules §D8). Make sure
    // a malicious value can't steer the admin-token Gitea fetch.
    firestoreData["workspaces/alice/projects/mygame"] = {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "../../../../etc/passwd",
    };
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Safe content", "utf-8").toString("base64"),
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    // Path in the response is the safe fallback, not the owner's input.
    expect(res.body.path).toBe("README.md");
    // And the Gitea call used the safe fallback too.
    expect(mockGiteaApi).toHaveBeenCalledWith("alice-proj-mygame/contents/README.md");
  });

  it("falls back to README.md when canvasFile is an absolute path", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "/etc/passwd",
    };
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("hi", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("README.md");
  });

  it("honors a legitimate nested canvasFile path", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      visibility: "public",
      giteaRepoName: "alice-proj-mygame",
      canvasFile: "docs/INTRO.md",
    };
    mockGiteaApi.mockResolvedValue({
      content: Buffer.from("# Intro", "utf-8").toString("base64"),
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/alice/mygame/readme");
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("docs/INTRO.md");
    expect(mockGiteaApi).toHaveBeenCalledWith("alice-proj-mygame/contents/docs/INTRO.md");
  });
});

// ── Availability endpoint ────────────────────────────────────────────────────

describe("GET /api/projects/slug-available", () => {
  beforeEach(() => {
    resetFirestoreMocks();
    firestoreData["users/caller-uid"] = { username: "alice", workspaceId: "alice" };
  });

  it("rejects slugs containing hyphens", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=my-game")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/no hyphens/i);
  });

  it("rejects slugs with uppercase letters", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=MyGame")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("rejects reserved slugs", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=settings")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/reserved/);
  });

  it("rejects too-long slugs (>16 chars)", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=seventeencharsxxx")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("returns available=true for a valid, unclaimed slug", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=mygame")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });
});

// ── POST / creation — hard-fail path per spec §D4 ───────────────────────────

describe("POST /api/projects — MM channel failure is hard-failure", () => {
  beforeEach(() => {
    resetFirestoreMocks();
    firestoreData["users/caller-uid"] = { username: "alice", workspaceId: "alice" };
    mockMmApi.mockReset();
    mockGetWorkspaceMmContext.mockReset();
    // Gitea calls resolve by default so the MM-failure path isn't affected
    // by Gitea mock state from a previous test; individual Gitea tests
    // override these.
    mockCreateProjectGiteaRepo.mockReset();
    mockCreateProjectGiteaRepo.mockResolvedValue(undefined);
    mockGiteaWriteFile.mockReset();
    mockGiteaWriteFile.mockResolvedValue(undefined);
  });

  it("returns 502 and marks provisioningState:failed when MM channel POST throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockRejectedValue(new Error("MM unreachable"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(authHeaders())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/provisioning/i);
    // Project doc must persist so the client can retry or surface the state.
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc).toBeDefined();
    expect(doc.provisioningState).toBe("failed");
    expect(doc.provisioningError).toBeTruthy();
    // Must NOT have been flipped to active.
    expect(doc.provisioningState).not.toBe("active");
    // No channels/general doc should have been written.
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toBeUndefined();
    // Caller's target visibility is preserved so retry can restore it
    // without the client having to re-submit. `visibility` stays `private`
    // (half-provisioned docs shouldn't surface in discovery).
    expect(doc.visibility).toBe("private");
    expect(doc.pendingVisibility).toBe("public");
    // `giteaRepoName` is deterministic, written up-front.
    expect(doc.giteaRepoName).toBe("alice-proj-mygame");
  });

  it("returns 502 when teamId is missing (no MM workspace context)", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: null,
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(authHeaders())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc?.provisioningState).toBe("failed");
    // MM API should not have been called — we failed pre-flight.
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("succeeds with 200 + provisioningState:active when MM channel creation succeeds", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockResolvedValue({ id: "ch-new-123" });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(authHeaders())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.channelId).toBe("ch-new-123");
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("active");
    // After success, visibility flips from 'private' to the requested target
    // and the pendingVisibility staging field is cleared.
    expect(doc.visibility).toBe("public");
    expect(doc.pendingVisibility).toBeNull();
    expect(doc.giteaRepoName).toBe("alice-proj-mygame");
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toMatchObject({
      kind: "general",
      mattermost: { channelId: "ch-new-123" },
    });
    // Gitea side effects (phase 5 §D12): repo created + README seeded.
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice-proj-mygame",
      expect.any(String),
      false, // public visibility → private=false
    );
    expect(mockGiteaWriteFile).toHaveBeenCalledWith(
      "alice-proj-mygame",
      "README.md",
      expect.stringContaining("My Game"),
      expect.any(String),
    );
  });

  it("passes private=true to Gitea when the requested visibility is private", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null, username: null, coachUserId: null,
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockMmApi.mockResolvedValue({ id: "ch-priv-1" });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(authHeaders())
      .send({ name: "Private Thing", slug: "privthing", visibility: "private" });

    expect(res.status).toBe(200);
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice-proj-privthing",
      expect.any(String),
      true,
    );
  });

  it("returns 502 + marks failed when Gitea repo creation throws", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null, username: null, coachUserId: null,
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    mockMmApi.mockResolvedValue({ id: "ch-new-999" });
    mockCreateProjectGiteaRepo.mockRejectedValue(new Error("Gitea down"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects")
      .set(authHeaders())
      .send({ name: "My Game", slug: "mygame", visibility: "public" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/code repo/i);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("failed");
    expect(doc.provisioningError).toMatch(/Gitea down/);
    // MM channel + channels subdoc should still have been written — the
    // Gitea step fires AFTER the MM step succeeds.
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toMatchObject({
      mattermost: { channelId: "ch-new-999" },
    });
  });
});

// ── POST /:wid/:pid/retry-provisioning — repair endpoint ────────────────────

describe("POST /api/projects/:wid/:pid/retry-provisioning", () => {
  beforeEach(() => {
    resetFirestoreMocks();
    firestoreData["users/caller-uid"] = { username: "alice", workspaceId: "alice" };
    mockMmApi.mockReset();
    mockGetWorkspaceMmContext.mockReset();
    mockCreateProjectGiteaRepo.mockReset();
    mockCreateProjectGiteaRepo.mockResolvedValue(undefined);
    mockGiteaWriteFile.mockReset();
    mockGiteaWriteFile.mockResolvedValue(undefined);
  });

  it("creates the MM channel + channels/general doc and restores requested visibility (failed → active)", async () => {
    // Seed a failed project owned by the caller. The creation handler
    // would have written `visibility: 'private'` (hide while provisioning)
    // and parked the caller's requested 'public' target on
    // `pendingVisibility`. Retry restores it.
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      giteaRepoName: "alice-proj-mygame",
      provisioningState: "failed",
      provisioningError: "MM unreachable",
    };
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    // Lookup-by-name 404s → forces the create branch, exercising the
    // POST-on-404 code path (regression coverage per review P1).
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-abc/channels/name/")) {
        const err = new Error("MM API 404: channel not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      if (method === "POST" && path === "/channels") {
        return { id: "ch-retry-456" };
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("active");
    expect(doc.provisioningError).toBeNull();
    // Caller's original intent is honored.
    expect(doc.visibility).toBe("public");
    expect(doc.pendingVisibility).toBeNull();
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toMatchObject({
      kind: "general",
      mattermost: { channelId: "ch-retry-456" },
    });
    // Both lookup-by-name and the create POST were exercised.
    expect(mockMmApi).toHaveBeenCalledWith(
      "/teams/team-abc/channels/name/alice-proj-mygame-general",
    );
    expect(mockMmApi).toHaveBeenCalledWith(
      "/channels",
      "POST",
      expect.objectContaining({ team_id: "team-abc", name: "alice-proj-mygame-general" }),
    );
    // Gitea reconcile: repo + README seeded alongside the MM work (§D12).
    expect(mockCreateProjectGiteaRepo).toHaveBeenCalledWith(
      "alice-proj-mygame",
      expect.any(String),
      false,
    );
    expect(mockGiteaWriteFile).toHaveBeenCalledWith(
      "alice-proj-mygame",
      "README.md",
      expect.any(String),
      expect.any(String),
    );
  });

  it("flips to failed with a Gitea-specific error when the Gitea reconcile throws during retry", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    };
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null, username: null, coachUserId: null,
      coachDmChannelId: null, generalChannelId: null, adminChannelId: null,
    });
    // MM side of the retry succeeds.
    mockMmApi.mockImplementation(async (_path: string, method?: string) => {
      if (method === "POST") return { id: "ch-retry-gitea-fail" };
      const err = new Error("MM API 404: not found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    // Gitea side fails.
    mockCreateProjectGiteaRepo.mockRejectedValue(new Error("Gitea unreachable"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/code repo/i);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("failed");
    expect(doc.provisioningError).toMatch(/Gitea unreachable/);
  });

  it("reuses an existing MM channel when lookup-by-name returns it (idempotent retry)", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "private",
      pendingVisibility: "public",
      provisioningState: "failed",
    };
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    // Lookup succeeds → retry must NOT create a duplicate channel.
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if ((method ?? "GET") === "GET" && path.startsWith("/teams/team-abc/channels/name/")) {
        return { id: "ch-existing-999" };
      }
      throw new Error(`Unexpected MM call: ${method} ${path}`);
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(200);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("active");
    expect(doc.visibility).toBe("public");
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toMatchObject({
      mattermost: { channelId: "ch-existing-999" },
    });
    // No POST — the channel already existed.
    const postCalls = mockMmApi.mock.calls.filter((c) => c[1] === "POST");
    expect(postCalls).toHaveLength(0);
  });

  it("repairs an active project missing the channels/general subdoc (the existing TEST data shape)", async () => {
    // This is the state dannyboy's three TEST projects are in: the project
    // doc exists as 'active' but no channels/general was ever written.
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      name: "My Game",
      visibility: "public",
      provisioningState: "active",
    };
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockResolvedValue({ id: "ch-repair-789" });

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(200);
    expect(firestoreData["workspaces/alice/projects/mygame/channels/general"]).toMatchObject({
      mattermost: { channelId: "ch-repair-789" },
    });
  });

  it("returns 403 when caller is not the project owner", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "other-uid",
      workspaceId: "alice",
      slug: "mygame",
      provisioningState: "failed",
    };

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(403);
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/ghost/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(404);
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("returns 502 + keeps state as failed when MM retry itself throws", async () => {
    firestoreData["workspaces/alice/projects/mygame"] = {
      id: "mygame",
      ownerUid: "caller-uid",
      workspaceId: "alice",
      slug: "mygame",
      provisioningState: "failed",
      provisioningError: "old error",
    };
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: "caller-uid",
      slug: "alice",
      teamId: "team-abc",
      userId: null,
      username: null,
      coachUserId: null,
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockRejectedValue(new Error("still broken"));

    const app = createApp();
    const res = await request(app)
      .post("/api/projects/alice/mygame/retry-provisioning")
      .set(authHeaders())
      .send({});

    expect(res.status).toBe(502);
    const doc = firestoreData["workspaces/alice/projects/mygame"];
    expect(doc.provisioningState).toBe("failed");
    expect(doc.provisioningError).toMatch(/still broken/);
  });
});
