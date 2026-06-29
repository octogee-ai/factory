import { describe, it, expect, beforeEach, vi } from "vitest";

const SECRET = "projects/octogee/secrets/MM_ADMIN_TOKEN";

const h = vi.hoisted(() => ({
  addSecretVersion: vi.fn(),
  listSecretVersions: vi.fn(),
  destroySecretVersion: vi.fn(async () => [{}]),
  createSecret: vi.fn(async () => [{}]),
  setSpy: vi.fn(async () => {}),
  getMmAdminToken: vi.fn(),
  mmApiCall: vi.fn(),
}));

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: class {
    addSecretVersion = h.addSecretVersion;
    listSecretVersions = h.listSecretVersions;
    destroySecretVersion = h.destroySecretVersion;
    createSecret = h.createSecret;
  },
}));
vi.mock("../firebase.js", () => ({ db: { doc: () => ({ set: h.setSpy }) } }));
vi.mock("../mattermost/client.js", () => ({
  getMmAdminToken: h.getMmAdminToken,
  mmApiCall: h.mmApiCall,
}));
vi.mock("../config.js", () => ({ log: vi.fn() }));
vi.mock("../secret-manager.js", () => ({
  SINGLE_REGION_REPLICATION: { userManaged: { replicas: [{ location: "us-central1" }] } },
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));

import { ensureAdminCredentials } from "../mattermost/admin-creds.js";

const enabled = (n: number) => ({ name: `${SECRET}/versions/${n}`, state: "ENABLED" });

describe("ensureAdminCredentials — secret version hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MM_URL = "http://mm";
    process.env.MM_ADMIN_USER_ID = "admin-id";
    process.env.GCLOUD_PROJECT = "octogee";
    h.getMmAdminToken.mockResolvedValue("fresh-token");
  });

  it("destroys superseded enabled versions, keeping the one just written", async () => {
    h.addSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/21` }]);
    h.listSecretVersions.mockResolvedValue([[enabled(21), enabled(20), enabled(19)]]);

    await ensureAdminCredentials();

    expect(h.addSecretVersion).toHaveBeenCalledOnce();
    const destroyed = h.destroySecretVersion.mock.calls.map((c) => c[0].name);
    expect(destroyed).toEqual([`${SECRET}/versions/20`, `${SECRET}/versions/19`]);
    expect(destroyed).not.toContain(`${SECRET}/versions/21`);
  });

  it("destroys nothing when the new version is the only enabled one", async () => {
    h.addSecretVersion.mockResolvedValue([{ name: `${SECRET}/versions/1` }]);
    h.listSecretVersions.mockResolvedValue([[enabled(1)]]);

    await ensureAdminCredentials();

    expect(h.destroySecretVersion).not.toHaveBeenCalled();
  });

  it("prunes after creating the secret on first run (NOT_FOUND path)", async () => {
    h.addSecretVersion
      .mockRejectedValueOnce({ code: 5 })
      .mockResolvedValueOnce([{ name: `${SECRET}/versions/1` }]);
    h.listSecretVersions.mockResolvedValue([[enabled(1)]]);

    await ensureAdminCredentials();

    expect(h.createSecret).toHaveBeenCalledOnce();
    expect(h.destroySecretVersion).not.toHaveBeenCalled();
  });

  it("does not prune when the token write fails (no version added)", async () => {
    h.addSecretVersion.mockRejectedValue({ code: 7, message: "permission denied" });

    await ensureAdminCredentials();

    expect(h.listSecretVersions).not.toHaveBeenCalled();
    expect(h.destroySecretVersion).not.toHaveBeenCalled();
  });
});
