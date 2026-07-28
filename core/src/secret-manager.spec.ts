import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
  updateSecret: vi.fn(),
  getIamPolicy: vi.fn(),
  setIamPolicy: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn(function () {
    return {
      createSecret: mocks.createSecret,
      addSecretVersion: mocks.addSecretVersion,
      updateSecret: mocks.updateSecret,
      getIamPolicy: mocks.getIamPolicy,
      setIamPolicy: mocks.setIamPolicy,
      deleteSecret: mocks.deleteSecret,
    };
  }),
}));

import {
  writeSecret,
  provisionGatewayAuthSecret,
  deleteSecret,
  secretReplicationPolicy,
} from "./secret-manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSecret.mockResolvedValue([{}]);
  mocks.addSecretVersion.mockResolvedValue([{ name: "projects/p/secrets/s/versions/1" }]);
  mocks.updateSecret.mockResolvedValue([{}]);
  mocks.getIamPolicy.mockResolvedValue([{ bindings: [] }]);
  mocks.setIamPolicy.mockResolvedValue([{}]);
  mocks.deleteSecret.mockResolvedValue([{}]);
  process.env.GCP_PROJECT_ID = "octogee";
});

describe("deleteSecret — hard delete, idempotent (decommission teardown)", () => {
  it("deletes the secret by fully-qualified name", async () => {
    const res = await deleteSecret("gateway-auth-token-mama");
    expect(mocks.deleteSecret).toHaveBeenCalledWith({
      name: "projects/octogee/secrets/gateway-auth-token-mama",
    });
    expect(res).toEqual({ deleted: true });
  });

  it("is idempotent — a NotFound (code 5) resolves cleanly, never throws", async () => {
    mocks.deleteSecret.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: 5 }));
    const res = await deleteSecret("gateway-auth-token-gone");
    expect(res).toEqual({ deleted: false });
  });

  it("rethrows non-NotFound errors (no silent failure)", async () => {
    mocks.deleteSecret.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: 7 }));
    await expect(deleteSecret("gateway-auth-token-x")).rejects.toThrow(/denied/);
  });
});

describe("secret-manager replication policy follows the exact deployment project", () => {
  it("pins the central target without a regional fallback", () => {
    expect(secretReplicationPolicy("octogee")).toEqual({
      userManaged: { replicas: [{ location: "us-central1" }] },
    });
  });

  it("rejects the retired prod data project", () => {
    expect(() => secretReplicationPolicy("octogee-data-prod")).toThrow(
      "Unknown Firebase deployment project: octogee-data-prod",
    );
  });

  it("writeSecret creates the secret single-region", async () => {
    await writeSecret({ name: "FOO", value: "bar" });
    expect(mocks.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: expect.objectContaining({ replication: secretReplicationPolicy("octogee") }),
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
        secret: expect.objectContaining({ replication: secretReplicationPolicy("octogee") }),
      }),
    );
  });
});
