import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { openUpstream } from "../openclaw/upstream.js";
import {
  buildDeviceAuthPayloadV3,
  generateIdentity,
} from "@octogee/shared/types/device-identity";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
    "base64",
  );
}

function verifyConnectSignature(params: any, identity: ReturnType<typeof generateIdentity>, token: string): boolean {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: params.device.id,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.device.signedAt,
    token,
    nonce: params.device.nonce,
    platform: params.client.platform,
    deviceFamily: null,
  });
  return crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPublicKey(identity.publicKeyPem),
    decodeBase64Url(params.device.signature),
  );
}

async function withMockGateway<T>(
  fn: (url: string, captured: { params: any }) => Promise<T>,
  opts: { helloAuth?: Record<string, unknown> } = {},
): Promise<T> {
  const wss = new WebSocketServer({ port: 0 });
  const captured = { params: null as any };

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame?.method !== "connect") return;
      captured.params = frame.params;
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
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
            ...(opts.helloAuth ? { auth: opts.helloAuth } : {}),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(`ws://127.0.0.1:${port}`, captured);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("openUpstream OpenClaw auth", () => {
  it("uses auth.deviceToken and signs with the device token when provided", async () => {
    const identity = generateIdentity();
    await withMockGateway(async (url, captured) => {
      const ws = await openUpstream({
        url,
        deviceToken: "device-token-abc123",
        identity,
        timeoutMs: 30_000,
      });
      ws.close();

      expect(captured.params?.auth).toEqual({ deviceToken: "device-token-abc123" });
      expect(captured.params?.auth?.token).toBeUndefined();
      expect(captured.params?.scopes).toEqual([
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
      ]);
      expect(verifyConnectSignature(captured.params, identity, "device-token-abc123")).toBe(true);
    });
  });

  it("surfaces an issued device token from hello-ok for sidecar-local persistence", async () => {
    const identity = generateIdentity();
    const issued: unknown[] = [];
    await withMockGateway(
      async (url) => {
        const ws = await openUpstream({
          url,
          token: "legacy-token",
          identity,
          timeoutMs: 30_000,
          onDeviceToken: (auth) => issued.push(auth),
        });
        ws.close();
      },
      {
        helloAuth: {
          deviceToken: "issued-device-token",
          role: "operator",
          scopes: ["operator.admin"],
        },
      },
    );

    expect(issued).toEqual([
      {
        deviceToken: "issued-device-token",
        role: "operator",
        scopes: ["operator.admin"],
      },
    ]);
  });
});
