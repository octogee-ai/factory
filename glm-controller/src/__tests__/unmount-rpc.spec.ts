import { afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { verifyFleetRequest } from "@octogee/core/fleet-signature";
import {
  buildOperatorHeartbeatPollerDeps,
  callUnmountRpc,
  heartbeatPollInstanceIds,
  heartbeatRosterTarget,
} from "../index.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

function fakeDb(): Firestore {
  return {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({
            docKind: "runtime",
            gatewayId: "bender",
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
    await deps.writeHeartbeat("bender", { status: "ready", mountedCustomers: ["ceckert"], startedAt: 42 });

    expect(committed).toBe(true);
    expect(setCalls.map((c) => c.collection)).toEqual(["glmGateways"]);
    const glmCall = setCalls.find((c) => c.collection === "glmGateways");
    expect(glmCall!.doc).toBe("bender");
    expect(glmCall!.data).toHaveProperty("heartbeat");
    expect(glmCall!.data).toMatchObject({
      heartbeat: { internalUrl: expect.stringContaining("octogee-gateway-bender") },
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

    await deps.evictSlug?.("bender", "ghost");

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

  it("leaves shared eviction to the in-pod reconciler and owns builder eviction", async () => {
    const durableGateway = (gatewayClass: "shared" | "builder") => ({
      gatewayId: "bender",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      profile: null,
      gatewayClass,
      imageProfile: "standard",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      operatorAccess: null,
      ownerUid: gatewayClass === "shared" ? null : "uid-bender",
      builderSlug: gatewayClass === "shared" ? null : "bender",
      openclawOverrides: null,
      modelBrokerLimits: null,
      preemption: null,
    });
    let gateway = durableGateway("shared");
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => gateway }),
        }),
      }),
    } as unknown as Firestore;
    const deps = buildOperatorHeartbeatPollerDeps(db, vi.fn(), FLEET_KEY_PAIR.privateKey);

    await expect(deps.ownsEviction?.("bender")).resolves.toBe(false);
    gateway = durableGateway("builder");
    await expect(deps.ownsEviction?.("bender")).resolves.toBe(true);
  });
});

describe("operator heartbeat poll — a converged gateway writes nothing", () => {
  function pollerDb(store: Map<string, Record<string, unknown>>) {
    const writes: Array<{ doc: string; data: Record<string, unknown> }> = [];
    const db = {
      collection: (name: string) => ({
        get: async () => ({
          docs: [...store.entries()].map(([id, data]) => ({ id, data: () => data })),
        }),
        doc: (id: string) => ({ _collection: name, _doc: id }),
      }),
      batch: () => ({
        set: (ref: { _doc: string }, data: Record<string, unknown>) => {
          writes.push({ doc: ref._doc, data });
        },
        commit: async () => {},
      }),
    } as unknown as Firestore;
    return { db, writes };
  }

  function landWrite(
    store: Map<string, Record<string, unknown>>,
    write: { data: Record<string, unknown> },
  ): void {
    const heartbeat = write.data.heartbeat as Record<string, unknown>;
    store.set("bender", {
      ...store.get("bender")!,
      heartbeat: { ...heartbeat, lastHeartbeatAt: Date.now() },
    });
  }

  function runtimeStore(): Map<string, Record<string, unknown>> {
    return new Map([
      ["bender", { docKind: "runtime", gatewayId: "bender", release: 2, lifecycle: "serving" }],
    ]);
  }

  it("writes the first poll and skips an identical second poll", async () => {
    const store = runtimeStore();
    const { db, writes } = pollerDb(store);
    const deps = buildOperatorHeartbeatPollerDeps(db, vi.fn(), FLEET_KEY_PAIR.privateKey);
    const health = { status: "ready", mountedCustomers: ["ceckert"], startedAt: 42 };

    expect(await deps.listGatewayIds()).toEqual(["bender"]);
    await deps.writeHeartbeat("bender", health);
    expect(writes).toHaveLength(1);
    landWrite(store, writes[0]);

    await deps.listGatewayIds();
    await deps.writeHeartbeat("bender", health);

    expect(writes).toHaveLength(1);
  });

  it("writes exactly once more when the poll reports a new mounted set", async () => {
    const store = runtimeStore();
    const { db, writes } = pollerDb(store);
    const deps = buildOperatorHeartbeatPollerDeps(db, vi.fn(), FLEET_KEY_PAIR.privateKey);

    await deps.listGatewayIds();
    await deps.writeHeartbeat("bender", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      startedAt: 42,
    });
    landWrite(store, writes[0]);

    await deps.listGatewayIds();
    await deps.writeHeartbeat("bender", {
      status: "ready",
      mountedCustomers: [],
      startedAt: 42,
    });

    expect(writes).toHaveLength(2);
    expect(writes[1].data.heartbeat).toMatchObject({ mountedCustomers: [] });
  });
});

describe("runtime heartbeat polling", () => {
  it("polls only live runtime realizations", () => {
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
        { id: "default", data: () => ({ docKind: "runtime", gatewayId: "default", release: 2, lifecycle: "provisioning" }) },
        { id: "failed", data: () => ({ docKind: "runtime", gatewayId: "failed", release: 1, lifecycle: "failed" }) },
      ]),
    ).toEqual(["default"]);
  });

  it("does not poll a shadow document that claims another gateway identity", () => {
    expect(
      heartbeatPollInstanceIds([
        {
          id: "default-shadow",
          data: () => ({
            docKind: "runtime",
            gatewayId: "default",
            release: 2,
            lifecycle: "serving",
          }),
        },
      ]),
    ).toEqual([]);
  });

  it("resolves a runtime instance to the bare gateway roster", () => {
    expect(
      heartbeatRosterTarget("default", {
        docKind: "runtime",
        gatewayId: "default",
        release: 2,
        lifecycle: "serving",
      }),
    ).toEqual({ gatewayId: "default" });
    expect(heartbeatRosterTarget("default-green", { gatewayId: "default-green" })).toBeNull();
  });
});
