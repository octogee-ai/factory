import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ConnectorTokenReadError extends Error {
    constructor(
      readonly status: number,
      readonly errorCode: string,
      message = `connector token read failed: ${errorCode}`,
    ) {
      super(message);
      this.name = "ConnectorTokenReadError";
    }
  }

  class ConnectorTokenBrokerError extends ConnectorTokenReadError {
    constructor(status: number, errorCode: string) {
      super(status, errorCode, `connector token broker failed: ${errorCode}`);
      this.name = "ConnectorTokenBrokerError";
    }
  }

  return {
    docs: {} as Record<string, Record<string, unknown>>,
    readConnectorAccessToken: vi.fn(),
    ConnectorTokenReadError,
    ConnectorTokenBrokerError,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => ({
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(mocks.docs, path),
        data: () => mocks.docs[path],
      }),
    }),
  },
}));

vi.mock("../lib/connector-tokens.js", () => ({
  readConnectorAccessToken: mocks.readConnectorAccessToken,
  ConnectorTokenReadError: mocks.ConnectorTokenReadError,
  ConnectorTokenBrokerError: mocks.ConnectorTokenBrokerError,
}));

vi.mock("../middleware/builder-shell-auth.js", () => ({
  requireBuilderShellInternalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { error: mocks.error, warn: mocks.warn, info: mocks.info },
}));

import connectorRoutes from "../routes/internal/connectors.js";
import {
  ConnectorTokenBrokerError,
  readConnectorAccessToken,
} from "../lib/connector-tokens.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/internal/connectors", connectorRoutes);
  return a;
}

function rootConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: { shellsEnabled: true },
    ownerUid: "uid-owner",
    coOwnerUids: [],
    builderSlug: "acme",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("internal connector materialize route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.docs)) delete mocks.docs[key];
    process.env.GATEWAY_CLASS = "operator";
    process.env.GATEWAY_PROFILE = "operator";
    process.env.GATEWAY_ID = "bender";
    process.env.GATEWAY_REVISION_ID = "bender";
    process.env.GATEWAY_BUILDER_SLUG = "acme";
    mocks.docs["workspaces/acme"] = { ownerUid: "uid-owner" };
    mocks.docs["gateways/bender"] = {
      gatewayId: "bender",
      latestRelease: 2,
      desiredRelease: 2,
      liveRelease: 2,
      desiredStatus: "running",
      ...rootConfig(),
    };
    mocks.docs["glmGateways/bender"] = {
      docKind: "runtime",
      gatewayId: "bender",
      release: 2,
      lifecycle: "serving",
    };
  });

  it("materializes a connected owner-runtime token for the bound operator owner", async () => {
    vi.mocked(readConnectorAccessToken).mockResolvedValue("cf_secret");

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "connected",
      connectorId: "cloudflare",
      accessToken: "cf_secret",
    });
    expect(readConnectorAccessToken).toHaveBeenCalledWith("uid-owner", "cloudflare", {
      kind: "owner-runtime",
    });
  });

  it("materializes GitHub through the same owner-runtime rail", async () => {
    vi.mocked(readConnectorAccessToken).mockResolvedValue("gho_secret");

    const res = await request(app()).get("/internal/connectors/github/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "connected",
      connectorId: "github",
      accessToken: "gho_secret",
    });
    expect(readConnectorAccessToken).toHaveBeenCalledWith("uid-owner", "github", {
      kind: "owner-runtime",
    });
  });

  it("authorizes a revision runtime from durable root config without a bare glm alias", async () => {
    vi.mocked(readConnectorAccessToken).mockResolvedValue("gho_secret");

    const res = await request(app()).get("/internal/connectors/github/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "connected", accessToken: "gho_secret" });
  });

  it("fails closed when the runtime doc is legacy-shaped instead of honoring its stale config", async () => {
    mocks.docs["glmGateways/bender"] = {
      gatewayId: "bender",
      ownerUid: "uid-someone-else",
      gatewayClass: "shared",
    };
    vi.mocked(readConnectorAccessToken).mockResolvedValue("gho_secret");

    const res = await request(app()).get("/internal/connectors/github/materialize");

    expect(res.status).toBe(503);
  });

  it("returns a structured disconnected response when the owner has no token", async () => {
    vi.mocked(readConnectorAccessToken).mockResolvedValue(null);

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "disconnected",
      connectorId: "cloudflare",
      reason: "not_connected",
    });
  });

  it("returns reauth_required when the broker cannot refresh the owner token", async () => {
    vi.mocked(readConnectorAccessToken).mockRejectedValue(
      new ConnectorTokenBrokerError(409, "reauth_required"),
    );

    const res = await request(app()).get("/internal/connectors/google/materialize");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: "disconnected",
      connectorId: "google",
      reason: "reauth_required",
    });
  });

  it("allows builder-class gateways because they are isolated exec-capable runtimes", async () => {
    process.env.GATEWAY_CLASS = "builder";
    process.env.GATEWAY_PROFILE = "standard";
    mocks.docs["gateways/bender"].gatewayClass = "builder";
    vi.mocked(readConnectorAccessToken).mockResolvedValue("cf_secret");

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "connected", accessToken: "cf_secret" });
  });

  it("rejects shared gateways before reading a token", async () => {
    process.env.GATEWAY_CLASS = "shared";
    process.env.GATEWAY_PROFILE = "standard";

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "owner_runtime_gateway_required" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("returns 503 when the durable root config marker is missing", async () => {
    delete mocks.docs["gateways/bender"].configSchemaVersion;

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "gateway owner unavailable", code: "gateway_owner_unconfigured" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("returns 503 when the root config is malformed", async () => {
    mocks.docs["gateways/bender"].operatorAccess = "corrupt";

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "gateway owner unavailable", code: "gateway_owner_unconfigured" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a shared desired-state gateway even when the pod env says owner-runtime", async () => {
    mocks.docs["gateways/bender"].gatewayClass = "shared";

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "owner_runtime_gateway_required" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a gateway whose desired owner does not match the mounted workspace owner", async () => {
    mocks.docs["gateways/bender"].ownerUid = "uid-someone-else";

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "gateway_owner_mismatch" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("rejects fields-only connectors because this route returns a token shape", async () => {
    const res = await request(app()).get("/internal/connectors/docker/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "connector_not_materializable" });
    expect(readConnectorAccessToken).not.toHaveBeenCalled();
  });
});
