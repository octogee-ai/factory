import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platformDocs: Record<string, Record<string, unknown> | undefined> = {};
const setCalls: Array<{ path: string; data: Record<string, unknown>; opts?: unknown }> = [];

vi.mock("../lib/db", () => {
  function collection(path: string): any {
    return {
      doc: (id: string) => ({
        get: async () => ({
          exists: platformDocs[`${path}/${id}`] !== undefined,
          data: () => platformDocs[`${path}/${id}`],
        }),
        set: async (data: Record<string, unknown>, opts?: unknown) => {
          setCalls.push({ path: `${path}/${id}`, data, opts });
          platformDocs[`${path}/${id}`] = { ...(platformDocs[`${path}/${id}`] ?? {}), ...data };
        },
        collection: () => ({
          doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
        }),
      }),
      where: () => ({ get: async () => ({ docs: [], size: 0 }) }),
      orderBy: () => ({ get: async () => ({ docs: [], size: 0 }) }),
    };
  }
  return {
    db: { collection, doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }), getAll: async () => [] },
    FieldValue: { serverTimestamp: () => "server-now" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { uid: "admin-user" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { uid: "admin-user" };
    next();
  },
}));

import express from "express";
import adminRouter from "../routes/admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

describe("admin platform-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    setCalls.length = 0;
  });

  it("GET serves the compiled default plus the full catalog when no doc exists", async () => {
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(res.body.defaultFreeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
    const refs = res.body.catalog.map((c: { ref: string }) => c.ref);
    expect(refs).toContain("anthropic/claude-haiku-4-5");
    expect(refs).toContain("platform-openrouter/z-ai/glm-5.2");
    expect(refs).toContain("platform-openrouter/deepseek/deepseek-v4-pro");
    const haiku = res.body.catalog.find((c: { ref: string }) => c.ref === "anthropic/claude-haiku-4-5");
    expect(haiku).toMatchObject({ label: "Claude Haiku 4.5", provider: "anthropic" });
  });

  it("GET serves the configured dial when the doc exists", async () => {
    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
    };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
  });

  it("GET falls back to the default when the stored ref left the catalog", async () => {
    platformDocs["platformConfig/models"] = { freeTierModelRef: "platform-openrouter/gone/model" };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("PUT writes the dial with audit fields and echoes the new value", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe("platformConfig/models");
    expect(setCalls[0].data).toMatchObject({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      updatedBy: "admin-user",
      updatedAt: "server-now",
    });
  });

  it("PUT rejects a non-catalog ref with 400 and writes nothing", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({ freeTierModelRef: "anthropic/claude-opus-4-8" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(setCalls).toHaveLength(0);
  });

  it("PUT rejects a missing ref with 400", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
  });
});
