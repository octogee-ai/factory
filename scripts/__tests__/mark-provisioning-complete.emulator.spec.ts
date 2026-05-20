// C1b — emulator-backed integration net for markProvisioningComplete.
// Same playbook as customer-lifecycle-prod-adapter.emulator.spec (B1b):
// real firebase-admin against the real Firestore emulator. Pins the
// cascading writes — system/config snapshot, user-doc mirror (per-
// dot-path so orchestrator-set fields like gatewayId survive), the
// workspace doc + channels + members subcollections, the agents/{uid}
// doc, and the per-user workspaces subcollection update.
//
// Excluded from the default `npm test`; run via `npm run test:emulator`
// (firebase emulators:exec) — same CI job introduced for B1b.
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8088";
process.env.FIREBASE_PROJECT_ID ??= "octogee-test";

// Bring up the admin app BEFORE provisionSteps.ts is imported — its
// transitive `./firebase.js` does `if (!getApps().length) initializeApp(...)`,
// so claiming the default app here makes the emulator routing stick and
// avoids the SA_KEY_PATH branch in test env.
const adminMod = await import("firebase-admin");
const admin = adminMod.default;
if (admin.apps.length === 0) admin.initializeApp({ projectId: "octogee-test" });
const db = admin.firestore();

// Activity-pair persistence makes real MM API calls inside markProvisioning-
// Complete when teamId + customerMmUserId + coachMmUserId are all present.
// Stub it at the boundary so the emulator net stays focused on the
// Firestore cascade. The unit suite already covers the activity-pair shape
// in provisionWorkspaceActivityPairs.spec.ts.
vi.mock("../lib/mattermost/provisionWorkspaceActivityPairs.js", () => ({
  persistWorkspaceChannelsWithActivityPairs: vi
    .fn()
    .mockResolvedValue({ successes: [], failures: [] }),
  provisionWorkspaceActivityPair: vi.fn(),
}));

const { markProvisioningComplete } = await import("../lib/provisionSteps.js");

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

describe("markProvisioningComplete — system/config snapshot", () => {
  it("writes role / approved / tier / selectedTier and the provisioning.openclaw object", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(
      baseCtx(uid, slug, "pro"),
      fullMmUpdate(slug),
      [`octogee-${slug}-coach`],
    );

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg).toMatchObject({
      role: "user",
      approved: true,
      tier: "pro",
      selectedTier: "pro",
      provisioning: {
        openclaw: {
          status: "complete",
          version: "v1",
          slug,
          agentIds: [`octogee-${slug}-coach`],
          activatedAgents: ["coach"],
          customerDir: `/octogee/customers/${slug}`,
        },
      },
    });
    expect(cfg?.provisioning.openclaw.provisionedAt).toBeDefined();
    expect(cfg?.updatedAt).toBeDefined();
  });

  it("flattens mattermost.* update keys onto system/config (drops the prefix)", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg?.mattermost).toMatchObject({
      userId: `mm-user-${slug}`,
      teamId: `mm-team-${slug}`,
      channelId: `mm-coach-dm-${slug}`,
      generalChannelId: `mm-general-${slug}`,
      adminChannelId: `mm-admin-${slug}`,
      coachUserId: `mm-coach-${slug}`,
    });
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

  it("mirrors provisioning.openclaw.greeting from mmUpdate onto system/config", async () => {
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

    const cfg = await readDoc(`users/${uid}/system/config`);
    expect(cfg?.provisioning.openclaw.greeting).toMatchObject({ ok: true, postId: "post-1" });
  });
});

describe("markProvisioningComplete — user-doc mirror (per-dot-path writes)", () => {
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
    // status stays "provisioning" — the orchestrator's later
    // setProvisioningStatus("complete") owns the racing-on signal flip.
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

  it("mirrors mattermost.userId + mattermost.username onto the user doc when present", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    await markProvisioningComplete(baseCtx(uid, slug), fullMmUpdate(slug), []);

    const user = await readDoc(`users/${uid}`);
    expect(user?.mattermost?.userId).toBe(`mm-user-${slug}`);
    expect(user?.mattermost?.username).toBe(slug);
  });
});

describe("markProvisioningComplete — workspace doc + channels + members", () => {
  it("creates workspaces/{slug} with ownerUid + mattermost + gitea (merge: true)", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });
    // Pre-existing field that onboarding wrote — must survive the merge.
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

  it("skips per-channel writes when the corresponding mattermost id is absent (partial mmUpdate)", async () => {
    const { uid, slug } = freshIds();
    await seedUser(uid, { username: slug });

    // Only general — no coach-dm, no admin.
    await markProvisioningComplete(
      baseCtx(uid, slug),
      {
        "mattermost.teamId": `mm-team-${slug}`,
        "mattermost.userId": `mm-user-${slug}`,
        "mattermost.generalChannelId": `mm-general-${slug}`,
        "mattermost.coachUserId": `mm-coach-${slug}`,
      },
      [],
    );

    expect(await readDoc(`workspaces/${slug}/channels/general`)).not.toBeNull();
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

    await markProvisioningComplete(
      baseCtx(uid, slug),
      {
        "mattermost.teamId": `mm-team-${slug}`,
        "mattermost.userId": `mm-user-${slug}`,
        // no coachUserId
      },
      [],
    );

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
    expect(wsEntry?.createdAt).toBe("earlier"); // survives the update
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
