import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTenantEnforcementMiddleware } from "../tenant-enforcement.js";

type UserDoc = Record<string, unknown>;
type FlowDoc = Record<string, unknown>;

function fakeDb(opts: {
  users: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
}): Pick<Firestore, "collection"> {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: Object.prototype.hasOwnProperty.call(
            name === "byosubFlows" ? (opts.flows ?? {}) : opts.users,
            id,
          ),
          data: () => (name === "byosubFlows" ? opts.flows?.[id] : opts.users[id]),
        }),
      }),
      where: (_field: string, _op: string, gatewayId: string) => ({
        get: async () => ({
          docs: Object.values(opts.users)
            .filter((data) => {
              const provisioning = data.provisioning as Record<string, unknown> | undefined;
              const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
              return openclaw?.gatewayId === gatewayId;
            })
            .map((data) => ({ data: () => data })),
        }),
      }),
    }),
  } as unknown as Pick<Firestore, "collection">;
}

function app(opts: {
  boundTenant?: Express.Request["boundTenant"];
  internalServiceKey?: string;
  users?: Record<string, UserDoc>;
  flows?: Record<string, FlowDoc>;
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
    }),
    internalServiceKey: opts.internalServiceKey,
  });
  const handler = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  a.post("/internal/probe", enforcement, handler);
  a.post("/internal/probe/:uid", enforcement, handler);
  a.post("/internal/connectors/access-token", enforcement, handler);
  return a;
}

const BENDER: Express.Request["boundTenant"] = {
  kind: "gateway",
  gatewayId: "bender",
  ownerUid: "owner-bender",
};

describe("tenant enforcement middleware", () => {
  it("allows the explicit platform-key carve-out for targetless global jobs", async () => {
    const res = await request(app({ internalServiceKey: "platform-key" }))
      .post("/internal/probe")
      .set("X-Internal-Service-Key", "platform-key")
      .send({});

    expect(res.status).toBe(200);
  });

  it("rejects missing binding/key before route handlers run", async () => {
    const res = await request(app({ internalServiceKey: "platform-key" }))
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
