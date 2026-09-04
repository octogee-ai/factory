import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type {
  GatewayPermissionSetId,
  OpenClawBrokerProfile,
} from "@octogee/core/gateway-principal-access";
import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";
import { reconcilePlatformInvariants } from "@octogee/core/system-config-invariants";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";

import {
  attachOpenClawControlWsRoute,
  createOpenClawControlHttpRouter,
  isOpenClawControlWsPath,
  openClawControlRpcDeadlineMs,
  openClawControlUpstreamBase,
  openClawControlUpstreamPath,
} from "./surface.js";
import { OpenClawControlSessionManager } from "./session.js";
import { OPENCLAW_CONTROL_ALLOWED_METHODS } from "./rpc-policy.js";
import { OpenClawControlResourceLimiter } from "./limits.js";
import {
  createOpenClawControlAuthorizationCache,
  OpenClawControlBrokerError,
} from "./broker.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];
const SESSION_ID = "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessions(now = () => 1_000): OpenClawControlSessionManager {
  return new OpenClawControlSessionManager({ key: Buffer.alloc(32, 1), now });
}

function issue(
  manager: OpenClawControlSessionManager,
  brokerProfile: OpenClawBrokerProfile = "native-owner",
): string {
  const permissionSetByProfile: Record<Exclude<OpenClawBrokerProfile, "native-owner">, GatewayPermissionSetId> = {
    "native-co-owner": "co-owner.v1",
    "delegated-config": "trusted-helper.v1",
    "delegated-read": "agent-viewer.v1",
  };
  const permissionSetIds = brokerProfile === "native-owner"
    ? []
    : [permissionSetByProfile[brokerProfile]];
  return manager.issue({
    sessionId: SESSION_ID,
    uid: "uid-owner",
    gatewayId: "bender",
    workspaceSlug: "alice",
    revisionId: "bender-r7",
    brokerProfile,
    permissionSetIds,
    grantRevision: brokerProfile === "native-owner" ? null : 1,
    absoluteExpiresAt: 3_601_000,
  }).cookie.split(";", 1)[0];
}

function appWith(args: {
  env: NodeJS.ProcessEnv;
  sessions: OpenClawControlSessionManager;
  redeem?: Parameters<typeof createOpenClawControlHttpRouter>[0]["redeem"];
  authorize?: Parameters<typeof createOpenClawControlHttpRouter>[0]["authorize"];
  authorizationCache?: Parameters<typeof createOpenClawControlHttpRouter>[0]["authorizationCache"];
  loadGatewayToken?: Parameters<typeof createOpenClawControlHttpRouter>[0]["loadGatewayToken"];
  httpTimeoutMs?: number;
}) {
  const app = express();
  app.use("/api/g/:gatewayId/openclaw", createOpenClawControlHttpRouter({
    ...args,
    authorize: args.authorize ?? (async () => true),
    loadGatewayToken: args.loadGatewayToken ?? (async () => "gateway-secret"),
  }));
  return app;
}

