import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbDoc: vi.fn((path: string) => ({ path })),
  giteaApi: vi.fn(),
  createProjectGiteaRepo: vi.fn(),
  giteaDeleteVerifiedRepo: vi.fn(),
  giteaWriteFile: vi.fn(),
  giteaWriteFiles: vi.fn(),
  internalFetch: vi.fn(),
  readProject: vi.fn(),
  renderReadmeTemplate: vi.fn(),
  projectPlaybookSeeds: vi.fn(),
  notesWelcomeSeed: vi.fn(),
  readWorkspace: vi.fn(),
  mmApi: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => h.dbDoc(path),
  },
  auth: { verifyIdToken: vi.fn() },
  FieldValue: { serverTimestamp: vi.fn() },
}));

vi.mock("../lib/gitea.js", () => ({
  giteaApi: (...args: unknown[]) => h.giteaApi(...args),
  createProjectGiteaRepo: (...args: unknown[]) => h.createProjectGiteaRepo(...args),
  giteaDeleteVerifiedRepo: (...args: unknown[]) => h.giteaDeleteVerifiedRepo(...args),
  giteaWriteFile: (...args: unknown[]) => h.giteaWriteFile(...args),
  giteaWriteFiles: (...args: unknown[]) => h.giteaWriteFiles(...args),
}));

vi.mock("../lib/internal-fetch.js", () => ({
  internalFetch: (...args: unknown[]) => h.internalFetch(...args),
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readProject: (...args: unknown[]) => h.readProject(...args),
  readWorkspace: (...args: unknown[]) => h.readWorkspace(...args),
}));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

vi.mock("@octogee/core/templates/project-readmes", () => ({
  renderReadmeTemplate: (...args: unknown[]) => h.renderReadmeTemplate(...args),
}));

vi.mock("@octogee/core/templates/project-seeds", () => ({
  projectPlaybookSeeds: (...args: unknown[]) => h.projectPlaybookSeeds(...args),
  notesWelcomeSeed: (...args: unknown[]) => h.notesWelcomeSeed(...args),
}));

const { default: readmeRoutes } = await import("../routes/projects/readme.js");
const {
  ensureProjectGiteaRepo,
  deleteProjectRepo,
  provisionProjectRepo,
} = await import("../routes/projects/provisioning.js");
const { default: displayNameRoutes } = await import("../routes/workspace/display-name.js");

function readmeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", readmeRoutes);
  return app;
}

