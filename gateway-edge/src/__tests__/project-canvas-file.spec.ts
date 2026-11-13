import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isSettableCanvasFile, resolveCanvasFile } from "../lib/canvas-file.js";

const h = vi.hoisted(() => ({
  dbDoc: vi.fn((path: string) => ({ path })),
  serverTimestamp: vi.fn(() => ({ __op: "serverTimestamp" })),
  giteaApi: vi.fn(),
  githubContentsApi: vi.fn(),
  readConnectorAccessToken: vi.fn(),
  readProject: vi.fn(),
  withProject: vi.fn(),
  update: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../lib/db.js", () => ({
  db: { doc: (path: string) => h.dbDoc(path) },
  auth: { verifyIdToken: vi.fn() },
  FieldValue: { serverTimestamp: () => h.serverTimestamp() },
}));

vi.mock("../lib/gitea.js", () => ({
  giteaApi: (...args: unknown[]) => h.giteaApi(...args),
}));

vi.mock("../lib/github.js", () => ({
  githubContentsApi: (...args: unknown[]) => h.githubContentsApi(...args),
}));

vi.mock("../lib/connector-tokens.js", () => ({
  readConnectorAccessToken: (...args: unknown[]) => h.readConnectorAccessToken(...args),
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readProject: (...args: unknown[]) => h.readProject(...args),
}));