function env(port?: number, openclawDir = "/home/node/.openclaw"): NodeJS.ProcessEnv {
  return {
    GATEWAY_ID: "bender",
    GATEWAY_REVISION_ID: "bender-r7",
    GATEWAY_CLASS: "builder",
    GATEWAY_PROFILE: "builder",
    API_PUBLIC_URL: "https://api.octogee.com",
    APP_URL: "https://app.octogee.com",
    OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${port ?? 18789}`,
    OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
    OPENCLAW_DIR: openclawDir,
  };
}

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("OpenClaw Dashboard HTTP surface", () => {
  it("accepts only its exact base path and a loopback HTTP upstream", () => {
    expect(isOpenClawControlWsPath("/openclaw")).toBe(true);
    expect(isOpenClawControlWsPath("/openclaw/ws")).toBe(false);
    expect(isOpenClawControlWsPath("/openclaw-evil/ws")).toBe(false);
    expect(openClawControlUpstreamPath("/openclaw/assets/app.js?build=1", "bender"))
      .toBe("/g/bender/openclaw/assets/app.js?build=1");
    expect(openClawControlUpstreamPath("/api/g/bender/openclaw/", "bender"))
      .toBe("/g/bender/openclaw/");
    for (const unsafe of [
      "/openclaw/../../hooks",
      "/openclaw/%2e%2e/%2e%2e/hooks",
      "/openclaw/%2F..%2Fhooks",
      "/openclaw\\..\\hooks",
      "/openclaw-evil/hooks",
      "/openclaw/ws?token=gateway-secret",
      "/openclaw/approve/%2E%2E%2Fescape",
    ]) {
      expect(() => openClawControlUpstreamPath(unsafe, "bender"), unsafe)
        .toThrow(/outside|sensitive/i);
    }
    expect(openClawControlUpstreamBase(env()).href).toBe("http://127.0.0.1:18789/");
    expect(() => openClawControlUpstreamBase({ OPENCLAW_GATEWAY_URL: "https://127.0.0.1" }))
      .toThrow(/HTTP/i);
    expect(() => openClawControlUpstreamBase({ OPENCLAW_GATEWAY_URL: "http://openclaw.example" }))
      .toThrow(/loopback/i);
  });

  it("allows the native chat session selector without weakening sensitive query rejection", () => {
    expect(openClawControlUpstreamPath(
      "/api/g/bender/openclaw/chat?session=agent%3Aoctogee-eggman-coach%3Amain",
      "bender",
    )).toBe(
      "/g/bender/openclaw/chat?session=agent%3Aoctogee-eggman-coach%3Amain",
    );
    expect(() => openClawControlUpstreamPath(
      "/api/g/bender/openclaw/chat?session=agent%3Aoctogee-eggman-coach%3Amain&token=secret",
      "bender",
    )).toThrow(/sensitive/i);
    expect(() => openClawControlUpstreamPath(
      "/api/g/bender/openclaw/chat?session=agent%3Aoctogee-eggman-coach%3Amain&session=secret%2Fpath",
      "bender",
    )).toThrow(/sensitive/i);
  });

  it("redeems once into an embedded-context secure partitioned path-scoped boot-local cookie", async () => {
    const manager = sessions();
    const ticket = "a".repeat(43);
    const redeem = vi.fn(async (input) => ({
      uid: "uid-owner",
      gatewayId: input.gatewayId,
      workspaceSlug: "alice",
      revisionId: input.revisionId,
      brokerProfile: "native-owner" as const,
      permissionSetIds: [],
      grantRevision: null,
      expiresAt: 3_601_000,
    }));
    const response = await request(appWith({ env: env(), sessions: manager, redeem }))
      .get(`/api/g/bender/openclaw/launch/${ticket}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/g/bender/openclaw/");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]?.[0]).toContain("Partitioned");
    expect(response.headers["set-cookie"]?.[0]).not.toContain("SameSite=Lax");
    expect(JSON.stringify(response.headers)).not.toContain(ticket);
    expect(response.text).not.toContain(ticket);
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({
      ticket,
      gatewayId: "bender",
      revisionId: "bender-r7",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }));
  });

  it("returns a branded relaunch document only to an unauthenticated Dashboard navigation", async () => {
    const manager = sessions();
    const application = appWith({ env: env(), sessions: manager });

    const navigation = await request(application)
      .get("/api/g/bender/openclaw/")
      .set("accept", "text/html");
    const asset = await request(application)
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("accept", "application/json");

    expect(navigation.status).toBe(401);
    expect(navigation.type).toBe("text/html");
    expect(navigation.text).toContain("OpenClaw Dashboard");
    expect(navigation.text).toContain("octogee-openclaw-dashboard-error");
    expect(navigation.text).toContain('"https://app.octogee.com"');
    expect(navigation.text).not.toContain('postMessage({type:"octogee-openclaw-dashboard-error"},"*")');
    expect(asset.status).toBe(401);
    expect(asset.body).toEqual({ error: "dashboard-session-invalid", relaunch: true });
  });

  it("redacts ticket redemption failures behind the branded embedded retry", async () => {
    const manager = sessions();
    const ticket = "a".repeat(43);
    const response = await request(appWith({
      env: env(),
      sessions: manager,
      redeem: async () => { throw new Error(`broker failed for ${ticket}`); },
    }))
      .get(`/api/g/bender/openclaw/launch/${ticket}`)
      .set("accept", "text/html");

    expect(response.status).toBe(503);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain("octogee-openclaw-dashboard-error");
    expect(response.text).not.toContain(ticket);
  });

  it("authenticates allowlisted native UI resources without forwarding browser identity or exposing the gateway token", async () => {
    let captured: http.IncomingHttpHeaders = {};
    const loadGatewayToken = vi.fn(async () => "gateway-secret");
    const upstream = http.createServer((req, res) => {
      captured = req.headers;
      if (req.headers.authorization !== "Bearer gateway-secret") {
        res.statusCode = 401;
        res.end("missing gateway auth");
        return;
      }
      res.setHeader("content-type", "text/javascript");
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:",
      );
      res.setHeader("etag", "gateway-secret");
      res.setHeader("set-cookie", "openclaw=gateway-secret");
      res.setHeader("authorization", "Bearer gateway-secret");
      res.end("native-ui gateway-secret");
    });
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({ env: env(port), sessions: manager, loadGatewayToken }))
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager))
      .set("authorization", "Bearer browser-token")
      .set("x-forwarded-for", "forged")
      .set("x-openclaw-token", "browser-token");
    expect(response.status).toBe(200);
    expect(loadGatewayToken).toHaveBeenCalledWith({ gatewayId: "bender" });
    expect(captured.authorization).toBe("Bearer gateway-secret");
    expect(captured.cookie).toBeUndefined();
    expect(captured["x-forwarded-for"]).toBeUndefined();
    expect(captured["x-openclaw-token"]).toBeUndefined();
    expect(captured.origin).toBe("https://api.octogee.com");
    expect(captured["accept-encoding"]).toBe("identity");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'self'; frame-ancestors https://app.octogee.com; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:",
    );
    expect(response.headers["x-frame-options"]).toBeUndefined();
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(JSON.stringify(response.headers)).not.toContain("gateway-secret");
    expect(response.text).not.toContain("gateway-secret");
  });

  it("does not let browser range requests split the upstream gateway credential", async () => {
    let capturedRange: string | undefined;
    const upstream = http.createServer((req, res) => {
      capturedRange = req.headers.range;
      res.setHeader("accept-ranges", "bytes");
      if (capturedRange) {
        res.statusCode = 206;
        res.setHeader("content-range", "bytes 0-6/14");
        res.end("gateway");
        return;
      }
      res.end("native-ui gateway-secret");
    });
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({ env: env(port), sessions: manager }))
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager))
      .set("range", "bytes=0-6");

    expect(response.status).toBe(200);
    expect(capturedRange).toBeUndefined();
    expect(response.headers["accept-ranges"]).toBeUndefined();
    expect(response.headers["content-range"]).toBeUndefined();
    expect(response.text).toBe("native-ui **************");
  });

  it("rejects unsolicited partial upstream responses before exposing their body", async () => {
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 206;
      res.setHeader("content-range", "bytes 0-6/14");
      res.end("gateway");
    });
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({ env: env(port), sessions: manager }))
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager));

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "openclaw-partial-response-rejected" });
    expect(response.text).not.toContain("gateway");
    expect(response.headers["content-range"]).toBeUndefined();
  });

  it.each([
    "/",
    "/chat?session=agent%3Aoctogee-eggman-coach%3Amain",
    "/new",
    "/automations",
    "/settings/plugins",
    "/settings/devices",
    "/settings/approvals",
    "/approve/approval%3A%F0%9F%A6%9E%2Fpercent%25",
    "/chat/octogee-eggman-coach",
    "/dashboard/octogee-eggman-coach",
    "/settings/agents/octogee-eggman-coach/files",
    "/workboard/city-scout",
    "/control-ui-config.json",
    "/avatar/octogee-eggman-coach?meta=1",
    "/avatar/ops%2Fmain",
    "/__openclaw__/catalog-icon/https%3A%2F%2Fcdn.example.test%2Ficon.svg",
    "/__openclaw__/channel-avatar/agent%3Amain%3Adiscord%3Adirect%3Auser-1",
    "/__openclaw__/link-favicon/docs.example.test",
    "/__openclaw__/plugin-icon/%40openclaw%2Fdiscord",
    "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
    "/__openclaw__/assistant-media?source=%2Fhome%2Fnode%2F.openclaw%2Fmedia%2Fbrowser.png",
    "/api/users/profile%2Fa%20b/avatar?v=hash%2Fimage",
    "/favicon.svg",
    "/provider-icons/ProviderIcon-openai.svg",
    "/assets/app-4c3f.js?build=1",
    "/fonts/instrument-sans.css",
    "/fonts/instrument-sans-latin.woff2",
  ])("forwards the gateway token only for the required UI resource %s", async (suffix) => {
    let requests = 0;
    let authorization: string | undefined;
    const loadGatewayToken = vi.fn(async () => "gateway-secret");
    const upstream = http.createServer((req, res) => {
      requests += 1;
      authorization = req.headers.authorization;
      if (authorization !== "Bearer gateway-secret") {
        res.statusCode = 401;
        res.end("missing gateway auth");
        return;
      }
      res.end("ok");
    });
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      loadGatewayToken,
    }))
      .get(`/api/g/bender/openclaw${suffix}`)
      .set("cookie", issue(manager));

    expect(response.status).toBe(200);
    expect(requests).toBe(1);
    expect(authorization).toBe("Bearer gateway-secret");
    expect(loadGatewayToken).toHaveBeenCalledTimes(1);
  });

  it.each<OpenClawBrokerProfile>([
    "native-co-owner",
    "delegated-config",
    "delegated-read",
  ])("does not expose owner assistant media to the %s profile", async (brokerProfile) => {
    let requests = 0;
    const loadGatewayToken = vi.fn(async () => "gateway-secret");
    const upstream = http.createServer((_req, res) => {
      requests += 1;
      res.end("unexpected");
    });
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      loadGatewayToken,
    }))
      .get("/api/g/bender/openclaw/__openclaw__/assistant-media?source=%2Fhome%2Fnode%2F.openclaw%2Fmedia%2Fbrowser.png")
      .set("cookie", issue(manager, brokerProfile));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "dashboard-resource-not-found" });
    expect(requests).toBe(0);
    expect(loadGatewayToken).not.toHaveBeenCalled();
  });

  it.each([
    "/api",
    "/hooks",
    "/plugins/arbitrary",
    "/__openclaw__/assistant-media",
    "/__openclaw__/plugin-icon/one/two",
    "/api/users/one/two/avatar",
    "/avatar/octogee-eggman-coach/extra",
    "/assets/app.js/extra",
    "/fonts/license.txt",
    "/fonts/nested/font.woff2",
    "/fonts/font.js",
    "/approve/approval%3Aok/extra",
  ])("rejects non-UI HTTP resource %s before loading or forwarding the gateway token", async (suffix) => {
    let requests = 0;
    const loadGatewayToken = vi.fn(async () => "gateway-secret");
    const upstream = http.createServer((_req, res) => {
      requests += 1;
      res.end("unexpected");
    });
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      loadGatewayToken,
    }))
      .get(`/api/g/bender/openclaw${suffix}`)
      .set("cookie", issue(manager));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "dashboard-resource-not-found" });
    expect(requests).toBe(0);
    expect(loadGatewayToken).not.toHaveBeenCalled();
  });

  it("keeps the Dashboard session usable after transient broker readiness uncertainty", async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/javascript");
      res.end("export const loaded = true;");
    });
    const port = await listen(upstream);
    const manager = sessions();
    const cookie = issue(manager);
    let authorizations = 0;
    const application = appWith({
      env: env(port),
      sessions: manager,
      authorize: async () => {
        authorizations += 1;
        if (authorizations === 1) {
          throw new Error("OpenClaw Control authorization broker returned 409");
        }
        return true;
      },
    });

    const unavailable = await request(application)
      .get("/api/g/bender/openclaw/assets/tasks-page.js")
      .set("cookie", cookie);
    const recovered = await request(application)
      .get("/api/g/bender/openclaw/assets/agents-page.js")
      .set("cookie", cookie);

    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: "openclaw-broker-unavailable", retryable: true });
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe("export const loaded = true;");
    expect(authorizations).toBe(2);
  });

  it("single-flights concurrent authorization and reuses its positive result", async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/javascript");
      res.end("export const loaded = true;");
    });
    const port = await listen(upstream);
    const manager = sessions();
    const cookie = issue(manager);
    let resolveAuthorization!: (value: boolean) => void;
    const authorize = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveAuthorization = resolve;
    }));
    const application = appWith({ env: env(port), sessions: manager, authorize });

    const first = request(application)
      .get("/api/g/bender/openclaw/assets/tasks-page.js")
      .set("cookie", cookie);
    const second = request(application)
      .get("/api/g/bender/openclaw/assets/agents-page.js")
      .set("cookie", cookie);
    const responses = Promise.all([first, second]);

    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    resolveAuthorization(true);
    expect((await responses).map((response) => response.status)).toEqual([200, 200]);

    const cached = await request(application)
      .get("/api/g/bender/openclaw/assets/skills-page.js")
      .set("cookie", cookie);
    expect(cached.status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("does not cache broker timeout failures", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const port = await listen(upstream);
    const manager = sessions();
    const cookie = issue(manager);
    let attempts = 0;
    const application = appWith({
      env: env(port),
      sessions: manager,
      authorize: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new OpenClawControlBrokerError("timeout", "broker timed out");
        }
        return true;
      },
    });

    const timeout = await request(application)
      .get("/api/g/bender/openclaw/assets/tasks-page.js")
      .set("cookie", cookie);
    const recovered = await request(application)
      .get("/api/g/bender/openclaw/assets/agents-page.js")
      .set("cookie", cookie);

    expect(timeout.status).toBe(504);
    expect(timeout.body).toEqual({ error: "openclaw-broker-timeout", retryable: true });
    expect(recovered.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("redacts rejected sensitive query parameters from the HTTP response", async () => {
    const manager = sessions();
    const response = await request(appWith({ env: env(), sessions: manager }))
      .get("/api/g/bender/openclaw/chat?token=gateway-secret")
      .set("accept", "application/json")
      .set("cookie", issue(manager));

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "openclaw-upstream-unavailable", retryable: true });
    expect(JSON.stringify(response.body)).not.toContain("gateway-secret");
    expect(JSON.stringify(response.body)).not.toContain("sensitive query parameter");
  });

  it("allows framing only by the configured Octogee app origin", async () => {
    const upstream = http.createServer((_req, res) => res.end("dashboard"));
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({
      env: { ...env(port), APP_URL: "https://app-octogee-test.web.app" },
      sessions: manager,
    })).get("/api/g/bender/openclaw/").set("cookie", issue(manager));

    expect(response.headers["content-security-policy"])
      .toContain("frame-ancestors https://app-octogee-test.web.app");
    expect(response.headers["content-security-policy"]).not.toContain("frame-ancestors *");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("rejects malformed or non-HTTPS Dashboard frame origins", () => {
    for (const APP_URL of [
      "https://app.octogee.com/path",
      "https://app.octogee.com?leak=1",
      "https://user@app.octogee.com",
      "http://app.octogee.com",
      "ftp://localhost",
    ]) {
      expect(() => createOpenClawControlHttpRouter({
        env: { ...env(), APP_URL },
        sessions: sessions(),
      }), APP_URL).toThrow(/APP_URL.*HTTPS origin/i);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects authenticated %s before the upstream",
    async (method) => {
      let requests = 0;
      const upstream = http.createServer((_req, res) => {
        requests += 1;
        res.end("unexpected");
      });
      const port = await listen(upstream);
      const manager = sessions();
      const edge = http.createServer(appWith({ env: env(port), sessions: manager }));
      const edgePort = await listen(edge);
      const response = await fetch(
        `http://127.0.0.1:${edgePort}/api/g/bender/openclaw/rpc`,
        { method, headers: { cookie: issue(manager) } },
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(requests).toBe(0);
    },
  );

  it("times out every upstream HTTP request and returns a redacted typed failure", async () => {
    const upstream = http.createServer(() => {});
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      httpTimeoutMs: 20,
    })).get("/api/g/bender/openclaw/assets/app.js").set("cookie", issue(manager));
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: "openclaw-upstream-timeout", retryable: true });
    expect(JSON.stringify(response.body)).not.toContain("gateway-secret");
  });

  it("gives the current Dashboard asset graph a fifteen-second default upstream budget", async () => {
    const timeout = vi.spyOn(http.ClientRequest.prototype, "setTimeout");
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const port = await listen(upstream);
    const manager = sessions();

    const response = await request(appWith({ env: env(port), sessions: manager }))
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager));

    expect(response.status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(15_000, expect.any(Function));
    timeout.mockRestore();
  });

  it("reports an upstream navigation failure to the embedding Octogee panel", async () => {
    const upstream = http.createServer(() => {});
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      httpTimeoutMs: 20,
    }))
      .get("/api/g/bender/openclaw/")
      .set("accept", "text/html")
      .set("cookie", issue(manager));

    expect(response.status).toBe(504);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain("OpenClaw Dashboard");
    expect(response.text).toContain("octogee-openclaw-dashboard-error");
    expect(response.text).not.toContain("gateway-secret");
  });

  it("assigns bounded RPC deadlines by method risk", () => {
    expect(openClawControlRpcDeadlineMs({ category: "read", method: "status" })).toBe(15_000);
    expect(openClawControlRpcDeadlineMs({ category: "config_mutation", method: "config.patch" })).toBe(30_000);
    expect(openClawControlRpcDeadlineMs({ category: "approval_mutation", method: "approval.resolve" })).toBe(30_000);
    expect(openClawControlRpcDeadlineMs({ category: "tools_invoke", method: "tools.invoke" })).toBe(30_000);
    expect(openClawControlRpcDeadlineMs({ category: "config_mutation", method: "config.apply" })).toBe(60_000);
    expect(openClawControlRpcDeadlineMs({ category: "unknown", method: "browser.request" })).toBe(60_000);
    expect(openClawControlRpcDeadlineMs({ category: "config_mutation", method: "config.apply", overrideMs: 20 })).toBe(20);
  });
});

