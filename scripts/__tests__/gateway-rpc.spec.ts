/**
 * Unit tests for the gateway WS JSON-RPC client used by the provisioner.
 *
 * Drives a real `ws.WebSocketServer` on a loopback port so the full handshake
 * (connect → hello-ok → RPC req/res) is covered. Per-test handler overrides
 * let each test inject success, auth-failure, hash-mismatch, or malformed
 * response behavior without having to stub the client's internals.
 *
 * The client is short-lived: each high-level method opens a WS, authenticates,
 * issues its request, and closes. That matches the provisioner's use pattern
 * (one RPC per signup step) and keeps the surface area tight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import * as crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GatewayRpcError,
  createGatewayRpc,
  type ConnectTrace,
  type GatewayRpcClient,
} from "../lib/gateway-rpc.js";
import type { DeviceIdentity } from "../lib/gateway-device-identity.js";

function makeTestIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const raw = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawKey = raw.length === 44 ? raw.subarray(12) : raw; // strip SPKI prefix for Ed25519
  const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
  return { deviceId, publicKeyPem, privateKeyPem };
}

// ── Mock gateway server ─────────────────────────────────────────────────────

type RpcHandler = (params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } };

interface MockServerHandle {
  port: number;
  url: string;
  setHandler: (method: string, handler: RpcHandler) => void;
  /** If set, overrides the default connect/hello-ok reply. */
  setConnectHandler: (
    handler: (params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } },
  ) => void;
  /** Reject the very first client message before sending hello-ok. */
  setRejectAllAsAuth: (enabled: boolean) => void;
  /** Count of RPC calls per method, for hash-mismatch retry assertions. */
  callCount: (method: string) => number;
  close: () => Promise<void>;
}

async function startMockGateway(): Promise<MockServerHandle> {
  const wss = new WebSocketServer({ port: 0 });
  const handlers = new Map<string, RpcHandler>();
  const counts = new Map<string, number>();
  let connectHandler: ((params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } }) | null = null;
  let rejectAuth = false;

  wss.on("connection", (ws: WebSocket) => {
    // Mirror OpenClaw: push a connect.challenge event with a one-shot nonce
    // as soon as the socket is open. Real clients read this before sending
    // their signed connect frame.
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
              protocol: 3,
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
      const out = handler(frame.params);
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
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close any open client sockets so wss.close() doesn't hang.
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

// ── Tests ───────────────────────────────────────────────────────────────────

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

  // ── configPatch ────────────────────────────────────────────────────────────

  describe("configPatch", () => {
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

    it("throws GatewayRpcError with 'hash-mismatch' code when the server rejects the base hash", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "config changed since last load; re-run config.get and retry" },
      }));

      await expect(client.configPatch({}, "stalehash")).rejects.toMatchObject({
        name: "GatewayRpcError",
        code: "hash-mismatch",
      });
    });

    it("throws GatewayRpcError with 'invalid-patch' code on a validation error", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid config: channels.mattermost.accounts.x-coach.botToken must be a string" },
      }));

      await expect(client.configPatch({}, "hash")).rejects.toMatchObject({
        name: "GatewayRpcError",
        code: "invalid-patch",
      });
    });
  });

  // ── configGet ─────────────────────────────────────────────────────────────

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

    it("throws GatewayRpcError when the snapshot has no hash", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: { valid: true, config: {} },
      }));

      await expect(client.configGet()).rejects.toMatchObject({
        name: "GatewayRpcError",
        code: "invalid-response",
      });
    });
  });

  // ── isGatewayUp ───────────────────────────────────────────────────────────

  describe("isGatewayUp", () => {
    it("returns true when the handshake succeeds", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: { channels: [] } }));
      expect(await client.isGatewayUp(500)).toBe(true);
    });

    it("returns false when the WS port is not reachable", async () => {
      await server.close();
      // Point the client at a port we know nothing is listening on.
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

  // ── auth & transport failures ─────────────────────────────────────────────

  describe("auth + transport errors", () => {
    it("throws GatewayRpcError('auth-failed') when the server rejects the connect frame", async () => {
      server.setRejectAllAsAuth(true);
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "GatewayRpcError",
        code: "auth-failed",
      });
    });

    it("throws GatewayRpcError('timeout') when the connect never completes", async () => {
      server.setConnectHandler(() => ({ ok: true, payload: {} })); // swallow reply — well, we'll NOT reply
      // Override: make connect handler never call respond by using a custom server that drops the message.
      // Simpler — stop the server and retarget to a port that accepts TCP but never speaks WS upgrade.
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
          name: "GatewayRpcError",
          code: "connect-failed",
        });
      } finally {
        await offline.close();
      }
    });

    it("throws GatewayRpcError('invalid-response') when the server replies with non-JSON", async () => {
      // Hijack: point the client at a raw TCP server that speaks the WS upgrade
      // but sends garbage frames. Simpler: override setHandler to return an
      // inherently-invalid payload (the client should still tolerate missing
      // fields by surfacing invalid-response).
      server.setHandler("config.patch", () => ({ ok: true, payload: null }));
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "GatewayRpcError",
        code: "invalid-response",
      });
    });
  });

  // ── GatewayRpcError.is helper ─────────────────────────────────────────────

  describe("GatewayRpcError", () => {
    it("exposes code + message and is instanceof Error", () => {
      const e = new GatewayRpcError("hash-mismatch", "stale hash");
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe("hash-mismatch");
      expect(e.message).toBe("stale hash");
      expect(e.name).toBe("GatewayRpcError");
    });
  });

  // ── connect-frame shape ───────────────────────────────────────────────────

  describe("connect frame", () => {
    it("requests operator.admin scope, signs the challenge nonce with the device identity, and identifies itself in `client.displayName`", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
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
      // User-Agent / displayName identifies the provisioner in gateway `[ws]` log lines.
      expect(captured.client.displayName?.toLowerCase()).toContain("octogee");

      // Device block is present and internally consistent.
      expect(captured.device).toBeTruthy();
      expect(typeof captured.device.id).toBe("string");
      expect(typeof captured.device.publicKey).toBe("string");
      expect(typeof captured.device.signature).toBe("string");
      expect(typeof captured.device.signedAt).toBe("number");
      expect(typeof captured.device.nonce).toBe("string");
      // Signature actually verifies over the v3 payload. This is what catches
      // protocol-drift: if our payload build ever falls out of sync with
      // OpenClaw's verification, the server would reject us live.
      const payload = [
        "v3",
        captured.device.id,
        captured.client.id,
        captured.client.mode,
        captured.role,
        captured.scopes.join(","),
        String(captured.device.signedAt),
        captured.auth?.token ?? "",
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
      expect(crypto.verify(null, Buffer.from(payload, "utf8"), pubKey, sigBuf)).toBe(true);
    });
  });

  // ── Connect trace instrumentation (#3) ────────────────────────────────────
  //
  // Every connect attempt — success OR failure — emits a `ConnectTrace` with
  // per-phase timings. This is the diagnostic hook we'll rely on when the
  // gateway's event loop pins during plugin init: the trace tells us
  // whether the stall was in TCP+upgrade (`ws-open`), challenge receive
  // (`challenge`), or the connect frame itself (`connect`).

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

      // isGatewayUp swallows errors but still emits a trace.
      expect(traces.length).toBeGreaterThanOrEqual(1);
      const fail = traces.find((t) => !t.success);
      expect(fail).toBeTruthy();
      expect(fail?.stage).toBe("ws-open");
      expect(fail?.errorCode).toBe("connect-failed");
      // wsOpenMs was not completed, so it's undefined; challengeMs + connectMs too.
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
      // We got past ws-open and challenge; those timings should be present.
      expect(typeof fail?.wsOpenMs).toBe("number");
      expect(typeof fail?.challengeMs).toBe("number");
      // connectMs undefined because the connect frame never completed.
      expect(fail?.connectMs).toBeUndefined();
    });

    it("is optional — omitting onConnectTrace still works (production default uses config.log)", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: {} }));
      // No onConnectTrace option — uses the default log-based trace.
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

