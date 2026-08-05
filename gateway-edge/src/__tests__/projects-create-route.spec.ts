import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";

const h = vi.hoisted(() => ({
  uid: "owner-1",
  user: { username: "mira" } as Record<string, unknown>,
  workspaceSlug: "mira" as string | undefined,
  isAdmin: false,
  existingProject: false,
  createProjectForActor: vi.fn(),
  projectSlugAvailability: vi.fn(),
  evaluate: vi.fn(),
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => {
    next();
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => ({
      get: async () => {
        if (path !== "workspaces/mira/projects/orbit") {
          throw new Error(`unexpected doc ${path}`);
        }
        return { exists: h.existingProject };
      },
    }),
  },
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));

vi.mock("../lib/project-create-service.js", () => ({
  createProjectForActor: (...args: unknown[]) => h.createProjectForActor(...args),
  projectSlugAvailability: (slug: string) => h.projectSlugAvailability(slug),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

const { default: createRoutes, createProjectCreateRoutes } =
  await import("../routes/projects/create.js");

const featurePolicy = {
  evaluate: (...args: unknown[]) => h.evaluate(...args),
} as unknown as FeaturePolicy;

function app(routes: express.Router = createRoutes) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.uid = h.uid;
    req.user = h.user;
    req.workspaceSlug = h.workspaceSlug;
    req.isAdmin = h.isAdmin;
    next();
  });
  a.use("/api/projects", routes);
  return a;
}

function gatedApp() {
  return app(createProjectCreateRoutes({ featurePolicy }));
}

beforeEach(() => {
  h.uid = "owner-1";
  h.user = { username: "mira" };
  h.workspaceSlug = "mira";
  h.isAdmin = false;
  h.existingProject = false;
  h.createProjectForActor.mockReset().mockResolvedValue({
    status: 200,
    body: { success: true, slug: "orbit" },
  });
  h.projectSlugAvailability.mockReset().mockReturnValue({ ok: true });
  h.evaluate.mockReset().mockResolvedValue({ state: "enabled", value: true });
  h.logger.error.mockReset();
});

describe("GET /api/projects/slug-available", () => {
  it("returns unavailable with the validation reason for malformed slugs", async () => {
    h.projectSlugAvailability.mockReturnValueOnce({
      ok: false,
      reason: "That slug is reserved.",
    });

    await request(app())
      .get("/api/projects/slug-available?slug=settings")
      .expect(200, { available: false, reason: "That slug is reserved." });

    expect(h.projectSlugAvailability).toHaveBeenCalledWith("settings");
  });

  it("requires a provisioned workspace before checking Firestore", async () => {
    h.workspaceSlug = undefined;

    await request(app())
      .get("/api/projects/slug-available?slug=orbit")
      .expect(422, { error: "Workspace not provisioned" });
  });

  it("checks the workspace project doc for valid slugs", async () => {
    h.existingProject = true;

    await request(app())
      .get("/api/projects/slug-available?slug= orbit ")
      .expect(200, { available: false });
  });
});

describe("POST /api/projects", () => {
  it("passes the authenticated actor and request body to the project creation service", async () => {
    const body = { name: "Orbit", slug: "orbit" };

    await request(app())
      .post("/api/projects")
      .send(body)
      .expect(200, { success: true, slug: "orbit" });

    expect(h.createProjectForActor).toHaveBeenCalledWith(
      {
        uid: "owner-1",
        userData: { username: "mira" },
        workspaceId: "mira",
        source: "ui",
      },
      body,
    );
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("evaluates the repo-source flag only when the body asks for a GitHub repo", async () => {
    const body = {
      name: "Orbit",
      slug: "orbit",
      repoSource: { provider: "github", owner: "octogee-ai", repo: "seed" },
    };

    await request(gatedApp()).post("/api/projects").send(body).expect(200);

    expect(h.evaluate).toHaveBeenCalledWith(
      "release-project-repo-source",
      expect.objectContaining({ uid: "owner-1", isAdmin: false, workspaceSlug: "mira" }),
      expect.any(String),
    );
    expect(h.createProjectForActor).toHaveBeenCalledWith(
      expect.objectContaining({ repoSourceAccess: "enabled" }),
      body,
    );
  });

  it("hands a disabled decision to the service rather than deciding on its own", async () => {
    h.evaluate.mockResolvedValue({ state: "disabled", value: false });

    await request(gatedApp())
      .post("/api/projects")
      .send({
        name: "Orbit",
        slug: "orbit",
        repoSource: { provider: "github", owner: "octogee-ai", repo: "seed" },
      })
      .expect(200);

    expect(h.createProjectForActor).toHaveBeenCalledWith(
      expect.objectContaining({ repoSourceAccess: "disabled" }),
      expect.anything(),
    );
  });

  it("treats an admin as enabled without consulting the flag", async () => {
    h.isAdmin = true;
    h.evaluate.mockResolvedValue({ state: "disabled", value: false });

    await request(gatedApp())
      .post("/api/projects")
      .send({
        name: "Orbit",
        slug: "orbit",
        repoSource: { provider: "github", owner: "octogee-ai", repo: "seed" },
      })
      .expect(200);

    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.createProjectForActor).toHaveBeenCalledWith(
      expect.objectContaining({ repoSourceAccess: "enabled" }),
      expect.anything(),
    );
  });

  it("fails the repo-source gate closed when no feature policy is wired in", async () => {
    await request(app())
      .post("/api/projects")
      .send({
        name: "Orbit",
        slug: "orbit",
        repoSource: { provider: "github", owner: "octogee-ai", repo: "seed" },
      })
      .expect(200);

    expect(h.createProjectForActor).toHaveBeenCalledWith(
      expect.objectContaining({ repoSourceAccess: "disabled" }),
      expect.anything(),
    );
  });

  it("logs unexpected service failures and returns the stable route error", async () => {
    h.createProjectForActor.mockRejectedValueOnce(new Error("boom"));

    await request(app())
      .post("/api/projects")
      .send({ name: "Orbit", slug: "orbit" })
      .expect(500, { error: "Failed to create project" });

    expect(h.logger.error).toHaveBeenCalledWith("[projects] Create failed:", {
      err: expect.any(Error),
    });
  });
});
