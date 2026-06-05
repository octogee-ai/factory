import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
  updateSecret: vi.fn(),
  getIamPolicy: vi.fn(),
  setIamPolicy: vi.fn(),
}));

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn(function () {
    return {
      createSecret: mocks.createSecret,
      addSecretVersion: mocks.addSecretVersion,
      updateSecret: mocks.updateSecret,
      getIamPolicy: mocks.getIamPolicy,
      setIamPolicy: mocks.setIamPolicy,
    };
  }),
}));

import {
  writeSecret,
  provisionGatewayAuthSecret,
  SINGLE_REGION_REPLICATION,
} from "../lib/secret-manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSecret.mockResolvedValue([{}]);
  mocks.addSecretVersion.mockResolvedValue([{ name: "projects/p/secrets/s/versions/1" }]);
  mocks.updateSecret.mockResolvedValue([{}]);
  mocks.getIamPolicy.mockResolvedValue([{ bindings: [] }]);
  mocks.setIamPolicy.mockResolvedValue([{}]);
  process.env.GCP_PROJECT_ID = "octogee";
});

describe("secret-manager replication policy is single-region (automatic = ~25× storage cost)", () => {
  it("SINGLE_REGION_REPLICATION pins us-central1 user-managed, never multi-region automatic", () => {
    expect(SINGLE_REGION_REPLICATION).toEqual({
      userManaged: { replicas: [{ location: "us-central1" }] },
    });
  });

  it("writeSecret creates the secret single-region", async () => {
    await writeSecret({ name: "FOO", value: "bar" });
    expect(mocks.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: expect.objectContaining({ replication: SINGLE_REGION_REPLICATION }),
      }),
    );
  });

  it("provisionGatewayAuthSecret creates the per-gateway token secret single-region", async () => {
    await provisionGatewayAuthSecret({
      gatewayId: "gw1",
      gatewayServiceAccount: "octogee-gateway@octogee.iam.gserviceaccount.com",
    });
    expect(mocks.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: expect.objectContaining({ replication: SINGLE_REGION_REPLICATION }),
      }),
    );
  });
});
