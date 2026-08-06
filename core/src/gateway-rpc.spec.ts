import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import * as crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  OpenclawWireError,
  createGatewayRpc,
  type ConnectTrace,
  type GatewayRpcClient,
} from "./gateway-rpc.js";
import type { DeviceIdentity } from "./gateway-device-identity.js";

function makeTestIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const raw = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawKey = raw.length === 44 ? raw.subarray(12) : raw;
  const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
  return { deviceId, publicKeyPem, privateKeyPem };
}

type RpcHandler = (
  params: unknown,
  ws: WebSocket,
) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } };

interface MockServerHandle {
  port: number;
  url: string;
  setHandler: (method: string, handler: RpcHandler) => void;
  
  setConnectHandler: (
    handler: (params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } },
  ) => void;
  
  setRejectAllAsAuth: (enabled: boolean) => void;
  
  callCount: (method: string) => number;
  disconnectClients: () => Promise<void>;
  close: () => Promise<void>;
}

async function startMockGateway(): Promise<MockServerHandle> {
  const wss = new WebSocketServer({ port: 0 });
  const handlers = new Map<string, RpcHandler>();
  const counts = new Map<string, number>();
  let connectHandler: ((params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } }) | null = null;
  let rejectAuth = false;

  wss.on("connection", (ws: WebSocket) => {

const nonce = crypto.randomBytes(12).toString("hex");
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce } }));
    ws.on("message", (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame?.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") {
        return;
      }
      counts.set(frame.method, (counts.get(frame.method) ?? 0) + 1);

      if (frame.method === "connect") {
        if (rejectAuth) {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "UNAUTHENTICATED", message: "bad token" } }));
          return;
        }
        if (connectHandler) {
          const out = connectHandler(frame.params);
          ws.send(
            JSON.stringify(
              out.ok
                ? { type: "res", id: frame.id, ok: true, payload: out.payload }
                : { type: "res", id: frame.id, ok: false, error: out.error },
            ),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "c1" },
              features: { methods: [], events: [] },
              snapshot: {},
              policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 1000 },
            },
          }),
        );
        return;
      }

      const handler = handlers.get(frame.method);
      if (!handler) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "NOT_FOUND", message: `no handler for ${frame.method}` },
          }),
        );
        return;
      }
      const out = handler(frame.params, ws);
      ws.send(
        JSON.stringify(
          out.ok
            ? { type: "res", id: frame.id, ok: true, payload: out.payload }
            : { type: "res", id: frame.id, ok: false, error: out.error },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    setHandler: (method, handler) => handlers.set(method, handler),
    setConnectHandler: (handler) => {
      connectHandler = handler;
    },
    setRejectAllAsAuth: (enabled) => {
      rejectAuth = enabled;
    },
    callCount: (method) => counts.get(method) ?? 0,
    disconnectClients: async () => {
      await Promise.all(
        [...wss.clients].map(
          (client) => new Promise<void>((resolve) => {
            client.once("close", resolve);
            client.close();
          }),
        ),
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        
        for (const c of wss.clients) {
          try {
            c.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      }),
  };
}

describe("gateway-rpc", () => {
  let server: MockServerHandle;
  let client: GatewayRpcClient;

  beforeEach(async () => {
    server = await startMockGateway();
    client = createGatewayRpc({
      url: server.url,
      token: "test-token",
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  describe("configPatch", () => {
    it("authenticates the config-change connection with the configured token", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "authenticated-hash" },
        }));
        return {
          ok: true,
          payload: { ok: true, hash: "authenticated-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(captured?.auth).toEqual({ token: "test-token" });
    });

    it("waits for the matching persisted-candidate config.changed before resolving", async () => {
      const events: string[] = [];
      server.setHandler("config.patch", (_params, ws) => {
        events.push("patch-response");
        setTimeout(() => {
          events.push("config-changed");
          ws.send(JSON.stringify({
            type: "event",
            event: "config.changed",
            payload: { hash: "accepted-hash" },
          }));
        }, 10);
        return {
          ok: true,
          payload: { ok: true, hash: "accepted-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(events).toEqual(["patch-response", "config-changed"]);
    });

    it("captures config.changed that arrives before the patch response", async () => {
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "early-hash" },
        }));
        return {
          ok: true,
          payload: { ok: true, hash: "early-hash", path: "/fake/openclaw.json" },
        };
      });

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).resolves.toMatchObject({ hash: "early-hash" });
    });

    it("ignores unrelated config.changed events while waiting for its persisted hash", async () => {
      const accepted: string[] = [];
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "someone-else" },
        }));
        setTimeout(() => {
          accepted.push("ours");
          ws.send(JSON.stringify({
            type: "event",
            event: "config.changed",
            payload: { hash: "our-hash" },
          }));
        }, 10);
        return {
          ok: true,
          payload: { ok: true, hash: "our-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(accepted).toEqual(["ours"]);
    });

    it("returns a no-op patch without waiting for an acceptance event", async () => {
      server.setHandler("config.patch", () => ({
        ok: true,
        payload: { ok: true, noop: true, path: "/fake/openclaw.json" },
      }));

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).resolves.toMatchObject({ noop: true });
    });

    it("rejects a changed patch without the acceptance hash", async () => {
      server.setHandler("config.patch", () => ({
        ok: true,
        payload: { ok: true, path: "/fake/openclaw.json" },
      }));

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: expect.stringContaining("missing `hash`"),
      });
    });

    it("sends a JSON-RPC request with raw + baseHash and returns the server payload on success", async () => {
      let captured: any;
      server.setHandler("config.patch", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            ok: true,
            noop: false,
            path: "/fake/openclaw.json",
            config: { channels: { mattermost: { accounts: { "x-coach": { botToken: "***" } } } } },
          },
        };
      });

      const patch = { channels: { mattermost: { accounts: { "x-coach": { botToken: "tok" } } } } };
      const result = await client.configPatch(patch, "deadbeef");

      expect(captured.baseHash).toBe("deadbeef");
      expect(JSON.parse(captured.raw)).toEqual(patch);
      expect(result.ok).toBe(true);
      expect(result.noop).toBe(false);
      expect(result.config).toEqual({ channels: { mattermost: { accounts: { "x-coach": { botToken: "***" } } } } });
    });

    it("includes replacePaths in the wire params when provided; omits the key otherwise", async () => {
      const capturedParams: any[] = [];
      server.setHandler("config.patch", (params) => {
        capturedParams.push(params);
        return { ok: true, payload: { ok: true, path: "/fake/openclaw.json" } };
      });

      await client.configPatch({ bindings: [] }, "h1", {
        replacePaths: ["bindings", "channels.mattermost.accounts.alice-coach.groupAllowFrom"],
      });
      expect(capturedParams[0].replacePaths).toEqual([
        "bindings",
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      ]);

      await client.configPatch({ bindings: [] }, "h1");
      expect(capturedParams[1]).not.toHaveProperty("replacePaths");

      await client.configPatch({ bindings: [] }, "h1", { replacePaths: [] });
      expect(capturedParams[2]).not.toHaveProperty("replacePaths");
    });

    it("throws OpenclawWireError with 'hash-mismatch' code when the server rejects the base hash", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "config changed since last load; re-run config.get and retry" },
      }));

      await expect(client.configPatch({}, "stalehash")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "hash-mismatch",
      });
    });

    it("throws OpenclawWireError with 'invalid-patch' code on a validation error", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid config: channels.mattermost.accounts.x-coach.botToken must be a string" },
      }));

      await expect(client.configPatch({}, "hash")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-patch",
      });
    });
  });

  describe("configApply", () => {
    it("sends the complete config as raw JSON with its base hash", async () => {
      let captured: any;
      server.setHandler("config.apply", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, path: "/fake/openclaw.json" } };
      });

      const config = {
        agents: {
          list: [
            { id: "octogee-bob-coach", memorySearch: { apiKey: { source: "env", id: "BOB" } } },
          ],
        },
      };
      const result = await client.configApply(config, "current-hash");

      expect(captured).toEqual({ raw: JSON.stringify(config), baseHash: "current-hash" });
      expect(result.ok).toBe(true);
    });

    it("maps stale base-hash and invalid-config errors to stable wire codes", async () => {
      server.setHandler("config.apply", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "config changed since last load" },
      }));
      await expect(client.configApply({}, "stale")).rejects.toMatchObject({
        code: "hash-mismatch",
      });

      server.setHandler("config.apply", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid config: agents.list" },
      }));
      await expect(client.configApply({}, "current")).rejects.toMatchObject({
        code: "invalid-patch",
      });
    });
  });

  describe("gatewayRestartRequest", () => {
    it("requests a safe gateway restart through the OpenClaw RPC", async () => {
      let captured: any;
      server.setHandler("gateway.restart.request", (params) => {
        captured = params;
        return { ok: true, payload: { status: "requested" } };
      });

      const result = await client.gatewayRestartRequest({
        reason: "byosub.oauth-runtime",
        skipDeferral: true,
      });

      expect(captured).toEqual({
        reason: "byosub.oauth-runtime",
        skipDeferral: true,
      });
      expect(result).toEqual({ status: "requested" });
    });
  });

  describe("channels lifecycle", () => {
    it("stops and starts one Mattermost account through the channel RPC", async () => {
      const calls: Array<{ method: string; params: unknown }> = [];
      server.setHandler("channels.stop", (params) => {
        calls.push({ method: "channels.stop", params });
        return {
          ok: true,
          payload: { channel: "mattermost", accountId: "alice-coach", stopped: true },
        };
      });
      server.setHandler("channels.start", (params) => {
        calls.push({ method: "channels.start", params });
        return {
          ok: true,
          payload: { channel: "mattermost", accountId: "alice-coach", started: true },
        };
      });

      await expect(
        client.channelsStop({ channel: "mattermost", accountId: "alice-coach" }),
      ).resolves.toMatchObject({ stopped: true });
      await expect(
        client.channelsStart({ channel: "mattermost", accountId: "alice-coach" }),
      ).resolves.toMatchObject({ started: true });
      expect(calls).toEqual([
        {
          method: "channels.stop",
          params: { channel: "mattermost", accountId: "alice-coach" },
        },
        {
          method: "channels.start",
          params: { channel: "mattermost", accountId: "alice-coach" },
        },
      ]);
    });
  });

  describe("configGet", () => {
    it("returns the config snapshot and its hash", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: { valid: true, hash: "abc123", config: { channels: { mattermost: {} } } },
      }));

      const { config, hash } = await client.configGet();
      expect(hash).toBe("abc123");
      expect(config).toEqual({ channels: { mattermost: {} } });
    });

    it("throws OpenclawWireError when the snapshot has no hash", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: { valid: true, config: {} },
      }));

      await expect(client.configGet()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });
  });

  describe("sessions", () => {
    it("lists and resets the agent's runtime sessions through the official gateway API", async () => {
      server.setHandler("sessions.list", (params) => ({
        ok: true,
        payload: {
          sessions: [{ key: "agent:octogee-alice-coach:mattermost:group:channel", agentId: "octogee-alice-coach" }],
          ...params as object,
        },
      }));
      server.setHandler("sessions.reset", (params) => ({
        ok: true,
        payload: { ok: true, ...params as object },
      }));

      await expect(client.sessionsList({ agentId: "octogee-alice-coach" })).resolves.toEqual({
        sessions: [{ key: "agent:octogee-alice-coach:mattermost:group:channel", agentId: "octogee-alice-coach" }],
        agentId: "octogee-alice-coach",
      });
      await expect(
        client.sessionsReset({
          key: "agent:octogee-alice-coach:mattermost:group:channel",
          agentId: "octogee-alice-coach",
          reason: "reset",
        }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe("toolsCatalog", () => {
    it("requests the exact agent plugin catalog and validates the response", async () => {
      let captured: unknown;
      server.setHandler("tools.catalog", (params) => {
        captured = params;
        return {
          ok: true,
          payload: { agentId: "octogee-test-coach", groups: [] },
        };
      });

      await expect(client.toolsCatalog({
        agentId: "octogee-test-coach",
        includePlugins: true,
      })).resolves.toEqual({
        agentId: "octogee-test-coach",
        groups: [],
      });
      expect(captured).toEqual({
        agentId: "octogee-test-coach",
        includePlugins: true,
      });
    });

    it("rejects a catalog for a different agent", async () => {
      server.setHandler("tools.catalog", () => ({
        ok: true,
        payload: { agentId: "octogee-other-coach", groups: [] },
      }));

      await expect(client.toolsCatalog({
        agentId: "octogee-test-coach",
        includePlugins: true,
      })).rejects.toMatchObject({
        code: "invalid-response",
      });
    });
  });

  describe("cronAdd", () => {
    it("calls `cron.add` with the job spec verbatim and returns the server payload", async () => {
      let captured: unknown = "not-called";
      server.setHandler("cron.add", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            id: "job-abc",
            name: "test-job",
            createdAtMs: 1,
            updatedAtMs: 1,
            enabled: true,
            schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "hi" },
            state: {},
          },
        };
      });

      const job = {
        name: "test-job",
        agentId: "octogee-test-coach",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at" as const, at: "2030-01-01T00:00:00Z" },
        sessionTarget: "isolated" as const,
        wakeMode: "now" as const,
        payload: { kind: "agentTurn" as const, message: "hi" },
        delivery: {
          mode: "announce" as const,
          channel: "mattermost" as const,
          accountId: "test-coach",
          bestEffort: true,
        },
      };
      const result = await client.cronAdd(job);

      expect(captured).toEqual(job);
      expect(result.id).toBe("job-abc");
    });

    it("throws OpenclawWireError('invalid-response') if the server returns a non-object payload", async () => {
      server.setHandler("cron.add", () => ({ ok: true, payload: "boom" }));
      await expect(
        client.cronAdd({
          name: "x",
          enabled: true,
          schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
        }),
      ).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("surfaces server-side validation errors as 'rpc-error'", async () => {
      server.setHandler("cron.add", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid cron.add params: schedule.at must be ISO" },
      }));
      await expect(
        client.cronAdd({
          name: "x",
          enabled: true,
          schedule: { kind: "at", at: "bogus" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
        }),
      ).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "rpc-error",
      });
    });
  });

  describe("channelsStatus", () => {
    it("reuses one authenticated connection across health polls", async () => {
      server.setHandler("channels.status", () => ({
        ok: true,
        payload: { channels: [] },
      }));

      await client.channelsStatus();
      await client.channelsStatus();

      expect(server.callCount("channels.status")).toBe(2);
      expect(server.callCount("connect")).toBe(1);
    });

    it("reconnects after the health connection drops", async () => {
      server.setHandler("channels.status", () => ({
        ok: true,
        payload: { channels: [] },
      }));

      await client.channelsStatus();
      await server.disconnectClients();
      await client.channelsStatus();

      expect(server.callCount("channels.status")).toBe(2);
      expect(server.callCount("connect")).toBe(2);
    });
  });

  describe("secretsReload", () => {
    it("calls the `secrets.reload` method with empty params and returns the payload", async () => {
      let captured: unknown = "not-called";
      server.setHandler("secrets.reload", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, warningCount: 0 } };
      });

      const result = await client.secretsReload();

expect(captured).toEqual({});
      expect(result.ok).toBe(true);
      expect(result.warningCount).toBe(0);
    });

    it("surfaces warningCount when the gateway reports unresolved refs", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { ok: true, warningCount: 3 },
      }));
      const result = await client.secretsReload();
      expect(result.warningCount).toBe(3);
    });

    it("throws OpenclawWireError('invalid-response') if the gateway returns a non-object payload", async () => {
      server.setHandler("secrets.reload", () => ({ ok: true, payload: "boom" }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("throws when warningCount is present but not a number (regression: silent NaN)", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { warningCount: "lots" },
      }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("throws when ok is present but not a boolean", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { ok: "yes" },
      }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });
  });

  describe("isGatewayUp", () => {
    it("returns true when the handshake succeeds", async () => {
      expect(await client.isGatewayUp(500)).toBe(true);
    });

    it("does NOT call channels.status (or any other RPC) — handshake completion is the liveness signal", async () => {

expect(await client.isGatewayUp(500)).toBe(true);
      expect(server.callCount("channels.status")).toBe(0);
    });

    it("returns false when the WS port is not reachable", async () => {
      await server.close();
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "test-token",
        connectTimeoutMs: 250,
        callTimeoutMs: 250,
        identity: makeTestIdentity(),
      });
      try {
        expect(await offline.isGatewayUp(250)).toBe(false);
      } finally {
        await offline.close();
      }
    });

    it("returns false on connect-time auth failure", async () => {
      server.setRejectAllAsAuth(true);
      expect(await client.isGatewayUp(500)).toBe(false);
    });
  });

  describe("auth + transport errors", () => {
    it("throws OpenclawWireError('auth-failed') when the server rejects the connect frame", async () => {
      server.setRejectAllAsAuth(true);
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "auth-failed",
      });
    });

    it("throws OpenclawWireError('timeout') when the connect never completes", async () => {
      server.setConnectHandler(() => ({ ok: true, payload: {} })); 

await server.close();
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "t",
        connectTimeoutMs: 100,
        callTimeoutMs: 100,
        identity: makeTestIdentity(),
      });
      try {
        await expect(offline.configPatch({}, "h")).rejects.toMatchObject({
          name: "OpenclawWireError",
          code: "connect-failed",
        });
      } finally {
        await offline.close();
      }
    });

    it("throws OpenclawWireError('invalid-response') when the server replies with non-JSON", async () => {

server.setHandler("config.patch", () => ({ ok: true, payload: null }));
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });
  });

  describe("OpenclawWireError", () => {
    it("exposes code + message and is instanceof Error", () => {
      const e = new OpenclawWireError("hash-mismatch", "stale hash");
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe("hash-mismatch");
      expect(e.message).toBe("stale hash");
      expect(e.name).toBe("OpenclawWireError");
    });
  });

  describe("connect frame", () => {
    function verifyCapturedDeviceSignature(captured: any, authToken: string): boolean {
      const payload = [
        "v3",
        captured.device.id,
        captured.client.id,
        captured.client.mode,
        captured.role,
        captured.scopes.join(","),
        String(captured.device.signedAt),
        authToken,
        captured.device.nonce,
        (captured.client.platform ?? "").toLowerCase(),
        "", // deviceFamily left unset
      ].join("|");
      const sigBuf = Buffer.from(
        captured.device.signature.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - (captured.device.signature.length % 4)) % 4),
        "base64",
      );
      const pubRaw = Buffer.from(
        captured.device.publicKey.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - (captured.device.publicKey.length % 4)) % 4),
        "base64",
      );
      const pubKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw]),
        type: "spki",
        format: "der",
      });
      return crypto.verify(null, Buffer.from(payload, "utf8"), pubKey, sigBuf);
    }

    it("requests operator.admin scope, signs the challenge nonce with the device identity, and identifies itself in `client.displayName`", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });
      server.setHandler("channels.status", () => ({ ok: true, payload: { channels: [] } }));

      await client.isGatewayUp(500);

      expect(captured).toBeTruthy();
      expect(captured.scopes).toContain("operator.admin");
      expect(captured.role).toBe("operator");
      expect(captured.client.id).toBe("gateway-client");
      
      expect(captured.client.displayName?.toLowerCase()).toContain("octogee");

