import request from "supertest";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Characterization spec for the Mattermost token + invite routes. Pins the
// current behaviour (status codes, response shapes, branch selection) so the
// handlers can be decomposed safely. Uses a mocked db + mocked auth/context
// (service-route convention; not the Firestore emulator).

const authState = vi.hoisted(() => ({ uid: "caller-uid", user: {} as Record<string, unknown> }));

const dbState = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  collections: new Map<string, Array<{ id: string; data: Record<string, unknown> }>>(),
  writes: [] as Array<{ op: string; path?: string; collection?: string; data: unknown }>,
  addCounter: 0,
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.uid = authState.uid;
    req.user = authState.user;
    next();
  },
}));

vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: vi.fn(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(dbState.docs) };
});

vi.mock("../lib/db", () => {
  type Pred = (d: Record<string, unknown>) => boolean;
  function makeQuery(coll: string, preds: Pred[]) {
    return {
      where(field: string, op: string, val: unknown) {
        const pred: Pred = (d) => {
          const fv = d[field];
          if (op === "==") return fv === val;
          if (op === "in") return Array.isArray(val) && val.includes(fv);
          return true;
        };
        return makeQuery(coll, [...preds, pred]);
      },
      limit() {
        return makeQuery(coll, preds);
      },
      async get() {
        const rows = (dbState.collections.get(coll) ?? []).filter((r) => preds.every((p) => p(r.data)));
        return { empty: rows.length === 0, docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
      },
    };
  }
  return {
    db: {
      doc: (path: string) => ({
        async get() {
          const d = dbState.docs.get(path);
          return { exists: d !== undefined, data: () => d };
        },
        async set(data: Record<string, unknown>) {
          dbState.docs.set(path, data);
          dbState.writes.push({ op: "set", path, data });
        },
        async update(data: Record<string, unknown>) {
          dbState.docs.set(path, { ...(dbState.docs.get(path) ?? {}), ...data });
          dbState.writes.push({ op: "update", path, data });
        },
      }),
      collection: (name: string) => ({
        where: (f: string, o: string, v: unknown) => makeQuery(name, []).where(f, o, v),
        async add(data: Record<string, unknown>) {
          const id = `gen-${++dbState.addCounter}`;
          const arr = dbState.collections.get(name) ?? [];
          arr.push({ id, data });
          dbState.collections.set(name, arr);
          dbState.writes.push({ op: "add", collection: name, data });
          return { id };
        },
      }),
    },
    FieldValue: { serverTimestamp: () => "SERVER_TS", increment: (n: number) => ({ __increment: n }) },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  };
});

import router from "../routes/mattermost.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";

const ctxMock = vi.mocked(getWorkspaceMmContext);

const app = express();
app.use(express.json());
app.use("/api/mattermost", router);

beforeEach(() => {
  dbState.docs.clear();
  dbState.collections.clear();
  dbState.writes.length = 0;
  dbState.addCounter = 0;
  authState.uid = "caller-uid";
  authState.user = {};
  ctxMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("GET /token", () => {
  it("202 provisioning when the MM context has no userId/dmChannelId", async () => {
    ctxMock.mockResolvedValue({ userId: undefined, coachDmChannelId: undefined } as never);
    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("provisioning");
  });

  it("202 provisioning when the personalToken secret is absent", async () => {
    ctxMock.mockResolvedValue({ userId: "mm-1", coachDmChannelId: "dm-1" } as never);
    // no users/<uid>/secrets/mattermost doc
    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(202);
  });

  it("200 with the connection payload + validated gatewayId when fully provisioned", async () => {
    authState.user = {
      onboarding: { coachName: "Octo" },
      provisioning: { openclaw: { gatewayId: "christopher" } },
    };
    ctxMock.mockResolvedValue({
      userId: "mm-1",
      coachDmChannelId: "dm-1",
      coachUserId: "coach-1",
    } as never);
    dbState.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "tok-xyz" });

    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mmUserId: "mm-1",
      dmChannelId: "dm-1",
      gatewayId: "christopher",
      coachMmUserId: "coach-1",
      coachName: "Octo",
    });
  });

  it("blanks an invalid gatewayId rather than echoing it", async () => {
    authState.user = { provisioning: { openclaw: { gatewayId: "Bad GW!" } } };
    ctxMock.mockResolvedValue({ userId: "mm-1", coachDmChannelId: "dm-1" } as never);
    dbState.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "tok" });

    const res = await request(app).get("/api/mattermost/token");
    expect(res.body.gatewayId).toBe("");
  });
});