function displayNameApp(reqUser: Record<string, unknown> = { workspaceId: "mira" }, uid = "uid-owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = uid;
    req.user = reqUser;
    next();
  });
  app.use("/api/workspace", displayNameRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

beforeEach(() => {
  h.dbDoc.mockClear();
  h.giteaApi.mockReset();
  h.createProjectGiteaRepo.mockReset().mockResolvedValue(undefined);
  h.giteaDeleteVerifiedRepo.mockReset().mockResolvedValue(undefined);
  h.giteaWriteFile.mockReset().mockResolvedValue(undefined);
  h.giteaWriteFiles.mockReset().mockResolvedValue(undefined);
  h.internalFetch.mockReset();
  delete process.env.GITEA_TOKEN;
  process.env.FLEET_BROKER_URL = "http://octogee-api.test:3001";
  h.readProject.mockReset();
  h.renderReadmeTemplate.mockReset().mockReturnValue("# Orbit\n");
  h.projectPlaybookSeeds.mockReset().mockReturnValue([
    { relPath: "runbook/how-we-build.md", content: "# How we build Orbit\n" },
    { relPath: "DECISIONS.md", content: "# Decisions — Orbit\n" },
  ]);
  h.notesWelcomeSeed.mockReset().mockReturnValue({
    relPath: "notes/welcome.md",
    content: "# Welcome to notes\n",
  });
  h.readWorkspace.mockReset();
  h.mmApi.mockReset().mockResolvedValue({});
  h.logger.error.mockClear();
});

describe("project README route", () => {
  it("returns public README content from the configured safe canvas path", async () => {
    h.readProject.mockResolvedValue({
      visibility: "public",
      canvasFile: "docs/README.md",
    });
    h.giteaApi.mockResolvedValue({
      content: Buffer.from("# Orbit\n").toString("base64"),
    });

    const res = await request(readmeApp())
      .get("/api/projects/mira/orbit/readme")
      .expect(200);

    expect(res.body).toEqual({ content: "# Orbit\n", path: "docs/README.md" });
    expect(h.readProject).toHaveBeenCalledWith({ path: "workspaces/mira/projects/orbit" });
    expect(h.giteaApi).toHaveBeenCalledWith("mira", "orbit/contents/docs/README.md");
  });

  it("hides invalid, missing, private, and malformed projects", async () => {
    await request(readmeApp())
      .get("/api/projects/BadSlug/orbit/readme")
      .expect(404, { error: "Project not found" });

    h.readProject.mockResolvedValueOnce(null);
    await request(readmeApp())
      .get("/api/projects/mira/missing/readme")
      .expect(404, { error: "Project not found" });

    h.readProject.mockResolvedValueOnce({ visibility: "private" });
    await request(readmeApp())
      .get("/api/projects/mira/private/readme")
      .expect(404, { error: "Project not found" });
  });

  it("falls back to README.md for unsafe paths and returns empty content for missing files", async () => {
    h.readProject.mockResolvedValue({
      visibility: "unlisted",
      canvasFile: "../secret.md",
    });
    h.giteaApi.mockRejectedValue({ status: 404 });

    const res = await request(readmeApp())
      .get("/api/projects/mira/orbit/readme")
      .expect(200);

    expect(res.body).toEqual({ content: "", path: "README.md" });
    expect(h.giteaApi).toHaveBeenCalledWith("mira", "orbit/contents/README.md");
  });

  it("logs unexpected README load failures", async () => {
    h.readProject.mockResolvedValue({ visibility: "public" });
    h.giteaApi.mockRejectedValue(new Error("gitea down"));

    await request(readmeApp())
      .get("/api/projects/mira/orbit/readme")
      .expect(500, { error: "Failed to load project readme" });

    expect(h.logger.error).toHaveBeenCalledWith(
      "[projects] Public README fetch failed for mira/orbit:",
      { err: expect.any(Error) },
    );
  });
});

describe("project provisioning helpers", () => {
  it("creates the project repo and seeds the rendered README", async () => {
    await ensureProjectGiteaRepo({
      workspaceId: "mira",
      slug: "orbit",
      name: "Orbit",
      tagline: "Ship it",
      projectType: "web",
      visibility: "public",
      recipe: "static-site",
    });

    expect(h.createProjectGiteaRepo).toHaveBeenCalledWith("mira", "orbit", "Ship it", false);
    expect(h.renderReadmeTemplate).toHaveBeenCalledWith("web", {
      name: "Orbit",
      tagline: "Ship it",
      owner: "mira",
      workspaceSlug: "mira",
      projectSlug: "orbit",
    });
    expect(h.giteaWriteFile).toHaveBeenCalledWith(
      "mira",
      "orbit",
      "README.md",
      "# Orbit\n",
      "auto: seed project README",
    );
  });

  it("writes no Octogee metadata file into the project repo", async () => {
    await ensureProjectGiteaRepo({
      workspaceId: "mira",
      slug: "orbit",
      name: "Orbit",
      tagline: "Ship it",
      projectType: "web",
      visibility: "public",
      recipe: "static-site",
    });

    expect(h.giteaWriteFile.mock.calls.map((args) => args[2])).toEqual(["README.md"]);
    const seededPaths = (h.giteaWriteFiles.mock.calls[0]?.[2] ?? []) as ReadonlyArray<{ path: string }>;
    expect(seededPaths.map((seed) => seed.path)).not.toContain("project.json");
  });

  it("seeds the playbook and welcome note as one commit, from the shared core seeds", async () => {
    await ensureProjectGiteaRepo({
      workspaceId: "mira",
      slug: "orbit",
      name: "Orbit",
      tagline: "Ship it",
      projectType: "web",
      visibility: "public",
      recipe: "static-site",
    });

    expect(h.giteaWriteFiles).toHaveBeenCalledTimes(1);
    const [org, repo, files, message] = h.giteaWriteFiles.mock.calls[0] as [
      string,
      string,
      ReadonlyArray<{ path: string; content: string }>,
      string,
    ];
    expect(org).toBe("mira");
    expect(repo).toBe("orbit");
    expect(message).toBe("auto: seed project playbook");
    expect(files).toEqual([
      { path: "runbook/how-we-build.md", content: "# How we build Orbit\n" },
      { path: "DECISIONS.md", content: "# Decisions — Orbit\n" },
      { path: "notes/welcome.md", content: "# Welcome to notes\n" },
    ]);
  });

  it("seeds against the project's own type and resolved recipe, not a flat default", async () => {
    await ensureProjectGiteaRepo({
      workspaceId: "mira",
      slug: "orbit",
      name: "Orbit",
      tagline: "Ship it",
      projectType: "game",
      visibility: "public",
      recipe: "vite-static",
    });

    expect(h.projectPlaybookSeeds).toHaveBeenCalledWith({
      projectName: "Orbit",
      projectType: "game",
      recipe: "vite-static",
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(h.notesWelcomeSeed).toHaveBeenCalledWith("Orbit");
  });

  it("fails provisioning when a seed write fails — the playbook is not best-effort", async () => {
    h.giteaWriteFiles.mockRejectedValueOnce(new Error("gitea 500"));

    await expect(
      ensureProjectGiteaRepo({
        workspaceId: "mira",
        slug: "orbit",
        name: "Orbit",
        tagline: "",
        projectType: null,
        visibility: "private",
        recipe: "static-site",
      }),
    ).rejects.toThrow("gitea 500");
  });

  it("provisions through the tenant-bound API broker and returns its failure loudly", async () => {
    h.internalFetch.mockResolvedValueOnce(new Response(JSON.stringify({ created: true }), { status: 200 }));
    await expect(
      provisionProjectRepo({
        workspaceId: "mira",
        slug: "orbit",
        name: "Orbit",
        tagline: "",
        projectType: null,
        visibility: "private",
        recipe: "static-site",
      }),
    ).resolves.toBeNull();
    expect(h.internalFetch).toHaveBeenCalledWith(
      "http://octogee-api.test:3001/internal/gitea/provision-project-repo",
      expect.objectContaining({ method: "POST" }),
      { requireProjectedToken: true },
    );

    h.internalFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "repo exists" }), { status: 502 }));
    await expect(
      provisionProjectRepo({
        workspaceId: "mira",
        slug: "orbit",
        name: "Orbit",
        tagline: "",
        projectType: null,
        visibility: "private",
        recipe: "static-site",
      }),
    ).resolves.toBe("repo exists (HTTP 502)");
  });

  it("uses the local Gitea admin credential when mounted by octogee-api", async () => {
    process.env.GITEA_TOKEN = "platform-gitea-token";

    await expect(
      provisionProjectRepo({
        workspaceId: "mira",
        slug: "orbit",
        name: "Orbit",
        tagline: "",
        projectType: null,
        visibility: "private",
        recipe: "static-site",
      }),
    ).resolves.toBeNull();

    expect(h.createProjectGiteaRepo).toHaveBeenCalledWith("mira", "orbit", "Octogee project: Orbit", true);
    expect(h.internalFetch).not.toHaveBeenCalled();
  });

  it("deletes directly when octogee-api holds the Gitea admin credential", async () => {
    process.env.GITEA_TOKEN = "platform-gitea-token";

    await deleteProjectRepo({ workspaceId: "mira", slug: "orbit" });

    expect(h.giteaDeleteVerifiedRepo).toHaveBeenCalledWith("mira", "orbit");
    expect(h.internalFetch).not.toHaveBeenCalled();
  });
});

