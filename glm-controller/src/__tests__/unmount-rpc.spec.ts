import { afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { verifyFleetRequest } from "@octogee/core/fleet-signature";
import {
  buildLegacyBackfillRecoveryHeartbeatPollerDeps,
  buildOperatorHeartbeatPollerDeps,
  callUnmountRpc,
  heartbeatPollInstanceIds,
  heartbeatRosterTarget,
  startLegacyBackfillRecoveryHeartbeatPoller,
} from "../index.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

function fakeDb(): Firestore {
  return {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({
            docKind: "revision",
            revisionId: "bender-r2",
            gateway: "bender",
            release: 2,
            lifecycle: "serving",
          }),
        })),
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
      privateKey: FLEET_KEY_PAIR.privateKey,
      gatewayId: "bender",
      revisionId: "bender-r2",
      slug: "ghost",
      log: vi.fn(),
      timeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toThrow(
      /unmount timed out after 25ms gatewayId=bender revisionId=bender-r2 slug=ghost/,
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

  it("writeHeartbeat writes ONLY glmGateways/{id}.heartbeat — never the flat gateways/{id} doc", async () => {
    const setCalls: Array<{ collection: string; doc: string; data: Record<string, unknown> }> = [];
    let committed = false;
    const batchDb = {
      collection: (name: string) => ({
        doc: (id: string) => ({ _collection: name, _doc: id }),
      }),
      batch: () => ({
        set: (
          ref: { _collection: string; _doc: string },
          data: Record<string, unknown>,
        ) => {
          setCalls.push({ collection: ref._collection, doc: ref._doc, data });
        },
        commit: async () => {
          committed = true;
        },
      }),
    } as unknown as Firestore;

    const deps = buildOperatorHeartbeatPollerDeps(batchDb, vi.fn(), FLEET_KEY_PAIR.privateKey);
    await deps.writeHeartbeat("bender-r2", { status: "ready", mountedCustomers: ["ceckert"], startedAt: 42 });

    expect(committed).toBe(true);
    expect(setCalls.map((c) => c.collection)).toEqual(["glmGateways"]);
    const glmCall = setCalls.find((c) => c.collection === "glmGateways");
    expect(glmCall!.doc).toBe("bender-r2");
    expect(glmCall!.data).toHaveProperty("heartbeat");
    expect(glmCall!.data).toMatchObject({
      heartbeat: { internalUrl: expect.stringContaining("octogee-gateway-bender-r2") },
    });
    expect(setCalls.some((c) => c.collection === "gateways")).toBe(false);
  });

  it("signs operator eviction with the fleet controller private key", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedInit = init;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const deps = buildOperatorHeartbeatPollerDeps(
      fakeDb(),
      vi.fn(),
      FLEET_KEY_PAIR.privateKey,
    );

    await deps.evictSlug?.("bender-r2", "ghost");

    const rawBody = capturedInit?.body as string;
    const body = JSON.parse(rawBody) as { migrationId: string };
    const headers = capturedInit?.headers as Record<string, string>;
    const signature = headers[SIGNATURE_HEADER];
    expect(
      verifyFleetRequest(FLEET_KEY_PAIR.publicKey, body.migrationId, rawBody, signature),
    ).toBe(true);
    expect(
      verifyFleetRequest("gateway-token", body.migrationId, rawBody, signature),
    ).toBe(false);
  });
});

describe("buildLegacyBackfillRecoveryHeartbeatPollerDeps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls only canonical bridge revisions and cannot evict customers", async () => {
    const roots = {
      default: {
        gatewayId: "default",
        latestRelease: 1,
        desiredRelease: 1,
        desiredStatus: "running",
        legacyBackfill: { sourceGlmGatewayIds: ["default-blue"], startedAt: 1 },
      },
      ordinary: {
        gatewayId: "ordinary",
        latestRelease: 3,
        desiredRelease: 3,
        desiredStatus: "running",
        legacyBackfill: null,
      },
    };
    const runtime = {
      "default-blue": {
        gatewayId: "default-blue",
        gateway: "default",
        desiredStatus: "running",
        imageRepository: "repo",
        imageTag: "abc1234",
        createdBy: "legacy-controller",
      },
      "default-r1": {
        docKind: "revision",
        revisionId: "default-r1",
        gateway: "default",
        release: 1,
        lifecycle: "provisioning",
      },
      "ordinary-r3": {
        docKind: "revision",
        revisionId: "ordinary-r3",
        gateway: "ordinary",
        release: 3,
        lifecycle: "serving",
      },
    };
    const db = {
      collection: (name: string) => {
        const store = name === "gateways" ? roots : runtime;
        return {
          get: async () => ({
            docs: Object.entries(store).map(([id, data]) => ({ id, data: () => data })),
          }),
        };
      },
    } as unknown as Firestore;

    const deps = buildLegacyBackfillRecoveryHeartbeatPollerDeps(db, vi.fn());

    await expect(deps.listGatewayIds()).resolves.toEqual(["default-r1"]);
    expect(deps.evictSlug).toBeUndefined();
  });

  it("starts a stoppable heartbeat-only loop for the recovery controller", () => {
    vi.useFakeTimers();
    const db = {
      collection: () => ({ get: async () => ({ docs: [] }) }),
    } as unknown as Firestore;

    const stop = startLegacyBackfillRecoveryHeartbeatPoller(db, vi.fn());

    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("revision heartbeat polling", () => {
  it("polls only active revision realizations", () => {
    expect(
      heartbeatPollInstanceIds([
        {
          id: "default-green",
          data: () => ({
            gatewayId: "default-green",
            imageRepository: "repo",
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "test",
          }),
        },
        { id: "default-r2", data: () => ({ docKind: "revision", revisionId: "default-r2", gateway: "default", release: 2, lifecycle: "provisioning" }) },
        { id: "default-r1", data: () => ({ docKind: "revision", revisionId: "default-r1", gateway: "default", release: 1, lifecycle: "retired" }) },
      ]),
    ).toEqual(["default-r2"]);
  });

  it("does not poll a shadow document that claims another revision identity", () => {
    expect(
      heartbeatPollInstanceIds([
        {
          id: "default-r2-shadow",
          data: () => ({
            docKind: "revision",
            revisionId: "default-r2",
            gateway: "default",
            release: 2,
            lifecycle: "serving",
          }),
        },
      ]),
    ).toEqual([]);
  });

  it("resolves a revision instance to the bare gateway's revision-filtered roster", () => {
    expect(
      heartbeatRosterTarget("default-r2", {
        docKind: "revision",
        revisionId: "default-r2",
        gateway: "default",
        release: 2,
        lifecycle: "warming",
      }),
    ).toEqual({ gatewayId: "default", revisionId: "default-r2" });
    expect(heartbeatRosterTarget("default-green", { gatewayId: "default-green" })).toBeNull();
  });
});
