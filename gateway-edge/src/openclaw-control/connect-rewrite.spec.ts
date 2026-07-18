import { describe, expect, it } from "vitest";

import {
  challengeNonce,
  rewriteTrustedOpenClawConnect,
  sanitizeOpenClawControlServerFrame,
} from "./connect-rewrite.js";

describe("trusted OpenClaw Dashboard connect rewrite", () => {
  it("replaces all browser identity and auth with the pinned loopback backend contract", () => {
    const gatewayToken = "server-gateway-token";
    const rewritten = JSON.parse(rewriteTrustedOpenClawConnect({
      frame: {
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
      },
      nonce: "nonce-1",
      gatewayToken,
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
          "operator.pairing",
        ],
        auth: { token: gatewayToken },
      },
    });
    expect(JSON.stringify(rewritten)).not.toContain("browser-token");
    expect(rewritten.params).not.toHaveProperty("device");
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
        auth: { token: gatewayToken },
        nested: `prefix-${gatewayToken}-suffix`,
      },
    }, [gatewayToken]);
    expect(sanitized).not.toContain(gatewayToken);
    expect(JSON.parse(sanitized).payload).not.toHaveProperty("auth");
  });
});
