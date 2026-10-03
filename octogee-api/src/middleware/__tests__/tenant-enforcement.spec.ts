import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createTenantEnforcementMiddleware } from "../tenant-enforcement.js";
import type { TenantDenial, TenantDenialReporter } from "../tenant-denial.js";

type UserDoc = Record<string, unknown>;
type FlowDoc = Record<string, unknown>;
type OperationDoc = Record<string, unknown>;

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function fakeDb(opts: {
  users: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
  operations?: Record<string, OperationDoc>;
  gateways?: Record<string, Record<string, unknown>>;
  // gateways/{gatewayId}/assignments/{uid} — the Step 2 roster layer. Empty by
  // default: the roster then falls back to the assigned user mirror (legacy).
  assignments?: Record<string, Record<string, Record<string, unknown>>>;
}): Pick<Firestore, "collection"> {
  return {
    collection: (name: string) => {
      if (name === "gateways") {
        return {
          doc: (gatewayId: string) => ({
            get: async () => ({
              exists: Object.prototype.hasOwnProperty.call(opts.gateways ?? {}, gatewayId),
              data: () => opts.gateways?.[gatewayId],
            }),
            collection: (_sub: string) => ({
              get: async () => ({
                docs: Object.entries(opts.assignments?.[gatewayId] ?? {}).map(
                  ([uid, data]) => ({ id: uid, data: () => data }),
                ),
              }),
            }),
          }),
        };
      }
      const records =
        name === "byosubFlows"
          ? (opts.flows ?? {})
          : name === "glmOperations"
            ? (opts.operations ?? {})
            : opts.users;
      const query = (filters: Array<{ field: string; value: unknown }> = []) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: Object.prototype.hasOwnProperty.call(records, id),
            data: () => records[id],
          }),
        }),
        where: (field: string, _op: string, value: unknown) =>
          query([...filters, { field, value }]),
        limit: () => query(filters),
        get: async () => ({
          docs: Object.entries(records)
            .filter(([, data]) =>
              filters.every((filter) => valueAtPath(data, filter.field) === filter.value),
            )
            .map(([id, data]) => ({ id, data: () => data })),
        }),
      });
      return query();
    },
  } as unknown as Pick<Firestore, "collection">;
}

