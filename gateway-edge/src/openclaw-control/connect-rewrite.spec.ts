import { describe, expect, it } from "vitest";

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

  it("presents a Control UI client with no self-declared authority when the proxy carries the identity", () => {
    const rewritten = JSON.parse(rewriteTrustedOpenClawConnect({
      frame: browserConnect,
      nonce: "nonce-1",
      identity: { mode: "per-user" },
      platform: "linux",
    })!);
    expect(rewritten).toMatchObject({
      type: "req",
      id: "browser-connect",
      method: "connect",
      params: {
        client: { id: "openclaw-control-ui", mode: "ui", platform: "linux" },
        role: "operator",
      },
    });
    expect(rewritten.params).not.toHaveProperty("scopes");
    expect(rewritten.params).not.toHaveProperty("auth");
    expect(rewritten.params).not.toHaveProperty("device");
    expect(JSON.stringify(rewritten)).not.toContain("browser-token");
    expect(JSON.stringify(rewritten)).not.toContain("stolen.scope");
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