describe("workspace display-name route", () => {
  it("renames the Mattermost team for the workspace owner", async () => {
    h.readWorkspace.mockResolvedValue({
      ownerUid: "uid-owner",
      mattermost: { teamId: "team-1" },
    });

    const res = await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: " Mira Labs " })
      .expect(200);

    expect(res.body).toEqual({ ok: true, displayName: "Mira Labs" });
    expect(h.mmApi).toHaveBeenCalledWith("/teams/team-1", "PUT", { display_name: "Mira Labs" });
  });

  it("rejects invalid names and missing workspace context before external writes", async () => {
    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "   " })
      .expect(400, { error: "displayName is required" });

    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "x".repeat(65) })
      .expect(400, { error: "displayName exceeds 64-char MM limit" });

    await request(displayNameApp({}))
      .patch("/api/workspace/display-name")
      .send({ displayName: "Mira" })
      .expect(404, { error: "No workspace for caller" });

    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("rejects missing, non-owner, and unprovisioned workspaces", async () => {
    h.readWorkspace.mockResolvedValueOnce(null);
    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "Mira" })
      .expect(404, { error: "Workspace not found" });

    h.readWorkspace.mockResolvedValueOnce({ ownerUid: "someone-else", mattermost: { teamId: "team-1" } });
    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "Mira" })
      .expect(403, { error: "Only the workspace owner can rename" });

    h.readWorkspace.mockResolvedValueOnce({ ownerUid: "uid-owner", mattermost: {} });
    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "Mira" })
      .expect(409, { error: "Workspace is not yet provisioned" });

    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("logs and forwards unexpected failures", async () => {
    h.readWorkspace.mockResolvedValue({
      ownerUid: "uid-owner",
      mattermost: { teamId: "team-1" },
    });
    h.mmApi.mockRejectedValueOnce(new Error("mattermost down"));

    await request(displayNameApp())
      .patch("/api/workspace/display-name")
      .send({ displayName: "Mira" })
      .expect(500, { error: "mattermost down" });

    expect(h.logger.error).toHaveBeenCalledWith("[workspace] PATCH /display-name failed", {
      uid: "uid-owner",
      error: "mattermost down",
    });
  });
});