function app(opts: {
  boundTenant?: Express.Request["boundTenant"];
  users?: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
  operations?: Record<string, OperationDoc>;
  gateways?: Record<string, Record<string, unknown>>;
  onDenied?: TenantDenialReporter;
}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (opts.boundTenant) req.boundTenant = opts.boundTenant;
    next();
  });
  const enforcement = createTenantEnforcementMiddleware({
    onDenied: opts.onDenied ?? (async () => {}),
    db: fakeDb({
      users:
        opts.users ?? {
          alice: {
            username: "alice",
            provisioning: { openclaw: { slug: "alice", gatewayId: "bender" } },
          },
          victim: {
            username: "victim",
            provisioning: { openclaw: { slug: "victim", gatewayId: "other" } },
          },
        },
      flows: opts.flows,
      operations: opts.operations,
      gateways: opts.gateways,
    }),
  });
  const handler = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  a.post("/internal/probe", enforcement, handler);
  a.post("/internal/probe/:uid", enforcement, handler);
  a.post("/internal/connectors/access-token", enforcement, handler);
  a.post("/internal/connectors/github-project-clone-access", enforcement, handler);
  a.post("/internal/byok/agent-usage-status", enforcement, handler);
  a.post("/internal/byok/byosub-flow", enforcement, handler);
  a.post("/internal/byok/byosub-cred-syncback", enforcement, handler);
  a.post("/internal/openclaw-control/redeem", enforcement, handler);
  a.post("/internal/openclaw-control/authorize", enforcement, handler);
  a.post("/internal/openclaw-control/profile", enforcement, handler);
  a.post("/internal/openclaw-control/tool-conversation", enforcement, handler);
  a.post("/internal/voice/conversation", enforcement, handler);
  a.post("/internal/voice/turn", enforcement, handler);
  a.post("/internal/openclaw-control/mattermost/authorize", enforcement, handler);
  a.post("/internal/openclaw-control/mattermost/channels", enforcement, handler);
  a.post("/internal/openclaw/notifications/final-reply", enforcement, handler);
  a.post("/internal/openclaw/activity/session-context", enforcement, handler);
  a.post("/internal/openclaw/activity/dispatch-context", enforcement, handler);
  a.post("/internal/agent-support/ask", enforcement, handler);
  a.post("/internal/openclaw/previews/authorize", enforcement, handler);
  a.post("/internal/workspace-git/authorize", enforcement, handler);
  a.post("/internal/channel-agent-readiness/authorize", enforcement, handler);
  a.post("/internal/agent-projects/create", enforcement, handler);
  a.post("/internal/agent-projects/list", enforcement, handler);
  a.post("/internal/agent-projects/set-recipe", enforcement, handler);
  a.post("/internal/agent-projects/delegate", enforcement, handler);
  a.post("/internal/agent-projects/identity", enforcement, handler);
  a.post("/internal/agent-board/list", enforcement, handler);
  a.post("/internal/agent-board/card-read", enforcement, handler);
  a.post("/internal/agent-board/card-create", enforcement, handler);
  a.post("/internal/agent-board/card-update", enforcement, handler);
  a.post("/internal/agent-board/card-move", enforcement, handler);
  a.post("/internal/agent-board/card-comment", enforcement, handler);
  a.post("/internal/agent-productivity/google/calendar/events", enforcement, handler);
  a.post("/internal/computer/agent-context", enforcement, handler);
  a.get("/internal/agent-imports/github/sources", enforcement, handler);
  a.get("/internal/agent-imports/records/:importId", enforcement, handler);
  a.patch("/internal/agent-imports/identity", enforcement, handler);
  a.delete("/internal/agent-imports/staging/:importId", enforcement, handler);
  a.post("/internal/fleet/agent/web-search", enforcement, handler);
  a.post("/internal/fleet/agent/web-extract", enforcement, handler);
  a.post("/internal/fleet/configured-builder-bootstrap", enforcement, handler);
  a.post("/internal/fleet/assigned-users", enforcement, handler);
  a.post("/internal/fleet/system-config-status", enforcement, handler);
  a.post("/internal/fleet/user-snapshot", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/download-url", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/snapshot-urls", enforcement, handler);
  a.post("/internal/fleet/builder-runtime-state/prune", enforcement, handler);
  a.post("/internal/fleet/computer-home/checkpoint-url", enforcement, handler);
  a.post("/internal/fleet/computer-home/commit", enforcement, handler);
  a.post("/internal/fleet/computer-home/download-url", enforcement, handler);
  a.post("/internal/fleet/computer-home/prune", enforcement, handler);
  a.post("/internal/fleet/vm-runtime", enforcement, handler);
  a.post("/internal/fleet/computer-egress", enforcement, handler);
  a.post("/internal/fleet/uid-for-slug", enforcement, handler);
  a.post("/internal/billing/check-trial-expiry", enforcement, handler);
  a.post("/internal/billing/run-auto-top-ups", enforcement, handler);
  a.post("/internal/chat-artifacts/claim", enforcement, handler);
  a.post("/internal/chat-artifacts/:artifactId/lease", enforcement, handler);
  a.post("/internal/product-analytics/events", enforcement, handler);
  a.post("/internal/fleet/npm-cache-authorize", enforcement, handler);
  a.post("/internal/fleet/npm-registry-credentials", enforcement, handler);
  a.post("/internal/notifications/social", enforcement, handler);
  a.post("/api/notifications/ingest", enforcement, handler);
  a.get("/internal/gitea/user-pubkey", enforcement, handler);
  return a;
}

const BENDER: Express.Request["boundTenant"] = {
  kind: "gateway",
  gatewayId: "bender",
  ownerUid: "owner-bender",
};

const BENDER_R2: Express.Request["boundTenant"] = {
  ...BENDER,
  podName: "octogee-gateway-bender-r2-5bc5949d46-p946t",
  podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
};