describe("POST /invite", () => {
  beforeEach(() => {
    authState.user = { mattermost: { userId: "mm-caller" }, firstName: "Cam" };
    ctxMock.mockResolvedValue({ coachDmChannelId: "chan-1" } as never);
  });

  it("400 when channelId or email is missing", async () => {
    const res = await request(app).post("/api/mattermost/invite").send({ channelId: "chan-1" });
    expect(res.status).toBe(400);
  });

  it("403 when the caller has no chat access", async () => {
    authState.user = {};
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "chan-1", email: "a@b.com" });
    expect(res.status).toBe(403);
  });

  it("403 when inviting to a channel that isn't the caller's", async () => {
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "other-chan", email: "a@b.com" });
    expect(res.status).toBe(403);
  });

  it("404 when no Octogee user has that email", async () => {
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "chan-1", email: "nobody@b.com" });
    expect(res.status).toBe(404);
  });

  it("400 when the invitee's workspace isn't set up", async () => {
    dbState.collections.set("users", [{ id: "invitee-1", data: { email: "a@b.com", firstName: "Ada" } }]);
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "chan-1", email: "A@B.com" });
    expect(res.status).toBe(400);
  });

  it("returns the existing message when a completed invite already exists", async () => {
    dbState.collections.set("users", [
      { id: "invitee-1", data: { email: "a@b.com", firstName: "Ada" } },
    ]);
    dbState.docs.set("users/invitee-1", { mattermost: { userId: "mm-i" } });
    dbState.collections.set("invites", [
      { id: "inv-old", data: { channelId: "chan-1", inviteeUid: "invitee-1", status: "completed" } },
    ]);
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "chan-1", email: "a@b.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already in this channel/);
  });

  it("creates a pending invite + returns its id on success", async () => {
    dbState.collections.set("users", [
      { id: "invitee-1", data: { email: "a@b.com", firstName: "Ada" } },
    ]);
    dbState.docs.set("users/invitee-1", { mattermost: { userId: "mm-i" } });
    const res = await request(app)
      .post("/api/mattermost/invite")
      .send({ channelId: "chan-1", email: "a@b.com" });
    expect(res.status).toBe(200);
    expect(res.body.inviteId).toBe("gen-1");
    expect(dbState.writes.find((w) => w.op === "add" && w.collection === "invites")).toBeTruthy();
  });
});

describe("GET /invite-status", () => {
  it("400 without inviteId", async () => {
    const res = await request(app).get("/api/mattermost/invite-status");
    expect(res.status).toBe(400);
  });

  it("404 when the invite is missing", async () => {
    const res = await request(app).get("/api/mattermost/invite-status?inviteId=nope");
    expect(res.status).toBe(404);
  });

  it("maps completed/failed/pending to their messages", async () => {
    dbState.docs.set("invites/c", { status: "completed", inviteeFirstName: "Ada" });
    dbState.docs.set("invites/f", { status: "failed", error: "boom" });
    dbState.docs.set("invites/p", { status: "pending" });

    const c = await request(app).get("/api/mattermost/invite-status?inviteId=c");
    expect(c.body).toMatchObject({ status: "completed", message: "Ada has been added!" });
    const f = await request(app).get("/api/mattermost/invite-status?inviteId=f");
    expect(f.body).toMatchObject({ status: "failed", message: "boom" });
    const p = await request(app).get("/api/mattermost/invite-status?inviteId=p");
    expect(p.body).toMatchObject({ status: "pending", message: "Processing..." });
  });
});

