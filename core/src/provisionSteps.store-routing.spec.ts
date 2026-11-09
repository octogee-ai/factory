import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const docRef = (path: string): Record<string, unknown> => ({
    set: async (data: Record<string, unknown>) => {
      writes.push({ path, data });
    },
    update: async (data: Record<string, unknown>) => {
      writes.push({ path, data });
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  });
  const collectionRef = (path: string): Record<string, unknown> => ({
    doc: (id: string) => docRef(`${path}/${id}`),
    where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
  });
  const write = () => vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
  const records = {
    get: vi.fn(async () => ({ role: "user" })),
    patch: write(),
    addAgents: write(),
    setActivatedAgents: write(),
  };
  const workspaces = {
    records: { put: write() },
    channels: { put: write() },
    members: { put: write() },
    agentIdentities: { put: write() },
  };
  const store = {
    builders: { records },
    workspaces,
    transaction: (_options: unknown, body: (transaction: unknown) => Promise<unknown>) => body(store),
  };
  return { writes, records, workspaces, store, db: { collection: collectionRef, doc: docRef } };
});

vi.mock("./firebase.js", () => ({ db: h.db, platformStateStore: h.store }));

import { buildProvisioningContext, markProvisioningComplete } from "./provisionSteps.js";

const SERVER_NOW = { serverNow: true };
const ctx = buildProvisioningContext("u1", { username: "acme", tier: "pro" });
const mmUpdate = {
  "mattermost.userId": "mm-builder",
  "mattermost.username": "acme",
  "mattermost.teamId": "mm-team",
  "mattermost.channelId": "mm-coach-dm",
  "mattermost.channelName": "octogee-acme-coach",
  "mattermost.generalChannelId": "mm-general",
  "mattermost.coachUserId": "mm-coach",
};

function firestoreWrite(path: string): Record<string, unknown> | undefined {
  return h.writes.find((write) => write.path === path)?.data;
}

describe("markProvisioningComplete store routing", () => {
  beforeEach(() => {
    h.writes.length = 0;
    vi.clearAllMocks();
  });

  it("records the Builder's platform provisioning state through the store", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach", "octogee-second"]);

    expect(h.records.patch).toHaveBeenCalledWith("u1", {
      slug: "acme",
      workspaceId: "acme",
      mattermostUserId: "mm-builder",
      openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: SERVER_NOW },
    });
    expect(h.records.addAgents).toHaveBeenCalledWith("u1", ["octogee-acme-coach", "octogee-second"]);
    expect(h.records.setActivatedAgents).toHaveBeenCalledWith("u1", ["coach"]);
  });

  it("keeps only product fields on the Firestore user document", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach"]);

    expect(firestoreWrite("users/u1")).toEqual({
      tier: "pro",
      "mattermost.username": "acme",
      "mattermost.teamId": "mm-team",
      "mattermost.channelId": "mm-coach-dm",
      "mattermost.channelName": "octogee-acme-coach",
      "mattermost.generalChannelId": "mm-general",
      "mattermost.coachUserId": "mm-coach",
    });
  });

  it("records the workspace and owner through the store, leaving Firestore the display names", async () => {
    await markProvisioningComplete(ctx, mmUpdate, []);

    expect(h.workspaces.records.put).toHaveBeenCalledWith({
      slug: "acme",
      id: "acme",
      ownerUid: "u1",
      ownerActive: null,
      mattermostTeamId: "mm-team",
      giteaOrgName: "acme",
      giteaRepoName: expect.any(String),
      createdAt: null,
      updatedAt: SERVER_NOW,
    });
    expect(firestoreWrite("workspaces/acme")).toEqual({ name: "acme", ownerDisplayName: "acme" });
    expect(h.workspaces.members.put).toHaveBeenCalledWith({
      workspaceSlug: "acme",
      uid: "u1",
      role: "owner",
      joinedAt: SERVER_NOW,
      mattermostUserId: null,
    });
    expect(firestoreWrite("workspaces/acme/members/u1")).toBeUndefined();
  });

  it("does not clear a workspace's team when the update carries none", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, []);

    expect(h.workspaces.records.put).toHaveBeenCalledWith(expect.objectContaining({ mattermostTeamId: null }));
  });

  it("seeds each primary channel through the store, leaving Firestore its name", async () => {
    await markProvisioningComplete(ctx, mmUpdate, []);

    const scope = { workspaceSlug: "acme", projectSlug: null };
    const channel = { scope, archivedAt: null, createdBy: null, createdAt: SERVER_NOW };
    expect(h.workspaces.channels.put).toHaveBeenCalledWith({
      ...channel,
      channelId: "general",
      kind: "general",
      mattermostChannelId: "mm-general",
    });
    expect(h.workspaces.channels.put).toHaveBeenCalledWith({
      ...channel,
      channelId: "coach-dm",
      kind: "coach-dm",
      mattermostChannelId: "mm-coach-dm",
    });
    expect(firestoreWrite("workspaces/acme/channels/general")).toEqual({ name: "general" });
    expect(firestoreWrite("workspaces/acme/channels/coach-dm")).toEqual({ name: "octogee-acme-coach" });
  });

  it("seeds only the channels the update carries", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, []);

    expect(h.workspaces.channels.put).toHaveBeenCalledTimes(1);
    expect(h.workspaces.channels.put).toHaveBeenCalledWith(expect.objectContaining({ channelId: "general" }));
    expect(firestoreWrite("workspaces/acme/channels/coach-dm")).toBeUndefined();
  });

  it("records the coach's identity through the store, leaving Firestore its presentation", async () => {
    await markProvisioningComplete(ctx, mmUpdate, []);

    expect(h.workspaces.agentIdentities.put).toHaveBeenCalledWith({
      uid: "u1",
      mattermostUserId: "mm-coach",
      at: SERVER_NOW,
    });
    const presentation = firestoreWrite("agents/u1");
    expect(presentation).toMatchObject({
      name: "Octo",
      persona: "",
      avatarEmoji: "🐙",
      look: { style: "octo", color: "#e74e3c" },
    });
    expect(presentation).not.toHaveProperty("mattermost");
  });

  it("writes no coach identity when the update has no coach user", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, []);

    expect(h.workspaces.agentIdentities.put).not.toHaveBeenCalled();
    expect(firestoreWrite("agents/u1")).toBeUndefined();
  });
});
