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
}): Pick<Firestore, "collection"> {
  return {
    collection: (name: string) => {
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
            approved: true,
            username: "alice",
            provisioning: { openclaw: { slug: "alice", gatewayId: "bender" } },
          },
          victim: {
            approved: true,
            username: "victim",
            provisioning: { openclaw: { slug: "victim", gatewayId: "other" } },
          },
        },
      flows: opts.flows,
      operations: opts.operations,
    }),
  });
  const handler = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  a.post("/internal/probe", enforcement, handler);
  a.post("/internal/probe/:uid", enforcement, handler);
  a.post("/internal/connectors/access-token", enforcement, handler);
  a.post("/internal/byok/byosub-flow", enforcement, handler);
  a.post("/internal/byok/platform-embedding-key", enforcement, handler);
  a.post("/internal/billing/check-trial-expiry", enforcement, handler);
  a.post("/internal/billing/run-auto-top-ups", enforcement, handler);
  a.get("/internal/gitea/user-pubkey", enforcement, handler);
  return a;
}

const BENDER: Express.Request["boundTenant"] = {
  kind: "gateway",
  gatewayId: "bender",
  ownerUid: "owner-bender",
};

describe("tenant enforcement middleware", () => {
  it("allows a platform-bound cron caller on an allowlisted cron route", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/billing/check-trial-expiry")
      .send({});

    expect(res.status).toBe(200);
  });

  it("allows the cron caller on the auto-top-up sweep route", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/billing/run-auto-top-ups")
      .send({});

    expect(res.status).toBe(200);
  });

  it("forbids a platform-bound caller on any non-cron internal route (no skeleton key)", async () => {
    const res = await request(app({ boundTenant: { kind: "platform", actor: "cron" } }))
      .post("/internal/probe")
      .send({});

    expect(res.status).toBe(403);
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

  it("lets the platform embedding broker perform its own agent assignment authorization", async () => {
    const ownedGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/platform-embedding-key")
      .send({
        agentId: "octogee-alice-coach",
        provider: "openai",
      });

    const foreignGateway = await request(app({ boundTenant: BENDER }))
      .post("/internal/byok/platform-embedding-key")
      .send({
        gatewayId: "other",
        agentId: "octogee-alice-coach",
        provider: "openai",
      });

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
});
