

import { afterAll, describe, expect, it, vi } from "vitest";
import {
  workspaceAdminChannelName,
  workspaceCoachChannelName,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8088";
process.env.FIREBASE_PROJECT_ID ??= "octogee-test";
const originalMmUrl = process.env.MM_URL;
const originalMmAdminToken = process.env.MM_ADMIN_TOKEN;
const originalFetch = globalThis.fetch;
process.env.MM_URL = "http://mattermost.test";
process.env.MM_ADMIN_TOKEN = "test-admin-token";

const adminMod = await import("firebase-admin");
const admin = adminMod.default;
if (admin.apps.length === 0) admin.initializeApp({ projectId: "octogee-test" });
const db = admin.firestore();

const { markProvisioningComplete: markProvisioningCompleteImpl } = await import("../lib/provisionSteps.js");

interface MattermostChannelFixture {
  id: string;
  name: string;
  team_id: string;
  type: "P" | "O";
  delete_at: number;
  members: Set<string>;
}

function mockMattermostActivityPairs(slug: string, mmUpdate: Record<string, unknown>): void {
  const teamId = typeof mmUpdate["mattermost.teamId"] === "string"
    ? mmUpdate["mattermost.teamId"]
    : "";
  const memberIds = [
    mmUpdate["mattermost.userId"],
    mmUpdate["mattermost.coachUserId"],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const plans = [
    {
      id: mmUpdate["mattermost.generalChannelId"],
      name: workspaceGeneralChannelName(slug),
    },
    {
      id: mmUpdate["mattermost.channelId"],
      name: typeof mmUpdate["mattermost.channelName"] === "string"
        ? mmUpdate["mattermost.channelName"]
        : workspaceCoachChannelName(slug),
    },
    {
      id: mmUpdate["mattermost.adminChannelId"],
      name: workspaceAdminChannelName(slug),
    },
  ];
  const channels = new Map<string, MattermostChannelFixture>();
  for (const plan of plans) {
    if (typeof plan.id !== "string" || !plan.id) continue;
    channels.set(plan.id, {
      id: plan.id,
      name: plan.name,
      team_id: teamId,
      type: "P",
      delete_at: 0,
      members: new Set(memberIds),
    });
  }

  const response = (status: number, body: unknown): Response => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const channelRead = /^\/channels\/([^/]+)$/.exec(path);
    if (method === "GET" && channelRead) {
      const channel = channels.get(channelRead[1]);
      return channel
        ? response(200, channel)
        : response(404, { message: `${path} not found` });
    }
    const channelLookup = /^\/teams\/([^/]+)\/channels\/name\/(.+)$/.exec(path);
    if (method === "GET" && channelLookup) {
      const channel = [...channels.values()].find((candidate) =>
        candidate.team_id === channelLookup[1] && candidate.name === channelLookup[2]
      );
      return channel
        ? response(200, channel)
        : response(404, { message: `${path} not found` });
    }
    if (method === "POST" && path === "/channels") {
      if (
        typeof body?.name !== "string"
        || typeof body.team_id !== "string"
        || (body.type !== "P" && body.type !== "O")
      ) {
        return response(400, { message: "invalid channel create" });
      }
      const primary = [...channels.values()].find((candidate) =>
        `${candidate.name}-activity` === body.name
      );
      if (!primary) return response(400, { message: `no primary for ${body.name}` });
      const created: MattermostChannelFixture = {
        id: `${primary.id}-activity`,
        name: body.name,
        team_id: body.team_id,
        type: body.type,
        delete_at: 0,
        members: new Set(),
      };
      channels.set(created.id, created);
      return response(201, created);
    }
    const memberList = /^\/channels\/([^/]+)\/members$/.exec(path);
    if (method === "GET" && memberList) {
      const channel = channels.get(memberList[1]);
      if (!channel) return response(404, { message: `${path} not found` });
      return response(200, [...channel.members].map((userId) => ({ user_id: userId })));
    }
    if (method === "POST" && memberList) {
      const channel = channels.get(memberList[1]);
      if (!channel) return response(404, { message: `${path} not found` });
      if (typeof body?.user_id !== "string") return response(400, { message: "user_id required" });
      channel.members.add(body.user_id);
      return response(201, { user_id: body.user_id, channel_id: channel.id });
    }
    return response(500, { message: `unexpected Mattermost call: ${method} ${path}` });
  }) as typeof fetch;
}

async function markProvisioningComplete(
  ...args: Parameters<typeof markProvisioningCompleteImpl>
): Promise<void> {
  mockMattermostActivityPairs(args[0].slug, args[1] as Record<string, unknown>);
  await markProvisioningCompleteImpl(...args);
}

let seq = 0;
const freshIds = () => {
  seq++;
  const slug = `c1b-${Date.now()}-${seq}`;
  return { uid: `uid-${slug}`, slug };
};

async function seedUser(uid: string, data: Record<string, unknown>) {
  await db.collection("users").doc(uid).set(data);
}

