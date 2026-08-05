import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTenantEnforcementMiddleware } from "../tenant-enforcement.js";

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
}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (opts.boundTenant) req.boundTenant = opts.boundTenant;
    next();
  });
  const enforcement = createTenantEnforcementMiddleware({
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
  a.post("/internal/byok/agent-usage-status", enforcement, handler);
  a.post("/internal/byok/byosub-flow", enforcement, handler);
  a.post("/internal/openclaw-control/redeem", enforcement, handler);
  a.post("/internal/openclaw-control/authorize", enforcement, handler);
  a.post("/internal/openclaw-control/audit", enforcement, handler);
  a.post("/internal/openclaw/activity/session-context", enforcement, handler);
  a.post("/internal/openclaw/activity/dispatch-context", enforcement, handler);
  a.post("/internal/agent-support/ask", enforcement, handler);
  a.post("/internal/openclaw/previews/authorize", enforcement, handler);
  a.post("/internal/agent-projects/create", enforcement, handler);
  a.post("/internal/agent-projects/list", enforcement, handler);
  a.post("/internal/agent-projects/set-recipe", enforcement, handler);
  a.post("/internal/agent-productivity/google/calendar/events", enforcement, handler);
  a.get("/internal/agent-access/context", enforcement, handler);
  a.post("/internal/agent-access/prepare", enforcement, handler);
  a.get("/internal/agent-access/approvals/:approvalId/status", enforcement, handler);
  a.get("/internal/agent-imports/github/sources", enforcement, handler);
  a.get("/internal/agent-imports/records/:importId", enforcement, handler);
  a.patch("/internal/agent-imports/identity", enforcement, handler);
  a.delete("/internal/agent-imports/staging/:importId", enforcement, handler);
  a.post("/internal/fleet/agent/web-search", enforcement, handler);
  a.post("/internal/fleet/agent/web-extract", enforcement, handler);
  a.post("/internal/fleet/configured-builder-bootstrap", enforcement, handler);
  a.post("/internal/fleet/uid-for-slug", enforcement, handler);
  a.post("/internal/billing/check-trial-expiry", enforcement, handler);
  a.post("/internal/billing/run-auto-top-ups", enforcement, handler);
  a.post("/internal/activity-pairs/report", enforcement, handler);
  a.post("/internal/chat-artifacts/claim", enforcement, handler);
  a.post("/internal/chat-artifacts/:artifactId/lease", enforcement, handler);
  a.post("/internal/product-analytics/events", enforcement, handler);
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
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-bender",
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: "owner-bender",
    builderSlug: "victim",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("tenant enforcement middleware", () => {
  it.each([
    "/internal/billing/check-trial-expiry",
    "/internal/billing/run-auto-top-ups",
    "/internal/activity-pairs/report",
  ])("allows the cron caller on %s", async (path) => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post(path)
      .send({});
    expect(res.status).toBe(200);
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
    expect(res.body).toEqual({ error: "forbidden" });
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

  it("lets the delegated-access broker perform its own assigned-agent authorization", async () => {
    const target = app({ boundTenant: BENDER });
    const context = await request(target)
      .get("/internal/agent-access/context")
      .query({ agentId: "octogee-alice-coach" });
    const prepare = await request(target)
      .post("/internal/agent-access/prepare")
      .send({ agentId: "octogee-alice-coach", granteeUid: "victim" });
    const status = await request(target)
      .get("/internal/agent-access/approvals/approval-1/status")
      .query({ agentId: "octogee-alice-coach" });

    expect(context.status).toBe(200);
    expect(prepare.status).toBe(200);
    expect(status.status).toBe(200);
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
    for (const route of ["redeem", "authorize", "audit"]) {
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
    for (const route of ["create", "list", "set-recipe"]) {
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

  it("rejects an unbound caller but keeps configured-builder bootstrap identity-pure while retiring", async () => {
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
    expect(retiring.status).toBe(200);
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
      .send({ flowId: "foreign" });

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
