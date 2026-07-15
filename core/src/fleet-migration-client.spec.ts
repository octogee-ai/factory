import { describe, it, expect, vi } from "vitest";
import { signFleetRequest } from "./fleet-signature";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
} from "@octogee/shared/types/fleet-controller";
import { createMigrationClient, MigrationRpcError } from "./fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

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

describe("MigrationClient system config fencing", () => {
  it("mints a fresh bounded mutation envelope for every signed config attempt", async () => {
    const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m1",
      slug: "alice",
      frozen: true,
      checkpointCommit: "a".repeat(40),
      configHash: "b".repeat(64),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const requestIds = ["request:id.0001", "request:id.0002"];
    const issuedAt = [1_000, 2_000];
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: fakeFetch,
      now: () => issuedAt.shift()!,
      genRequestId: () => requestIds.shift()!,
    });

    await client.freezeConfig({ migrationId: "m1", gatewayId: "bender", slug: "alice" });
    await client.freezeConfig({ migrationId: "m1", gatewayId: "bender", slug: "alice" });

    expect(calls.map((call) => JSON.parse(call.body!))).toEqual([
      expect.objectContaining({ action: "freeze", issuedAt: 1_000, expiresAt: 31_000, requestId: "request:id.0001" }),
      expect.objectContaining({ action: "freeze", issuedAt: 2_000, expiresAt: 32_000, requestId: "request:id.0002" }),
    ]);
    expect(calls[0].headers[SIGNATURE_HEADER.toLowerCase()])
      .not.toBe(calls[1].headers[SIGNATURE_HEADER.toLowerCase()]);
  });

  it("surfaces a typed freeze-owner conflict with the durable owner id", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      error: "config freeze owned",
      code: "system-config-freeze-owned",
      ownerMigrationId: "mig-old-op",
      slug: "alice",
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: fakeFetch,
    });

    await expect(client.freezeConfig({
      migrationId: "mig-new-op",
      gatewayId: "bender",
      transportId: "bender-r1",
      slug: "alice",
    })).rejects.toMatchObject<Partial<MigrationRpcError>>({
      status: 409,
      code: "system-config-freeze-owned",
      ownerMigrationId: "mig-old-op",
      slug: "alice",
    });
  });

  it("marks proof-only reverification explicitly on the signed target request", async () => {
    const checkpointCommit = "a".repeat(40);
    const { calls, fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m1",
      slug: "alice",
      restoredCommit: checkpointCommit,
      acceptedCommit: "c".repeat(40),
      configHash: "d".repeat(64),
      configReady: true,
      observedRevisionId: "bender-r2",
      restoreProvenAt: 200,
      configReadyAt: 201,
      runtimeConfigHash: "runtime-reloaded",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://target.example.com",
      fetch: fakeFetch,
    });

    await client.reproveConfigRestore({
      migrationId: "m1",
      gatewayId: "bender",
      transportId: "bender-r2",
      slug: "alice",
      checkpointCommit,
    });

    expect(JSON.parse(calls[0].body!)).toMatchObject({
      action: "restore-proof",
      proofOnly: true,
    });
  });

  it("freezes/checkpoints the source, proves the target ancestor, and unfreezes by revision transport", async () => {
    const checkpointCommit = "a".repeat(40);
    const { calls, fakeFetch } = captureFetch((call) => {
      const common = { migrationId: "m1", slug: "alice" };
      if (call.url.includes("/config-freeze/")) {
        return new Response(JSON.stringify({
          ...common,
          frozen: true,
          checkpointCommit,
          configHash: "b".repeat(64),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (call.url.includes("/config-restore-proof/")) {
        return new Response(JSON.stringify({
          ...common,
          restoredCommit: checkpointCommit,
          acceptedCommit: "c".repeat(40),
          configHash: "d".repeat(64),
          configReady: true,
          observedRevisionId: "default-r2",
          restoreProvenAt: 100,
          configReadyAt: 101,
          runtimeConfigHash: "runtime-after",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ...common, unfrozen: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) => `https://${id}.example.com`,
      fetch: fakeFetch,
    });

    const checkpoint = await client.freezeConfig({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r1",
      slug: "alice",
    });
    const proof = await client.proveConfigRestore({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r2",
      slug: "alice",
      checkpointCommit,
    });
    await client.unfreezeConfig({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r1",
      slug: "alice",
    });

    expect(checkpoint.checkpointCommit).toBe(checkpointCommit);
    expect(proof).toMatchObject({ restoredCommit: checkpointCommit, acceptedCommit: "c".repeat(40) });
    expect(calls.map((call) => call.url)).toEqual([
      "https://default-r1.example.com/config-freeze/default",
      "https://default-r2.example.com/config-restore-proof/default",
      "https://default-r1.example.com/config-unfreeze/default",
    ]);
    expect(JSON.parse(calls[1].body!)).toMatchObject({ checkpointCommit });
    expect(calls.map((call) => JSON.parse(call.body!).action)).toEqual([
      "freeze",
      "restore-proof",
      "unfreeze",
    ]);
    for (const call of calls) {
      expect(call.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
        signFleetRequest(PRIVATE_KEY, "m1", call.body!),
      );
    }
  });

  it("rejects a malformed checkpoint response before migration can continue", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m1",
      slug: "alice",
      frozen: true,
      checkpointCommit: "not-a-commit",
      configHash: "not-a-hash",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: fakeFetch,
    });

    await expect(client.freezeConfig({
      migrationId: "m1",
      gatewayId: "default",
      slug: "alice",
    })).rejects.toThrow(/malformed config checkpoint/i);
  });

  it("rejects a checkpoint response bound to another migration or builder", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m-other",
      slug: "mallory",
      frozen: true,
      checkpointCommit: "a".repeat(40),
      configHash: "b".repeat(64),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: fakeFetch,
    });

    await expect(client.freezeConfig({
      migrationId: "m1",
      gatewayId: "default",
      slug: "alice",
    })).rejects.toThrow(/response binding/i);
  });

  it("rejects readiness observed before restore proof or for another target revision", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m1",
      slug: "alice",
      restoredCommit: "a".repeat(40),
      acceptedCommit: "c".repeat(40),
      configHash: "d".repeat(64),
      configReady: true,
      observedRevisionId: "default-r1",
      restoreProvenAt: 200,
      configReadyAt: 199,
      runtimeConfigHash: "runtime-stale",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://target.example.com",
      fetch: fakeFetch,
    });

    await expect(client.proveConfigRestore({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r2",
      slug: "alice",
      checkpointCommit: "a".repeat(40),
    })).rejects.toThrow(/malformed config restore proof/i);
  });

  it("rejects an unfreeze response that does not confirm the source is writable", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: "m1",
      slug: "alice",
      unfrozen: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://source.example.com",
      fetch: fakeFetch,
    });

    await expect(client.unfreezeConfig({
      migrationId: "m1",
      gatewayId: "default",
      slug: "alice",
    })).rejects.toThrow(/unfreeze was not confirmed/i);
  });
});

