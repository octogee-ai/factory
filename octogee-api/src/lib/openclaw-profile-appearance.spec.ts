import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

const mocks = vi.hoisted(() => ({ doc: vi.fn(), file: vi.fn(), fetch: vi.fn() }));
vi.mock("../../../gateway-edge/src/lib/db.js", () => ({ db: { doc: mocks.doc }, storage: { bucket: () => ({ file: mocks.file }) } }));
vi.mock("../../../gateway-edge/src/lib/mattermost.js", () => ({ MM_URL: "http://mattermost.test" }));
import { loadOpenClawProfileAppearance } from "./openclaw-profile-appearance.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

let documents: Record<string, Record<string, unknown>>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("MM_ADMIN_TOKEN", undefined);
  documents = {
    "users/uid-A": { displayName: "Account name", mattermost: { userId: "mm-A" } },
    "users/uid-A/secrets/mattermost": { personalToken: "user-mm-token" },
  };
  mocks.file.mockReturnValue({ getMetadata: async () => { throw Object.assign(new Error("not found"), { code: 404 }); } });
  mocks.doc.mockImplementation((path: string) => ({ get: async () => ({ exists: Boolean(documents[path]), data: () => documents[path] }) }));
});

describe("Octogee profile appearance", () => {
  it("reads the Octogee upload by UID without fetching a profile-supplied URL", async () => {
    documents["users/uid-A/profile/public"] = { displayName: "Chris", avatarUrl: "https://untrusted.test/image" };
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    mocks.file.mockReturnValue({ getMetadata: async () => [{ generation: "1" }], createReadStream: () => Readable.from([png]) });
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    expect(appearance.displayName).toBe("Chris");
    expect(appearance.avatar!.revision).toBe("octogee:1");
    const bytes = await appearance.avatar!.read();
    expect(mocks.file).toHaveBeenCalledWith("avatars/uid-A/user.jpg", { generation: "1" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 256, height: 256 });
  });

  it("imports the mapped Mattermost name and avatar when no Octogee appearance is set", async () => {
    documents["users/uid-A"] = { mattermost: { userId: "mm-A" } };
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "mm-A", first_name: "Ada", last_name: "Lovelace", last_picture_update: 42 })))
      .mockResolvedValueOnce(new Response(new Uint8Array(png)));
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    expect(appearance.displayName).toBe("Ada Lovelace");
    expect(appearance.avatar!.revision).toContain("42");
    await appearance.avatar!.read();
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, "http://mattermost.test/api/v4/users/mm-A/image", expect.objectContaining({
      headers: { Authorization: "Bearer user-mm-token" }, redirect: "error",
    }));
  });

  it("uses the mapped Mattermost avatar for OAuth photos without a stored upload", async () => {
    documents["users/uid-A/profile/public"] = { avatarUrl: "https://google.test/photo" };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "mm-A", last_picture_update: 5 })));
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    expect(appearance.avatar!.revision).toBe("mattermost:mm-A:5");
    expect(mocks.fetch).toHaveBeenCalledWith("http://mattermost.test/api/v4/users/me", expect.objectContaining({
      headers: { Authorization: "Bearer user-mm-token" },
    }));
  });

  it("does not treat an OAuth URL as an upload for an unprovisioned user", async () => {
    documents["users/uid-A"] = { displayName: "Ada" };
    documents["users/uid-A/profile/public"] = { avatarUrl: "https://google.test/photo" };
    expect(await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).toEqual({ displayName: "Ada", avatar: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects a Mattermost token bound to a different user", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: "another-person" })));
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost profile identity mismatch");
  });

  it("reports missing personal credentials without using an admin credential", async () => {
    vi.stubEnv("MM_ADMIN_TOKEN", "must-not-use");
    delete documents["users/uid-A/secrets/mattermost"];
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost personal token missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("propagates storage outages instead of treating them as absent uploads", async () => {
    mocks.file.mockReturnValue({ getMetadata: async () => { throw Object.assign(new Error("storage unavailable"), { code: 503 }); } });
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("storage unavailable");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not import another user's profile when the authenticated UID is missing", async () => {
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "unknown")).rejects.toThrow("Octogee user not found");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("leaves an unprovisioned user's avatar absent and uses their Octogee name", async () => {
    documents["users/uid-A"] = { firstName: "Ada", lastName: "Lovelace" };
    expect(await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).toEqual({ displayName: "Ada Lovelace", avatar: null });
  });

  it("reports Mattermost failures rather than treating them as an empty profile", async () => {
    mocks.fetch.mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A")).rejects.toThrow("Mattermost profile request failed: 403");
  });

  it("rejects oversized avatar streams", async () => {
    documents["users/uid-A/profile/public"] = { avatarUrl: "upload" };
    mocks.file.mockReturnValue({ getMetadata: async () => [{ generation: "1" }], createReadStream: () => Readable.from([Buffer.alloc(5 * 1024 * 1024 + 1)]) });
    const appearance = await loadOpenClawProfileAppearance(createDocumentFixtureStore(documents), "uid-A");
    await expect(appearance.avatar!.read()).rejects.toThrow("Avatar exceeds 5 MB");
  });
});
