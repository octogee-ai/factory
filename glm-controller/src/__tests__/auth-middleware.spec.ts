import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { builderAccountFromData, type BuilderAccountReader } from "@octogee/core/builder-account";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createRequireAdmin } from "../middleware/auth";

interface Seed {
  users: Record<string, { email?: string; accountLifecycle?: { status?: string } }>;
  configs: Record<string, { role?: string }>;
}

function seededStore(seed: Seed): PlatformStateStore {
  return createDocumentFixtureStore({
    ...Object.fromEntries(Object.entries(seed.users).map(([uid, data]) => [`users/${uid}`, data])),
    ...Object.fromEntries(Object.entries(seed.configs).map(([uid, data]) => [`users/${uid}/system/config`, data])),
  });
}

function seededAccounts(seed: Seed): Pick<BuilderAccountReader, "get"> {
  return {
    get: async (uid) => {
      const data = seed.users[uid];
      return data === undefined ? null : builderAccountFromData(uid, data);
    },
  };
}

function buildApp(opts: {
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  store: Seed;
}): Express {
  const app = express();
  app.use(
    createRequireAdmin({
      verifyIdToken: opts.verifyIdToken,
      store: seededStore(opts.store),
      accounts: seededAccounts(opts.store),
      log: vi.fn(),
    }),
  );
  app.get("/probe", (req, res) => {
    res.json({
      uid: req.uid ?? null,
      isAdmin: req.isAdmin ?? false,
      email: req.user?.email ?? null,
    });
  });
  return app;
}

describe("createRequireAdmin", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const app = buildApp({
      verifyIdToken: vi.fn(),
      store: { users: {}, configs: {} },
    });
    const res = await request(app).get("/probe");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthenticated" });
  });

  it("returns 401 when Authorization header lacks Bearer prefix", async () => {
    const app = buildApp({
      verifyIdToken: vi.fn(),
      store: { users: {}, configs: {} },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "fake-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyIdToken throws", async () => {
    const app = buildApp({
      verifyIdToken: async () => {
        throw new Error("token expired");
      },
      store: { users: {}, configs: {} },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer bad-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid token" });
  });

  it("returns 403 when role is missing", async () => {
    const app = buildApp({
      verifyIdToken: async () => ({ uid: "alice" }),
      store: {
        users: { alice: { email: "alice@octogee.com" } },
        configs: {},
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(403);
  });

  it("returns 403 when role is not 'admin'", async () => {
    const app = buildApp({
      verifyIdToken: async () => ({ uid: "alice" }),
      store: {
        users: { alice: { email: "alice@octogee.com" } },
        configs: { alice: { role: "user" } },
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(403);
  });

  it("fails the request instead of reading an unknown stored role as non-admin", async () => {
    const app = buildApp({
      verifyIdToken: async () => ({ uid: "alice" }),
      store: {
        users: { alice: { email: "alice@octogee.com" } },
        configs: { alice: { role: "operator" } },
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(500);
  });

  it("returns 403 for an admin whose account deletion is scheduled", async () => {
    const app = buildApp({
      verifyIdToken: async () => ({ uid: "alice" }),
      store: {
        users: {
          alice: {
            email: "alice@octogee.com",
            accountLifecycle: { status: "deletion_scheduled" },
          },
        },
        configs: { alice: { role: "admin" } },
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account suspended" });
  });

  it("returns 500 when Firestore throws on the role lookup", async () => {
    const app = express();
    const seed: Seed = { users: { alice: { email: "alice@octogee.com" } }, configs: { alice: { role: "admin" } } };
    const store = seededStore(seed);
    vi.spyOn(store.builders.records, "get").mockRejectedValue(new Error("firestore unreachable"));
    app.use(
      createRequireAdmin({
        verifyIdToken: async () => ({ uid: "alice" }),
        store,
        accounts: seededAccounts(seed),
        log: vi.fn(),
      }),
    );
    app.get("/probe", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(500);
  });

  it("populates req.uid + req.user + req.isAdmin and continues for admins", async () => {
    const app = buildApp({
      verifyIdToken: async () => ({ uid: "alice" }),
      store: {
        users: { alice: { email: "alice@octogee.com" } },
        configs: { alice: { role: "admin" } },
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uid: "alice",
      isAdmin: true,
      email: "alice@octogee.com",
    });
  });
});
