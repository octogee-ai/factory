import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { createRequireAdmin } from "../middleware/auth";

interface FakeStore {
  users: Record<string, { email?: string }>;
  configs: Record<string, { role?: string }>;
}

function buildDb(store: FakeStore) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === "users") {
            const data = store.users[id];
            return { exists: data !== undefined, data: () => data };
          }
          return { exists: false, data: () => undefined };
        },
        collection: (sub: string) => ({
          doc: (subId: string) => ({
            get: async () => {
              if (name === "users" && sub === "system" && subId === "config") {
                const data = store.configs[id];
                return { exists: data !== undefined, data: () => data };
              }
              return { exists: false, data: () => undefined };
            },
          }),
        }),
      }),
    }),
  };
}

function buildApp(opts: {
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  store: FakeStore;
}): Express {
  const app = express();
  app.use(
    createRequireAdmin({
      verifyIdToken: opts.verifyIdToken,
      db: buildDb(opts.store) as any,
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
        configs: { alice: { role: "operator" } },
      },
    });
    const res = await request(app)
      .get("/probe")
      .set("Authorization", "Bearer ok");
    expect(res.status).toBe(403);
  });

  it("returns 500 when Firestore throws on the role lookup", async () => {
    const app = express();
    const failingDb = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw new Error("firestore unreachable");
          },
          collection: () => ({
            doc: () => ({
              get: async () => {
                throw new Error("firestore unreachable");
              },
            }),
          }),
        }),
      }),
    };
    app.use(
      createRequireAdmin({
        verifyIdToken: async () => ({ uid: "alice" }),
        db: failingDb as any,
        log: vi.fn(),
      }),
    );
    app.get("/probe", (_req, res) => {
      res.json({ ok: true });
    });
    // Default Express error handler returns 500 for next(err); the
    // assertion is that we GET 500 rather than the request hanging or
    // surfacing as an unhandled rejection.
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