async function readDoc(path: string) {
  const snap = await db.doc(path).get();
  return snap.exists ? snap.data() : null;
}

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalMmUrl === undefined) delete process.env.MM_URL;
  else process.env.MM_URL = originalMmUrl;
  if (originalMmAdminToken === undefined) delete process.env.MM_ADMIN_TOKEN;
  else process.env.MM_ADMIN_TOKEN = originalMmAdminToken;
  await admin.app().delete();
});

const baseCtx = (uid: string, slug: string, tier = "trial") => ({
  uid,
  slug,
  tier,
  ownerName: slug,
  customerDir: `/octogee/customers/${slug}`,
  today: "2026-05-19",
  username: slug,
  templateVars: {},
  userData: { username: slug, email: `${slug}@example.com` },
});

const fullMmUpdate = (slug: string) => ({
  "mattermost.userId": `mm-user-${slug}`,
  "mattermost.username": slug,
  "mattermost.teamId": `mm-team-${slug}`,
  "mattermost.channelId": `mm-coach-dm-${slug}`,
  "mattermost.channelName": `octogee-${slug}-coach`,
  "mattermost.generalChannelId": `mm-general-${slug}`,
  "mattermost.adminChannelId": `mm-admin-${slug}`,
  "mattermost.coachUserId": `mm-coach-${slug}`,
});

describe("markProvisioningComplete — system/config (privilege fields only)", () => {
  it("writes role + updatedAt only — operational/entitlement fields are NOT mirrored here", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(
      baseCtx(uid, slug, "pro"),
      fullMmUpdate(slug),
      [`octogee-${slug}-coach`],
    );

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg).toMatchObject({ role: "user" });
    expect(cfg?.updatedAt).toBeDefined();
    expect(cfg?.provisioning).toBeUndefined();
    expect(cfg?.mattermost).toBeUndefined();
    expect(cfg?.tier).toBeUndefined();
    expect(cfg?.selectedTier).toBeUndefined();
  });

  it("sets trialExpiresAt 7 days out for tier=trial", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });
    const before = Date.now();

    await markProvisioningComplete(baseCtx(uid, slug, "trial"), fullMmUpdate(slug), []);

    const cfg = await readDoc(`users/${uid}/system/config`);
    const expiresAt = cfg?.trialExpiresAt;
    expect(expiresAt).toBeDefined();
    const expiresMs = expiresAt.toDate ? expiresAt.toDate().getTime() : new Date(expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 5_000);
    expect(expiresMs).toBeLessThanOrEqual(before + sevenDaysMs + 5_000);
  });

  it("does NOT set trialExpiresAt for non-trial tiers", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug, "pro"), fullMmUpdate(slug), []);

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg?.trialExpiresAt).toBeUndefined();
  });
});

describe("markProvisioningComplete — top-level user doc (canonical operational fields)", () => {
  it("writes tier but NOT selectedTier — provisioning must not default-mask a later paid subscription.tier", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug, "pro"), fullMmUpdate(slug), []);

    const user = await readDoc(`users/${uid}`);
    expect(user?.tier).toBe("pro");
    expect(user?.selectedTier).toBeUndefined();
  });

  it("preserves orchestrator-set gatewayId — the TEST 2026-04-22 chris-test11 regression", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, {
      username: slug,
      provisioning: {
        openclaw: { gatewayId: "gw-test", status: "provisioning" },
      },
    });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), [
      `octogee-${slug}-coach`,
    ]);

    const user = await readDoc(`users/${uid}`);
    expect(user?.provisioning?.openclaw?.gatewayId).toBe("gw-test");
  });

  it("does NOT mirror provisioning.openclaw.status onto the user doc — TEST 2026-04-27 dual-mount race", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, {
      username: slug,
      provisioning: { openclaw: { status: "provisioning" } },
    });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const user = await readDoc(`users/${uid}`);

expect(user?.provisioning?.openclaw?.status).toBe("provisioning");
  });

  it("mirrors agentIds + customerDir + provisionedAt + slug onto the user doc", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), [
      `octogee-${slug}-coach`,
      "octogee-second-agent",
    ]);

    const user = await readDoc(`users/${uid}`);
    const oc = user?.provisioning?.openclaw;
    expect(oc?.agentIds).toEqual([`octogee-${slug}-coach`, "octogee-second-agent"]);
    expect(oc?.customerDir).toBe(`/octogee/customers/${slug}`);
    expect(oc?.slug).toBe(slug);
    expect(oc?.provisionedAt).toBeDefined();
  });

  it("writes ALL mattermost.* subfields onto the user doc, incl. coachUserId (the milestones fix)", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const user = await readDoc(`users/${uid}`);
    expect(user?.mattermost).toMatchObject({
      userId: `mm-user-${slug}`,
      username: slug,
      teamId: `mm-team-${slug}`,
      channelId: `mm-coach-dm-${slug}`,
      coachUserId: `mm-coach-${slug}`,
    });
  });

  it("writes provisioning.openclaw.greeting onto the user doc when present", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(
      baseCtx(uid, slug),
      {
        ...fullMmUpdate(slug),
        "provisioning.openclaw.greeting": { ok: true, postId: "post-1", at: 1700000000000 },
      },
      [],
    );

    const user = await readDoc(`users/${uid}`);
    expect(user?.provisioning?.openclaw?.greeting).toMatchObject({ ok: true, postId: "post-1" });
  });
});

