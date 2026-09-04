import { describe, expect, it } from "vitest";

import {
  OPENCLAW_CONTROL_SESSION_COOKIE,
  OpenClawControlSessionManager,
} from "./session.js";

describe("OpenClaw Dashboard session", () => {
  it("issues a boot-local signed cookie bound to the gateway, revision, idle, and absolute lifetime", () => {
    let now = 1_000;
    const manager = new OpenClawControlSessionManager({
      key: Buffer.alloc(32, 1),
      now: () => now,
      idleMs: 1_000,
    });
    const issued = manager.issue({
      sessionId: "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70",
      uid: "uid-owner",
      gatewayId: "bender",
      workspaceSlug: "alice",
      revisionId: "bender-r7",
      brokerProfile: "delegated-config",
      permissionSetIds: ["trusted-helper.v1"],
      grantRevision: 4,
      absoluteExpiresAt: 5_000,
    });
    expect(issued.cookie).toContain(`${OPENCLAW_CONTROL_SESSION_COOKIE}=`);
    expect(issued.cookie).toContain("Path=/g/bender/openclaw;");
    expect(issued.cookie).toContain("HttpOnly");
    expect(issued.cookie).toContain("Secure");
    expect(issued.cookie).toContain("SameSite=None");
    expect(issued.cookie).toContain("Partitioned");
    expect(issued.cookie).not.toContain("SameSite=Lax");

    const cookieHeader = issued.cookie.split(";", 1)[0];
    expect(manager.verify({ cookieHeader, gatewayId: "bender", revisionId: "bender-r7" }))
      .toMatchObject({
        uid: "uid-owner",
        workspaceSlug: "alice",
        brokerProfile: "delegated-config",
        permissionSetIds: ["trusted-helper.v1"],
        grantRevision: 4,
        idleExpiresAt: 2_000,
        absoluteExpiresAt: 5_000,
      });
    expect(manager.verify({ cookieHeader, gatewayId: "other", revisionId: "bender-r7" })).toBeNull();
    expect(manager.verify({ cookieHeader, gatewayId: "bender", revisionId: "bender-r8" })).toBeNull();

    now = 1_500;
    const touched = manager.touch({ cookieHeader, gatewayId: "bender", revisionId: "bender-r7" });
    expect(touched?.session).toMatchObject({ idleExpiresAt: 2_500, absoluteExpiresAt: 5_000 });
    now = 2_000;
    expect(manager.verify({ cookieHeader, gatewayId: "bender", revisionId: "bender-r7" }))
      .not.toBeNull();
    expect(manager.verify({
      cookieHeader: touched?.cookie.split(";", 1)[0],
      gatewayId: "bender",
      revisionId: "bender-r7",
    })).not.toBeNull();
    now = 2_500;
    expect(manager.verify({ cookieHeader, gatewayId: "bender", revisionId: "bender-r7" })).toBeNull();
    now = 5_000;
    expect(manager.verify({
      cookieHeader: touched?.cookie.split(";", 1)[0],
      gatewayId: "bender",
      revisionId: "bender-r7",
    })).toBeNull();
  });

  it("rejects signature tampering and replay after a gateway-edge boot", () => {
    const manager = new OpenClawControlSessionManager({
      key: Buffer.alloc(32, 1),
      now: () => 1_000,
    });
    const issued = manager.issue({
      sessionId: "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70",
      uid: "uid-owner",
      gatewayId: "bender",
      workspaceSlug: "alice",
      revisionId: "bender-r7",
      brokerProfile: "native-owner",
      permissionSetIds: [],
      grantRevision: null,
      absoluteExpiresAt: 5_000,
    });
    const cookieHeader = issued.cookie.split(";", 1)[0];
    expect(manager.verify({
      cookieHeader: `${cookieHeader}x`,
      gatewayId: "bender",
      revisionId: "bender-r7",
    })).toBeNull();
    const nextBoot = new OpenClawControlSessionManager({
      key: Buffer.alloc(32, 2),
      now: () => 1_000,
    });
    expect(nextBoot.verify({ cookieHeader, gatewayId: "bender", revisionId: "bender-r7" }))
      .toBeNull();
  });
});