describe("MigrationClient protocol-v2 config control", () => {
  const common = {
    migrationId: "roll-config:roll-1",
    gatewayId: "bender",
    slug: "alice",
    sourceRevisionId: "bender-r1",
    targetRevisionId: "bender-r2",
  };
  const checkpointCommit = "1".repeat(40);
  const configHash = "a".repeat(64);
  const freezeObject = "2".repeat(40);
  const candidateCommit = "3".repeat(40);
  const candidateHash = "b".repeat(64);

  it("signs all five exact v2 actions with both revision bindings", async () => {
    const { calls, fakeFetch } = captureFetch((call) => {
      const request = JSON.parse(call.body!);
      const binding = {
        migrationId: common.migrationId,
        slug: common.slug,
        sourceRevisionId: common.sourceRevisionId,
        targetRevisionId: common.targetRevisionId,
      };
      const responses: Record<string, object> = {
        "freeze-v2": {
          ...binding,
          frozen: true,
          checkpointCommit,
          configHash,
          freezeRef: `refs/octogee/system-config/freeze/${common.sourceRevisionId}`,
          freezeObject,
        },
        "candidate-proof": {
          ...binding,
          checkpointCommit,
          candidateCommit,
          candidateHash,
          candidateRef: `refs/octogee/system-config/candidate/${common.targetRevisionId}`,
          freezeObject,
          runtimeConfigHash: "runtime-hash",
          observedRevisionId: common.targetRevisionId,
          targetStartedAt: 100,
          imageTag: "image-1",
          buildSha: "build-1",
          openclawVersion: "oc-1",
          configReady: true,
          provenAt: 101,
        },
        "promote-candidate": { ...binding, promoted: true, promotedCommit: candidateCommit },
        "abort-v2": { ...binding, aborted: true },
        "finalize-v2": { ...binding, finalized: true },
      };
      return new Response(JSON.stringify(responses[request.action]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) => `https://${id}.example.com`,
      fetch: fakeFetch,
    });

    await client.freezeConfigV2({ ...common, transportId: common.sourceRevisionId });
    await client.proveConfigCandidate({
      ...common,
      transportId: common.targetRevisionId,
      checkpointCommit,
      freezeObject,
    });
    await client.promoteConfigCandidate({
      ...common,
      transportId: common.targetRevisionId,
      checkpointCommit,
      candidateCommit,
      candidateHash,
      freezeObject,
    });
    await client.abortConfigV2({
      ...common,
      transportId: common.sourceRevisionId,
      checkpointCommit,
      candidateCommit,
      freezeObject,
    });
    await client.finalizeConfigV2({
      ...common,
      transportId: common.targetRevisionId,
      checkpointCommit,
      candidateCommit,
      candidateHash,
      freezeObject,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://bender-r1.example.com/config-freeze-v2/bender",
      "https://bender-r2.example.com/config-candidate-proof/bender",
      "https://bender-r2.example.com/config-promote-candidate/bender",
      "https://bender-r1.example.com/config-abort-v2/bender",
      "https://bender-r2.example.com/config-finalize-v2/bender",
    ]);
    expect(calls.map((call) => JSON.parse(call.body!).action)).toEqual([
      "freeze-v2",
      "candidate-proof",
      "promote-candidate",
      "abort-v2",
      "finalize-v2",
    ]);
    for (const call of calls) {
      const request = JSON.parse(call.body!);
      expect(request).toMatchObject({
        migrationId: common.migrationId,
        slug: common.slug,
        sourceRevisionId: common.sourceRevisionId,
        targetRevisionId: common.targetRevisionId,
      });
      expect(call.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(
        signFleetRequest(PRIVATE_KEY, common.migrationId, call.body!),
      );
    }
  });

  it("rejects a candidate proof observed from another target process", async () => {
    const { fakeFetch } = captureFetch(() => new Response(JSON.stringify({
      migrationId: common.migrationId,
      slug: common.slug,
      sourceRevisionId: common.sourceRevisionId,
      targetRevisionId: common.targetRevisionId,
      checkpointCommit,
      candidateCommit,
      candidateHash,
      candidateRef: `refs/octogee/system-config/candidate/${common.targetRevisionId}`,
      freezeObject,
      runtimeConfigHash: "runtime-hash",
      observedRevisionId: "bender-r9",
      targetStartedAt: 100,
      imageTag: "image-1",
      buildSha: "build-1",
      openclawVersion: "oc-1",
      configReady: true,
      provenAt: 101,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: () => "https://target.example.com",
      fetch: fakeFetch,
    });

    await expect(client.proveConfigCandidate({
      ...common,
      checkpointCommit,
      freezeObject,
    })).rejects.toThrow(/candidate proof/i);
  });
});

// Transport/tenant split (GATEWAY-RELEASES-SPEC "Placement and migration
// targeting"): the URL resolves from the revision service ({gw}-r{n}) while the
// in-pod path/body still carries the bare gatewayId (the pod's GATEWAY_ID and
// path guard stay bare). Same bare gateway, two revisions → two URLs.
describe("MigrationClient — transport/tenant split", () => {
  it("quiesce: URL uses transportId (revision service), path uses bare gatewayId", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) =>
        id === "default-r1" ? "https://rev1.example.com" : `https://${id}.example.com`,
      fetch: fakeFetch,
    });
    await client.quiesce({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r1",
      slug: "alice",
    });
    expect(calls[0].url).toBe("https://rev1.example.com/quiesce/default");
  });

  it("verifyTarget + restoreTarget + unmount: transport for URL, bare for path", async () => {
    const { calls, fakeFetch } = captureFetch((call) => {
      if (call.url.includes("/verify/")) {
        return new Response(
          JSON.stringify({
            migrationId: "m1",
            slug: "alice",
            ready: true,
            checks: { customerDir: true, coachWired: true, mountMarked: true, accountHealthy: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (call.url.includes("/restore/")) {
        return new Response(
          JSON.stringify({ migrationId: "m1", slug: "alice", restored: true, steps: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", unmounted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) => `https://${id}.example.com`,
      fetch: fakeFetch,
    });
    await client.verifyTarget({ migrationId: "m1", gatewayId: "default", transportId: "default-r2", slug: "alice" });
    await client.restoreTarget({
      migrationId: "m1",
      gatewayId: "default",
      transportId: "default-r2",
      uid: "uid-alice",
      slug: "alice",
      snapshot: SNAPSHOT,
    });
    await client.unmount({ migrationId: "m1", gatewayId: "default", transportId: "default-r1", slug: "alice" });
    expect(calls[0].url).toBe("https://default-r2.example.com/verify/default");
    expect(calls[1].url).toBe("https://default-r2.example.com/restore/default");
    expect(calls[2].url).toBe("https://default-r1.example.com/unmount/default");
  });

  it("transferState: source URL from fromTransportId, targetUrl from toTransportId, body ids bare", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createMigrationClient({
      privateKey: PRIVATE_KEY,
      resolveGatewayUrl: (id) => `https://${id}.example.com`,
      fetch: fakeFetch,
    });
    await client.transferState({
      migrationId: "m1",
      fromGatewayId: "default",
      toGatewayId: "default",
      fromTransportId: "default-r1",
      toTransportId: "default-r2",
      slug: "alice",
    });
    expect(calls[0].url).toBe("https://default-r1.example.com/push-state/default");
    const parsed = JSON.parse(calls[0].body!);
    expect(parsed).toMatchObject({
      targetGatewayId: "default",
      targetUrl: "https://default-r2.example.com",
    });
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

  it("can request key-only transfer before durable restore", async () => {
    const { calls, fakeFetch } = captureFetch(() =>
      new Response(
        JSON.stringify({ migrationId: "m1", slug: "alice", imported: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
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
      mode: "keys",
    });

    expect(JSON.parse(calls[0].body!)).toMatchObject({ mode: "keys" });
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
