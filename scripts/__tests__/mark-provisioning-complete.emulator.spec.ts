

import { afterAll, describe, expect, it } from "vitest";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8088";
process.env.FIREBASE_PROJECT_ID ??= "octogee-test";

const { deleteApp, getApps, initializeApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");
if (getApps().length === 0) initializeApp({ projectId: "octogee-test" });
const db = getFirestore();

const { markProvisioningComplete: markProvisioningCompleteImpl } = await import("../lib/provisionSteps.js");

async function markProvisioningComplete(
  ...args: Parameters<typeof markProvisioningCompleteImpl>
): Promise<void> {
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
  await Promise.all(getApps().map(deleteApp));
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

  it("preserves an admin role granted before late provisioning completes", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });
    await db.doc(`users/${uid}/system/config`).set({ role: "admin" });

    await markProvisioningComplete(
      baseCtx(uid, slug, "pro"),
      fullMmUpdate(slug),
      [`octogee-${slug}-coach`],
    );

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg).toMatchObject({ role: "admin" });
    expect(cfg?.updatedAt).toBeDefined();
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

  it("seeds workspaces/{slug}/channels/{general,coach-dm} without an Admin channel", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const general = await readDoc(`workspaces/${slug}/channels/general`);
    const coachDm = await readDoc(`workspaces/${slug}/channels/coach-dm`);

    expect(general).toMatchObject({ id: "general", kind: "general", name: "general", mattermost: { channelId: `mm-general-${slug}` } });
    expect(coachDm).toMatchObject({ id: "coach-dm", kind: "coach-dm", mattermost: { channelId: `mm-coach-dm-${slug}` } });
    expect(await readDoc(`workspaces/${slug}/channels/admin`)).toBeNull();
  });

  it("persists only supplied primary channels when the coach channel is absent", async () => {
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
    )).resolves.toBeUndefined();

    expect(await readDoc(`workspaces/${slug}/channels/general`)).toMatchObject({
      mattermost: {
        channelId: `mm-general-${slug}`,
      },
    });
    expect(await readDoc(`workspaces/${slug}/channels/coach-dm`)).toBeNull();
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
    )).resolves.toBeUndefined();

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
