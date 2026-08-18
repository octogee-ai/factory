import { describe, expect, it, vi } from "vitest";

import { signFleetRequest } from "../lib/fleet-signature.js";
import {
  createHoldSurgeOpenClawHandler,
  createResumeSurgeOpenClawHandler,
  createUnreserveSurgeOpenClawHandler,
} from "../lib/surge-openclaw-process-http.js";
import { SIGNATURE_HEADER } from "../../shared/types/fleet-controller.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;
const PUBLIC_KEY = FLEET_KEY_PAIR.publicKey;

function response() {
  let status = 200;
  let body: unknown;
  return {
    status: (code: number) => {
      status = code;
      return { json: (value: unknown) => { body = value; } };
    },
    json: (value: unknown) => { body = value; },
    result: () => ({ status, body }),
  };
}

function request(body: Record<string, unknown>, signature?: string) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    header: (name: string) => name.toLowerCase() === SIGNATURE_HEADER.toLowerCase() ? signature : undefined,
  };
}

const GATE_STATE = {
  version: 1 as const,
  podUid: "target-pod",
  role: "target" as const,
  mode: "held" as const,
  phase: "held" as const,
};

describe("surge OpenClaw process control handlers", () => {
  it("requires a signed configured Builder hold and returns only after the child is held", async () => {
    const hold = vi.fn(async () => GATE_STATE);
    const handler = createHoldSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold, resume: vi.fn(), unreserve: vi.fn() },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();

    await handler(
      { rawBody: raw, header: (name: string) => name.toLowerCase() === SIGNATURE_HEADER.toLowerCase()
        ? signFleetRequest(PRIVATE_KEY, body.migrationId, raw)
        : undefined } as never,
      res as never,
      vi.fn(),
    );

    expect(hold).toHaveBeenCalledWith(body);
    expect(res.result()).toEqual({
      status: 200,
      body: { ...body, operation: "hold", role: "target", mode: "held", phase: "held" },
    });
  });

  it("refuses unsigned and foreign Builder resume attempts", async () => {
    const resume = vi.fn();
    const handler = createResumeSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      configuredBuilder: () => false,
      processGate: { hold: vi.fn(), resume, unreserve: vi.fn() },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    const unsignedRes = response();
    await handler(request(body) as never, unsignedRes as never, vi.fn());
    expect(unsignedRes.result().status).toBe(401);

    const signedRes = response();
    const raw = JSON.stringify(body);
    await handler(
      request(body, signFleetRequest(PRIVATE_KEY, body.migrationId, raw)) as never,
      signedRes as never,
      vi.fn(),
    );
    expect(signedRes.result().status).toBe(409);
    expect(resume).not.toHaveBeenCalled();
  });

  it("unreserves a signed configured Builder target through the gate", async () => {
    const unreserve = vi.fn(async () => ({
      ...GATE_STATE,
      role: "normal" as const,
    }));
    const handler = createUnreserveSurgeOpenClawHandler({
      publicKey: PUBLIC_KEY,
      configuredBuilder: (slug) => slug === "ceckert-test",
      processGate: { hold: vi.fn(), resume: vi.fn(), unreserve },
    });
    const body = {
      migrationId: "surge-gateway-target",
      slug: "ceckert-test",
      targetPodUid: "target-pod",
    };
    const raw = JSON.stringify(body);
    const res = response();

    await handler(
      request(body, signFleetRequest(PRIVATE_KEY, body.migrationId, raw)) as never,
      res as never,
      vi.fn(),
    );

    expect(unreserve).toHaveBeenCalledWith(body);
    expect(res.result()).toEqual({
      status: 200,
      body: { ...body, operation: "unreserve", role: "normal", mode: "held", phase: "held" },
    });
  });
});