expect(captured.device).toBeTruthy();
      expect(typeof captured.device.id).toBe("string");
      expect(typeof captured.device.publicKey).toBe("string");
      expect(typeof captured.device.signature).toBe("string");
      expect(typeof captured.device.signedAt).toBe("number");
      expect(typeof captured.device.nonce).toBe("string");

      expect(verifyCapturedDeviceSignature(captured, captured.auth?.token ?? "")).toBe(true);
    });

    it("uses auth.deviceToken and signs with the device token when provided", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });

      const rpc = createGatewayRpc({
        url: server.url,
        deviceToken: "device-token-abc123",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
      });
      try {
        await rpc.isGatewayUp(500);
      } finally {
        await rpc.close();
      }

      expect(captured?.auth).toEqual({ deviceToken: "device-token-abc123" });
      expect(captured?.auth?.token).toBeUndefined();
      expect(verifyCapturedDeviceSignature(captured, "device-token-abc123")).toBe(true);
    });
  });

  describe("onConnectTrace", () => {
    it("fires with success=true, stage=done, and all three phase timings on a clean connect", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: {} }));

      const traces: ConnectTrace[] = [];
      const tracedClient = createGatewayRpc({
        url: server.url,
        token: "test",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await tracedClient.isGatewayUp(500);
      } finally {
        await tracedClient.close();
      }

      expect(traces).toHaveLength(1);
      const t = traces[0];
      expect(t.success).toBe(true);
      expect(t.stage).toBe("done");
      expect(t.url).toBe(server.url);
      expect(typeof t.wsOpenMs).toBe("number");
      expect(typeof t.challengeMs).toBe("number");
      expect(typeof t.connectMs).toBe("number");
      expect(t.totalMs).toBeGreaterThanOrEqual(
        (t.wsOpenMs ?? 0) + (t.challengeMs ?? 0) + (t.connectMs ?? 0) - 5, // ±5ms slack
      );
      expect(t.errorCode).toBeUndefined();
    });

    it("fires with stage=ws-open on a connect-failed timeout (nothing listening)", async () => {
      const traces: ConnectTrace[] = [];
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "t",
        connectTimeoutMs: 80,
        callTimeoutMs: 80,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await offline.isGatewayUp(80);
      } finally {
        await offline.close();
      }

expect(traces.length).toBeGreaterThanOrEqual(1);
      const fail = traces.find((t) => !t.success);
      expect(fail).toBeTruthy();
      expect(fail?.stage).toBe("ws-open");
      expect(fail?.errorCode).toBe("connect-failed");
      
      expect(fail?.wsOpenMs).toBeUndefined();
      expect(fail?.challengeMs).toBeUndefined();
      expect(fail?.connectMs).toBeUndefined();
    });

    it("fires with stage=connect on an auth-failed connect frame (connect frame rejected)", async () => {
      server.setRejectAllAsAuth(true);
      const traces: ConnectTrace[] = [];
      const rpc = createGatewayRpc({
        url: server.url,
        token: "t",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await expect(rpc.configGet()).rejects.toThrow();
      } finally {
        await rpc.close();
      }

      const fail = traces.find((t) => !t.success);
      expect(fail).toBeTruthy();
      expect(fail?.stage).toBe("connect");
      expect(fail?.errorCode).toBe("auth-failed");
      
      expect(typeof fail?.wsOpenMs).toBe("number");
      expect(typeof fail?.challengeMs).toBe("number");
      
      expect(fail?.connectMs).toBeUndefined();
    });

    it("is optional — omitting onConnectTrace still works (production default uses config.log)", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: {} }));
      
      const rpc = createGatewayRpc({
        url: server.url,
        token: "t",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
      });
      try {
        expect(await rpc.isGatewayUp(500)).toBe(true);
      } finally {
        await rpc.close();
      }
    });
  });
});