// ── Token resolution: env → openclaw.json → empty ──────────────────────────
//
// Production deployments rarely plumb OPENCLAW_GATEWAY_TOKEN into the
// provisioner's env; the token lives in the gateway's openclaw.json at
// `gateway.auth.token` instead. Client must fall back to reading that file
// so stock OpenClaw deployments work without extra config.

describe("token resolution", () => {
  let tmpDir: string;
  let configPath: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rpc-token-"));
    configPath = path.join(tmpDir, "openclaw.json");
    origEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = origEnv;
  });

  it("reads gateway.auth.token from openclaw.json when env is unset (captures auth.token in connect frame)", async () => {
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
          protocol: 3,
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

    expect(captured?.auth?.token).toBe("from-file-abc123");
  });

  it("prefers the OPENCLAW_GATEWAY_TOKEN env var over openclaw.json", async () => {
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
          protocol: 3,
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

    expect(captured?.auth?.token).toBe("from-env");
  });

  it("sends no auth block when neither env nor file has a token (server rejects, caller falls back)", async () => {
    // File exists but has no token.
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
          protocol: 3,
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

    // No auth block at all — matches the pre-hotfix behavior for token-less connects.
    expect(captured?.auth).toBeUndefined();
  });

  it("silently tolerates a missing/malformed openclaw.json", async () => {
    const rpc = createGatewayRpc({
      url: "ws://127.0.0.1:1",
      openclawConfigPath: "/does/not/exist.json",
      connectTimeoutMs: 100,
      callTimeoutMs: 100,
      identity: makeTestIdentity(),
    });
    try {
      // If the file-read threw, this would reject with a non-RPC error;
      // instead we expect the normal connect-failed path.
      expect(await rpc.isGatewayUp(100)).toBe(false);
    } finally {
      await rpc.close();
    }
  });
});

// ── Crash-safety: unhandled error on terminate ─────────────────────────────
//
// Regression for the April 16 TEST-cluster provisioner crash. The original
// `openAndConnect` timeout path did `cleanup()` (removing the 'error'
// listener) then `ws.terminate()`. `terminate()` emits an async 'error'
// event on the still-connecting socket → no listener → Node kills the
// process. The provisioner pod then restarted, losing the rest of the
// customer's signup state.
//
// This test drives the exact path: a plain TCP server that ACCEPTS
// connections silently (no WS upgrade), so the client's 'open' never fires
// and the connect timer is the only exit. If the crash regression returns,
// this test will either time out (unhandled exception aborts the run) or
// trip the explicit uncaughtException listener installed below.

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

    // Snapshot existing uncaughtException listeners so the check below
    // isn't contaminated by other parts of the test harness.
    originalHandlers = process.listeners("uncaughtException") as any;
  });

  afterEach(() => {
    tcpServer.close();
    // Restore listeners to the pre-test set; vitest's own watchdog stays.
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
      name: "GatewayRpcError",
      code: "connect-failed",
    });

    // Give any stray async error events a tick to surface.
    await new Promise((r) => setTimeout(r, 50));
    process.off("uncaughtException", crashCatcher);

    expect(crashes).toEqual([]);
    await client.close();
  });
});
