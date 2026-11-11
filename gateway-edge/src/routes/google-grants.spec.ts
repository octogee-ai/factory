import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { platformStateStore } from "../lib/platform-state.js";
import { createGoogleGrantRoutes } from "./google-grants.js";

const documents = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(documents) };
});

function harness() {
  const stamp = { seconds: 1, nanoseconds: 0 };
  for (const path of Object.keys(documents)) delete documents[path];
  Object.assign(documents, {
    "users/owner": { username: "space" },
    "users/member": { username: "collaborator" },
    "workspaces/space": { id: "space", ownerUid: "owner", ownerActive: true },
    "workspaces/space/members/member": {
      role: "member",
      canonicalSource: "mattermost-general",
      canonicalState: "active",
      mattermostChannelId: "general",
      mattermostUserId: "mm-member",
    },
    "workspaces/space/channels/general": {
      mattermost: { channelId: "general" },
    },
    "workspaces/space/channels/coach-dm": {
      mattermost: { channelId: "private" },
    },
    "workspaces/space/channels/old": {
      status: "archived",
      mattermost: { channelId: "old" },
    },
    "users/owner/integrations/google": {
      status: "connected",
      connectedAt: stamp,
      pickedFiles: [],
    },
  });
  const snapshot = (path: string) => ({
    id: path.split("/").at(-1)!,
    exists: !!documents[path],
    createTime: stamp,
    data: () => documents[path],
  });
  const db = {
    doc: (path: string) => ({ path, get: async () => snapshot(path) }),
    collection: (path: string) => {
      const query = {
        limit: () => query,
        get: async () => {
          const docs = Object.keys(documents)
            .filter(
              (key) =>
                key.startsWith(`${path}/`) &&
                !key.slice(path.length + 1).includes("/"),
            )
            .map(snapshot);
          return { docs, size: docs.length };
        },
      };
      return query;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, value: Record<string, unknown>) => {
          documents[ref.path] = value;
        },
      }),
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = req.get("x-user") ?? "owner";
    next();
  });
  app.use(createGoogleGrantRoutes(db as never));
  const permission = {
    operation: "/google/drive/read",
    resourceIds: ["file-a"],
  };
  return { app, documents, permission };
}

describe("owner-managed Google grants", () => {
  it("saves an explicit scoped grant with owner and lifecycle bindings", async () => {
    const h = harness();
    expect(
      (
        await request(h.app)
          .post("/member")
          .send({ permissions: [h.permission] })
      ).status,
    ).toBe(200);
    expect(h.documents["users/owner/googleGrants/member"]).toMatchObject({
      ownerUid: "owner",
      memberUid: "member",
      state: "active",
      connectionEpoch: "1:0",
      membershipEpoch: "1:0",
      permissions: [h.permission],
    });
  });
  it("allows revocation after disconnect and membership removal", async () => {
    const h = harness();
    await request(h.app)
      .post("/member")
      .send({ permissions: [h.permission] });
    delete h.documents["workspaces/space/members/member"];
    h.documents["users/owner/integrations/google"].status = "disconnected";
    expect(
      (await request(h.app).post("/member").send({ permissions: [] })).status,
    ).toBe(200);
    expect(h.documents["users/owner/googleGrants/member"].state).toBe(
      "revoked",
    );
  });
  it.each(["private", "old", "foreign"])(
    "rejects obsolete channel-scoped permissions: %s",
    async (channel) => {
      const h = harness();
      expect(
        (
          await request(h.app)
            .post("/member")
            .send({ permissions: [{ ...h.permission, channelIds: [channel] }] })
        ).status,
      ).toBe(400);
    },
  );
  it("denies a grant when the store holds a revoking member, even though the product document reads active", async () => {
    const h = harness();
    const member = await platformStateStore.workspaces.members.get("space", "member");
    const get = vi.spyOn(platformStateStore.workspaces.members, "get")
      .mockResolvedValueOnce({ ...member!, canonicalState: "revoking" });

    const response = await request(h.app).post("/member").send({ permissions: [h.permission] });

    expect(response.status).not.toBe(200);
    expect(h.documents["users/owner/googleGrants/member"]).toBeUndefined();
    get.mockRestore();
  });
  it("denies a grant when the store shows the owner suspended, even though the product document reads active", async () => {
    const h = harness();
    const owner = await platformStateStore.users.records.get("owner");
    const get = vi.spyOn(platformStateStore.users.records, "get")
      .mockResolvedValue({ ...owner!, accountLifecycle: { status: "suspended" } as never });

    const response = await request(h.app).post("/member").send({ permissions: [h.permission] });

    expect(response.status).toBe(403);
    expect(h.documents["users/owner/googleGrants/member"]).toBeUndefined();
    get.mockRestore();
  });
  it("does not allow a collaborator to approve access to the owner connection", async () => {
    const h = harness();
    expect(
      (
        await request(h.app)
          .post("/owner")
          .set("x-user", "member")
          .send({ permissions: [h.permission] })
      ).status,
    ).toBe(403);
    expect(h.documents["users/owner/googleGrants/member"]).toBeUndefined();
  });
  it("lists recognizable member names without channel-specific grant controls", async () => {
    const h = harness();
    const response = await request(h.app).get("/");
    expect(response.status).toBe(200);
    expect(response.body.members).toEqual([
      { uid: "member", name: "collaborator" },
    ]);
    expect(response.body.channels).toBeUndefined();
  });
  it("reports old grants as inactive after connection changes", async () => {
    const h = harness();
    await request(h.app)
      .post("/member")
      .send({ permissions: [h.permission] });
    h.documents["users/owner/integrations/google"].connectedAt = {
      seconds: 2,
      nanoseconds: 0,
    };
    const response = await request(h.app).get("/");
    expect(response.body.grants[0].state).toBe("inactive");
  });
});
