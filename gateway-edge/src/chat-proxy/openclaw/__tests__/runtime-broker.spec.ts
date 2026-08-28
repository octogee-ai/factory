import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawRuntimeBroker,
  createOpenClawRuntimeBrokerFromEnv,
  runtimeBrokerBaseUrlFromEnv,
} from "../runtime-broker.js";
import { SIDECAR_BROKER_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
} from "../activity-write-receipts.js";

function brokerWithRedeemStatus(
  status: number,
  body: Record<string, unknown>,
): ReturnType<typeof createOpenClawRuntimeBroker> {
  const fetchImpl: typeof fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
  return createOpenClawRuntimeBroker({
    baseUrl: "http://octogee-api:3001/",
    gatewayId: "default",
    fetchImpl,
  });
}

describe("redeemOpenClawWs outcome", () => {
  it("200 → redeemed", async () => {
    const broker = brokerWithRedeemStatus(200, {
      uid: "uid-bob",
      gatewayId: "default",
      gatewayUrl: "ws://gw",
      expectedAgentId: "octogee-bob-coach",
    });
    const outcome = await broker.redeemOpenClawWs("ticket");
    expect(outcome).toEqual({
      kind: "redeemed",
      redeemed: {
        uid: "uid-bob",
        gatewayId: "default",
        gatewayUrl: "ws://gw",
        expectedAgentId: "octogee-bob-coach",
      },
    });
  });

  it("401 → unauthorized", async () => {
    const broker = brokerWithRedeemStatus(401, { error: "unauthorized" });
    expect(await broker.redeemOpenClawWs("ticket")).toEqual({ kind: "unauthorized" });
  });

  it("502 gateway-url-unresolved → revision-unavailable (expected, distinguishable, not a throw)", async () => {
    const broker = brokerWithRedeemStatus(502, { error: "gateway-url-unresolved" });
    const outcome = await broker.redeemOpenClawWs("ticket");
    expect(outcome).toEqual({ kind: "revision-unavailable", reason: "gateway-url-unresolved" });
  });
});

describe("OpenClaw runtime broker env", () => {
  it("adds the sidecar capability only when resolving agent secrets", async () => {
    const calls: Array<{ path: string; credential: string | null }> = [];
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "shared-blue",
      sidecarBrokerHeaders: async () => ({
        [SIDECAR_BROKER_TOKEN_HEADER]: "credential-jwt",
      }),
      fetchImpl: vi.fn(async (input, init) => {
        calls.push({
          path: new URL(String(input)).pathname,
          credential: new Headers(init?.headers).get(SIDECAR_BROKER_TOKEN_HEADER),
        });
        const identity = {
          agentId: "octogee-alice-coach",
          uid: "uid-alice",
          coachToken: "coach-pat",
        };
        return new Response(JSON.stringify(
          String(input).endsWith("agent-identity") ? { identity } : { target: null },
        ), { headers: { "content-type": "application/json" }, status: 200 });
      }),
    });

    await broker.resolveAgentIdentity("octogee-alice-coach");
    await broker.resolveChannelTarget("channel-1");

    expect(calls).toEqual([
      {
        path: "/internal/openclaw/activity/agent-identity",
        credential: "credential-jwt",
      },
      { path: "/internal/openclaw/activity/channel-target", credential: null },
    ]);
  });

  it("requires OPENCLAW_RUNTIME_BROKER_URL", () => {
    expect(() => runtimeBrokerBaseUrlFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
    expect(() => createOpenClawRuntimeBrokerFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
  });

  it("requests run activation with only the gateway-bound agent and run identities", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "shared-blue",
      fetchImpl: vi.fn(async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({
          status: "requested",
          leaseId: "lease-1",
          generation: 1,
          sizingTier: "xs",
        }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    await expect(broker.requestBuilderRunActivation({
      agentId: "agent-alice",
      runId: "run-1",
    })).resolves.toEqual({
      status: "requested",
      leaseId: "lease-1",
      generation: 1,
      sizingTier: "xs",
    });
    expect(calls).toEqual([{
      url: "http://octogee-api:3001/internal/fleet/activity/run-start",
      body: {
        gatewayId: "shared-blue",
        agentId: "agent-alice",
        runId: "run-1",
      },
    }]);
  });

  it("derives the workspace binding for a root-level liveRuns v3 admission", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl: vi.fn(async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }),
    });
    const doc = {
      schemaVersion: 3 as const,
      projectionKind: "admission" as const,
      conversationId: "main-1",
      turnId: "input-1",
      mainChannelId: "main-1",
      activityChannelId: "main-1",
      inputPostId: "input-1",
      origin: "followup" as const,
      status: "queued" as const,
      attention: "routine" as const,
      revision: 2,
      updatedAt: 10,
      expiresAt: 20,
    };

    await broker.writeRunLiveDoc(
      "workspaces/acme/channels/build/liveRuns/admission-input-1",
      doc,
    );

    expect(calls).toEqual([
      {
        gatewayId: "gw-bender",
        workspaceSlug: "acme",
        path: "workspaces/acme/channels/build/liveRuns/admission-input-1",
        doc,
      },
    ]);
  });

  it("requires GATEWAY_ID when the broker URL is configured", () => {
    expect(() =>
      createOpenClawRuntimeBrokerFromEnv({
        OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      }),
    ).toThrow("GATEWAY_ID is required for OpenClaw runtime broker");
  });

  it("constructs the broker only when both env vars are present", () => {
    const broker = createOpenClawRuntimeBrokerFromEnv({
      OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      GATEWAY_ID: "default",
    });

    expect(broker).toEqual(
      expect.objectContaining({
        redeemOpenClawWs: expect.any(Function),
        getUserGatewayId: expect.any(Function),
        agentControlRegistry: expect.any(Object),
      }),
    );
  });

  it("brokers Mattermost owner and user-id resolution through octogee-api", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      calls.push({ url, body });

      if (url.endsWith("/internal/openclaw/activity/channel-owner")) {
        return new Response(JSON.stringify({ ownerUid: "uid-owner" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/internal/openclaw/activity/user-by-mm")) {
        return new Response(JSON.stringify({ uid: "uid-author" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl,
    });

    await expect(broker.resolveChannelOwnerUid("mm-channel")).resolves.toBe("uid-owner");
    await expect(broker.resolveOctogeeUidByMmUser("mm-user")).resolves.toBe("uid-author");
    expect(calls).toEqual([
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/channel-owner",
        body: { gatewayId: "gw-bender", channelId: "mm-channel" },
      },
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/user-by-mm",
        body: { gatewayId: "gw-bender", mmUserId: "mm-user" },
      },
    ]);
  });

  it("brokers preview membership without requiring Firestore access in the gateway pod", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ authorized: body.uid === "uid-member" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl,
    });

    await expect(
      broker.authorizePreviewAccess("uid-member", "acme", "launch-room"),
    ).resolves.toBe(true);
    await expect(
      broker.authorizePreviewAccess("uid-outsider", "acme", null),
    ).resolves.toBe(false);
    expect(calls).toEqual([
      {
        url: "http://octogee-api:3001/internal/openclaw/previews/authorize",
        body: {
          gatewayId: "gw-bender",
          uid: "uid-member",
          workspaceSlug: "acme",
          projectSlug: "launch-room",
        },
      },
      {
        url: "http://octogee-api:3001/internal/openclaw/previews/authorize",
        body: {
          gatewayId: "gw-bender",
          uid: "uid-outsider",
          workspaceSlug: "acme",
          projectSlug: null,
        },
      },
    ]);
  });
});