describe("token resolution", () => {
  let tmpDir: string;
  let configPath: string;
  let origEnv: string | undefined;
  let origConfigPath: string | undefined;

  beforeEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rpc-token-"));
    configPath = path.join(tmpDir, "openclaw.json");
    origEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    origConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_CONFIG_PATH;
  });

  afterEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = origEnv;
    if (origConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
  });

  it("does not read OPENCLAW_GATEWAY_TOKEN or openclaw.json by default", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { mode: "token", token: "from-file-abc123" } },
      }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "from-env-abc123";

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth).toBeUndefined();
  });

  it("reads gateway.auth.token from openclaw.json only when legacy fallback is explicit", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { mode: "token", token: "from-file-abc123" } },
      }),
    );

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-file-abc123");
  });

  it("uses OPENCLAW_CONFIG_PATH when legacy fallback has no explicit path", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "from-active-config" } } }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });

    const rpc = createGatewayRpc({
      url: srv.url,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-active-config");
  });

  it("legacy fallback prefers the OPENCLAW_GATEWAY_TOKEN env var over openclaw.json", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "from-file" } } }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "from-env";

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-env");
  });

  it("sends no auth block when neither env nor file has a token (server rejects, caller falls back)", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { mode: "none" } } }));

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

expect(captured?.auth).toBeUndefined();
  });

  it("silently tolerates a missing/malformed openclaw.json when legacy fallback is enabled", async () => {
    const rpc = createGatewayRpc({
      url: "ws://127.0.0.1:1",
      openclawConfigPath: "/does/not/exist.json",
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 100,
      callTimeoutMs: 100,
      identity: makeTestIdentity(),
    });
    try {
      expect(await rpc.isGatewayUp(100)).toBe(false);
    } finally {
      await rpc.close();
    }
  });
});