describe("markProvisioningComplete — workspace doc + channels + members", () => {
  it("creates workspaces/{slug} with ownerUid + mattermost + gitea (merge: true)", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });
    
    await db.doc(`workspaces/${slug}`).set({ vibe: "calm", createdAt: "earlier" });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const ws = await readDoc(`workspaces/${slug}`);
    expect(ws).toMatchObject({
      id: slug,
      ownerUid: uid,
      slug,
      name: slug,
      ownerDisplayName: slug,
      mattermost: { teamId: `mm-team-${slug}` },
      vibe: "calm", // ← survived the merge
      createdAt: "earlier",
    });
    expect(ws?.gitea?.orgName).toBe(slug);
    expect(typeof ws?.gitea?.repoName).toBe("string");
  });

  it("seeds workspaces/{slug}/channels/{general,coach-dm,admin} when their MM ids are present", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const general = await readDoc(`workspaces/${slug}/channels/general`);
    const coachDm = await readDoc(`workspaces/${slug}/channels/coach-dm`);
    const adminCh = await readDoc(`workspaces/${slug}/channels/admin`);

    expect(general).toMatchObject({ id: "general", kind: "general", name: "general", mattermost: { channelId: `mm-general-${slug}` } });
    expect(coachDm).toMatchObject({ id: "coach-dm", kind: "coach-dm", mattermost: { channelId: `mm-coach-dm-${slug}` } });
    expect(adminCh).toMatchObject({ id: "admin", kind: "admin", name: "admin", mattermost: { channelId: `mm-admin-${slug}` } });
  });

  it("persists only supplied channels but rejects completion when required pair primaries are absent", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await expect(markProvisioningComplete(
      baseCtx(uid, slug),
      {
        "mattermost.teamId": `mm-team-${slug}`,
        "mattermost.userId": `mm-user-${slug}`,
        "mattermost.generalChannelId": `mm-general-${slug}`,
        "mattermost.coachUserId": `mm-coach-${slug}`,
      },
      [],
    )).rejects.toThrow(/coach-dm=primary channel is missing.*admin=primary channel is missing/);

    expect(await readDoc(`workspaces/${slug}/channels/general`)).toMatchObject({
      mattermost: {
        channelId: `mm-general-${slug}`,
        activityChannelId: `mm-general-${slug}-activity`,
      },
    });
    expect(await readDoc(`workspaces/${slug}/channels/coach-dm`)).toBeNull();
    expect(await readDoc(`workspaces/${slug}/channels/admin`)).toBeNull();
  });

  it("seeds workspaces/{slug}/members/{uid} as role=owner", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const member = await readDoc(`workspaces/${slug}/members/${uid}`);
    expect(member).toMatchObject({ id: uid, role: "owner" });
    expect(member?.joinedAt).toBeDefined();
  });
});

describe("markProvisioningComplete — agents/{uid} doc", () => {
  it("creates agents/{uid} with name='Octo' + avatarEmoji + coach mattermost userId when present", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const agent = await readDoc(`agents/${uid}`);
    expect(agent).toMatchObject({
      id: uid,
      name: "Octo",
      persona: "",
      avatarEmoji: "🐙",
      mattermost: { userId: `mm-coach-${slug}` },
    });
  });

  it("does NOT create agents/{uid} when mmUpdate has no coachUserId", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await expect(markProvisioningComplete(
      baseCtx(uid, slug),
      {
        "mattermost.teamId": `mm-team-${slug}`,
        "mattermost.userId": `mm-user-${slug}`,
      },
      [],
    )).rejects.toThrow(/general=primary channel is missing.*coach-dm=primary channel is missing.*admin=primary channel is missing/);

    expect(await readDoc(`agents/${uid}`)).toBeNull();
  });
});

describe("markProvisioningComplete — per-user workspaces subcollection", () => {
  it("updates users/{uid}/workspaces/{wsid} when an entry matches workspaceSlug", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });
    await db
      .collection("users")
      .doc(uid)
      .collection("workspaces")
      .doc("ws-existing")
      .set({ workspaceSlug: slug, createdAt: "earlier" });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), [
      `octogee-${slug}-coach`,
    ]);

    const wsEntry = await readDoc(`users/${uid}/workspaces/ws-existing`);
    expect(wsEntry?.provisioning?.openclaw?.agentIds).toEqual([
      `octogee-${slug}-coach`,
    ]);
    expect(wsEntry?.updatedAt).toBeDefined();
    expect(wsEntry?.createdAt).toBe("earlier"); 
  });

  it("does NOT create a stray workspaces subcollection entry when none exists for the slug", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const wsSnap = await db
      .collection("users")
      .doc(uid)
      .collection("workspaces")
      .get();
    expect(wsSnap.empty).toBe(true);
  });
});
