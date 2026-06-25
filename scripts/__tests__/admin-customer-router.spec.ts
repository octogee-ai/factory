import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  addAdminCustomerRoutes,
  type AdminCustomerRouterDeps,
} from "../lib/admin-customer-router.js";

type DocData = Record<string, unknown>;
type DocStore = Map<string, DocData>;

function docSnapshot(path: string, data: DocData | undefined) {
  return {
    id: path.split("/").pop() ?? path,
    exists: data !== undefined,
    data: () => data,
  };
}

function collectionDocs(path: string, store: DocStore) {
  const prefix = `${path}/`;
  return [...store.entries()]
    .filter(([docPath]) => {
      if (!docPath.startsWith(prefix)) return false;
      return !docPath.slice(prefix.length).includes("/");
    })
    .map(([docPath, data]) => docSnapshot(docPath, data));
}

function fakeDoc(path: string, store: DocStore) {
  return {
    get: async () => docSnapshot(path, store.get(path)),
    collection: (collectionId: string) => fakeCollection(`${path}/${collectionId}`, store),
  };
}

function fakeCollection(path: string, store: DocStore) {
  const query = {
    doc: (docId: string) => fakeDoc(`${path}/${docId}`, store),
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    startAfter: () => query,
    get: async () => ({ docs: collectionDocs(path, store) }),
  };
  return query;
}

function fakeDb(docs: Record<string, DocData>): Firestore {
  const store = new Map(Object.entries(docs));
  return {
    collection: (path: string) => fakeCollection(path, store),
    doc: (path: string) => fakeDoc(path, store),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((ref) => ref.get())),
  } as unknown as Firestore;
}

function makeApp(docs: Record<string, DocData>) {
  const app = express();
  app.use(express.json());

  const deps: AdminCustomerRouterDeps = {
    db: fakeDb(docs),
    FieldValue: { serverTimestamp: () => new Date("2026-06-01T00:00:00.000Z") },
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: () => [],
    getWorkspaceMmContext: vi.fn().mockResolvedValue(null),
  };

  const router = express.Router();
  addAdminCustomerRoutes(router, deps);
  app.use("/api/admin", router);
  return app;
}

function customerDoc(overrides: DocData = {}): DocData {
  return {
    email: "builder@example.com",
    username: "builder",
    displayName: "Builder",
    subscription: { tier: "hobby", status: "active" },
    usage: {},
    provisioning: { openclaw: { status: "complete", slug: "builder" } },
    ...overrides,
  };
}

describe("GET /api/admin/customer/:uid — model credential state", () => {
  it("returns sanitized modelCredential metadata and keeps byot as an active compatibility alias", async () => {
    const app = makeApp({
      "users/uid-1": customerDoc({ byotActive: false }),
      "users/uid-1/system/config": {
        modelCredential: {
          active: true,
          provider: "anthropic",
          mode: "api_key",
          status: "active",
          reasonCode: "ok",
          secretName: "byok-secret-anthropic",
          keyHash: "deadbeefcafe",
          fingerprint: "sk-ant...7890",
          model: "claude-sonnet-4-6",
          lastUsedAt: new Date("2026-06-02T03:04:05.000Z"),
        },
      },
    });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);

    expect(res.body.modelCredential).toEqual({
      active: true,
      provider: "anthropic",
      mode: "api_key",
      status: "active",
      reasonCode: "ok",
      fingerprint: "sk-ant...7890",
      model: "claude-sonnet-4-6",
      baseUrl: null,
      lastUsedAt: "2026-06-02T03:04:05.000Z",
    });
    expect(res.body.byot).toEqual({ active: true });
    expect(JSON.stringify(res.body.modelCredential)).not.toContain("byok-secret-anthropic");
    expect(JSON.stringify(res.body.modelCredential)).not.toContain("deadbeefcafe");
  });

  it("keeps legacy byot.active when no modelCredential has been written yet", async () => {
    const app = makeApp({
      "users/uid-legacy": customerDoc({ byotActive: true }),
    });

    const res = await request(app).get("/api/admin/customer/uid-legacy").expect(200);

    expect(res.body.modelCredential).toBeNull();
    expect(res.body.byot).toEqual({ active: true });
  });
});
