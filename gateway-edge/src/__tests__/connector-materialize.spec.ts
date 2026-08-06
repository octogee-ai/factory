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
    readOwnerRuntimeConnectorAccessToken: vi.fn(),
    ConnectorTokenReadError,
    ConnectorTokenBrokerError,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock("../lib/connector-tokens.js", () => ({
  readOwnerRuntimeConnectorAccessToken: mocks.readOwnerRuntimeConnectorAccessToken,
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
  readOwnerRuntimeConnectorAccessToken,
} from "../lib/connector-tokens.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/internal/connectors", connectorRoutes);
  return a;
}

describe("internal connector materialize route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GATEWAY_CLASS = "operator";
    process.env.GATEWAY_PROFILE = "operator";
  });

  it("materializes a connected owner-runtime token without direct Firestore access", async () => {
    vi.mocked(readOwnerRuntimeConnectorAccessToken).mockResolvedValue("cf_secret");

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "connected",
      connectorId: "cloudflare",
      accessToken: "cf_secret",
    });
    expect(readOwnerRuntimeConnectorAccessToken).toHaveBeenCalledWith("cloudflare");
  });

  it("materializes GitHub through the owner-runtime broker rail", async () => {
    vi.mocked(readOwnerRuntimeConnectorAccessToken).mockResolvedValue("gho_secret");

    const res = await request(app()).get("/internal/connectors/github/materialize");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "connected", accessToken: "gho_secret" });
    expect(readOwnerRuntimeConnectorAccessToken).toHaveBeenCalledWith("github");
  });

  it("returns a structured disconnected response when the owner has no token", async () => {
    vi.mocked(readOwnerRuntimeConnectorAccessToken).mockResolvedValue(null);

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "disconnected",
      connectorId: "cloudflare",
      reason: "not_connected",
    });
  });

  it("rejects productivity OAuth before any bearer can enter the gateway runtime", async () => {
    const res = await request(app()).get("/internal/connectors/google/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "connector_not_materializable" });
    expect(readOwnerRuntimeConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("allows builder-class gateways because they are isolated exec-capable runtimes", async () => {
    process.env.GATEWAY_CLASS = "builder";
    process.env.GATEWAY_PROFILE = "standard";
    vi.mocked(readOwnerRuntimeConnectorAccessToken).mockResolvedValue("cf_secret");

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(200);
  });

  it("rejects shared gateways before reading a token", async () => {
    process.env.GATEWAY_CLASS = "shared";
    process.env.GATEWAY_PROFILE = "standard";

    const res = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "owner_runtime_gateway_required" });
    expect(readOwnerRuntimeConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("rejects fields-only connectors because this route returns a token shape", async () => {
    const res = await request(app()).get("/internal/connectors/docker/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "connector_not_materializable" });
    expect(readOwnerRuntimeConnectorAccessToken).not.toHaveBeenCalled();
  });
});
