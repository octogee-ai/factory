import { afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { SIGNATURE_HEADER } from "../../../shared/types/fleet-controller.js";
import { verifyFleetRequest } from "../../../scripts/lib/fleet-signature.js";
import { buildOperatorHeartbeatPollerDeps, callUnmountRpc } from "../index.js";

function fakeDb(): Firestore {
  return {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({ exists: true })),
      })),
    })),
  } as unknown as Firestore;
}

describe("callUnmountRpc", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a stuck unmount RPC instead of hanging the operator poller", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      });

    const pending = callUnmountRpc(fakeDb(), {
      secret: "secret",
      gatewayId: "bender",
      slug: "ghost",
      log: vi.fn(),
      timeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toThrow(
      /unmount timed out after 25ms gatewayId=bender slug=ghost/,
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/unmount/bender"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("buildOperatorHeartbeatPollerDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs operator eviction with the per-gateway auth token", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedInit = init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const readGatewayAuthTokenForId = vi.fn(async () => "gateway-token");
    const deps = buildOperatorHeartbeatPollerDeps(
      fakeDb(),
      vi.fn(),
      readGatewayAuthTokenForId,
    );

    await deps.evictSlug?.("bender", "ghost");

    expect(readGatewayAuthTokenForId).toHaveBeenCalledWith("bender");
    const rawBody = capturedInit?.body as string;
    const body = JSON.parse(rawBody) as { migrationId: string };
    const headers = capturedInit?.headers as Record<string, string>;
    const signature = headers[SIGNATURE_HEADER];
    expect(
      verifyFleetRequest("gateway-token", body.migrationId, rawBody, signature),
    ).toBe(true);
    expect(
      verifyFleetRequest("fleet-secret", body.migrationId, rawBody, signature),
    ).toBe(false);
  });
});