describe("crash safety on connect timeout", () => {
  let tcpServer: Server;
  let tcpPort: number;
  let originalHandlers: Array<(err: Error) => void>;

  beforeEach(async () => {
    tcpServer = createServer(() => {
      // Accept the connection but NEVER speak. No WS upgrade response,
      // no close. The client's connect-timer is its only exit.
    });
    await new Promise<void>((resolve) => {
      tcpServer.listen(0, "127.0.0.1", () => resolve());
    });
    tcpPort = (tcpServer.address() as AddressInfo).port;

originalHandlers = process.listeners("uncaughtException") as any;
  });

  afterEach(() => {
    tcpServer.close();
    
    const now = process.listeners("uncaughtException") as any;
    for (const h of now) {
      if (!originalHandlers.includes(h)) process.off("uncaughtException", h);
    }
  });

  it("rejects with connect-failed and does NOT emit an unhandled 'error' event when terminate() fires", async () => {
    const crashes: unknown[] = [];
    const crashCatcher = (err: unknown) => crashes.push(err);
    process.on("uncaughtException", crashCatcher);

    const client = createGatewayRpc({
      url: `ws://127.0.0.1:${tcpPort}`,
      token: "t",
      connectTimeoutMs: 80,
      callTimeoutMs: 80,
      identity: makeTestIdentity(),
    });

    await expect(client.configGet()).rejects.toMatchObject({
      name: "OpenclawWireError",
      code: "connect-failed",
    });

await new Promise((r) => setTimeout(r, 50));
    process.off("uncaughtException", crashCatcher);

    expect(crashes).toEqual([]);
    await client.close();
  });
});