vi.mock("../lib/withProject.js", () => ({
  withProject: (...args: unknown[]) => h.withProject(...args),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = "uid-owner";
    next();
  },
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

const { default: canvasRoutes } = await import("../routes/projects/readme.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/projects", canvasRoutes);
  return a;
}

const GITHUB_PROJECT = {
  ownerUid: "uid-owner",
  visibility: "public",
  canvasFile: "docs/landing.md",
  repoSource: { provider: "github", owner: "octogee-ai", repo: "orbit-site" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.dbDoc.mockImplementation((path: string) => ({ path }));
  h.serverTimestamp.mockReturnValue({ __op: "serverTimestamp" });
  h.readConnectorAccessToken.mockResolvedValue("gho_owner");
  h.withProject.mockImplementation(async (
    _req: unknown,
    _res: unknown,
    wid: string,
    pid: string,
    _opts: unknown,
    handler: (ctx: unknown) => Promise<void>,
  ) => {
    await handler({
      projectRef: { update: h.update },
      project: GITHUB_PROJECT,
      uid: "uid-owner",
      wid,
      pid,
    });
  });
});

describe("canvas file policy", () => {
  it("accepts nested markdown paths and rejects traversal, absolute, and non-markdown paths", () => {
    expect(isSettableCanvasFile("README.md")).toBe(true);
    expect(isSettableCanvasFile("docs/landing.md")).toBe(true);
    expect(isSettableCanvasFile("docs/landing.markdown")).toBe(true);
    expect(isSettableCanvasFile("docs/LANDING.MD")).toBe(true);

    expect(isSettableCanvasFile("../secret.md")).toBe(false);
    expect(isSettableCanvasFile("docs/../../secret.md")).toBe(false);
    expect(isSettableCanvasFile("/etc/passwd.md")).toBe(false);
    expect(isSettableCanvasFile("docs/landing.txt")).toBe(false);
    expect(isSettableCanvasFile(".env")).toBe(false);
    expect(isSettableCanvasFile(42)).toBe(false);
    expect(isSettableCanvasFile(undefined)).toBe(false);
  });

  it("falls back to README.md for absent or unsafe stored values", () => {
    expect(resolveCanvasFile("docs/landing.md")).toBe("docs/landing.md");
    expect(resolveCanvasFile(undefined)).toBe("README.md");
    expect(resolveCanvasFile("../secret.md")).toBe("README.md");
    expect(resolveCanvasFile("/etc/passwd")).toBe("README.md");
  });
});

describe("public canvas read — GitHub-backed project", () => {
  it("reads the canvas file from GitHub with an owner-brokered public-canvas token", async () => {
    h.readProject.mockResolvedValue(GITHUB_PROJECT);
    h.githubContentsApi.mockResolvedValue({
      content: Buffer.from("# Orbit\n").toString("base64"),
    });

    const res = await request(app())
      .get("/api/projects/mira/orbit/readme")
      .expect(200);

    expect(res.body).toEqual({ content: "# Orbit\n", path: "docs/landing.md" });
    expect(h.readConnectorAccessToken).toHaveBeenCalledWith("uid-owner", "github", {
      kind: "public-canvas",
      workspaceSlug: "mira",
      projectSlug: "orbit",
      canvasPath: "docs/landing.md",
    });
    expect(h.githubContentsApi).toHaveBeenCalledWith(
      "octogee-ai",
      "orbit-site",
      "docs/landing.md",
      "gho_owner",
    );
    expect(h.giteaApi).not.toHaveBeenCalled();
  });

  it("brokers the server-resolved canvas path, never a stored unsafe one", async () => {
    h.readProject.mockResolvedValue({ ...GITHUB_PROJECT, canvasFile: "../../etc/passwd" });
    h.githubContentsApi.mockResolvedValue({ content: "" });

    await request(app()).get("/api/projects/mira/orbit/readme").expect(200);

    expect(h.readConnectorAccessToken).toHaveBeenCalledWith(
      "uid-owner",
      "github",
      expect.objectContaining({ canvasPath: "README.md" }),
    );
    expect(h.githubContentsApi).toHaveBeenCalledWith(
      "octogee-ai",
      "orbit-site",
      "README.md",
      "gho_owner",
    );
  });

  it("returns empty content when the designated file is missing from the GitHub repo", async () => {
    h.readProject.mockResolvedValue(GITHUB_PROJECT);
    h.githubContentsApi.mockRejectedValue(new Error("GitHub API 404"));

    const res = await request(app())
      .get("/api/projects/mira/orbit/readme")
      .expect(200);

    expect(res.body).toEqual({ content: "", path: "docs/landing.md" });
  });

  it("fails loudly instead of serving empty content when the owner has no GitHub token", async () => {
    h.readProject.mockResolvedValue(GITHUB_PROJECT);
    h.readConnectorAccessToken.mockResolvedValue(null);

    await request(app())
      .get("/api/projects/mira/orbit/readme")
      .expect(500, { error: "Failed to load project readme" });

    expect(h.githubContentsApi).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      "[projects] Public README fetch failed for mira/orbit:",
      { err: expect.any(Error) },
    );
  });

  it("hides private GitHub-backed projects before brokering any token", async () => {
    h.readProject.mockResolvedValue({ ...GITHUB_PROJECT, visibility: "private" });

    await request(app())
      .get("/api/projects/mira/orbit/readme")
      .expect(404, { error: "Project not found" });

    expect(h.readConnectorAccessToken).not.toHaveBeenCalled();
    expect(h.githubContentsApi).not.toHaveBeenCalled();
  });

  it("keeps Gitea-backed projects on the Gitea path", async () => {
    h.readProject.mockResolvedValue({
      ownerUid: "uid-owner",
      visibility: "unlisted",
      canvasFile: "docs/README.md",
    });
    h.giteaApi.mockResolvedValue({ content: Buffer.from("# Orbit\n").toString("base64") });

    const res = await request(app())
      .get("/api/projects/mira/orbit/readme")
      .expect(200);

    expect(res.body).toEqual({ content: "# Orbit\n", path: "docs/README.md" });
    expect(h.giteaApi).toHaveBeenCalledWith("mira", "orbit/contents/docs/README.md");
    expect(h.readConnectorAccessToken).not.toHaveBeenCalled();
    expect(h.githubContentsApi).not.toHaveBeenCalled();
  });
});

describe("PUT canvas file", () => {
  it("stores an owner-designated nested markdown path", async () => {
    const res = await request(app())
      .put("/api/projects/mira/orbit/canvas-file")
      .send({ canvasFile: "docs/landing.md" })
      .expect(200);

    expect(res.body).toEqual({ ok: true, canvasFile: "docs/landing.md" });
    expect(h.update).toHaveBeenCalledWith({
      canvasFile: "docs/landing.md",
      updatedAt: { __op: "serverTimestamp" },
    });
  });

  it("delegates owner-only authorization to withProject", async () => {
    await request(app())
      .put("/api/projects/mira/orbit/canvas-file")
      .send({ canvasFile: "README.md" })
      .expect(200);

    expect(h.withProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "mira",
      "orbit",
      expect.objectContaining({ ownerOnly: true, requireActive: true }),
      expect.any(Function),
    );
  });

  it("rejects traversal, absolute, and non-markdown paths without writing", async () => {
    for (const canvasFile of ["../secret.md", "/etc/passwd.md", "docs/landing.txt", "", 7]) {
      await request(app())
        .put("/api/projects/mira/orbit/canvas-file")
        .send({ canvasFile })
        .expect(400);
    }

    expect(h.update).not.toHaveBeenCalled();
  });
});
