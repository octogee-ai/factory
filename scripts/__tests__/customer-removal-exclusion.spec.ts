import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createUnmountHandler } from "../lib/fleet-http-migration.js";
import { evictLocalCustomer } from "../lib/fleet-provisioner.js";
import type { CustomerLifecycleAdapter, RemoveCustomerResult } from "../lib/customer-lifecycle.js";
import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import { SIGNATURE_HEADER } from "../../shared/types/fleet-controller.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const GATEWAY_ID = "gw-a";

function signedUnmountRequest(slug: string): Request {
  const body = { migrationId: "mig-1", slug };
  const rawBody = JSON.stringify(body);
  const signature = signFleetRequest(
    FLEET_KEY_PAIR.privateKey,
    gatewayScopedJobId(body.migrationId, GATEWAY_ID),
    rawBody,
  );
  return {
    header: (name: string) => (name.toLowerCase() === SIGNATURE_HEADER.toLowerCase() ? signature : undefined),
    params: { gatewayId: GATEWAY_ID },
    rawBody,
    socket: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 3003 }) },
  } as unknown as Request;
}

function recordingResponse(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let status: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => status, body: () => body };
}

describe("customer removal exclusion", () => {
  it("unmount waits for the reconcile eviction of the same customer instead of deleting its agents concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    let mounted = true;
    let releaseEviction!: () => void;
    const evictionHeld = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    const removeImportedCustomerBySlug = vi.fn(async (): Promise<RemoveCustomerResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (removeImportedCustomerBySlug.mock.calls.length === 1) await evictionHeld;
        const wasMounted = mounted;
        mounted = false;
        return { wasMounted, steps: [] };
      } finally {
        active -= 1;
      }
    });
    const adapter = {
      log: vi.fn(),
      uidForSlug: vi.fn(async () => null),
      removeImportedCustomerBySlug,
      cancelPendingEviction: vi.fn(),
      onUnmounted: vi.fn(),
    } as unknown as CustomerLifecycleAdapter;

    const eviction = evictLocalCustomer({
      adapter,
      slug: "chris",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved: vi.fn(),
    });
    await vi.waitFor(() => expect(removeImportedCustomerBySlug).toHaveBeenCalledTimes(1));

    const voiceMigration = vi.fn(async () => ({ activeCalls: 0 }));
    const handler = createUnmountHandler({
      publicKey: FLEET_KEY_PAIR.publicKey,
      gatewayId: GATEWAY_ID,
      adapter,
      log: vi.fn(),
      pauseSystemConfigWatch: vi.fn(async () => undefined),
      voiceMigration,
    });
    const response = recordingResponse();
    const unmount = handler(signedUnmountRequest("chris"), response.res, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removeImportedCustomerBySlug).toHaveBeenCalledTimes(1);

    releaseEviction();
    await expect(eviction).resolves.toBe("deleted-user");
    await unmount;
    expect(maxActive).toBe(1);
    expect(response.status()).toBe(200);
    expect(voiceMigration).toHaveBeenCalledWith({ slug: "chris", operationId: "mig-1", phase: "resume" });
    expect(response.body()).toEqual({ migrationId: "mig-1", slug: "chris", unmounted: false });
  });
});