function configuredBender(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: "bender",
    createdAt: 1,
    createdBy: "admin",
    updatedAt: 2,
    updatedBy: "admin",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    liveRevisionId: "bender-r1",
    trafficRevisionId: "bender-r1",
    desiredStatus: "running",
    roll: {
      operationId: "roll-1",
      status: "warming",
      fromRelease: 1,
      toRelease: 2,
      sourceRevisionId: "bender-r1",
      targetRevisionId: "bender-r2",
      acceptingNewAssignments: false,
      startedAt: 2,
      updatedAt: 2,
      error: null,
      flippedAt: null,
    },
    configSchemaVersion: 1,
    profile: "builder",
    gatewayClass: "builder",
    imageProfile: "builder",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-bender",
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "owner-bender",
    builderSlug: "victim",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("tenant enforcement middleware", () => {
  it.each([
    "/internal/billing/check-trial-expiry",
    "/internal/billing/run-auto-top-ups",
  ])("allows the cron caller on %s", async (path) => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post(path)
      .send({});
    expect(res.status).toBe(200);
  });

function disposableClaim(uid: string, extra: Record<string, unknown> = {}) {
  return {
    gatewayId: "ceckert-s-072b95aa",
    gatewayClass: "builder",
    desiredStatus: "running",
    ownerUid: uid,
    builderSlug: "ceckert",
    allocation: {
      kind: "disposable-builder",
      schemaVersion: 1,
      leaseId: "lease-1",
      generation: 41,
      claimedByUid: uid,
    },
    ...extra,
  };
}

const CLAIMING_GATEWAY = {
  kind: "gateway",
  gatewayId: "ceckert-s-072b95aa",
  ownerUid: "uid-ceckert",
} as const;

// The user mirror still names the shared slot until activation completes, so a
// booting disposable builder cannot bootstrap unless its own claim counts.
const STILL_ON_SHARED = {
  "uid-ceckert": {
    username: "ceckert",
    provisioning: { openclaw: { slug: "ceckert", gatewayId: "shared-0" } },
  },
};

  it("lets a booting disposable builder bootstrap the user it has claimed", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: STILL_ON_SHARED,
      gateways: { "ceckert-s-072b95aa": disposableClaim("uid-ceckert") },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-ceckert" });

    expect(res.status).toBe(200);
  });

  it("refuses a disposable builder naming a user it has not claimed", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: {
        "uid-other": {
          username: "other",
          provisioning: { openclaw: { slug: "other", gatewayId: "shared-0" } },
        },
      },
      gateways: { "ceckert-s-072b95aa": disposableClaim("uid-ceckert") },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-other" });

    expect(res.status).toBe(403);
  });

  it("refuses a retired gateway still carrying a stale claim", async () => {
    const res = await request(app({
      boundTenant: CLAIMING_GATEWAY,
      users: STILL_ON_SHARED,
      gateways: {
        "ceckert-s-072b95aa": disposableClaim("uid-ceckert", { desiredStatus: "retired" }),
      },
    }))
      .post("/internal/fleet/system-config-status")
      .send({ uid: "uid-ceckert" });

    expect(res.status).toBe(403);
  });

  it("forbids a platform-bound caller on any non-cron internal route (no skeleton key)", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
  });

  it("allows the artifact worker only on artifact worker routes", async () => {
    const worker = { kind: "platform", actor: "artifact-worker" } as const;
    const claim = await request(app({ boundTenant: worker }))
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "artifact-worker-1" });
    const lease = await request(app({ boundTenant: worker }))
      .post(`/internal/chat-artifacts/${"a".repeat(64)}/lease`)
      .send({});
    const billing = await request(app({ boundTenant: worker }))
      .post("/internal/billing/check-trial-expiry")
      .send({});
    const cronClaim = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/chat-artifacts/claim")
      .send({ workerId: "cron" });

    expect(claim.status).toBe(200);
    expect(lease.status).toBe(200);
    expect(billing.status).toBe(403);
    expect(cronClaim.status).toBe(403);
  });

  it("allows the LLM broker only on its product-event route", async () => {
    const broker = { kind: "platform", actor: "llm-broker" } as const;
    const productEvent = await request(app({ boundTenant: broker }))
      .post("/internal/product-analytics/events")
      .send({ uid: "uid-alice" });
    const billing = await request(app({ boundTenant: broker }))
      .post("/internal/billing/check-trial-expiry")
      .send({});
    const cronProductEvent = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/product-analytics/events")
      .send({ uid: "uid-alice" });

    expect(productEvent.status).toBe(200);
    expect(billing.status).toBe(403);
    expect(cronProductEvent.status).toBe(403);
  });

  it("allows the npm cache proxy only on capability authorization", async () => {
    const proxy = { kind: "platform", actor: "npm-cache-proxy" } as const;
    const authorize = await request(app({ boundTenant: proxy }))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: "opaque" });
    const productEvent = await request(app({ boundTenant: proxy }))
      .post("/internal/product-analytics/events")
      .send({ uid: "uid-alice" });
    const cronAuthorize = await request(app({
      boundTenant: { kind: "platform", actor: "cron" },
    }))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: "opaque" });

    expect(authorize.status).toBe(200);
    expect(productEvent.status).toBe(403);
    expect(cronAuthorize.status).toBe(403);
  });

  it("does not honor a legacy X-Internal-Service-Key", async () => {
    const res = await request(app({}))
      .post("/internal/billing/check-trial-expiry")
      .set("X-Internal-Service-Key", "platform-key")
      .send({});

    expect(res.status).toBe(403);
  });

  it("rejects missing binding before route handlers run", async () => {
    const res = await request(app({}))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "forbidden: request carries no gateway tenant binding",
      code: "tenant-enforcement",
    });
  });

  describe("denial reporting", () => {
    function denialCapture() {
      const denials: TenantDenial[] = [];
      const onDenied = vi.fn(async (denial: TenantDenial) => { denials.push(denial); });
      return { denials, onDenied };
    }

    it("reports a fall-through deny with the reason, the bound tenant, and the calling agent", async () => {
      const { denials, onDenied } = denialCapture();
      const res = await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/probe")
        .send({ agentId: "octogee-alice-coach" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "forbidden: route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
        code: "tenant-enforcement",
      });
      expect(denials).toEqual([{
        method: "POST",
        path: "/internal/probe",
        reason: "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
        cause: "policy",
        tenant: { kind: "gateway", gatewayId: "bender", ownerUid: "owner-bender" },
        agentId: "octogee-alice-coach",
      }]);
    });

    it("marks assignment-skew denials as placement so they stay out of the Builder's inbox", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/agent-projects/list")
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" })
        .expect(403);
      await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/probe")
        .send({ workspaceSlug: "stranger" })
        .expect(403);
      await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/probe")
        .send({ agentId: "octogee-alice-coach" })
        .expect(403);
      expect(denials.map((d) => [d.reason, d.cause])).toEqual([
        ["request names a gatewayId other than the bound gateway", "placement"],
        ["request names a workspace slug not assigned to the bound gateway", "placement"],
        ["route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow", "policy"],
      ]);
    });

    it("reports a foreign-gateway deny and a platform-actor deny with their own reasons", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/agent-projects/list")
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" })
        .expect(403);
      await request(app({ boundTenant: { kind: "platform", actor: "cron" }, onDenied }))
        .post("/internal/probe")
        .send({})
        .expect(403);

      expect(denials.map((d) => [d.tenant, d.reason, d.agentId])).toEqual([
        [
          { kind: "gateway", gatewayId: "bender", ownerUid: "owner-bender" },
          "request names a gatewayId other than the bound gateway",
          "octogee-alice-coach",
        ],
        [{ kind: "platform", actor: "cron" }, "platform actor cron is not admitted on this route", null],
      ]);
    });

    it("reports an unbound deny without an agent", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ onDenied })).post("/internal/probe").send({ agentId: 42 }).expect(403);
      expect(denials).toEqual([{
        method: "POST",
        path: "/internal/probe",
        reason: "request carries no gateway tenant binding",
        cause: "policy",
        tenant: { kind: "unbound" },
        agentId: null,
      }]);
    });

    it("does not report an admitted call", async () => {
      const { denials, onDenied } = denialCapture();
      await request(app({ boundTenant: BENDER, onDenied }))
        .post("/internal/agent-projects/list")
        .send({ agentId: "octogee-alice-coach" })
        .expect(200);
      expect(denials).toEqual([]);
    });

    it("still answers 403 when the reporter rejects", async () => {
      const onDenied = vi.fn(async () => { throw new Error("inbox down"); });
      const res = await request(app({ boundTenant: BENDER, onDenied })).post("/internal/probe").send({});
      expect(res.status).toBe(403);
      expect(onDenied).toHaveBeenCalledOnce();
    });
  });

  it("allows a gateway-bound caller to target its own gatewayId only", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "bender" });

    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "other" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("admits the exact web-extension body only when it claims the bound gateway", async () => {
    const extensionBody = {
      gatewayId: "bender",
      agentId: "octogee-alice-coach",
      requestId: "tool-1",
      provider: "brave",
      query: "octopus research",
    };
    const admitted = await request(app({ boundTenant: BENDER }))
      .post("/internal/fleet/agent/web-search")
      .send(extensionBody);
    const missingGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/fleet/agent/web-search")
      .send({ ...extensionBody, gatewayId: undefined });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/fleet/agent/web-extract")
      .send({ ...extensionBody, gatewayId: "other", urls: ["https://example.com"] });

    expect(admitted.status).toBe(200);
    expect(missingGateway.status).toBe(403);
    expect(foreignGateway.status).toBe(403);
  });

  it("allows a gateway-bound caller to target only users assigned to that gateway", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ uid: "alice" });

    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ uid: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("does not let a matching gatewayId bypass uid ownership checks on ordinary routes", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "bender", uid: "alice" });

    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "bender", uid: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("admits only a bound gateway to the final reply route's own recipient authorization", async () => {
    const path = "/internal/openclaw/notifications/final-reply";
    expect((await request(app({ boundTenant: BENDER })).post(path).send({ gatewayId: "bender" })).status).toBe(200);
    expect((await request(app({ boundTenant: BENDER })).post(path).send({ gatewayId: "other" })).status).toBe(403);
    expect((await request(app({})).post(path).send({ gatewayId: "bender" })).status).toBe(403);
    expect((await request(app({ boundTenant: { kind: "platform", actor: "cron" } })).post(path).send({ gatewayId: "bender" })).status).toBe(403);
  });

  it("does not let a matching gatewayId bypass foreign notification recipients", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/api/notifications/ingest")
      .send({ gatewayId: "bender", targetUserIds: ["alice"] });
    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/api/notifications/ingest")
      .send({ gatewayId: "bender", targetUserIds: ["victim"] });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("never lends gateway authority to the platform-wide social fanout", async () => {
    const res = await request(app({ boundTenant: BENDER }))
      .post("/internal/notifications/social")
      .send({
        gatewayId: "bender",
        actorUid: "alice",
        type: "announcement",
        targetUserIds: [],
      });

    expect(res.status).toBe(403);
  });

  it("keeps the platform producer authorized for the social fanout", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/notifications/social")
      .send({
        actorUid: "admin",
        actorName: "Octogee",
        type: "announcement",
        targetUserIds: [],
      });

    expect(res.status).toBe(200);
  });

  it("lets the connector-token broker perform its own project-membership authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/connectors/access-token")
      .send({
        gatewayId: "bender",
        uid: "victim",
        access: {
          kind: "project",
          requestingUid: "owner-bender",
          workspaceSlug: "victim",
          projectSlug: "octo",
        },
      });

    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/connectors/access-token")
      .send({
        gatewayId: "other",
        uid: "victim",
        access: {
          kind: "project",
          requestingUid: "owner-bender",
          workspaceSlug: "victim",
          projectSlug: "octo",
        },
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("lets the fleet broker resolve an unassigned stale slug for idempotent eviction", async () => {
    const stale = await request(app({ boundTenant: BENDER }))
      .post("/internal/fleet/uid-for-slug")
      .send({ gatewayId: "bender", slug: "departed" });

    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/fleet/uid-for-slug")
      .send({ gatewayId: "other", slug: "alice" });

    expect(stale.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes a configured Builder owner snapshot to the route-level admission", async () => {
    const target = app({
      boundTenant: BENDER_R2,
      gateways: { bender: configuredBender() },
    });
    const owner = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "bender", uid: "owner-bender" });
    const foreignGateway = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "other", uid: "owner-bender" });

    expect(owner.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("lets computer context resolve its own assigned-agent authorization", async () => {
    const target = app({ boundTenant: BENDER });
    const response = await request(target).post("/internal/computer/agent-context").send({ agentId: "octogee-alice-coach" });
    expect(response.status).toBe(200);
  });

  it("lets the byosub flow broker perform its own roster authorization for new flows", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER, flows: {} }))
      .post("/internal/byok/byosub-flow")
      .send({
        flowId: "fresh-flow-123",
        agentId: "octogee-alice-coach",
        provider: "anthropic",
      });

    const foreignGateway = await request(app({ boundTenant: BENDER, flows: {} }))
      .post("/internal/byok/byosub-flow")
      .send({
        gatewayId: "other",
        flowId: "fresh-flow-123",
        agentId: "octogee-alice-coach",
        provider: "anthropic",
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes byosub credential syncback to route-level roster authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/byosub-cred-syncback")
      .send({ agentId: "octogee-alice-coach", provider: "openai", credential: "{}" });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/byosub-cred-syncback")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach", provider: "openai", credential: "{}" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes agent usage status to route-level roster authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/agent-usage-status")
      .send({ agentId: "octogee-alice-coach" });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/agent-usage-status")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes agent support to route-level roster authorization without trusting body context", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/agent-support/ask")
      .send({ agentId: "octogee-alice-coach", question: "Help", uid: "victim" });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/agent-support/ask")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach", question: "Help" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes session context to route-level agent and channel authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/activity/session-context")
      .send({
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/activity/session-context")
      .send({
        gatewayId: "other",
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });
    const platform = await request(
      app({ boundTenant: { kind: "platform", actor: "cron" } }),
    )
      .post("/internal/openclaw/activity/session-context")
      .send({
        agentId: "octogee-alice-coach",
        channelId: "mattermost-task-channel",
      });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
    expect(platform.status).toBe(403);
  });

  it("passes dispatch context only to the bound gateway tenant", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ agentId: "octogee-alice-coach" });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach" });
    const platform = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/openclaw/activity/dispatch-context")
      .send({ agentId: "octogee-alice-coach" });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
    expect(platform.status).toBe(403);
  });

  it("delegates exact OpenClaw Control routes only for the bound gateway tenant", async () => {
    for (const route of ["redeem", "authorize", "profile", "tool-conversation", "mattermost/authorize", "mattermost/channels"]) {
      const ownedGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/openclaw-control/${route}`)
        .send({ gatewayId: "bender", uid: "victim" });
      const foreignGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/openclaw-control/${route}`)
        .send({ gatewayId: "other" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("delegates voice conversation and turn brokering only for the bound gateway tenant", async () => {
    for (const route of ["conversation", "turn"]) {
      const ownedGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/voice/${route}`)
        .send({ gatewayId: "bender", uid: "victim", channelId: "c".repeat(26), text: "hello" });
      const foreignGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/voice/${route}`)
        .send({ gatewayId: "other", uid: "victim", channelId: "c".repeat(26), text: "hello" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("lets preview authorization evaluate a member whose own agent is on another gateway", async () => {
    const delegated = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/previews/authorize")
      .send({
        gatewayId: "bender",
        uid: "victim",
        workspaceSlug: "alice",
        projectSlug: "launch-room",
      });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/openclaw/previews/authorize")
      .send({
        gatewayId: "other",
        uid: "victim",
        workspaceSlug: "alice",
        projectSlug: "launch-room",
      });

    expect(delegated.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("delegates agent project routes only for the bound gateway tenant", async () => {
    for (const route of ["create", "list", "set-recipe", "delegate", "identity"]) {
      const ownedGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/agent-projects/${route}`)
        .send({ agentId: "octogee-alice-coach" });
      const foreignGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/agent-projects/${route}`)
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("delegates agent board routes only for the bound gateway tenant", async () => {
    for (const route of ["list", "card-read", "card-create", "card-update", "card-move", "card-comment"]) {
      const ownedGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/agent-board/${route}`)
        .send({ agentId: "octogee-alice-coach" });
      const foreignGateway = await request(app({ boundTenant: BENDER }))
        .post(`/internal/agent-board/${route}`)
        .send({ gatewayId: "other", agentId: "octogee-alice-coach" });

      expect(ownedGateway.status, route).toBe(200);
      expect(foreignGateway.status, route).toBe(403);
    }
  });

  it("delegates bearer-blind productivity routes only for the bound gateway tenant", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/agent-productivity/google/calendar/events")
      .send({ agentId: "octogee-alice-coach", params: {} });
    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/agent-productivity/google/calendar/events")
      .send({ gatewayId: "other", agentId: "octogee-alice-coach", params: {} });

    expect(ownedGateway.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("allows a gateway-bound caller to target only slugs assigned to that gateway", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ slug: "alice" });

    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ slug: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("does not let a matching gatewayId bypass slug ownership checks on ordinary routes", async () => {
    const owned = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "bender", slug: "alice" });

    const foreign = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({ gatewayId: "bender", slug: "victim" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("allows Gitea broker slug access during a running inbound customer migration", async () => {
    const inbound = await request(
      app({
        boundTenant: BENDER,
        operations: {
          inbound: {
            kind: "migrate-customer",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "bender" },
          },
        },
      }),
    )
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    const ordinaryRoute = await request(
      app({
        boundTenant: BENDER,
        operations: {
          inbound: {
            kind: "migrate-customer",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "bender" },
          },
        },
      }),
    )
      .post("/internal/probe")
      .send({ slug: "victim" });

    expect(inbound.status).toBe(200);
    expect(ordinaryRoute.status).toBe(403);
  });

  it("keeps the Gitea inbound migration allowance scoped to the target gateway", async () => {
    const res = await request(
      app({
        boundTenant: BENDER,
        operations: {
          inbound: {
            kind: "migrate-customer",
            status: "running",
            inputUid: "victim",
            input: { uid: "victim", toGatewayId: "other" },
          },
        },
      }),
    )
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(res.status).toBe(403);
  });

  it("allows an authenticated stable gateway pod to bootstrap its configured builder", async () => {
    const res = await request(app({
      boundTenant: BENDER_R2,
      gateways: { bender: configuredBender() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(res.status).toBe(200);
  });

  it("passes configured builder credential bootstrap to its stricter route-level authorization", async () => {
    const res = await request(app({
      boundTenant: BENDER_R2,
      gateways: { bender: configuredBender() },
    }))
      .post("/internal/fleet/configured-builder-bootstrap")
      .send({ gatewayId: "bender", revisionId: "bender-r2", slug: "victim" });

    expect(res.status).toBe(200);
  });

  it("passes configured builder owner snapshots to their stricter route-level authorization", async () => {
    const target = app({
      boundTenant: BENDER_R2,
      gateways: { bender: configuredBender() },
    });

    const owner = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "bender", uid: "victim" });
    const foreignGateway = await request(target)
      .post("/internal/fleet/user-snapshot")
      .send({ gatewayId: "other", uid: "victim" });

    expect(owner.status).toBe(200);
    expect(foreignGateway.status).toBe(403);
  });

  it("passes builder runtime state snapshot and prune routes to their allocation-bound authorization", async () => {
    const target = app({
      boundTenant: BENDER_R2,
      gateways: { bender: configuredBender() },
    });

    const download = await request(target)
      .post("/internal/fleet/builder-runtime-state/download-url")
      .send({ gatewayId: "bender", revisionId: "bender-r2", slug: "victim" });
    const snapshot = await request(target)
      .post("/internal/fleet/builder-runtime-state/snapshot-urls")
      .send({
        gatewayId: "bender",
        revisionId: "bender-r2",
        slug: "victim",
        size: 1024,
        recoveryTiers: ["minute"],
      });
    const prune = await request(target)
      .post("/internal/fleet/builder-runtime-state/prune")
      .send({ gatewayId: "bender", revisionId: "bender-r2", slug: "victim" });
    const foreign = await request(target)
      .post("/internal/fleet/builder-runtime-state/download-url")
      .send({ gatewayId: "other", revisionId: "other", slug: "victim" });

    expect(download.status).toBe(200);
    expect(snapshot.status).toBe(200);
    expect(prune.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("passes channel readiness to its user-membership broker and rejects a foreign gateway", async () => {
    const target = app({ boundTenant: BENDER, gateways: { bender: configuredBender() } });
    const route = "/internal/channel-agent-readiness/authorize";
    expect((await request(target).post(route).send({ gatewayId: "bender", channelId: "a".repeat(26) })).status).toBe(200);
    expect((await request(target).post(route).send({ gatewayId: "other", channelId: "a".repeat(26) })).status).toBe(403);
  });

  it("passes computer-home checkpoint routes to their VM-bound authorization and rejects a claimed foreign gateway", async () => {
    const target = app({
      boundTenant: { ...BENDER, podName: "octogee-gw-bender", podUid: "4242" },
      gateways: { bender: configuredBender() },
    });
    const routes = ["checkpoint-url", "commit", "download-url", "prune"] as const;

    for (const route of routes) {
      const own = await request(target)
        .post(`/internal/fleet/computer-home/${route}`)
        .send({ gatewayId: "bender", slug: "victim", size: 1 });
      const foreign = await request(target)
        .post(`/internal/fleet/computer-home/${route}`)
        .send({ gatewayId: "other", slug: "victim", size: 1 });
      expect(own.status, route).toBe(200);
      expect(foreign.status, route).toBe(403);
    }
  });

  it("admits the computer egress mode route for the gateway's own binding with an empty body and refuses a foreign gateway claim", async () => {
    const target = app({
      boundTenant: { ...BENDER, podName: "octogee-gw-bender", podUid: "4242" },
      gateways: { bender: configuredBender() },
    });
    expect((await request(target).post("/internal/fleet/computer-egress").send({})).status).toBe(200);
    expect((await request(target).post("/internal/fleet/computer-egress").send({ mode: "desktop" })).status).toBe(200);
    expect((await request(target).post("/internal/fleet/computer-egress").send({ gatewayId: "other", mode: "desktop" })).status).toBe(403);
  });

  it("limits a retired computer's final-checkpoint binding to the runtime bundle and checkpoint upload routes", async () => {
    const target = app({
      boundTenant: { ...BENDER, podName: "octogee-gw-bender", podUid: "4242", finalHomeCheckpoint: true },
      gateways: { bender: configuredBender({ desiredStatus: "retired" }) },
    });
    const send = (path: string, body: Record<string, unknown> = { gatewayId: "bender", slug: "alice", size: 1 }) =>
      request(target).post(path).send(body);

    for (const path of ["/internal/fleet/vm-runtime", "/internal/fleet/computer-home/checkpoint-url", "/internal/fleet/computer-home/commit", "/internal/fleet/computer-home/prune"]) {
      expect((await send(path)).status, path).toBe(200);
    }
    for (const path of [
      "/internal/fleet/computer-home/download-url",
      "/internal/fleet/user-snapshot",
      "/internal/fleet/configured-builder-bootstrap",
      "/internal/fleet/builder-runtime-state/download-url",
      "/internal/openclaw-control/authorize",
      "/internal/workspace-git/authorize",
      "/internal/channel-agent-readiness/authorize",
      "/internal/byok/agent-usage-status",
      "/internal/agent-projects/list",
      "/internal/computer/agent-context",
    ]) {
      expect((await send(path)).status, path).toBe(403);
    }
    expect((await send("/internal/probe", { uid: "alice" })).status).toBe(403);
    expect((await send("/internal/probe", { gatewayId: "bender" })).status).toBe(403);
    expect((await send("/internal/fleet/computer-home/commit", { gatewayId: "other", slug: "alice", size: 1 })).status).toBe(403);
  });

  it("allows any pod of the gateway's own Deployment — identity, never lifecycle (GATEWAY-SIMPLE-ROLL-SPEC)", async () => {
    const anyPod = await request(app({
      boundTenant: {
        ...BENDER_R2,
        podName: "octogee-gateway-bender-r1-5bc5949d46-p946t",
      },
      gateways: { bender: configuredBender() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(anyPod.status).toBe(200);
  });

  it("rejects unbound callers and revokes configured-builder bootstrap while retiring", async () => {
    const unbound = await request(app({
      boundTenant: BENDER,
      gateways: { bender: configuredBender() },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });
    const retiring = await request(app({
      boundTenant: BENDER_R2,
      gateways: {
        bender: configuredBender({
          retirementClaim: { operationId: "retire-1", version: 1 },
        }),
      },
    }))
      .get("/internal/gitea/user-pubkey")
      .query({ slug: "victim" });

    expect(unbound.status).toBe(403);
    expect(retiring.status).toBe(403);
  });

  it("allows BYOS capture only for flows owned by the bound gateway", async () => {
    const owned = await request(
      app({
        boundTenant: BENDER,
        flows: {
          owned: { gatewayId: "bender" },
          foreign: { gatewayId: "other" },
        },
      }),
    )
      .post("/internal/probe")
      .send({ flowId: "owned" });

    const foreign = await request(
      app({
        boundTenant: BENDER,
        flows: {
          owned: { gatewayId: "bender" },
          foreign: { gatewayId: "other" },
        },
      }),
    )
      .post("/internal/probe")
      .send({ gatewayId: "bender", flowId: "foreign" });

    expect(owned.status).toBe(200);
    expect(foreign.status).toBe(403);
  });

  it("rejects unknown BYOS capture flows before the route handler runs", async () => {
    const res = await request(app({ boundTenant: BENDER, flows: {} }))
      .post("/internal/probe")
      .send({ flowId: "missing" });

    expect(res.status).toBe(403);
  });

  it("rejects targetless gateway-bound calls so global jobs stay platform-only", async () => {
    const res = await request(app({ boundTenant: BENDER }))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
  });

  it("admits targetless agent-import broker calls for route-local owner authorization", async () => {
    const target = app({ boundTenant: BENDER });
    const responses = await Promise.all([
      request(target).get("/internal/agent-imports/github/sources"),
      request(target).get("/internal/agent-imports/records/import-1"),
      request(target).patch("/internal/agent-imports/identity").send({ name: "Moof" }),
      request(target).delete("/internal/agent-imports/staging/import-1"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  });
});

it.each(["/internal/fleet/npm-registry-credentials", "/internal/connectors/github-project-clone-access"])(
  "passes %s preparation to its operation-bound authorization while rejecting a foreign gateway", async (route) => {
    const target = app({ boundTenant: BENDER_R2 });
    const responses = await Promise.all([
      request(target).post(route).send({ gatewayId: "bender", slug: "victim", access: { kind: "project-clone", builderSlug: "victim", projectSlug: "project" } }),
      request(target).post(route).send({ gatewayId: "other", slug: "victim", access: { kind: "project-clone", builderSlug: "victim", projectSlug: "project" } }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 403]);
  },
);
