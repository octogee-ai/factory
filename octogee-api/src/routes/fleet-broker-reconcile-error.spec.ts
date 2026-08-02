import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";

function fixture(start = 1_000_000) {
  let now = start;
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const stored: Record<string, Record<string, unknown>> = {};
  const gatewayDoc = (id: string) => ({
    path: `gateways/${id}`,
    get: vi.fn(async () => ({ exists: true, data: () => stored[`gateways/${id}`] })),
    set: vi.fn(async (data: Record<string, unknown>) => {
      writes.push({ path: `gateways/${id}`, data });
      stored[`gateways/${id}`] = { ...stored[`gateways/${id}`], ...data };
    }),
  });
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "users") {
        return {
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              docs: [{
                id: "uid-alice",
                data: () => ({
                  provisioning: {
                    openclaw: { gatewayId: GATEWAY_ID, slug: "alice" },
                  },
                }),
              }],
            })),
          })),
        };
      }
      if (name === "gateways") return { doc: vi.fn(gatewayDoc) };
      throw new Error(`unexpected collection ${name}`);
    }),
    runTransaction: vi.fn(async (body: (txn: unknown) => Promise<void>) =>
      body({
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          writes.push({ path: ref.path, data });
          stored[ref.path] = { ...stored[ref.path], ...data };
        },
      })),
  };
  const server = express();
  server.disable("x-powered-by");
  server.use(express.json());
  server.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  server.use("/internal/fleet", createFleetBrokerRoutes({
    db: db as never,
    now: () => now,
  }));
  return {
    server,
    writes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function report(server: express.Express, message: string) {
  return request(server)
    .post("/internal/fleet/reconcile-error")
    .send({ gatewayId: GATEWAY_ID, slug: "alice", message });
}

describe("reconcile-error reporting", () => {
  it("writes the first report and drops an identical repeat inside the window", async () => {
    const { server, writes } = fixture();

    await expect(report(server, "mount failed").expect(204)).resolves.toBeDefined();
    await expect(report(server, "mount failed").expect(204)).resolves.toBeDefined();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`gateways/${GATEWAY_ID}`);
    expect(writes[0]?.data.lastError).toMatchObject({ slug: "alice", message: "mount failed" });
  });

  it("writes again once the window elapses", async () => {
    const { server, writes, advance } = fixture();

    await report(server, "mount failed").expect(204);
    advance(59_999);
    await report(server, "mount failed").expect(204);
    expect(writes).toHaveLength(1);

    advance(1);
    await report(server, "mount failed").expect(204);
    expect(writes).toHaveLength(2);
  });

  it("writes a different message immediately", async () => {
    const { server, writes } = fixture();

    await report(server, "mount failed").expect(204);
    await report(server, "unmount failed").expect(204);

    expect(writes.map((write) => (write.data.lastError as { message: string }).message)).toEqual([
      "mount failed",
      "unmount failed",
    ]);
  });

  it("lets the next report through after the error is cleared", async () => {
    const { server, writes } = fixture();

    await report(server, "mount failed").expect(204);
    await request(server)
      .post("/internal/fleet/clear-reconcile-error")
      .send({ gatewayId: GATEWAY_ID, slug: "alice" })
      .expect(204);
    await report(server, "mount failed").expect(204);

    expect(writes).toHaveLength(3);
    expect(writes[1]?.data).toEqual({ lastError: null });
  });
});
