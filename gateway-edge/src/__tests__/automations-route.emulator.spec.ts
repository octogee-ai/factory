import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../index.js";
import { db } from "../lib/db.js";
import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

const OWNER_UID = "automations-owner";
const GATEWAY_ID = "gw-automations";
const WORKSPACE_SLUG = "automations-owner";
const originalGatewayId = process.env.GATEWAY_ID;
const originalBrokerUrl = process.env.AUTOMATIONS_BROKER_URL;
const originalTokenPath = process.env.OCTOGEE_API_SA_TOKEN_PATH;
let tokenDirectory: string;

setupEmulatorTest();

beforeEach(async () => {
  tokenDirectory = await mkdtemp(join(tmpdir(), "octogee-automations-"));
  const tokenPath = join(tokenDirectory, "token");
  await writeFile(tokenPath, "projected-token", "utf8");
  process.env.GATEWAY_ID = GATEWAY_ID;
  process.env.AUTOMATIONS_BROKER_URL = "http://localhost:3001";
  process.env.OCTOGEE_API_SA_TOKEN_PATH = tokenPath;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tokenDirectory, { recursive: true, force: true });
  if (originalGatewayId === undefined) delete process.env.GATEWAY_ID;
  else process.env.GATEWAY_ID = originalGatewayId;
  if (originalBrokerUrl === undefined) delete process.env.AUTOMATIONS_BROKER_URL;
  else process.env.AUTOMATIONS_BROKER_URL = originalBrokerUrl;
  if (originalTokenPath === undefined) delete process.env.OCTOGEE_API_SA_TOKEN_PATH;
  else process.env.OCTOGEE_API_SA_TOKEN_PATH = originalTokenPath;
});

async function authHeader(uid: string): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await getIdTokenForUid(uid)}` };
}

async function seedActiveUser(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({
    accountLifecycle: { status: "active" },
  });
}

describe("POST /api/g/:gatewayId/automations/rpc", () => {
  it("rejects an unauthenticated request at the sidecar mount", async () => {
    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .send({ method: "config.patch" });

    expect(response.status).toBe(401);
  });

  it("propagates an authorization broker rejection", async () => {
    await seedActiveUser("automations-member");
    const authorization = await authHeader("automations-member");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } },
    )));

    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .set(authorization)
      .send({ method: "config.patch" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
  });

  it("rejects an authorized owner request outside the automation allowlist", async () => {
    await seedActiveUser(OWNER_UID);
    const authorization = await authHeader(OWNER_UID);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ slug: WORKSPACE_SLUG, gatewayId: GATEWAY_ID }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const response = await request(createApp({ surface: "sidecar" }))
      .post(`/api/g/${GATEWAY_ID}/automations/rpc`)
      .set(authorization)
      .send({ method: "config.patch" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "unsupported automation operation" });
  });
});
