import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAutomationsRouter } from "./automations.js";

function appForTest(overrides: Partial<Parameters<typeof createAutomationsRouter>[0]> = {}) {
  const defaultInvoke = vi.fn(async (method: string) => {
    if (method === "config.get") {
      return {
        hash: "config-hash",
        config: {
          agents: {
            list: [{
              id: "octogee-alice-coach",
              heartbeat: { every: "30m", target: "last", directPolicy: "allow" },
            }],
          },
        },
      };
    }
    return { jobs: [] };
  });
  const invoke = overrides.invoke ?? defaultInvoke;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = "builder-uid";
    next();
  });
  app.use(
    "/api/g/:gatewayId/automations",
    createAutomationsRouter({
      resolveUserGateway: async () => ({ slug: "alice", gatewayId: "gw-alice" }),
      resolveWorkspaceOwnerUid: async () => "builder-uid",
      localGatewayId: () => "gw-alice",
      invoke,
      ...overrides,
    }),
  );
  return { app, invoke };
}

describe("automations locality broker", () => {
  it("lists only cron jobs scoped to the authenticated Builder's coach", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "cron.list", params: { includeDisabled: false } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: { jobs: [] } });
    expect(invoke).toHaveBeenCalledWith("cron.list", {
      agentId: "octogee-alice-coach",
      includeDisabled: true,
      limit: 200,
      sortBy: "updatedAtMs",
      sortDir: "desc",
    });
  });

  it("projects cron listing responses to A2-safe agent-turn jobs", async () => {
    const safeJob = {
      id: "daily-digest",
      agentId: "octogee-alice-coach",
      name: "Daily digest",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Summarize the day." },
      delivery: { mode: "webhook", to: "https://secret.example/hook" },
      state: { nextRunAtMs: 1_783_820_800_000, lastRunStatus: "ok" },
    };
    const { app } = appForTest({
      invoke: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return {
            jobs: [
              safeJob,
              { ...safeJob, id: "legacy-command", payload: { kind: "command", argv: ["env"] } },
            ],
            deliveryPreviews: { "daily-digest": { detail: "https://secret.example/hook" } },
          };
        }
        return { jobs: [] };
      }),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "cron.list" });

    expect(response.body).toEqual({
      result: {
        jobs: [{
          id: "daily-digest",
          name: "Daily digest",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Summarize the day." },
          delivery: { mode: "none" },
          state: { nextRunAtMs: 1_783_820_800_000, lastRunStatus: "ok" },
        }],
      },
    });
  });

  it.each(["cron.get", "cron.remove"])("rejects unsupported browser operation %s without invoking OpenClaw", async (method) => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method, params: { id: "daily-digest" } });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "unsupported automation operation" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects command payloads instead of lending the gateway's operator authority", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "cron.add",
        params: {
          name: "Take over the pod",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "command", argv: ["sh", "-c", "curl https://attacker.test"] },
        },
      });

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forces new cron jobs onto the caller's coach with the A2 delivery contract", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "cron.add",
        params: {
          name: "Daily digest",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Summarize the day." },
          delivery: { mode: "announce", channel: "slack", to: "#outside" },
        },
      });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("cron.add", {
      agentId: "octogee-alice-coach",
      name: "Daily digest",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Summarize the day." },
      delivery: { mode: "announce", channel: "mattermost", to: "channel:coach" },
    });
  });

  it("refuses operations on a cron job outside the caller's coach", async () => {
    const { app, invoke } = appForTest({
      invoke: vi.fn(async (method: string) => {
        if (method === "cron.get") return { job: { id: "foreign-job", agentId: "another-agent" } };
        return { ok: true };
      }),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "cron.run", params: { id: "foreign-job", mode: "force" } });

    expect(response.status).toBe(404);
    expect(invoke).toHaveBeenCalledWith("cron.get", { id: "foreign-job" });
    expect(invoke).not.toHaveBeenCalledWith("cron.run", expect.anything());
  });

  it("refuses to rewrite an unsupported existing job into an agent turn", async () => {
    const { app, invoke } = appForTest({
      invoke: vi.fn(async (method: string) => {
        if (method === "cron.get") {
          return {
            job: {
              id: "legacy-command",
              agentId: "octogee-alice-coach",
              payload: { kind: "command", argv: ["echo", "legacy"] },
            },
          };
        }
        return { ok: true };
      }),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "cron.update",
        params: {
          id: "legacy-command",
          patch: { payload: { kind: "agentTurn", message: "A new prompt" } },
        },
      });

    expect(response.status).toBe(404);
    expect(invoke).not.toHaveBeenCalledWith("cron.update", expect.anything());
  });

  it("refuses a mismatched gateway before it can reach OpenClaw", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-someone-else/automations/rpc")
      .send({ method: "cron.list" });

    expect(response.status).toBe(404);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not turn the Automations surface into an arbitrary gateway RPC proxy", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "config.patch", params: { raw: "{}" } });

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the caller's coach heartbeat from its hash-bound config snapshot", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "heartbeat.get" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      result: {
        hash: "config-hash",
        heartbeat: { every: "30m", target: "last" },
      },
    });
    expect(invoke).toHaveBeenCalledWith("config.get", {});
  });

  it("hash-CAS patches only the caller's coach heartbeat", async () => {
    const { app, invoke } = appForTest({
      invoke: vi.fn(async () => ({ ok: true, hash: "next-hash" })),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "heartbeat.update",
        baseHash: "before-hash",
        heartbeat: {
          every: "60m",
          prompt: "Check the release queue.",
          target: "last",
          lightContext: true,
        },
      });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({
        agents: {
          list: [{
            id: "octogee-alice-coach",
            heartbeat: {
              every: "60m",
              prompt: "Check the release queue.",
              target: "last",
              lightContext: true,
            },
          }],
        },
      }),
      baseHash: "before-hash",
    });
  });

  it("rejects heartbeat fields outside the narrow Automation editor contract", async () => {
    const { app, invoke } = appForTest();

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "heartbeat.update",
        baseHash: "before-hash",
        heartbeat: { every: "60m", dangerousGatewaySetting: true },
      });

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
});
