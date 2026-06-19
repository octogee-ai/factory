import { describe, it, expect, vi } from "vitest";
import { signFleetRequest } from "../lib/fleet-signature";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
} from "../../shared/types/fleet-controller";
import { createMigrationClient } from "../lib/fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function captureFetch(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fakeFetch };
}

const PRIVATE_KEY = FLEET_KEY_PAIR.privateKey;
const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "trial",
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  greetingPosted: true,
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  onboardingVibe: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
};

describe("MigrationClient.quiesce", () => {
  it("POSTs JSON to /quiesce/{gatewayId} signed by the fleet controller private key", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet-test.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.quiesce({
      migrationId: "m1",
      gatewayId: "gw-source",
      slug: "alice",
      timeoutMs: 30_000,
    });
    expect(res).toMatchObject({ migrationId: "m1", slug: "alice", drained: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fleet-test.example.com/quiesce/gw-source");
    expect(calls[0].method).toBe("POST");
    const expectedSig = signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice", timeoutMs: 30_000 });
  });

  it("throws on non-2xx response with the gateway's error body in the message", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 }),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/quiesce.*401.*invalid signature/i);
  });

  it("throws when the gateway returns drained=false with a runningCount", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: false, runningCount: 2 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/did not drain.*2 still running/i);
  });
});

describe("MigrationClient.unmount", () => {
  it("POSTs JSON to /unmount/{gatewayId} signed identically to quiesce", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/unmount/gw-source");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice" });
    const expectedSig = signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
  });

  it("treats unmounted=false as success (idempotent — already gone)", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.unmount({ migrationId: "m1", gatewayId: "gw-source", slug: "alice" });
    expect(res.unmounted).toBe(false); 
  });
});

describe("MigrationClient.restoreTarget", () => {
  it("POSTs the durable snapshot to /restore/{gatewayId} signed by the fleet controller key", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          restored: true,
          steps: ["clone-workspace-repo"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.restoreTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      uid: "uid-alice",
      slug: "alice",
      snapshot: SNAPSHOT,
    });
    expect(res.restored).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/restore/gw-green");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({
      migrationId: "m1",
      uid: "uid-alice",
      slug: "alice",
      snapshot: { uid: "uid-alice", slug: "alice", coachToken: "coach-token" },
    });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
      signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!),
    );
  });
});

describe("MigrationClient.transferState", () => {
  it("tells the source gateway to push directly to the target gateway", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) =>
        id === "gw-from" ? "https://fleet-from.example.com" : "https://fleet-to.example.com",
      fetch: fakeFetch,
    });
    const res = await client.transferState({
      migrationId: "m1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fleet-from.example.com/push-state/gw-from");
    expect(calls[0].method).toBe("POST");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toEqual({
      migrationId: "m1",
      slug: "alice",
      targetGatewayId: "gw-to",
      targetUrl: "https://fleet-to.example.com",
      targetImportSignature: signFleetRequest(PRIVATE_KEY, "m1", "alice"),
    });
    const expectedSig = signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expectedSig);
    expect(res.imported).toBe(true);
  });

  it("uses the controller private key for source and target signatures and can request an activation manifest", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) =>
        id === "gw-from" ? "https://fleet-from.example.com" : "https://fleet-to.example.com",
      fetch: fakeFetch,
    });
    await client.transferState({
      migrationId: "m1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "final",
      includeActivationManifest: true,
    });

    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({
      mode: "final",
      includeActivationManifest: true,
      targetImportSignature: signFleetRequest(PRIVATE_KEY, "m1", "alice"),
    });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
      signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!),
    );
  });

  it("throws if push-state returns non-2xx", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response("source gateway is draining", { status: 503 }),
    );

    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.transferState({
        migrationId: "m1",
        fromGatewayId: "gw-from",
        toGatewayId: "gw-to",
        slug: "alice",
      }),
    ).rejects.toThrow(/push-state.*503.*source gateway is draining/i);
    expect(calls).toHaveLength(1);
  });
});

