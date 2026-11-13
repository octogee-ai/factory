import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const stored = new Map<string, Record<string, unknown>>();
  const workspaceEntries: Array<{ ref: { update: (data: Record<string, unknown>) => Promise<void> } }> = [];
  const docRef = (path: string): Record<string, unknown> => ({
    get: async () => ({ data: () => stored.get(path) }),
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
    where: () => ({
      limit: () => ({ get: async () => ({ empty: workspaceEntries.length === 0, docs: workspaceEntries }) }),
    }),
  });
  const write = () => vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
  const records = {
    get: vi.fn(async () => ({ role: "user" })),
    patch: write(),
    addAgents: write(),
    setActivatedAgents: write(),
  };
  const workspaces = {
    records: { get: vi.fn(async (): Promise<unknown> => null), put: write(), patch: write() },
    channels: { get: vi.fn(async (): Promise<unknown> => null), put: write(), patch: write() },
    members: { get: vi.fn(async (): Promise<unknown> => null), put: write() },
    agentIdentities: { put: write() },
  };
  const store = {
    users: { records },
    workspaces,
    transaction: (_options: unknown, body: (transaction: unknown) => Promise<unknown>) => body(store),
  };
  return { writes, stored, workspaceEntries, records, workspaces, store, db: { collection: collectionRef, doc: docRef } };
});

vi.mock("./firebase.js", () => ({ db: h.db, platformStateStore: h.store }));

import {
  buildProvisioningContext,
  firestoreProvisioningProjection,
  markProvisioningComplete,
  noProvisioningProjection,
} from "./provisionSteps.js";

