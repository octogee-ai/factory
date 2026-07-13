import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "../lib/db.js";
import { createApp } from "../index.js";
import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

const OWNER_UID = "automations-owner";
const MEMBER_UID = "automations-member";
const GATEWAY_ID = "gw-automations";
const WORKSPACE_SLUG = "automations-owner";
const originalGatewayId = process.env.GATEWAY_ID;

setupEmulatorTest();

beforeEach(() => {
  process.env.GATEWAY_ID = GATEWAY_ID;
});

afterEach(() => {
  if (originalGatewayId === undefined) delete process.env.GATEWAY_ID;
  else process.env.GATEWAY_ID = originalGatewayId;
});

async function authHeader(uid: string): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await getIdTokenForUid(uid)}` };
}

async function seedUser(uid: string, username: string): Promise<void> {
  await db.collection("users").doc(uid).set({
    username,
    provisioning: { openclaw: { slug: WORKSPACE_SLUG, gatewayId: GATEWAY_ID } },
  });
}

async function seedWorkspace(): Promise<void> {
  await db.collection("workspaces").doc(WORKSPACE_SLUG).set({ ownerUid: OWNER_UID });
}

describe("POST /api/g/:gatewayId/automations/rpc", () => {
  it("rejects an unauthenticated request at the sidecar mount", async () => {
    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .send({ method: "config.patch" });

    expect(response.status).toBe(401);
  });

  it("rejects a member whose user record points at the owner gateway", async () => {
    await seedWorkspace();
    await seedUser(MEMBER_UID, "member");

    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .set(await authHeader(MEMBER_UID))
      .send({ method: "config.patch" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
  });

  it("rejects an owner request outside the automation allowlist", async () => {
    await seedWorkspace();
    await seedUser(OWNER_UID, WORKSPACE_SLUG);

    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .set(await authHeader(OWNER_UID))
      .send({ method: "config.patch" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "unsupported automation operation" });
  });
});
