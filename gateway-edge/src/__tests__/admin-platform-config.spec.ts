import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platformDocs: Record<string, Record<string, unknown> | undefined> = {};
const setCalls: Array<{ path: string; data: Record<string, unknown>; opts?: unknown }> = [];
const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
const aggregateCalls: string[] = [];

vi.mock("../lib/db", () => {
  function collection(path: string): any {
    const queryResult = (key: string, limit?: number) => {
      const rows = (queryDocs[key] ?? []).slice(0, limit);
      return {
        docs: rows.map((row) => ({ id: row.id, data: () => row.data })),
        size: rows.length,
      };
    };
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
        collection: (subcollection: string) => ({
          doc: (subId: string) => ({
            get: async () => ({
              exists: platformDocs[`${path}/${id}/${subcollection}/${subId}`] !== undefined,
              data: () => platformDocs[`${path}/${id}/${subcollection}/${subId}`],
            }),
          }),
        }),
      }),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => queryResult(`${path}:${field}:${String(value)}`),
        count: () => ({
          get: async () => {
            const key = `${path}:${field}:${String(value)}`;
            aggregateCalls.push(key);
            return { data: () => ({ count: queryDocs[key]?.length ?? 0 }) };
          },
        }),
        orderBy: () => ({
          limit: (count: number) => ({ get: async () => queryResult(`${path}:${field}:${String(value)}`, count) }),
          get: async () => queryResult(`${path}:${field}:${String(value)}`),
        }),
      }),
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
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
    aggregateCalls.length = 0;
  });

  it("GET serves the compiled default plus the full catalog when no doc exists", async () => {
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(res.body.defaultFreeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/minimax/minimax-m3");
    expect(res.body.defaultOpsAgentModelRef).toBe("platform-openrouter/minimax/minimax-m3");
    const refs = res.body.catalog.map((c: { ref: string }) => c.ref);
    expect(refs).toContain("anthropic/claude-haiku-4-5");
    expect(refs).toContain("platform-openrouter/z-ai/glm-5.2");
    expect(refs).toContain("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(refs).toContain("platform-openrouter/openai/gpt-5.6-luna");
    const haiku = res.body.catalog.find((c: { ref: string }) => c.ref === "anthropic/claude-haiku-4-5");
    expect(haiku).toMatchObject({ label: "Claude Haiku 4.5", provider: "anthropic" });
    expect(res.body.opsCatalog.map((c: { ref: string }) => c.ref)).toEqual(
      expect.arrayContaining(["platform-openrouter/z-ai/glm-5.2"]),
    );
    expect(res.body.opsCatalog.every((c: { provider: string }) => c.provider === "openrouter")).toBe(true);
  });

  it("GET serves the configured dial when the doc exists", async () => {
    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("GET resolves each model dial independently when its sibling is invalid", async () => {
    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    };
    let res = await request(app).get("/api/admin/platform-config");
    expect(res.body.freeTierModelRef).toBe("anthropic/claude-haiku-4-5");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/minimax/minimax-m3");

    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "invalid/model",
      opsAgentModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
    };
    res = await request(app).get("/api/admin/platform-config");
    expect(res.body.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
    expect(res.body.opsAgentModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("GET falls back to the default when the stored ref left the catalog", async () => {
    platformDocs["platformConfig/models"] = { freeTierModelRef: "platform-openrouter/gone/model" };
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("GET serves the Builder Agent default dial with its compiled defaults", async () => {
    const res = await request(app).get("/api/admin/platform-config");
    expect(res.status).toBe(200);
    expect(res.body.builderAgentModelRef).toBe("platform-openrouter/openai/gpt-5.6-luna");
    expect(res.body.defaultBuilderAgentModelRef).toBe(
      "platform-openrouter/openai/gpt-5.6-luna",
    );
    expect(res.body.catalog).toContainEqual({
      ref: "platform-openrouter/openai/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      provider: "openrouter",
    });
    expect(res.body.builderAgentFallbackModelRef).toBe("platform-openrouter/z-ai/glm-5.2");
    expect(res.body.defaultBuilderAgentFallbackModelRef).toBe("platform-openrouter/z-ai/glm-5.2");

    platformDocs["platformConfig/models"] = {
      freeTierModelRef: "anthropic/claude-haiku-4-5",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: null,
    };
    const dialed = await request(app).get("/api/admin/platform-config");
    expect(dialed.body.builderAgentModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(dialed.body.builderAgentFallbackModelRef).toBeNull();
  });

  it("PUT writes the dial with audit fields and echoes the new value", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({
        freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
        opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
        builderAgentModelRef: "anthropic/claude-sonnet-4-6",
        builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe("platformConfig/models");
    expect(setCalls[0].data).toMatchObject({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "platform-openrouter/z-ai/glm-5.2",
      builderAgentModelRef: "anthropic/claude-sonnet-4-6",
      builderAgentFallbackModelRef: "platform-openrouter/z-ai/glm-5.2",
      updatedBy: "admin-user",
      updatedAt: "server-now",
    });
  });

  it("PUT rejects a Builder Agent ref outside the catalog", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      builderAgentModelRef: "z-ai/glm-5.2",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(setCalls).toHaveLength(0);
  });

  it("PUT rejects a non-catalog ref with 400 and writes nothing", async () => {
    const res = await request(app)
      .put("/api/admin/platform-config")
      .send({ freeTierModelRef: "anthropic/claude-opus-4-8" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_model_ref");
    expect(setCalls).toHaveLength(0);
  });

  it("PUT rejects an Ops model outside the platform OpenRouter catalog", async () => {
    const res = await request(app).put("/api/admin/platform-config").send({
      freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro",
      opsAgentModelRef: "anthropic/claude-haiku-4-5",
    });
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

describe("admin platform-connect-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
  });

  it("GET serves the compiled dark default when no doc exists", async () => {
    const res = await request(app).get("/api/admin/platform-connect-config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ googleStage: "off", googleAllowlistUids: [] });
  });

  it("GET serves the stored dial, and a malformed doc reads as the dark default", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    };
    const stored = await request(app).get("/api/admin/platform-connect-config");
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual({
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });

    platformDocs["platformConfig/connect"] = { googleStage: "public" };
    const malformed = await request(app).get("/api/admin/platform-connect-config");
    expect(malformed.status).toBe(200);
    expect(malformed.body).toEqual({ googleStage: "off", googleAllowlistUids: [] });
  });

  it("PUT writes the dial with audit fields and echoes the normalized value", async () => {
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStage: "allowlist", googleAllowlistUids: [" uid-chris ", ""] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris"],
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe("platformConfig/connect");
    expect(setCalls[0].data).toMatchObject({
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris"],
      updatedBy: "admin-user",
      updatedAt: "server-now",
    });
  });

  it("PUT rejects an unknown stage with 400 and writes nothing", async () => {
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStage: "public" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_connect_config");
    expect(setCalls).toHaveLength(0);
  });
});

describe("admin platform-connect-config — stage-only updates", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
  });

  it("a stage-only PUT preserves the stored allowlist", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStage: "on" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      googleStage: "on",
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });
    expect(setCalls[0].data).toMatchObject({
      googleStage: "on",
      googleAllowlistUids: ["uid-chris", "uid-dan"],
    });
  });

  it("an explicit empty allowlist clears it", async () => {
    platformDocs["platformConfig/connect"] = {
      googleStage: "allowlist",
      googleAllowlistUids: ["uid-chris"],
    };
    const res = await request(app)
      .put("/api/admin/platform-connect-config")
      .send({ googleStage: "allowlist", googleAllowlistUids: [] });
    expect(res.status).toBe(200);
    expect(res.body.googleAllowlistUids).toEqual([]);
    expect(setCalls[0].data).toMatchObject({ googleAllowlistUids: [] });
  });
});

describe("admin platform-trial-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    for (const key of Object.keys(queryDocs)) delete queryDocs[key];
    setCalls.length = 0;
  });

  it("GET returns strict location-free defaults and concrete plan choices", async () => {
    platformDocs["platformConfig/trial"] = {
      schemaVersion: 2,
      offerId: "builder-signup",
      offerVersion: 1,
      durationDays: 7,
      defaultPersonalTier: "personal",
      defaultBuilderTier: "hobby",
    };
    const res = await request(app).get("/api/admin/platform-trial-config");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({
      schemaVersion: 2,
      offerId: "builder-signup",
      offerVersion: 1,
      durationDays: 7,
      defaultPersonalTier: "personal",
      defaultBuilderTier: "hobby",
    });
    expect(res.body.personalPlans).toContainEqual({ name: "personal_pro", displayName: "Personal Pro" });
    expect(res.body.builderPlans).toContainEqual({
      name: "pro",
      displayName: "Builder Pro",
      sizingTier: "m",
    });
    expect(res.body.builderPlans.map((plan: { name: string }) => plan.name)).not.toContain("enterprise");
    expect(res.body).not.toHaveProperty("provisioning");
    expect(aggregateCalls).toEqual([]);
  });

  it("GET reports missing configuration instead of silently granting a compiled tier", async () => {
    const res = await request(app).get("/api/admin/platform-trial-config");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("trial_config_invalid");
  });

  it("PUT writes validated defaults with audit fields", async () => {
    const res = await request(app)
      .put("/api/admin/platform-trial-config")
      .send({
        schemaVersion: 2,
        offerId: "builder-signup",
        offerVersion: 2,
        durationDays: 14,
        defaultPersonalTier: "personal_pro_max",
        defaultBuilderTier: "team",
      });

    expect(res.status).toBe(200);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({
      path: "platformConfig/trial",
      data: {
        schemaVersion: 2,
        offerId: "builder-signup",
        offerVersion: 2,
        durationDays: 14,
        defaultPersonalTier: "personal_pro_max",
        defaultBuilderTier: "team",
        updatedAt: "server-now",
        updatedBy: "admin-user",
      },
    });
  });

  it("PUT rejects enterprise", async () => {
    const enterprise = await request(app)
      .put("/api/admin/platform-trial-config")
      .send({
        schemaVersion: 2,
        offerId: "builder-signup",
        offerVersion: 1,
        durationDays: 7,
        defaultPersonalTier: "personal_pro",
        defaultBuilderTier: "enterprise",
      });
    expect(enterprise.status).toBe(400);
    expect(enterprise.body.error).toBe("invalid_trial_config");

    expect(setCalls).toHaveLength(0);
  });
});

describe("admin platform-free-config", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    for (const key of Object.keys(platformDocs)) delete platformDocs[key];
    setCalls.length = 0;
  });

  it("GET returns the compiled allowance when the document is absent", async () => {
    const res = await request(app).get("/api/admin/platform-free-config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemaVersion: 1, workspaceStorageGb: 10 });
  });

  it("PUT stores a validated workspace allowance with audit fields", async () => {
    const res = await request(app)
      .put("/api/admin/platform-free-config")
      .send({ schemaVersion: 1, workspaceStorageGb: 2.5 });
    expect(res.status).toBe(200);
    expect(setCalls).toContainEqual({
      path: "platformConfig/free",
      data: {
        schemaVersion: 1,
        workspaceStorageGb: 2.5,
        updatedAt: "server-now",
        updatedBy: "admin-user",
      },
      opts: undefined,
    });
  });

  it("PUT rejects an invalid allowance", async () => {
    const res = await request(app)
      .put("/api/admin/platform-free-config")
      .send({ schemaVersion: 1, workspaceStorageGb: 0 });
    expect(res.status).toBe(400);
    expect(setCalls).toHaveLength(0);
  });
});
