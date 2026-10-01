import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSet = vi.fn().mockResolvedValue(undefined);
const mockDoc = vi.fn(() => ({ set: mockSet }));
const mockMmApi = vi.fn().mockResolvedValue({});
const mockUploadAvatar = vi.fn().mockResolvedValue(true);
const mockReadAgent = vi.fn();
const mockResolveFileTarget = vi.fn();
const mockStoreWorkspaceBlob = vi.fn();
const mockRemoveWorkspaceBlob = vi.fn();

vi.mock("../lib/db.js", () => ({
  db: { doc: (p: string) => mockDoc(p) },
  FieldValue: {
    serverTimestamp: () => ({ __op: "ts" }),
    increment: (n: number) => ({ __op: "inc", n }),
    delete: () => ({ __op: "delete" }),
  },
}));
vi.mock("../middleware/logging.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../lib/firestoreReads.js", () => ({
  readAgent: (uid: string) => mockReadAgent(uid),
}));
vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...a: unknown[]) => mockMmApi(...a),
  mmUploadAvatarBuffer: (...a: unknown[]) => mockUploadAvatar(...a),
}));
vi.mock("../lib/fileTarget.js", () => ({
  resolveFileTarget: (...a: unknown[]) => mockResolveFileTarget(...a),
}));
vi.mock("../lib/workspace-blob.js", () => ({
  storeWorkspaceBlob: (...a: unknown[]) => mockStoreWorkspaceBlob(...a),
  removeWorkspaceBlob: (...a: unknown[]) => mockRemoveWorkspaceBlob(...a),
}));

import { replaceCoachTextIdentity, syncCoachIdentity, avatarFileName } from "../lib/coach-identity.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  vi.clearAllMocks();
  mockReadAgent.mockResolvedValue({ id: "u1", mattermost: { userId: "coach-mm-u1" } });
  mockResolveFileTarget.mockResolvedValue({
    ok: true,
    target: { slug: "alice", org: "octogee-alice", repoName: "alice-workspace", gcsPrefix: "customers/alice", sudoUser: "ws-alice" },
  });
  mockStoreWorkspaceBlob.mockResolvedValue({ gcsPath: "customers/alice/Scout-avatar.png", size: 100 });
  mockRemoveWorkspaceBlob.mockResolvedValue(undefined);
});

describe("avatarFileName", () => {
  it("derives an obvious workspace-root filename from the display name", () => {
    expect(avatarFileName("Scout")).toBe("Scout-avatar.png");
    expect(avatarFileName("The Dude")).toBe("The-Dude-avatar.png");
    expect(avatarFileName("🎳💥")).toBe("Coach-avatar.png");
  });
});