const SERVER_NOW = { serverNow: true };
const ctx = buildProvisioningContext("u1", { username: "acme", tier: "pro" });
const mmUpdate = {
  "mattermost.userId": "mm-user",
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
    h.workspaceEntries.length = 0;
    vi.clearAllMocks();
  });

  it("records the user's platform provisioning state through the store", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach", "octogee-second"], firestoreProvisioningProjection);

    expect(h.records.patch).toHaveBeenCalledWith("u1", {
      slug: "acme",
      workspaceId: "acme",
      mattermostUserId: "mm-user",
      openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: SERVER_NOW },
    });
    expect(h.records.addAgents).toHaveBeenCalledWith("u1", ["octogee-acme-coach", "octogee-second"]);
    expect(h.records.setActivatedAgents).toHaveBeenCalledWith("u1", ["coach"]);
  });

  it("records the same platform state and writes nothing to Firestore without a projection", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach"], noProvisioningProjection);

    expect(h.writes).toEqual([]);
    expect(h.records.patch).toHaveBeenCalledWith("u1", expect.objectContaining({ slug: "acme", mattermostUserId: "mm-user" }));
    expect(h.records.addAgents).toHaveBeenCalledWith("u1", ["octogee-acme-coach"]);
    expect(h.workspaces.records.put).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme", mattermostTeamId: "mm-team" }));
    expect(h.workspaces.channels.put).toHaveBeenCalledTimes(2);
    expect(h.workspaces.members.put).toHaveBeenCalledWith(expect.objectContaining({ uid: "u1", role: "owner" }));
    expect(h.workspaces.agentIdentities.put).toHaveBeenCalledWith(expect.objectContaining({ uid: "u1", mattermostUserId: "mm-coach" }));
  });

  it("marks the user's workspace entry complete", async () => {
    const update = vi.fn(async (_data: Record<string, unknown>): Promise<void> => undefined);
    h.workspaceEntries.push({ ref: { update } });

    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ "provisioning.openclaw.status": "complete" }));
  });

  it("records the workspace and owner through the store, leaving Firestore the display names", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

    expect(h.workspaces.records.put).toHaveBeenCalledWith({
      slug: "acme",
      id: "acme",
      ownerUid: "u1",
      ownerActive: null,
      mattermostTeamId: "mm-team",
      giteaOrgName: "acme",
      giteaRepoName: expect.any(String),
      createdAt: SERVER_NOW,
      updatedAt: SERVER_NOW,
    });
    expect(firestoreWrite("workspaces/acme")).toMatchObject({ name: "acme", ownerDisplayName: "acme" });
    expect(firestoreWrite("workspaces/acme")).not.toHaveProperty("ownerUid");
    expect(h.workspaces.members.put).toHaveBeenCalledWith({
      workspaceSlug: "acme",
      uid: "u1",
      role: "owner",
      joinedAt: SERVER_NOW,
      mattermostUserId: "mm-user",
    });
    expect(firestoreWrite("workspaces/acme/members/u1")).toBeUndefined();
  });

  it("does not clear a workspace's team when the update carries none", async () => {
    h.workspaces.records.get.mockResolvedValueOnce({ slug: "acme", mattermostTeamId: "mm-existing" });

    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], firestoreProvisioningProjection);

    expect(h.workspaces.records.put).not.toHaveBeenCalled();
    expect(h.workspaces.records.patch).toHaveBeenCalledTimes(1);
    expect(h.workspaces.records.patch.mock.calls[0]?.[1]).not.toHaveProperty("mattermostTeamId");
  });

  it("replaces a workspace's team when the update carries one", async () => {
    h.workspaces.records.get.mockResolvedValueOnce({ slug: "acme", mattermostTeamId: "mm-existing" });

    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

    expect(h.workspaces.records.patch).toHaveBeenCalledWith("acme", expect.objectContaining({ mattermostTeamId: "mm-team" }));
  });

  it("seeds each primary channel through the store, leaving Firestore its name", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

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
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], firestoreProvisioningProjection);

    expect(h.workspaces.channels.put).toHaveBeenCalledTimes(1);
    expect(h.workspaces.channels.put).toHaveBeenCalledWith(expect.objectContaining({ channelId: "general" }));
    expect(firestoreWrite("workspaces/acme/channels/coach-dm")).toBeUndefined();
  });

  it("keeps an existing channel's creation record and updates only its Mattermost channel", async () => {
    h.workspaces.channels.get.mockResolvedValueOnce({ channelId: "general" });

    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], firestoreProvisioningProjection);

    expect(h.workspaces.channels.put).not.toHaveBeenCalled();
    expect(h.workspaces.channels.patch).toHaveBeenCalledWith(
      { workspaceSlug: "acme", projectSlug: null },
      "general",
      { mattermostChannelId: "mm-general" },
    );
  });

  it("leaves an existing owner membership alone", async () => {
    h.workspaces.members.get.mockResolvedValueOnce({ uid: "u1", role: "owner" });

    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

    expect(h.workspaces.members.put).not.toHaveBeenCalled();
  });

  it("records the agent's identity through the store, leaving Firestore its presentation", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], firestoreProvisioningProjection);

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

  it("writes no agent identity when the update has no agent user", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], firestoreProvisioningProjection);

    expect(h.workspaces.agentIdentities.put).not.toHaveBeenCalled();
    expect(firestoreWrite("agents/u1")).toBeUndefined();
  });
});

describe("stored Mattermost names", () => {
  beforeEach(() => {
    h.stored.clear();
  });

  it("reads the product's username and agent channel name from Firestore", async () => {
    h.stored.set("users/u1", { mattermost: { username: "legacy-name" } });
    h.stored.set("workspaces/acme/channels/coach-dm", { name: "acme-coach" });

    await expect(firestoreProvisioningProjection.storedMattermostNames("u1", "acme"))
      .resolves.toEqual({ username: "legacy-name", coachChannelName: "acme-coach" });
    await expect(firestoreProvisioningProjection.storedMattermostNames("u2", "other"))
      .resolves.toEqual({ username: null, coachChannelName: null });
  });

  it("has no stored names without a product projection", async () => {
    h.stored.set("users/u1", { mattermost: { username: "legacy-name" } });

    await expect(noProvisioningProjection.storedMattermostNames("u1", "acme"))
      .resolves.toEqual({ username: null, coachChannelName: null });
  });
});