describe("OpenClaw Dashboard WebSocket surface", () => {
  it("shares a positive authorization cache between Dashboard assets and the WebSocket attachment", async () => {
    const upstream = http.createServer((_req, res) => res.end("asset"));
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const cookie = issue(manager);
    const authorize = vi.fn(async () => true);
    const authorizationCache = createOpenClawControlAuthorizationCache({ authorize });
    const edge = http.createServer(appWith({
      env: env(upstreamPort),
      sessions: manager,
      authorizationCache,
    }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorizationCache,
      loadGatewayToken: async () => "gateway-secret",
    });
    router.attach(edge);
    const edgePort = await listen(edge);

    const asset = await request(edge)
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", cookie);
    expect(asset.status).toBe(200);

    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie, origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    expect(authorize).toHaveBeenCalledTimes(1);

    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it.each([
    ["timeout", 504, "OPENCLAW_BROKER_TIMEOUT"],
    ["unavailable", 503, "OPENCLAW_BROKER_UNAVAILABLE"],
  ] as const)("returns typed %s broker failures during the WebSocket handshake", async (kind, status, code) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(),
      sessions: manager,
      authorize: async () => {
        throw new OpenClawControlBrokerError(kind, `broker ${kind}`);
      },
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const outcome = await new Promise<{ status: number; errorCode: string | undefined }>((resolve, reject) => {
      const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
        headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
      });
      browser.once("unexpected-response", (_request, response) => {
        const errorCode = response.headers["x-octogee-ws-error"];
        response.resume();
        browser.terminate();
        resolve({ status: response.statusCode ?? 0, errorCode: typeof errorCode === "string" ? errorCode : undefined });
      });
      browser.once("open", () => reject(new Error("broker-failed handshake unexpectedly opened")));
      browser.once("error", () => undefined);
    });
    errorSpy.mockRestore();

    expect(outcome).toEqual({ status, errorCode: code });
  });

  it.each([
    "result",
    "late-result",
    "malformed-response",
    "late-malformed-response",
    "hard-timeout",
    "browser-close",
    "upstream-close",
  ] as const)(
    "handles %s without an early durable config writer lease release",
    async (terminal) => {
      const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dashboard-lease-"));
      tempDirs.push(openclawDir);
      const currentConfig: Record<string, unknown> = { customerSetting: "before" };
      reconcilePlatformInvariants(currentConfig, {
        gatewayClass: "builder",
        gatewayId: "bender",
        apiOrigin: "https://api.octogee.com",
      });
      let upstreamSocket: WebSocket | undefined;
      let retainedMutationLease: { release(): Promise<void> } | undefined;
      let mutationAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => { mutationAdmitted = resolve; });
      const upstream = http.createServer();
      const upstreamWs = new WebSocketServer({ noServer: true });
      upstream.on("upgrade", (req, socket, head) => {
        upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
      });
      upstreamWs.on("connection", (ws) => {
        upstreamSocket = ws;
        ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
        ws.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.method === "connect") {
            ws.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
              },
            }));
          } else if (frame.method === "config.get") {
            ws.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { raw: JSON.stringify(currentConfig), hash: "hash-1" },
            }));
          } else if (frame.method === "config.patch") {
            mutationAdmitted();
          }
        });
      });
      const upstreamPort = await listen(upstream);
      const manager = sessions();
      const testEnv = env(upstreamPort, openclawDir);
      const edge = http.createServer(appWith({ env: testEnv, sessions: manager }));
      const router = new WsUpgradeRouter();
      attachOpenClawControlWsRoute({
        router,
        env: testEnv,
        sessions: manager,
        authorize: async () => true,
        loadGatewayToken: async () => "gateway-secret",
        rpcTimeoutMs: ["late-result", "late-malformed-response", "hard-timeout"].includes(terminal)
          ? 500
          : 30_000,
        retainMutationLeaseUntilProcessReplacement: (lease) => {
          retainedMutationLease = lease;
        },
      });
      router.attach(edge);
      const edgePort = await listen(edge);
      const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
        headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
      });
      const browserClosed = new Promise<void>((resolve) => browser.once("close", () => resolve()));
      let collisionObserved!: () => void;
      const collidingFrame = new Promise<void>((resolve) => { collisionObserved = resolve; });
      const terminalFrame = new Promise<Record<string, unknown>>((resolve, reject) => {
        browser.on("error", reject);
        browser.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.event === "connect.challenge") {
            browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
          } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
            browser.send(JSON.stringify({ type: "req", id: "config-read", method: "config.get", params: {} }));
          } else if (frame.id === "config-read") {
            browser.send(JSON.stringify({
              type: "req",
              id: "config-write",
              method: "config.patch",
              params: {
                raw: JSON.stringify({ customerSetting: "after" }),
                baseHash: "hash-1",
                replacePaths: [],
              },
            }));
          } else if (frame.type === "event" && frame.id === "config-write") {
            collisionObserved();
          } else if (frame.id === "config-write") {
            resolve(frame);
          }
        });
      });

      await admitted;
      const racingFreeze = acquireSystemConfigSyncLeaseSync({ openclawDir });
      try {
        expect(racingFreeze).toBeNull();
      } finally {
        racingFreeze?.release();
      }

      if (terminal === "result") {
        upstreamSocket?.send(JSON.stringify({
          type: "event",
          id: "config-write",
          event: "unrelated",
        }));
        await collidingFrame;
        expect(acquireSystemConfigSyncLeaseSync({ openclawDir })).toBeNull();
        upstreamSocket?.send(JSON.stringify({
          type: "res",
          id: "config-write",
          ok: true,
          payload: { accepted: true },
        }));
        await expect(terminalFrame).resolves.toMatchObject({ id: "config-write", ok: true });
      } else if (terminal === "late-result") {
        await expect(terminalFrame).resolves.toMatchObject({
          id: "config-write",
          ok: false,
          error: { code: "UPSTREAM_TIMEOUT" },
        });
        expect(acquireSystemConfigSyncLeaseSync({ openclawDir })).toBeNull();
        upstreamSocket?.send(JSON.stringify({
          type: "res",
          id: "config-write",
          ok: true,
          payload: { accepted: true },
        }));
      } else if (terminal === "malformed-response") {
        upstreamSocket?.send(JSON.stringify({ type: "res", id: "config-write" }));
        await browserClosed;
      } else if (terminal === "late-malformed-response") {
        await expect(terminalFrame).resolves.toMatchObject({
          id: "config-write",
          ok: false,
          error: { code: "UPSTREAM_TIMEOUT" },
        });
        expect(acquireSystemConfigSyncLeaseSync({ openclawDir })).toBeNull();
        upstreamSocket?.send(JSON.stringify({ type: "res", id: "config-write", ok: "maybe" }));
        await browserClosed;
      } else if (terminal === "hard-timeout") {
        await expect(terminalFrame).resolves.toMatchObject({
          id: "config-write",
          ok: false,
          error: { code: "UPSTREAM_TIMEOUT" },
        });
        await browserClosed;
      } else if (terminal === "browser-close") {
        browser.close();
        await browserClosed;
      } else {
        upstreamSocket?.close();
        await browserClosed;
      }

      if (terminal === "result" || terminal === "late-result") {
        await vi.waitFor(() => {
          expect(fs.existsSync(path.join(openclawDir, "system_config.sync.lock"))).toBe(false);
        });
        expect(retainedMutationLease).toBeUndefined();
        const after = acquireSystemConfigSyncLeaseSync({ openclawDir });
        expect(after).not.toBeNull();
        after?.release();
      } else {
        await vi.waitFor(() => expect(retainedMutationLease).toBeDefined());
        expect(fs.existsSync(path.join(openclawDir, "system_config.sync.lock"))).toBe(true);
        expect(acquireSystemConfigSyncLeaseSync({ openclawDir })).toBeNull();
        await retainedMutationLease?.release();
      }
      if (browser.readyState === WebSocket.OPEN) browser.close();
      if (browser.readyState !== WebSocket.CLOSED) await browserClosed;
      await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
    },
  );

  it("holds the browser connect until the loopback gateway challenge arrives", async () => {
    const upstreamFrames: Array<Record<string, unknown>> = [];
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      setTimeout(() => {
        upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
      }, 50);
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "delayed-challenge" },
      }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamFrames.push(frame);
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("delayed connect did not complete")), 1_000);
      browser.once("open", () => {
        setTimeout(() => {
          browser.send(JSON.stringify({
            type: "req",
            id: "early-connect",
            method: "connect",
            params: {},
          }));
        }, 10);
      });
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          clearTimeout(deadline);
          resolve(frame);
        }
      });
    });

    await expect(hello).resolves.toMatchObject({ id: "early-connect", ok: true });
    expect(upstreamFrames).toContainEqual(expect.objectContaining({
      id: "early-connect",
      method: "connect",
      params: expect.objectContaining({ auth: { token: "gateway-secret" } }),
    }));
    expect(browser.readyState).toBe(WebSocket.OPEN);
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("requires the exact Origin, rewrites connect, forwards native owner exec tools, and scrubs frames", async () => {
    const upstreamFrames: Array<Record<string, unknown>> = [];
    let upstreamOrigin: string | undefined;
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamOrigin = req.headers.origin;
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "native-smoke" },
      }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamFrames.push(frame);
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: { token: "gateway-secret" },
              features: {
                methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS],
              },
            },
          }));
        } else if (frame.method === "tools.invoke") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { output: "uid=1000(node)" },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 100,
    });
    router.attach(edge);
    const edgePort = await listen(edge);

    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const rejected = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
        headers: { cookie: issue(manager), origin: "https://evil.example" },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejected.terminate();
        reject(new Error("cross-origin handshake timed out"));
      }, 2_000);
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      rejected.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        settle(() => {
          rejected.terminate();
          resolve(status);
        });
      });
      rejected.once("open", () => {
        settle(() => {
          rejected.terminate();
          reject(new Error("cross-origin handshake unexpectedly opened"));
        });
      });
      rejected.once("error", (error) => {
        settle(() => reject(error));
      });
    });
    expect(rejectedStatus).toBe(403);
    expect(upstreamOrigin).toBeUndefined();

    const browserFrames: Array<Record<string, unknown>> = [];
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: {
        cookie: issue(manager),
        origin: "https://api.octogee.com",
        authorization: "Bearer browser-token",
        "x-forwarded-for": "forged",
      },
    });
    await new Promise<void>((resolve, reject) => {
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        browserFrames.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({
            type: "req",
            id: "connect-native",
            method: "connect",
            params: {
              auth: { token: "browser-token" },
              device: { id: "browser-device" },
            },
          }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({
            type: "req",
            id: "owner-tool",
            method: "tools.invoke",
            params: { name: "exec", args: { command: "id" } },
          }));
        } else if (frame.id === "owner-tool") {
          resolve();
        }
      });
    });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));

    expect(upstreamFrames).toContainEqual(expect.objectContaining({
      method: "connect",
      params: expect.objectContaining({
        client: expect.objectContaining({ id: "gateway-client", mode: "backend" }),
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.questions",
          "operator.pairing",
        ],
        auth: { token: "gateway-secret" },
      }),
    }));
    expect(upstreamFrames).toContainEqual(expect.objectContaining({
      id: "owner-tool",
      method: "tools.invoke",
      params: { name: "exec", args: { command: "id" } },
    }));
    expect(browserFrames).toContainEqual(expect.objectContaining({
      id: "owner-tool",
      ok: true,
      payload: { output: "uid=1000(node)" },
    }));
    expect(upstreamOrigin).toBeUndefined();
    expect(JSON.stringify(browserFrames)).not.toContain("gateway-secret");
    expect(JSON.stringify(browserFrames)).not.toContain("browser-token");
  });

  it("forwards hidden native-owner methods and returns the runtime's response", async () => {
    const upstreamFrames: Array<Record<string, unknown>> = [];
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamFrames.push(frame);
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: {
                methods: [
                  ...OPENCLAW_CONTROL_ALLOWED_METHODS.filter((method) => method !== "status"),
                  "future.write",
                ],
              },
            },
          }));
        } else if (frame.id === "hidden-session-usage") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { sessions: [] },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("hidden method was not forwarded")), 1_000);
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({
            type: "req",
            id: "hidden-session-usage",
            method: "sessions.usage",
            params: {},
          }));
        } else if (frame.id === "hidden-session-usage") {
          clearTimeout(deadline);
          resolve(frame);
        }
      });
    });

    expect(response).toMatchObject({
      id: "hidden-session-usage",
      ok: true,
      payload: { sessions: [] },
    });
    expect(upstreamFrames).toContainEqual(expect.objectContaining({
      id: "hidden-session-usage",
      method: "sessions.usage",
    }));
    expect(browser.readyState).toBe(WebSocket.OPEN);
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("includes Mattermost discovery in the RPC deadline and aborts its work", async () => {
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        } else if (frame.method === "status") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ready: true } }));
        }
      });
    });
    let preparationSignal: AbortSignal | undefined;
    const mattermostChat = {
      prepare: async (
        frame: { method: string },
        _session: unknown,
        signal?: AbortSignal,
      ) => {
        if (frame.method !== "sessions.list") return null;
        if (!signal) throw new Error("Mattermost preparation must receive an AbortSignal");
        preparationSignal = signal;
        return await new Promise<never>(() => undefined);
      },
    };
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 20,
      mattermostChat,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    let timedOutFrame: Record<string, unknown> | undefined;
    const statusFrame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Mattermost preparation did not time out")), 1_000);
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({ type: "req", id: "sessions-slow", method: "sessions.list", params: {} }));
        } else if (frame.id === "sessions-slow") {
          timedOutFrame = frame;
          browser.send(JSON.stringify({ type: "req", id: "status-after", method: "status", params: {} }));
        } else if (frame.id === "status-after") {
          clearTimeout(deadline);
          resolve(frame);
        }
      });
    });

    expect(timedOutFrame).toMatchObject({ ok: false, error: { code: "UPSTREAM_TIMEOUT" } });
    expect(preparationSignal?.aborted).toBe(true);
    expect(statusFrame).toMatchObject({ ok: true, payload: { ready: true } });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("aborts in-progress Mattermost discovery when the browser disconnects", async () => {
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        }
      });
    });
    let preparationSignal: AbortSignal | undefined;
    let preparationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      rpcTimeoutMs: 5_000,
      mattermostChat: {
        prepare: async (frame, _session, signal) => {
          if (frame.method !== "sessions.list") return null;
          preparationSignal = signal;
          preparationStarted();
          return await new Promise<never>(() => undefined);
        },
      },
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    browser.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.event === "connect.challenge") {
        browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
      } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
        browser.send(JSON.stringify({ type: "req", id: "sessions-disconnect", method: "sessions.list", params: {} }));
      }
    });

    await started;
    const closed = new Promise<void>((resolve) => browser.once("close", () => resolve()));
    browser.close();
    await closed;
    await vi.waitFor(() => expect(preparationSignal?.aborted).toBe(true));
    expect(preparationSignal?.reason).toBeInstanceOf(DOMException);
    expect((preparationSignal?.reason as DOMException).name).toBe("AbortError");
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("times out every forwarded RPC and releases the shared in-flight slot", async () => {
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 20,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    const timeoutFrame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({ type: "req", id: "status-1", method: "status", params: {} }));
        } else if (frame.id === "status-1") {
          resolve(frame);
        }
      });
    });
    expect(timeoutFrame).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM_TIMEOUT" },
    });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("tombstones a timed-out id until its late response drains before allowing safe reuse", async () => {
    let upstreamSocket: WebSocket | undefined;
    let statusRequests = 0;
    let returnFresh = false;
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      upstreamSocket = ws;
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        } else if (frame.method === "status") {
          statusRequests += 1;
          if (returnFresh) {
            ws.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { generation: "fresh" },
            }));
          }
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 30,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browserFrames: Array<Record<string, unknown>> = [];
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timed-id reuse did not settle")), 1_000);
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        browserFrames.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({ type: "req", id: "reused", method: "status", params: {} }));
        } else if ((frame.error as Record<string, unknown> | undefined)?.code === "UPSTREAM_TIMEOUT") {
          browser.send(JSON.stringify({ type: "req", id: "reused", method: "status", params: {} }));
          setTimeout(() => {
            upstreamSocket?.send(JSON.stringify({
              type: "res",
              id: "reused",
              ok: true,
              payload: { generation: "old" },
            }));
            setTimeout(() => {
              returnFresh = true;
              browser.send(JSON.stringify({ type: "req", id: "reused", method: "status", params: {} }));
            }, 5);
          }, 5);
        } else if ((frame.payload as Record<string, unknown> | undefined)?.generation === "fresh") {
          clearTimeout(deadline);
          resolve();
        }
      });
    });

    expect(statusRequests).toBe(2);
    expect(browserFrames.some((frame) =>
      (frame.error as Record<string, unknown> | undefined)?.message ===
        "Octogee policy denied this operation (request-id-quarantined)")).toBe(true);
    expect(browserFrames.some((frame) =>
      (frame.payload as Record<string, unknown> | undefined)?.generation === "old")).toBe(false);
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("quarantines repeated timed-out tools.invoke work and releases the socket after cleanup", async () => {
    let toolRequests = 0;
    let connections = 0;
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      connections += 1;
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        } else if (frame.method === "tools.invoke") {
          toolRequests += 1;
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 20,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const first = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("quarantined socket stayed open")), 1_000);
      first.on("error", () => undefined);
      first.on("close", () => {
        clearTimeout(deadline);
        resolve();
      });
      first.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          first.send(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          first.send(JSON.stringify({
            type: "req",
            id: "tool-1",
            method: "tools.invoke",
            params: { name: "web_search", args: { query: "first" } },
          }));
        } else if ((frame.error as Record<string, unknown> | undefined)?.code === "UPSTREAM_TIMEOUT") {
          for (let index = 2; index <= 5; index += 1) {
            first.send(JSON.stringify({
              type: "req",
              id: `tool-${index}`,
              method: "tools.invoke",
              params: { name: "web_search", args: { query: `retry-${index}` } },
            }));
          }
        }
      });
    });
    expect(toolRequests).toBe(1);

    const second = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("socket lease was not released")), 1_000);
      second.on("error", reject);
      second.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          second.send(JSON.stringify({ type: "req", id: "connect-2", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          clearTimeout(deadline);
          resolve();
        }
      });
    });
    expect(connections).toBe(2);
    second.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("terminates a still-negotiating upstream on browser disconnect or capability revocation", async () => {
    let heldSocket: Duplex | undefined;
    let acceptSocket!: () => void;
    let closeSocket!: () => void;
    const accepted = new Promise<void>((resolve) => { acceptSocket = resolve; });
    const closed = new Promise<void>((resolve) => { closeSocket = resolve; });
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      heldSocket = socket;
      socket.once("close", closeSocket);
      socket.once("end", closeSocket);
      acceptSocket();
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    let authorizations = 0;
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => (authorizations += 1) < 3,
      loadGatewayToken: async () => "gateway-secret",
      authorizationIntervalMs: 10,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    const browserClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      browser.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await accepted;
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 500)),
    ]);
    await expect(browserClosed).resolves.toEqual({ code: 1008, reason: "capability-revoked" });
    heldSocket?.destroy();
    expect(authorizations).toBeGreaterThanOrEqual(3);
  });

  it("uses the session authorization timer instead of revalidating every Dashboard RPC", async () => {
    let statusForwarded = false;
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        } else if (frame.method === "status") {
          statusForwarded = true;
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    let authorizations = 0;
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => {
        authorizations += 1;
        return true;
      },
      loadGatewayToken: async () => "gateway-secret",
      authorizationIntervalMs: 60_000,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("status RPC was not forwarded")), 1_000);
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({ type: "req", id: "status", method: "status", params: {} }));
        }
      });
      const observeStatus = setInterval(() => {
        if (!statusForwarded) return;
        clearInterval(observeStatus);
        clearTimeout(deadline);
        resolve();
      }, 5);
    });

    expect(authorizations).toBe(1);
    expect(statusForwarded).toBe(true);
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("carries each person's identity to OpenClaw and settles their role before forwarding connect", async () => {
    const upstreamFrames: Array<Record<string, unknown>> = [];
    const upgradeHeaders: Array<Record<string, unknown>> = [];
    const assetHeaders: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
      assetHeaders.push(req.headers);
      res.setHeader("content-type", "text/plain");
      res.end("asset");
    });
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upgradeHeaders.push(req.headers);
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "per-user-nonce" },
      }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamFrames.push(frame);
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: { role: "operator", scopes: ["operator.read"] },
              features: { methods: [...OPENCLAW_CONTROL_ALLOWED_METHODS] },
            },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const perUserEnv = { ...env(upstreamPort), OPENCLAW_CONTROL_IDENTITY: "per-user" };
    const manager = sessions();
    const syncOrder: string[] = [];
    const proxyIdentity = {
      enabled: true,
      userHeaders: (session: { uid: string }) => ({
        "x-octogee-user": session.uid,
        "x-octogee-proxy": "1",
        "x-forwarded-for": "10.9.8.7",
        "x-forwarded-proto": "https",
      }),
      serviceHeaders: () => ({ "x-octogee-user": "svc:gateway-edge", "x-octogee-proxy": "1" }),
      syncRole: vi.fn(async (session: { uid: string; brokerProfile: string }) => {
        syncOrder.push(`sync:${session.uid}:${session.brokerProfile}`);
      }),
    };
    const edge = http.createServer(appWith({
      env: perUserEnv,
      sessions: manager,
      loadGatewayToken: async () => {
        throw new Error("per-user must not load the pod token");
      },
      ...({ proxyIdentity } as object),
    }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: perUserEnv,
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => {
        throw new Error("per-user must not load the pod token");
      },
      proxyIdentity,
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 100,
    });
    router.attach(edge);
    const edgePort = await listen(edge);

    const asset = await request(edge)
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager, "delegated-config"))
      .set("x-octogee-user", "forged-uid")
      .set("x-octogee-proxy", "1");
    expect(asset.status).toBe(200);
    expect(assetHeaders[0]).toMatchObject({ "x-octogee-user": "uid-owner", "x-octogee-proxy": "1" });
    expect(assetHeaders[0]).not.toHaveProperty("authorization");

    const browserFrames: Array<Record<string, unknown>> = [];
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: {
        cookie: issue(manager, "delegated-config"),
        origin: "https://api.octogee.com",
        "x-octogee-user": "forged-uid",
        "x-octogee-proxy": "1",
      },
    });
    await new Promise<void>((resolve, reject) => {
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        browserFrames.push(frame);
        if (frame.event === "connect.challenge") {
          syncOrder.push("browser-connect");
          browser.send(JSON.stringify({
            type: "req",
            id: "connect-per-user",
            method: "connect",
            params: { auth: { token: "browser-token" }, scopes: ["operator.admin"] },
          }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          resolve();
        }
      });
    });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));

    expect(upgradeHeaders[0]).toMatchObject({
      "x-octogee-user": "uid-owner",
      "x-octogee-proxy": "1",
      "x-forwarded-for": "10.9.8.7",
    });
    expect(syncOrder).toEqual(["browser-connect", "sync:uid-owner:delegated-config"]);
    const connect = upstreamFrames.find((frame) => frame.method === "connect");
    expect(connect?.params).toMatchObject({
      client: expect.objectContaining({ id: "openclaw-control-ui", mode: "ui" }),
      role: "operator",
    });
    expect(connect?.params).not.toHaveProperty("auth");
    expect(connect?.params).not.toHaveProperty("scopes");
    expect(JSON.stringify(upstreamFrames)).not.toContain("browser-token");
    expect(JSON.stringify(upstreamFrames)).not.toContain("forged-uid");
    expect(JSON.stringify(upgradeHeaders)).not.toContain("forged-uid");
  });
});