describe("MigrationClient.verifyTarget", () => {
  it("POSTs signed JSON to /verify/{gatewayId} and returns the ready result", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          ready: true,
          checks: {
            customerDir: true,
            coachWired: true,
            mountMarked: true,
            accountHealthy: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    const res = await client.verifyTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      slug: "alice",
      timeoutMs: 7_000,
    });
    expect(res.ready).toBe(true);
    expect(calls[0].url).toBe("https://fleet.example.com/verify/gw-green");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({ migrationId: "m1", slug: "alice", timeoutMs: 7_000 });
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
      signFleetRequest(PRIVATE_KEY, "m1", calls[0].body!),
    );
  });

  it("derives the HTTP timeout from a larger per-call verify timeout", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { fakeFetch } = captureFetch(() =>
        new Response(
          JSON.stringify({
            migrationId: "m1",
            slug: "alice",
            ready: true,
            checks: {
              customerDir: true,
              coachWired: true,
              mountMarked: true,
              accountHealthy: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const client = createMigrationClient({
        privateKey: PRIVATE_KEY,
        resolveGatewayUrl: () => `https://fleet.example.com`,
        fetch: fakeFetch,
        timeouts: {
          verifyMs: 25,
        },
      });
      await client.verifyTarget({
        migrationId: "m1",
        gatewayId: "gw-green",
        slug: "alice",
        timeoutMs: 7_000,
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 37_000);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("throws when the target reports ready=false", async () => {
    const { fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({
          migrationId: "m1",
          slug: "alice",
          ready: false,
          checks: {
            customerDir: true,
            coachWired: true,
            mountMarked: false,
            accountHealthy: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => `https://fleet.example.com`,
      fetch: fakeFetch,
    });
    await expect(
      client.verifyTarget({ migrationId: "m1", gatewayId: "gw-green", slug: "alice" }),
    ).rejects.toThrow(/target verify failed.*mountMarked/i);
  });
});

describe("MigrationClient — per-RPC AbortSignal timeouts", () => {
  function captureSignal(): {
    fakeFetch: typeof fetch;
    seenSignal: () => AbortSignal | undefined;
  } {
    let lastSignal: AbortSignal | undefined;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ drained: true, runningCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fakeFetch, seenSignal: () => lastSignal };
  }

  it("passes an AbortSignal on quiesce derived from MIGRATION_QUIESCE_TIMEOUT_MS", async () => {
    const { fakeFetch, seenSignal } = captureSignal();
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
    });
    await client.quiesce({ migrationId: "m1", gatewayId: "gw", slug: "alice" });
    expect(seenSignal()).toBeInstanceOf(AbortSignal);
    expect(MIGRATION_QUIESCE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("aborts and reports a path-tagged timeout when the server stalls past the deadline", async () => {
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            "abort",
            () => reject((signal as AbortSignal).reason ?? new Error("aborted")),
            { once: true },
          );
        }
      });
    }) as typeof fetch;

    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
      timeouts: {
        quiesceMs: 25,
        transferMs: 25,
        unmountMs: 25,
        verifyMs: 25,
      },
    });

    await expect(
      client.unmount({ migrationId: "m1", gatewayId: "gw", slug: "alice" }),
    ).rejects.toThrow(/unmount.*timed out.*25ms/i);
  });

  it("passes the AbortSignal on /push-state inside transferState", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
    });
    await client.transferState({
      migrationId: "m1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(MIGRATION_TRANSFER_TIMEOUT_MS).toBeGreaterThan(MIGRATION_UNMOUNT_TIMEOUT_MS);
  });

  it("passes the AbortSignal on /verify inside verifyTarget", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({
        migrationId: "m1",
        slug: "alice",
        ready: true,
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
          accountHealthy: true,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://fleet.example.com",
      fetch: fakeFetch,
    });
    await client.verifyTarget({
      migrationId: "m1",
      gatewayId: "gw-green",
      slug: "alice",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(MIGRATION_VERIFY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
