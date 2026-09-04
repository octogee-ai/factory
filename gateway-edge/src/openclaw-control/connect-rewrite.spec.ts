import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayloadV3,
  generateIdentity,
} from "@octogee/shared/types/device-identity";

import {
  challengeNonce,
  rewriteTrustedOpenClawConnect,
  sanitizeOpenClawControlServerFrame,
} from "./connect-rewrite.js";

const browserConnect = {
  type: "req",
  id: "browser-connect",
  method: "connect",
  params: {
    client: { id: "untrusted-browser", mode: "cli" },
    role: "node",
    scopes: ["stolen.scope"],
    auth: { token: "browser-token" },
    device: { id: "browser-device", signature: "browser-signature" },
  },
};

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
    "base64",
  );
}

describe("trusted OpenClaw Dashboard connect rewrite", () => {
  it("replaces all browser identity and auth with the pinned loopback backend contract", () => {
    const gatewayToken = "server-gateway-token";
    const rewritten = JSON.parse(rewriteTrustedOpenClawConnect({
      frame: browserConnect,
      nonce: "nonce-1",
      identity: { mode: "shared-operator", gatewayToken },
      platform: "linux",
    })!);
    expect(rewritten).toMatchObject({
      type: "req",
      id: "browser-connect",
      method: "connect",
      params: {
        client: { id: "gateway-client", mode: "backend", platform: "linux" },
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.questions",
          "operator.pairing",
        ],
        auth: { token: gatewayToken },
      },
    });
    expect(JSON.stringify(rewritten)).not.toContain("browser-token");
    expect(rewritten.params).not.toHaveProperty("device");
  });

  it("presents a Control UI client with the person's own device and requested scopes when the proxy carries the identity", () => {
    const device = generateIdentity();
    const scopes = ["operator.read", "operator.write"];
    const rewritten = JSON.parse(rewriteTrustedOpenClawConnect({
      frame: browserConnect,
      nonce: "nonce-1",
      identity: { mode: "per-user", device, scopes },
      platform: "linux",
    })!);
    expect(rewritten).toMatchObject({
      type: "req",
      id: "browser-connect",
      method: "connect",
      params: {
        client: { id: "openclaw-control-ui", mode: "ui", platform: "linux" },
        role: "operator",
        scopes,
        device: { id: device.deviceId, nonce: "nonce-1" },
      },
    });
    expect(rewritten.params).not.toHaveProperty("auth");
    expect(JSON.stringify(rewritten)).not.toContain("browser-token");
    expect(JSON.stringify(rewritten)).not.toContain("stolen.scope");
    expect(JSON.stringify(rewritten)).not.toContain("browser-device");

    const payload = buildDeviceAuthPayloadV3({
      deviceId: rewritten.params.device.id,
      clientId: "openclaw-control-ui",
      clientMode: "ui",
      role: "operator",
      scopes,
      signedAtMs: rewritten.params.device.signedAt,
      token: null,
      nonce: "nonce-1",
      platform: "linux",
      deviceFamily: null,
    });
    expect(crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      crypto.createPublicKey(device.publicKeyPem),
      decodeBase64Url(rewritten.params.device.signature),
    )).toBe(true);
  });

  it("extracts only a challenge and removes server-held credentials from every server frame", () => {
    expect(challengeNonce({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }))
      .toBe("n");
    expect(challengeNonce({ type: "event", event: "other", payload: { nonce: "n" } })).toBeNull();
    const gatewayToken = "server-gateway-token";
    const sanitized = sanitizeOpenClawControlServerFrame({
      type: "res",
      payload: {
        type: "hello-ok",
        auth: {
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          token: gatewayToken,
          deviceToken: "server-device-token",
        },
        nested: `prefix-${gatewayToken}-suffix`,
      },
    }, [gatewayToken, "server-device-token"]);
    expect(sanitized).not.toContain(gatewayToken);
    expect(sanitized).not.toContain("server-device-token");
    expect(JSON.parse(sanitized).payload.auth).toEqual({
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
  });
});
