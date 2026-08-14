import { describe, expect, it, vi } from "vitest";
import {
  createSurgePodTransport,
  parseSurgePodSnapshot,
  readPodDurableSessionDigest,
} from "../surge-customer-handoff-runtime.js";
import type { SurgePod } from "../surge-customer-handoff.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const source: SurgePod = { uid: "old", name: "old-pod", podIP: "10.0.0.1", ready: true };
const target: SurgePod = { uid: "new", name: "new-pod", podIP: "10.0.0.2", ready: false };

describe("surge handoff Kubernetes projection", () => {
  it("keeps every observed UID while projecting usable pods independently", () => {
    expect(parseSurgePodSnapshot(JSON.stringify({
      items: [
        {
          metadata: { uid: "old", name: "old-pod" },
          status: {
            phase: "Running",
            podIP: "10.0.0.1",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
        {
          metadata: { uid: "new", name: "new-pod" },
          status: { phase: "Running", podIP: "10.0.0.2", conditions: [] },
        },
        {
          metadata: { uid: "gone", name: "gone-pod", deletionTimestamp: "now" },
          status: { phase: "Running", podIP: "10.0.0.3" },
        },
        {
          metadata: { uid: "pending", name: "pending-pod" },
          status: { phase: "Pending" },
        },
      ],
    }))).toEqual({
      pods: [source, target],
      observedPodUids: ["old", "new", "gone", "pending"],
    });
  });

  it("reads the session digest through kubectl exec so the source may run the prior image", async () => {
    const runKubectl = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) }),
    }));

    await expect(readPodDurableSessionDigest(
      runKubectl,
      "octogee-test",
      source,
      "alice",
    )).resolves.toEqual({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) });

    expect(runKubectl).toHaveBeenCalledWith(expect.arrayContaining([
      "-n",
      "octogee-test",
      "exec",
      "pod/old-pod",
      "-c",
      "gateway",
      "--",
      "node",
      "-e",
      expect.any(String),
      "alice",
    ]));
  });
});

type SurgeTransportCall = { url: string; body?: Record<string, unknown> };
type FetchInput = string | URL | Request;

describe("surge handoff direct pod transport", () => {
  it("transfers customer keys before final state and verifies each direct pod", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({
          status: "ready",
          version: url.includes("10.0.0.2") ? "new" : "old",
          customers: ["alice"],
        }));
      }
      if (url.endsWith("/surge-ready")) {
        return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }), { status: 503 });
      }
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import" }));
      }
      if (url.includes("/durable-session-digest/")) {
        return new Response(JSON.stringify({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) }));
      }
      return new Response(JSON.stringify({ imported: true, released: true }));
    }) as unknown as typeof globalThis.fetch;
    const randomKey = vi.fn()
      .mockReturnValueOnce("keys-transfer-key")
      .mockReturnValueOnce("final-transfer-key");
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target)).resolves.toEqual({
      status: "ready",
      version: "new",
      handoffReleased: false,
      mountedCustomers: ["alice"],
    });
    await transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
    });
    await transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    });
    await transport.releaseTarget({
      gatewayId: "default",
      operationId: "surge-default-new",
      pod: target,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/health",
      "http://10.0.0.2:3003/surge-ready",
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/unmount/default",
      "http://10.0.0.2:3003/complete-surge-handoff/default",
    ]);
    expect(calls.slice(2, 8).map((call) => call.body?.rpcPhase)).toEqual([
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
    ]);
    expect(calls[2]?.body).toMatchObject({
      slug: "alice",
      mode: "keys",
      sourcePodIp: "10.0.0.1",
      transferKey: "keys-transfer-key",
    });
    expect(calls[3]?.body).toMatchObject({
      mode: "keys",
      targetHost: "10.0.0.2",
      targetPort: 30873,
    });
    expect(calls[5]?.body).toMatchObject({
      slug: "alice",
      mode: "final",
      sourcePodIp: "10.0.0.1",
      transferKey: "final-transfer-key",
    });
    expect(calls[6]?.body).toMatchObject({
      mode: "final",
      targetHost: "10.0.0.2",
      targetPort: 30873,
      includeActivationManifest: true,
    });
    expect(calls[9]?.body).toEqual({
      migrationId: "surge-default-new",
      targetPodUid: "new",
    });
    expect(randomKey).toHaveBeenCalledTimes(2);
  });

  it("does not transfer final state when the key transfer fails", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import" }));
      }
      if (url.includes("/push-rsync-state/") && body?.mode === "keys") {
        return new Response(JSON.stringify({ error: "key export missing" }), { status: 404 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: () => "transfer-key",
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
    })).rejects.toThrow(/push-rsync-state.*404/u);

    expect(calls.map((call) => [call.url, call.body?.mode, call.body?.rpcPhase])).toEqual([
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "keys", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "keys", "push-rsync-state"],
      ["http://10.0.0.2:3003/abort-rsync-import/default", "keys", "abort-rsync-import"],
    ]);
  });

  it("retries signed target cleanup once after a structured config hash race", async () => {
    let attempts = 0;
    const log = vi.fn();
    const fetch = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({
          error: "unmount failed",
          message: "config changed",
          code: "hash-mismatch",
        }), { status: 500 })
        : new Response(JSON.stringify({ unmounted: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying signed unmount once"));
  });

  it("does not retry target cleanup after an unstructured or permanent failure", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "account removal rejected",
      code: "invalid-patch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("invalid-patch");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops after the single bounded retry when the config hash keeps racing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "config changed",
      code: "hash-mismatch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("hash-mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a latched runtime as booting when the live OpenClaw probe is down", async () => {
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
      }
      return new Response(JSON.stringify({
        handoffReleased: true,
        openclawUp: false,
      }), { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target)).resolves.toEqual({
      status: "booting",
      version: "new",
      handoffReleased: true,
      mountedCustomers: [],
    });
  });

  it("rejects pod health that does not prove the mounted customer inventory", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      return url.endsWith("/health")
        ? new Response(JSON.stringify({ status: "ready", version: "new" }))
        : new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(target)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("invalid surge health response"));
  });
});
