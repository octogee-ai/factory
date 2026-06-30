import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const docs = new Map<string, { exists: boolean }>();
  const get = vi.fn(async function get(this: { path: string }) {
    return { exists: docs.get(this.path)?.exists ?? false };
  });
  const set = vi.fn(async () => undefined);
  const del = vi.fn(async () => undefined);
  return {
    docs,
    get,
    set,
    del,
    serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
    readProject: vi.fn(),
    logger: {
      error: vi.fn(),
    },
  };
});

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => ({
      path,
      get: h.get,
      set: h.set,
      delete: h.del,
    }),
  },
  FieldValue: {
    serverTimestamp: () => h.serverTimestamp(),
  },
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readProject: (...args: unknown[]) => h.readProject(...args),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

const { corsMiddleware } = await import("../middleware/cors.js");
const { default: projectStarRoutes } = await import("../routes/projects/star.js");

function corsApp() {
  const app = express();
  app.use(corsMiddleware);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

function projectApp(uid = "uid-viewer") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = uid;
    next();
  });
  app.use("/api/projects", projectStarRoutes);
  return app;
}

beforeEach(() => {
  h.docs.clear();
  h.get.mockClear();
  h.set.mockClear();
  h.del.mockClear();
  h.serverTimestamp.mockClear();
  h.readProject.mockReset().mockResolvedValue({ ownerUid: "uid-owner" });
  h.logger.error.mockClear();
});

describe("corsMiddleware", () => {
  it("allows Octogee app origins and localhost development origins", async () => {
    const prod = await request(corsApp())
      .get("/probe")
      .set("Origin", "https://app.octogee.com")
      .expect("Access-Control-Allow-Origin", "https://app.octogee.com")
      .expect("Access-Control-Allow-Credentials", "true")
      .expect(200);
    expect(prod.body).toEqual({ ok: true });

    const local = await request(corsApp())
      .get("/probe")
      .set("Origin", "http://localhost:4322")
      .expect("Access-Control-Allow-Origin", "http://localhost:4322")
      .expect(200);
    expect(local.body).toEqual({ ok: true });
  });

  it("does not emit CORS allow headers for unknown origins", async () => {
    const res = await request(corsApp())
      .get("/probe")
      .set("Origin", "https://evil.test")
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("project star route", () => {
  it("sets a new star document for an unstarred project", async () => {
    const res = await request(projectApp())
      .post("/api/projects/mira/orbit/star")
      .expect(200);

    expect(res.body).toEqual({ starred: true });
    expect(h.readProject).toHaveBeenCalledWith(expect.objectContaining({
      path: "workspaces/mira/projects/orbit",
    }));
    expect(h.set).toHaveBeenCalledWith({
      actorUid: "uid-viewer",
      target: {
        type: "project",
        workspaceSlug: "mira",
        projectSlug: "orbit",
        ownerUid: "uid-owner",
      },
      createdAt: { __serverTimestamp: true },
    });
  });

  it("deletes an existing star document", async () => {
    h.docs.set(
      "stars/uid-viewer_p_mira_orbit",
      { exists: true },
    );

    const res = await request(projectApp())
      .post("/api/projects/mira/orbit/star")
      .expect(200);

    expect(res.body).toEqual({ starred: false });
    expect(h.del).toHaveBeenCalledTimes(1);
    expect(h.set).not.toHaveBeenCalled();
  });

  it("returns 404 for missing projects and logs unexpected failures", async () => {
    h.readProject.mockResolvedValueOnce(null);
    await request(projectApp())
      .post("/api/projects/mira/missing/star")
      .expect(404, { error: "Project not found" });

    h.readProject.mockRejectedValueOnce(new Error("firestore down"));
    await request(projectApp())
      .post("/api/projects/mira/orbit/star")
      .expect(500, { error: "Failed to toggle star" });

    expect(h.logger.error).toHaveBeenCalledWith("[projects] Star toggle failed:", {
      err: expect.any(Error),
    });
  });
});