describe("syncCoachIdentity", () => {
  it("persists an imported emoji without treating it as a credential or Mattermost mutation", async () => {
    const updated = await syncCoachIdentity("u1", { emoji: "🐮" });
    expect(updated).toEqual(["emoji"]);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", avatarEmoji: "🐮" }),
      { merge: true },
    );
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("writes name to agents/{uid} and pushes the MM bot display_name", async () => {
    const updated = await syncCoachIdentity("u1", { name: "Scout" });
    expect(updated).toEqual(["name"]);
    expect(mockDoc).toHaveBeenCalledWith("agents/u1");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", name: "Scout" }),
      { merge: true },
    );
    expect(mockMmApi).toHaveBeenCalledWith("/bots/coach-mm-u1", "PUT", { display_name: "Scout" });
  });

  it("persists the avatar as a durable workspace blob, uploads to MM, and bumps avatarVersion", async () => {
    const updated = await syncCoachIdentity("u1", { name: "Scout", avatarPng: PNG }, { slug: "alice" });
    expect(updated).toContain("avatar");
    expect(mockStoreWorkspaceBlob).toHaveBeenCalledWith(
      expect.anything(),
      "Scout-avatar.png",
      PNG,
      "image/png",
    );
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: expect.objectContaining({ path: "Scout-avatar.png", gcsPath: "customers/alice/Scout-avatar.png" }),
        avatarVersion: { __op: "inc", n: 1 },
      }),
      { merge: true },
    );
    expect(mockUploadAvatar).toHaveBeenCalledWith("coach-mm-u1", PNG);
    expect(mockRemoveWorkspaceBlob).not.toHaveBeenCalled();
  });

  it("uploads the MM avatar before writing avatarVersion — the client re-fetches on the Firestore bump, so the image must already be live", async () => {
    await syncCoachIdentity("u1", { name: "Scout", avatarPng: PNG }, { slug: "alice" });
    expect(mockUploadAvatar).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockUploadAvatar.mock.invocationCallOrder[0]).toBeLessThan(
      mockSet.mock.invocationCallOrder[0],
    );
  });

  it("writes agents/{uid} before the MM name push for name-only updates — a failed MM rename can't strand the write", async () => {
    await syncCoachIdentity("u1", { name: "Scout" });
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockMmApi).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockMmApi.mock.invocationCallOrder[0],
    );
  });

  it("records the character look an avatar was rendered from", async () => {
    await syncCoachIdentity("u1", { avatarPng: PNG, look: { style: "blob", color: "#0ea5e9" } }, { slug: "alice" });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ look: { style: "blob", color: "#0ea5e9" } }),
      { merge: true },
    );
  });

  it("forgets the character look when a new avatar arrives without one, so a picture is never animated as a character", async () => {
    await syncCoachIdentity("u1", { avatarPng: PNG }, { slug: "alice" });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ look: { __op: "delete" } }),
      { merge: true },
    );
  });

  it("leaves the look alone when the avatar does not change", async () => {
    await syncCoachIdentity("u1", { name: "Scout" });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty("look");
  });

  it("requires a slug to persist an avatar", async () => {
    await expect(syncCoachIdentity("u1", { avatarPng: PNG })).rejects.toThrow(/slug required/);
  });

  it("removes the old avatar blob when a rename changes the filename — no orphans", async () => {
    mockReadAgent.mockResolvedValue({
      id: "u1",
      name: "Old",
      mattermost: { userId: "coach-mm-u1" },
      avatar: { path: "Old-avatar.png" },
    });
    await syncCoachIdentity("u1", { name: "New", avatarPng: PNG }, { slug: "alice" });
    expect(mockStoreWorkspaceBlob).toHaveBeenCalledWith(expect.anything(), "New-avatar.png", PNG, "image/png");
    expect(mockRemoveWorkspaceBlob).toHaveBeenCalledWith(expect.anything(), "Old-avatar.png");
  });

  it("skips Mattermost when the coach has no bot id", async () => {
    mockReadAgent.mockResolvedValue({ id: "u1", mattermost: {} });
    await syncCoachIdentity("u1", { name: "Scout" });
    expect(mockMmApi).not.toHaveBeenCalled();
  });

  it("is best-effort: a Mattermost failure does not throw and still returns the write", async () => {
    mockMmApi.mockRejectedValueOnce(new Error("MM 500"));
    await expect(syncCoachIdentity("u1", { name: "Scout" })).resolves.toEqual(["name"]);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("persists the Talk voice on agents/{uid} without touching Mattermost, and an empty voice restores the default", async () => {
    expect(await syncCoachIdentity("u1", { voice: "gb_jane_confident" })).toEqual(["voice"]);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ id: "u1", voice: "gb_jane_confident" }), { merge: true });
    expect(mockMmApi).not.toHaveBeenCalled();
    expect(await syncCoachIdentity("u1", { voice: "" })).toEqual(["voice"]);
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ voice: "" }), { merge: true });
  });

  it("no-ops on an empty patch (no Firestore write)", async () => {
    const updated = await syncCoachIdentity("u1", {});
    expect(updated).toEqual([]);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("replaceCoachTextIdentity", () => {
  it("deletes identity fields absent from the checkpoint and resets the Mattermost name", async () => {
    await replaceCoachTextIdentity("u1", { name: null, persona: null, emoji: null });

    expect(mockSet).toHaveBeenCalledWith({
      id: "u1",
      updatedAt: { __op: "ts" },
      name: { __op: "delete" },
      persona: { __op: "delete" },
      avatarEmoji: { __op: "delete" },
    }, { merge: true });
    expect(mockMmApi).toHaveBeenCalledWith("/bots/coach-mm-u1", "PUT", { display_name: "Coach" });
  });
});

describe("syncCoachIdentity refuses a malformed look at the write boundary", () => {
  it("throws before touching Firestore or Mattermost", async () => {
    await expect(syncCoachIdentity("u1", {
      avatarPng: PNG,
      look: { style: "dragon", color: "red" } as unknown as import("@octogee/shared/types/agent-look").AgentLook,
    }, { slug: "u1" })).rejects.toThrow(/coach look must be a known style/u);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockMmApi).not.toHaveBeenCalled();
    expect(mockStoreWorkspaceBlob).not.toHaveBeenCalled();
  });
});
