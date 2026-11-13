import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { UserCredentialRejected, type UserIdentityProvider } from "@octogee/core/user-identity-provider";

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("../../../gateway-edge/src/middleware/logging.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../gateway-edge/src/middleware/logging.js")>(),
  logger: logged,
}));

import { USER_IDENTITY_BROKER_PATH } from "../../../gateway-edge/src/lib/brokered-user-identity-provider.js";
import {
  installUserIdentityProvider,
  loadUserWithInstalledProvider,
  requireAuthenticatedUid,
} from "../../../gateway-edge/src/middleware/auth.js";
import { SIDECAR_BROKER_ROUTES } from "../app.js";
import { createTenantEnforcementMiddleware, NO_PRODUCT_TENANT_ROUTES } from "../middleware/tenant-enforcement.js";
import { createUserIdentityBrokerRoutes } from "./user-identity-broker.js";

const ADA = { username: "ada", accountLifecycle: { status: "active" } };

function identity(users: Record<string, Record<string, unknown>> = { "uid-ada": ADA }) {
  return {
    verifyBearer: vi.fn<UserIdentityProvider["verifyBearer"]>(async (token) => {
      if (token !== "ada-session") throw new UserCredentialRejected("unknown session");
      return { uid: "uid-ada", authTime: 1_700_000_000 };
    }),
    loadUser: vi.fn<UserIdentityProvider["loadUser"]>(async (uid) => users[uid] ?? null),
  };
}

function api(opts: { bound?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.bound !== false) req.boundTenant = { kind: "gateway", gatewayId: "walter", saName: "octogee-gw-walter", podUid: "pod-1", podName: "pod-1" };
    next();
  });
  app.use(createTenantEnforcementMiddleware({
    onDenied: async () => {},
    onAccess: () => {},
    readFlowGateway: async () => null,
    store: createDocumentFixtureStore(new Map()),
    productRoutes: NO_PRODUCT_TENANT_ROUTES,
  }));
  app.use("/internal/user-identity", requireAuthenticatedUid, createUserIdentityBrokerRoutes({ loadUser: loadUserWithInstalledProvider }));
  return app;
}

function verify(app: express.Express, opts: { bearer?: string; gatewayId?: string } = {}) {
  return request(app)
    .post(USER_IDENTITY_BROKER_PATH)
    .set("authorization", `Bearer ${opts.bearer ?? "ada-session"}`)
    .send({ gatewayId: opts.gatewayId ?? "walter" });
}

beforeEach(() => {
  logged.error.mockClear();
  installUserIdentityProvider(identity());
});

describe("the user identity broker for gateway sidecars", () => {
  it("is a sidecar-only broker route", () => {
    expect(SIDECAR_BROKER_ROUTES.has(USER_IDENTITY_BROKER_PATH)).toBe(true);
  });

  it("answers the verified uid, sign-in time and user from the installed identity", async () => {
    const response = await verify(api());

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ uid: "uid-ada", authTime: 1_700_000_000, user: ADA });
  });

  it("answers a null user for a verified bearer whose user does not exist yet", async () => {
    installUserIdentityProvider(identity({}));

    const response = await verify(api());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uid: "uid-ada", authTime: 1_700_000_000, user: null });
  });

  it("answers 401 for a bearer the installed identity rejects", async () => {
    const response = await verify(api(), { bearer: "stolen" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid token" });
  });

  it("refuses a request that names another gateway", async () => {
    const response = await verify(api(), { gatewayId: "other" });

    expect(response.status).toBe(403);
  });

  it("refuses a caller that is not bound to a gateway", async () => {
    const response = await verify(api({ bound: false }));

    expect(response.status).toBe(403);
  });

  it("answers 503 and logs when the user cannot be loaded", async () => {
    const failing = identity();
    failing.loadUser.mockRejectedValueOnce(new Error("platform state unavailable"));
    installUserIdentityProvider(failing);

    const response = await verify(api());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Authentication lookup unavailable" });
    expect(logged.error).toHaveBeenCalledWith("[user-identity-broker] user lookup failed", expect.objectContaining({ gatewayId: "walter" }));
  });
});