describe("activity write receipts", () => {
  it("brokers every receipt transition with the bound gateway and channel path", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const eventKey = "a".repeat(64);
    const digest = "b".repeat(64);
    const receipt = {
      eventKey,
      payloadDigest: digest,
      state: "claimed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 1_100,
      attachment: { state: "none" },
      updatedAt: 100,
    };
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/activity/write-receipts/claim")) {
        return new Response(JSON.stringify({ outcome: "claimed", receipt, recovered: false }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/activity/write-receipts/read")) {
        return new Response(JSON.stringify({ receipt }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl,
    });
    const store = broker.activityWriteReceiptsFor("workspaces/bob/channels/coach-dm");

    await expect(store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 100,
      leaseMs: 1_000,
    })).resolves.toEqual({ outcome: "claimed", receipt, recovered: false });
    await expect(store.read(eventKey)).resolves.toEqual(receipt);
    await store.markPosted(eventKey, "lease-1", "post-1", 101);
    await store.updateAttachment(eventKey, "lease-1", {
      state: "attached",
      fileId: "file-1",
      sha256: digest,
      byteLength: 8,
    }, 102);
    await store.commit(eventKey, "lease-1", 103);

    expect(calls.map(({ url, body }) => ({
      path: new URL(url).pathname,
      body,
    }))).toEqual([
      {
        path: "/internal/openclaw/activity/write-receipts/claim",
        body: {
          gatewayId: "gw-bender",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          input: {
            eventKey,
            payloadDigest: digest,
            historyAnchorPostId: "anchor-1",
            leaseOwner: "pod-1",
            now: 100,
            leaseMs: 1_000,
          },
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/read",
        body: { gatewayId: "gw-bender", channelDocPath: "workspaces/bob/channels/coach-dm", eventKey },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/mark-posted",
        body: {
          gatewayId: "gw-bender",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          postId: "post-1",
          now: 101,
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/attachment",
        body: {
          gatewayId: "gw-bender",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          attachment: {
            state: "attached",
            fileId: "file-1",
            sha256: digest,
            byteLength: 8,
          },
          now: 102,
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/commit",
        body: {
          gatewayId: "gw-bender",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          now: 103,
        },
      },
    ]);
  });

  it("preserves receipt conflict and lease semantics across the broker", async () => {
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl: vi.fn(async (input) => new Response(
        JSON.stringify({
          error: String(input).endsWith("/claim") ? "receipt_conflict" : "receipt_leased",
        }),
        { headers: { "content-type": "application/json" }, status: 409 },
      )),
    });
    const store = broker.activityWriteReceiptsFor("workspaces/bob/channels/coach-dm");

    await expect(store.claim({
      eventKey: "a".repeat(64),
      payloadDigest: "b".repeat(64),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 100,
      leaseMs: 1_000,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
    await expect(store.commit("a".repeat(64), "lease-1", 101))
      .rejects.toBeInstanceOf(ActivityReceiptLeaseError);
  });
});
