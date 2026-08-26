import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import type {
  StartFleetOptions,
  StartedFleetController,
} from "../lib/fleet-provisioner.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
} from "../../shared/types/fleet-controller.js";

const GATEWAY_ID = "builder-jack";

function ed25519Pair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const COWBOY = ed25519Pair();

function controllerOpts(): StartFleetOptions {
  return {
    rpc: {} as GatewayRpcClient,
    adapter: {} as CustomerLifecycleAdapter,
    gatewayId: GATEWAY_ID,
    log: () => undefined,
    port: 0,
    publicKey: COWBOY.publicKey,
    version: "sha-1",
    openclawVersion: "2026.8.1-beta.2",
    platformState: false,
    reportState: false,
    openclawDir: "/tmp/octogee-fleet-surface-noexist",
  } as StartFleetOptions;
}

function signedFleetStateRequest(port: number, body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${port}${FLEET_STATE_PATH}/${GATEWAY_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signFleetRequest(COWBOY.privateKey, String(body.requestId), rawBody),
    },
    body: rawBody,
  });
}

describe("fleet controller port surface", () => {
  let controller: StartedFleetController | undefined;

  beforeEach(() => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    vi.stubEnv("POD_UID", "pod-uid-1");
  });

  afterEach(async () => {
    await controller?.stop();
    controller = undefined;
    vi.unstubAllEnvs();
  });

  it("answers the unauthenticated probe with liveness only — no roster, no tenant identity", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await fetch(`http://127.0.0.1:${controller.port}/health`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["podUid", "startedAt", "status"]);
    expect(body.podUid).toBe("pod-uid-1");
    expect(JSON.stringify(body)).not.toContain(GATEWAY_ID);
  });

  it("serves the roster only to a fleet-controller-signed request", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await signedFleetStateRequest(controller.port, {
      requestId: "req-1",
      gatewayId: GATEWAY_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      gatewayId: GATEWAY_ID,
      podUid: "pod-uid-1",
      version: "sha-1",
      openclawVersion: "2026.8.1-beta.2",
      customers: [],
      migratingIn: [],
    });
  });

  it("refuses an unsigned roster read", async () => {
    controller = await startFleetController(controllerOpts());

    const res = await fetch(
      `http://127.0.0.1:${controller.port}${FLEET_STATE_PATH}/${GATEWAY_ID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "req-1", gatewayId: GATEWAY_ID }),
      },
    );

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });

  it("answers an unsigned migration call identically whichever gatewayId it names", async () => {
    controller = await startFleetController(controllerOpts());

    const unsigned = (pathGatewayId: string) =>
      fetch(`http://127.0.0.1:${controller!.port}/quiesce/${pathGatewayId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ migrationId: "m1", slug: "alice" }),
      });

    const [mine, theirs] = await Promise.all([unsigned(GATEWAY_ID), unsigned("shared-a")]);

    expect(mine.status).toBe(401);
    expect(theirs.status).toBe(401);
    expect(await mine.text()).toEqual(await theirs.text());
  });

  it("refuses a migration call signed for a sibling gateway, so a relay cannot act here", async () => {
    controller = await startFleetController(controllerOpts());

    const rawBody = JSON.stringify({ migrationId: "m1", slug: "alice" });
    const res = await fetch(`http://127.0.0.1:${controller.port}/quiesce/${GATEWAY_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          COWBOY.privateKey,
          gatewayScopedJobId("m1", "shared-a"),
          rawBody,
        ),
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });

  it("rejects a correctly signed migration call whose path names another gateway", async () => {
    controller = await startFleetController(controllerOpts());

    const rawBody = JSON.stringify({ migrationId: "m1", slug: "alice" });
    const res = await fetch(`http://127.0.0.1:${controller.port}/quiesce/shared-a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          COWBOY.privateKey,
          gatewayScopedJobId("m1", GATEWAY_ID),
          rawBody,
        ),
      },
      body: rawBody,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(GATEWAY_ID);
  });
});