describe("POST /invite-link", () => {
  beforeEach(() => {
    authState.user = { mattermost: { userId: "mm-caller" } };
    ctxMock.mockResolvedValue({ coachDmChannelId: "chan-1", generalChannelId: "gen-1" } as never);
  });

  it("400 without channelId", async () => {
    const res = await request(app).post("/api/mattermost/invite-link").send({});
    expect(res.status).toBe(400);
  });

  it("403 when the caller has no chat access", async () => {
    authState.user = {};
    const res = await request(app).post("/api/mattermost/invite-link").send({ channelId: "chan-1" });
    expect(res.status).toBe(403);
  });

  it("403 for a channel the caller doesn't own", async () => {
    const res = await request(app).post("/api/mattermost/invite-link").send({ channelId: "stranger" });
    expect(res.status).toBe(403);
  });

  it("mints a link doc + returns url/token/expiresAt, defaulting to 72h", async () => {
    const res = await request(app).post("/api/mattermost/invite-link").send({ channelId: "gen-1" });
    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).toContain(`/invite/${res.body.token}`);
    const write = dbState.writes.find((w) => w.op === "set" && w.path?.startsWith("channelInvites/"));
    expect(write).toBeTruthy();
    // 72h default → ~3 days out
    const ms = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ms).toBeGreaterThan(71 * 3600_000);
    expect(ms).toBeLessThan(73 * 3600_000);
  });
});

describe("POST /accept-invite-link", () => {
  beforeEach(() => {
    authState.user = { mattermost: { userId: "mm-joiner" }, email: "j@b.com", firstName: "Jo" };
  });

  const future = () => ({ toDate: () => new Date(Date.now() + 3600_000) });
  const past = () => ({ toDate: () => new Date(Date.now() - 3600_000) });

  it("400 without token", async () => {
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({});
    expect(res.status).toBe(400);
  });

  it("404 when the link doesn't exist", async () => {
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "nope" });
    expect(res.status).toBe(404);
  });

  it("410 when the link is expired", async () => {
    dbState.docs.set("channelInvites/t", { channelId: "chan-1", expiresAt: past(), maxUses: 0, uses: 0 });
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "t" });
    expect(res.status).toBe(410);
  });

  it("410 when the link is over its usage limit", async () => {
    dbState.docs.set("channelInvites/t", { channelId: "chan-1", expiresAt: future(), maxUses: 2, uses: 2 });
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "t" });
    expect(res.status).toBe(410);
  });

  it("400 when the caller hasn't completed onboarding", async () => {
    authState.user = {};
    dbState.docs.set("channelInvites/t", { channelId: "chan-1", expiresAt: future(), maxUses: 0, uses: 0 });
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "t" });
    expect(res.status).toBe(400);
  });

  it("creates the invite + increments uses on success", async () => {
    dbState.docs.set("channelInvites/t", { channelId: "chan-1", expiresAt: future(), maxUses: 0, uses: 0 });
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "t" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inviteId: "gen-1", channelId: "chan-1", message: "Joining channel..." });
    expect(dbState.writes.find((w) => w.op === "add" && w.collection === "invites")).toBeTruthy();
    expect(dbState.writes.find((w) => w.op === "update" && w.path === "channelInvites/t")).toBeTruthy();
  });

  it("returns the existing invite instead of duplicating it", async () => {
    dbState.docs.set("channelInvites/t", { channelId: "chan-1", expiresAt: future(), maxUses: 0, uses: 0 });
    dbState.collections.set("invites", [
      { id: "inv-x", data: { channelId: "chan-1", inviteeUid: "caller-uid", status: "pending" } },
    ]);
    const res = await request(app).post("/api/mattermost/accept-invite-link").send({ token: "t" });
    expect(res.status).toBe(200);
    expect(res.body.inviteId).toBe("inv-x");
    expect(dbState.writes.find((w) => w.op === "add")).toBeFalsy();
  });
});
