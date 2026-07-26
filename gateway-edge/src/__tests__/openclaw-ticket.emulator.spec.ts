import request from "supertest";
import express from "express";
import { describe, expect, it } from "vitest";

import openclawRouter from "../routes/openclaw.js";
import { db } from "../lib/db.js";
import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";

setupEmulatorTest({
  env: { API_PUBLIC_URL: "https://chat-proxy.test.octogee.com" },
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/openclaw", openclawRouter);
  return app;
}

async function getActiveIdToken(uid: string): Promise<string> {
  await db.doc(`users/${uid}`).set(
    { accountLifecycle: { status: "active" } },
    { merge: true },
  );
  return getIdTokenForUid(uid);
}

async function seedDedicatedGateway({
  gatewayId,
  gatewayClass,
  desiredStatus,
  heartbeatStatus,
}: {
  gatewayId: string;
  gatewayClass: "builder" | "operator";
  desiredStatus: "running" | "paused";
  heartbeatStatus: "ready" | "unknown";
}): Promise<void> {
  const isOperator = gatewayClass === "operator";
  const replicas = desiredStatus === "running" ? 1 : 0;
  await db.doc(`gateways/${gatewayId}`).set({
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus,
    configSchemaVersion: 1,
    profile: isOperator ? "operator" : null,
    gatewayClass,
    imageProfile: isOperator ? "operator" : "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: "caller-uid",
    builderSlug: "alice",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  });
  const payload = {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
    imageTag: "abc1234",
  };
  await db.doc(`gateways/${gatewayId}/releases/1`).set({
    gatewayId,
    release: 1,
    createdAt: 1,
    createdBy: "test",
    sourceRelease: null,
    note: null,
    payloadHash: releasePayloadHash(payload),
    payload,
  });
  await db.doc(`glmGateways/${gatewayId}`).set({
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    helm: {
      releaseName: `octogee-gw-${gatewayId}`,
      deploymentName: `octogee-gateway-${gatewayId}`,
      gatewayServiceName: `octogee-gateway-${gatewayId}`,
      gatewayEdgeServiceName: `gateway-edge-${gatewayId}`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
      imageTag: "abc1234",
      replicas,
      availableReplicas: replicas,
      lastAppliedAt: 1,
    },
    heartbeat: {
      status: heartbeatStatus,
      lastHeartbeatAt: 1,
      version: "abc1234",
      openclawVersion: null,
      internalUrl: null,
      startedAt: 1,
      mountedCustomers: [],
      migratingIn: [],
    },
    lastError: { message: null, at: null },
  });
}

describe("POST /api/openclaw/ticket — real Firebase Auth + Firestore (emulators)", () => {
  it("rejects unauthenticated requests with 401 (real requireAuth)", async () => {
    const res = await request(buildApp()).post("/api/openclaw/ticket");
    expect(res.status).toBe(401);
  });

  it("rejects malformed Bearer token with 401 (real verifyIdToken)", async () => {
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns a ticket + proxy URL on a valid Firebase token", async () => {
    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.proxyUrl).toBe("https://chat-proxy.test.octogee.com");
  });

  it("writes an ocTickets/{uuid} doc with uid + ~30s expiry — visible in real Firestore", async () => {
    const token = await getActiveIdToken("caller-uid");
    const before = Date.now();
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const after = Date.now();
    expect(res.status).toBe(200);

    const snap = await db.collection("gatewayTickets").doc(res.body.wsTicket).get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    expect(data?.uid).toBe("caller-uid");
    expect(data?.purpose).toBe("openclaw-ws");
    const exp = data?.expiresAt as number;
    expect(exp).toBeGreaterThanOrEqual(before + 29_000);
    expect(exp).toBeLessThanOrEqual(after + 31_000);
  });

  it("issues distinct tickets across calls", async () => {
    const token = await getActiveIdToken("caller-uid");
    const a = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const b = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(a.body.wsTicket).not.toBe(b.body.wsTicket);
  });

it("returns gatewayId from users/{uid}.provisioning.openclaw.gatewayId when set", async () => {
    await db.doc("users/caller-uid").set({
      provisioning: { openclaw: { gatewayId: "gw-bender" } },
    });
    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("gw-bender");
  });

  it("returns gatewayId='' when the user doc has no openclaw provisioning (legacy / pre-provisioning fallback to bare /api path)", async () => {
    
    const token = await getActiveIdToken("no-provisioning-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("");
  });

  it("defers the ticket and queues an activation migration when the owned builder gateway is ready", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await seedDedicatedGateway({
      gatewayId: "gw-alice",
      gatewayClass: "builder",
      desiredStatus: "running",
      heartbeatStatus: "ready",
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "activating",
      gatewayId: "gw-alice",
      gatewayClass: "builder",
      openclawTicketDeferred: true,
    });
    expect(res.body.wsTicket).toBeUndefined();

    const ops = await db.collection("glmOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0].data()).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      gatewayId: "gw-alice",
      inputUid: "caller-uid",
      input: {
        uid: "caller-uid",
        toGatewayId: "gw-alice",
        source: "builder-activation-lease",
        builderSlug: "alice",
        gatewayClass: "builder",
        reason: "openclaw-ticket",
      },
    });
  });

  it("wakes a paused dedicated gateway and waits to mint until it reports ready", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await seedDedicatedGateway({
      gatewayId: "gw-alice",
      gatewayClass: "builder",
      desiredStatus: "paused",
      heartbeatStatus: "unknown",
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "waking",
      targetStatus: "unknown",
      gatewayId: "gw-alice",
      openclawTicketDeferred: true,
    });
    expect(res.body.wsTicket).toBeUndefined();

    const target = await db.doc("gateways/gw-alice").get();
    expect(target.data()?.desiredStatus).toBe("running");
    const ops = await db.collection("glmOperations").get();
    expect(ops.empty).toBe(true);
  });

  it("auto-activates an owned operator gateway when it is the only dedicated target", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await seedDedicatedGateway({
      gatewayId: "bender",
      gatewayClass: "operator",
      desiredStatus: "running",
      heartbeatStatus: "ready",
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "activating",
      gatewayId: "bender",
      gatewayClass: "operator",
      openclawTicketDeferred: true,
    });

    const ops = await db.collection("glmOperations").get();
    expect(ops.size).toBe(1);
    expect(ops.docs[0].data()).toMatchObject({
      input: {
        uid: "caller-uid",
        toGatewayId: "bender",
        gatewayClass: "operator",
      },
    });
  });
});
