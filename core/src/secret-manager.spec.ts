import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
  updateSecret: vi.fn(),
  getIamPolicy: vi.fn(),
  setIamPolicy: vi.fn(),
  deleteSecret: vi.fn(),
  accessSecretVersion: vi.fn(),
  listSecretVersions: vi.fn(),
  destroySecretVersion: vi.fn(),
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
      accessSecretVersion: mocks.accessSecretVersion,
      listSecretVersions: mocks.listSecretVersions,
      destroySecretVersion: mocks.destroySecretVersion,
    };
  }),
}));

import {
  addSecretVersionKeepingLatest,
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

describe("addSecretVersionKeepingLatest — one live version per subscription secret", () => {
  const SECRET = "projects/octogee/secrets/byosub-uid5-openai";
  const v = (n: number, state = "ENABLED") => ({ name: `${SECRET}/versions/${n}`, state });

  it("skips the add when the latest payload already matches, still sweeping superseded versions", async () => {
    mocks.accessSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/5`, payload: { data: Buffer.from("same") } }]);
    mocks.listSecretVersions.mockResolvedValue([[v(5), v(4), v(3, "DISABLED"), v(2, "DESTROYED")]]);
    mocks.destroySecretVersion.mockResolvedValue([{}]);

    const res = await addSecretVersionKeepingLatest("byosub-uid5-openai", "same");

    expect(res).toEqual({ ok: true, changed: false, destroyed: 2 });
    expect(mocks.addSecretVersion).not.toHaveBeenCalled();
    expect(mocks.destroySecretVersion.mock.calls.map(([arg]) => arg.name).sort()).toEqual([
      `${SECRET}/versions/3`,
      `${SECRET}/versions/4`,
    ]);
  });

  it("adds the rotated payload and destroys every superseded live version", async () => {
    mocks.accessSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/5`, payload: { data: Buffer.from("old") } }]);
    mocks.addSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/6` }]);
    mocks.listSecretVersions.mockResolvedValue([[v(6), v(5), v(4, "DISABLED"), v(3, "DESTROYED")]]);
    mocks.destroySecretVersion.mockResolvedValue([{}]);

    const res = await addSecretVersionKeepingLatest("byosub-uid5-openai", "rotated");

    expect(res).toEqual({ ok: true, changed: true, versionName: `${SECRET}/versions/6`, destroyed: 2 });
    expect(mocks.addSecretVersion).toHaveBeenCalledWith({
      parent: SECRET,
      payload: { data: Buffer.from("rotated", "utf8") },
    });
    expect(mocks.destroySecretVersion.mock.calls.map(([arg]) => arg.name).sort()).toEqual([
      `${SECRET}/versions/4`,
      `${SECRET}/versions/5`,
    ]);
  });

  it("keeps a version another writer added concurrently and destroys its own older one", async () => {
    mocks.accessSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/5`, payload: { data: Buffer.from("old") } }]);
    mocks.addSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/6` }]);
    mocks.listSecretVersions.mockResolvedValue([[v(7), v(6), v(5)]]);
    mocks.destroySecretVersion.mockResolvedValue([{}]);

    const res = await addSecretVersionKeepingLatest("byosub-uid5-openai", "rotated");

    expect(res).toEqual({ ok: true, changed: true, versionName: `${SECRET}/versions/6`, destroyed: 2 });
    expect(mocks.destroySecretVersion.mock.calls.map(([arg]) => arg.name).sort()).toEqual([
      `${SECRET}/versions/5`,
      `${SECRET}/versions/6`,
    ]);
  });

  it("reports a missing secret instead of creating one", async () => {
    mocks.accessSecretVersion.mockRejectedValue(Object.assign(new Error("not found"), { code: 5 }));

    const res = await addSecretVersionKeepingLatest("byosub-uid5-openai", "rotated");

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(mocks.addSecretVersion).not.toHaveBeenCalled();
  });
});
