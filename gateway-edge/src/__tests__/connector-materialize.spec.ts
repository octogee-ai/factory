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
    readOwnerGithubProjectCloneAccess: vi.fn(),
    cloneGithubProjectCheckout: vi.fn(),
    ConnectorTokenReadError,
    ConnectorTokenBrokerError,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock("../lib/connector-tokens.js", () => ({
  readOwnerRuntimeConnectorAccessToken: mocks.readOwnerRuntimeConnectorAccessToken,
  readOwnerGithubProjectCloneAccess: mocks.readOwnerGithubProjectCloneAccess,
  ConnectorTokenReadError: mocks.ConnectorTokenReadError,
  ConnectorTokenBrokerError: mocks.ConnectorTokenBrokerError,
}));

vi.mock("../lib/github-project-clone.js", () => ({
  cloneGithubProjectCheckout: mocks.cloneGithubProjectCheckout,
}));

vi.mock("../middleware/builder-shell-auth.js", () => ({
  requireBuilderShellInternalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { error: mocks.error, warn: mocks.warn, info: mocks.info },
}));

import connectorRoutes from "../routes/internal/connectors.js";
import {
  readOwnerGithubProjectCloneAccess,
  readOwnerRuntimeConnectorAccessToken,
} from "../lib/connector-tokens.js";
import { cloneGithubProjectCheckout } from "../lib/github-project-clone.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/internal/connectors", connectorRoutes);
  return a;
}

describe("internal connector materialize route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GATEWAY_CLASS = "builder";
    process.env.GATEWAY_PROFILE = "builder";
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

  it.each([
    ["github", "GitHub"],
    ["google", "productivity OAuth"],
  ])("rejects %s before a %s bearer can enter the agent runtime", async (connectorId) => {
    const res = await request(app()).get(`/internal/connectors/${connectorId}/materialize`);

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

  it("rejects the retired customer operator class and profile", async () => {
    delete process.env.GATEWAY_CLASS;
    process.env.GATEWAY_PROFILE = "operator";

    const legacyProfile = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(legacyProfile.status).toBe(403);
    process.env.GATEWAY_CLASS = "operator";
    delete process.env.GATEWAY_PROFILE;

    const legacyClass = await request(app()).get("/internal/connectors/cloudflare/materialize");

    expect(legacyClass.status).toBe(403);
    expect(readOwnerRuntimeConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("rejects fields-only connectors because this route returns a token shape", async () => {
    const res = await request(app()).get("/internal/connectors/docker/materialize");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "connector_not_materializable" });
    expect(readOwnerRuntimeConnectorAccessToken).not.toHaveBeenCalled();
  });

  it("clones through the sidecar broker without returning the GitHub credential", async () => {
    process.env.GATEWAY_BUILDER_SLUG = "alice";
    vi.mocked(readOwnerGithubProjectCloneAccess).mockResolvedValue({
      accessToken: "gho_secret",
      repository: { owner: "octogee-ai", repo: "octogee" },
    });
    vi.mocked(cloneGithubProjectCheckout).mockResolvedValue("cloned");

    const res = await request(app())
      .post("/internal/connectors/github/clone")
      .send({ builderSlug: "alice", projectSlug: "octo" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "cloned" });
    expect(cloneGithubProjectCheckout).toHaveBeenCalledWith(expect.objectContaining({
      builderSlug: "alice",
      projectSlug: "octo",
      accessToken: "gho_secret",
    }));
  });

  it("preserves the owner reauthorization signal from the broker", async () => {
    process.env.GATEWAY_BUILDER_SLUG = "alice";
    vi.mocked(readOwnerGithubProjectCloneAccess).mockRejectedValue(
      new mocks.ConnectorTokenBrokerError(409, "reauth_required"),
    );

    const res = await request(app())
      .post("/internal/connectors/github/clone")
      .send({ builderSlug: "alice", projectSlug: "octo" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "reauth_required" });
  });
});
