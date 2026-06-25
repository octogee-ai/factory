import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { deriveByosubHealth } from "../lib/byosub.js";
import {
  createByosubHealthRouter,
  type ByosubHealthDeps,
} from "../routes/byosub-health.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "../../../scripts/lib/model-credential-materializer.js";

const PROFILE = OPENAI_CODEX_DEFAULT_PROFILE_ID;
const NOW = 1_700_000_000_000;

// A codex auth-state that deriveCodexAuthHealth reads as permanently dead.
const DEAD_STATE = JSON.stringify({
  usageStats: { [PROFILE]: { disabledReason: "auth_permanent" } },
});

function base() {
  return { storePresent: true, authStateText: "", profileId: PROFILE, now: NOW };
}

describe("deriveByosubHealth — ref (expectation) ✕ store (reality)", () => {
  it("not mounted on this pod → not_on_this_pod (even if a ref says it should be here)", () => {
    expect(
      deriveByosubHealth({ ...base(), mountedHere: false, refProvider: "openai" }),
    ).toEqual({ connected: false, status: "not_on_this_pod" });
  });

  it("mounted, no byosub ref → not_connected (user never set up BYOS)", () => {
    expect(
      deriveByosubHealth({ ...base(), mountedHere: true, refProvider: null }),
    ).toEqual({ connected: false, status: "not_connected" });
  });

  it("mounted + ref present but pod store ABSENT → missing (the durability failure the shallow check can't see)", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: false,
      }),
    ).toEqual({ connected: false, status: "missing", provider: "openai" });
  });

  it("mounted + ref + store present + clean auth-state → healthy, connected", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: true,
        authStateText: "",
      }),
    ).toEqual({ connected: true, status: "healthy", provider: "openai" });
  });

  it("mounted + ref + store present but codex marked it permanently dead → needs_reauth", () => {
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: true,
        refProvider: "openai",
        storePresent: true,
        authStateText: DEAD_STATE,
      }),
    ).toEqual({ connected: false, status: "needs_reauth", provider: "openai" });
  });

  it("missing ranks below not_on_this_pod: a wrong-pod probe never masquerades as a durability failure", () => {
    // mountedHere=false dominates regardless of store state — the client asked
    // the wrong pod (mid-migration / stale gatewayId), not a real materialization gap.
    expect(
      deriveByosubHealth({
        ...base(),
        mountedHere: false,
        refProvider: "openai",
        storePresent: false,
      }).status,
    ).toBe("not_on_this_pod");
  });
});

function appWith(deps: ByosubHealthDeps) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "uid-1";
    next();
  });
  app.use("/api/g/:gatewayId/byosub", createByosubHealthRouter(deps));
  app.use("/probe/byosub", createByosubHealthRouter(deps));
  return app;
}

function healthPath(gatewayId = "default"): string {
  return `/api/g/${gatewayId}/byosub/health`;
}

function fakeDeps(over: Partial<ByosubHealthDeps> = {}): ByosubHealthDeps {
  return {
    resolveUserGateway: async () => ({ slug: "smile-wring-011b", gatewayId: "default" }),
    localGatewayId: () => "default",
    isMounted: () => true,
    readRefProvider: async () => "openai",
    readStorePresent: () => true,
    readAuthStateText: () => "",
    now: () => NOW,
    ...over,
  };
}

describe("GET /byosub/health route glue", () => {
  it("200 not_on_this_pod on the unscoped alias — no gateway-local proof without /api/g/<gatewayId>", async () => {
    const resolve = vi.fn(async () => ({ slug: "smile-wring-011b", gatewayId: "default" }));
    const res = await request(appWith(fakeDeps({ resolveUserGateway: resolve }))).get(
      "/probe/byosub/health",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("200 not_on_this_pod when the scoped path reached a different gateway pod — no fs reads", async () => {
    const resolve = vi.fn(async () => ({ slug: "smile-wring-011b", gatewayId: "operator-1" }));
    const mountRead = vi.fn(() => true);
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: resolve,
          localGatewayId: () => "default",
          isMounted: mountRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(resolve).not.toHaveBeenCalled();
    expect(mountRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("200 not_on_this_pod when the user is no longer assigned to the requested gateway — no fs reads", async () => {
    const mountRead = vi.fn(() => true);
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const refRead = vi.fn(async () => "openai");
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({ slug: "smile-wring-011b", gatewayId: "default" }),
          localGatewayId: () => "operator-1",
          isMounted: mountRead,
          readRefProvider: refRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "not_on_this_pod" });
    expect(mountRead).not.toHaveBeenCalled();
    expect(refRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("422 not_provisioned when the user has no resolved gateway", async () => {
    const res = await request(appWith(fakeDeps({ resolveUserGateway: async () => null }))).get(
      healthPath(),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ connected: false, status: "not_provisioned" });
  });

  it("200 missing — ref present but the pod store didn't materialize (the durability regression)", async () => {
    const res = await request(appWith(fakeDeps({ readStorePresent: () => false }))).get(
      healthPath(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, status: "missing", provider: "openai" });
  });

  it("200 healthy — mounted, ref present, store present, clean auth-state", async () => {
    const res = await request(appWith(fakeDeps())).get(healthPath());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, status: "healthy", provider: "openai" });
  });

  it("422 + NO filesystem read when the resolved slug would build a path-unsafe agent id (traversal guard)", async () => {
    // primaryWorkspaceSlug can fall back to the client-writable `username`; this
    // route feeds the derived agent id into filesystem paths (codexAgentDir /
    // CUSTOMERS_DIR), so a slug like "../../etc" must be rejected BEFORE any fs
    // access — the existing /connection route only used the id as a Firestore map
    // key, where traversal is harmless.
    const storeRead = vi.fn(() => true);
    const stateRead = vi.fn(() => "");
    const mountRead = vi.fn(() => true);
    const res = await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({ slug: "../../etc", gatewayId: "default" }),
          isMounted: mountRead,
          readStorePresent: storeRead,
          readAuthStateText: stateRead,
        }),
      ),
    ).get(healthPath());
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ connected: false, status: "not_provisioned" });
    expect(mountRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("passes the resolved gateway + coach agent id through to the ref read", async () => {
    let seen: { gatewayId: string; agentId: string } | null = null;
    await request(
      appWith(
        fakeDeps({
          resolveUserGateway: async () => ({ slug: "smile-wring-011b", gatewayId: "operator-1" }),
          localGatewayId: () => "operator-1",
          readRefProvider: async (gatewayId, agentId) => {
            seen = { gatewayId, agentId };
            return "openai";
          },
        }),
      ),
    ).get(healthPath("operator-1"));
    expect(seen).toEqual({ gatewayId: "operator-1", agentId: "octogee-smile-wring-011b-coach" });
  });
});
