import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DocData = Record<string, unknown>;

interface Write {
  method: "set" | "update";
  path: string;
  data: unknown;
  options?: unknown;
}

const h = vi.hoisted(() => ({
  auth: {
    uid: "owner-1" as string | undefined,
    isAdmin: false,
  },
  docs: new Map<string, DocData>(),
  userBySlug: new Map<string, { id: string; data: DocData }>(),
  writes: [] as Write[],
  arrayUnion: vi.fn((...values: unknown[]) => ({ __arrayUnion: values })),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
  readAgent: vi.fn(),
  mmApi: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function snap(path: string) {
  const data = h.docs.get(path);
  return { exists: data !== undefined, data: () => data };
}

function docRef(path: string) {
  return {
    get: async () => snap(path),
    set: async (data: unknown, options?: unknown) => {
      h.writes.push({ method: "set", path, data, options });
      const merge = (options as { merge?: boolean } | undefined)?.merge === true;
      const stored = { ...(data as DocData), ...("updatedAt" in (data as DocData) ? { updatedAt: 1 } : {}) };
      h.docs.set(path, merge ? { ...(h.docs.get(path) ?? {}), ...stored } : stored);
    },
    update: async (data: unknown) => {
      h.writes.push({ method: "update", path, data });
      h.docs.set(path, { ...(h.docs.get(path) ?? {}), ...(data as DocData) });
    },
    collection: (sub: string) => colRef(`${path}/${sub}`),
  };
}

function querySnapForSlug(slug: string) {
  const found = h.userBySlug.get(slug);
  return found
    ? { empty: false, docs: [{ id: found.id, data: () => found.data }] }
    : { empty: true, docs: [] };
}

function colRef(path: string) {
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (_field: string, _op: string, value: string) => ({
      limit: (_limit: number) => ({
        get: async () => (path === "users" ? querySnapForSlug(value) : { empty: true, docs: [] }),
      }),
    }),
  };
}

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: { uid?: string; isAdmin?: boolean }, _res: unknown, next: () => void) => {
    req.uid = h.auth.uid;
    req.isAdmin = h.auth.isAdmin;
    next();
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => docRef(path),
    collection: (path: string) => colRef(path),
  },
  FieldValue: {
    arrayUnion: h.arrayUnion,
    serverTimestamp: h.serverTimestamp,
  },
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("../lib/firestoreReads.js", () => ({
  readAgent: h.readAgent,
}));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: h.mmApi,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

const { default: agentRoutes } = await import("../routes/agents.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/agents", agentRoutes);
  return a;
}

describe("agent routes", () => {
  beforeEach(() => {
    h.auth.uid = "owner-1";
    h.auth.isAdmin = false;
    h.docs.clear();
    h.userBySlug.clear();
    h.writes.length = 0;
    h.arrayUnion.mockClear();
    h.serverTimestamp.mockClear();
    h.readAgent.mockReset();
    h.mmApi.mockReset();
    h.logger.info.mockReset();
    h.logger.warn.mockReset();
    h.logger.error.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("patches coach profile fields and syncs the Mattermost display name", async () => {
    h.docs.set("agents/owner-1", { mattermost: { userId: "coach-mm" } });

    const res = await request(app())
      .patch("/api/agents/me")
      .send({ name: "Sage", persona: "Direct and practical.", ignored: "value" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, updated: ["name", "persona"] });
    expect(h.writes).toContainEqual({
      method: "set",
      path: "agents/owner-1",
      data: {
        id: "owner-1",
        name: "Sage",
        persona: "Direct and practical.",
        updatedAt: { __serverTimestamp: true },
      },
      options: { merge: true },
    });
    expect(h.mmApi).toHaveBeenCalledWith("/bots/coach-mm", "PUT", {
      display_name: "Sage",
    });
  });

  it("rejects a coach patch without allowed string fields", async () => {
    const res = await request(app())
      .patch("/api/agents/me")
      .send({ name: 42, nickname: "Sage" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "no_valid_fields",
      allowed: ["name", "persona"],
    });
    expect(h.writes).toEqual([]);
    expect(h.mmApi).not.toHaveBeenCalled();
  });

  it("queues a tier-allowed specialist activation for the authenticated owner", async () => {
    h.docs.set("users/owner-1", {
      subscription: { tier: "pro" },
      provisioning: { openclaw: { activatedAgents: ["riley"] } },
    });

    const res = await request(app())
      .post("/api/agents/activate")
      .send({ role: "alex", requestedBy: "coach" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "queued", role: "alex", tier: "pro" });
    expect(h.writes).toContainEqual({
      method: "update",
      path: "users/owner-1",
      data: {
        "provisioning.pendingActivations": { __arrayUnion: ["alex"] },
        "provisioning.pendingActivationRequestedAt": { __serverTimestamp: true },
        "provisioning.pendingActivationRequestedBy": "coach",
      },
    });
  });

  it("reports a specialist the Builder record already activated without queueing it", async () => {
    h.docs.set("users/owner-1", {
      subscription: { tier: "pro" },
      provisioning: { openclaw: { activatedAgents: ["alex"] } },
    });

    const res = await request(app())
      .post("/api/agents/activate")
      .send({ role: "alex" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "already_active", role: "alex" });
    expect(h.writes).toEqual([]);
  });
});
