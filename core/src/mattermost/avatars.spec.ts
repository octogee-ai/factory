import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: vi.fn(),
  getMmAdminToken: vi.fn(),
}));

vi.mock("../config.js", () => ({ log: h.log }));
vi.mock("./client.js", () => ({
  getMmAdminToken: h.getMmAdminToken,
}));

import { mmUploadAvatar } from "./avatars.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.MM_URL = "https://mm.test";
  h.getMmAdminToken.mockResolvedValue("admin-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MM_URL;
});

describe("mmUploadAvatar", () => {
  it("downloads the image and uploads it to the Mattermost user image endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.jpg")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://images.test/avatar.jpg");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://mm.test/api/v4/users/user-1/image", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
      body: expect.any(FormData),
    });
  });

  it("returns false without Mattermost configuration, admin token, or a readable source image", async () => {
    delete process.env.MM_URL;
    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.png")).resolves.toBe(false);

    process.env.MM_URL = "https://mm.test";
    h.getMmAdminToken.mockResolvedValueOnce(null);
    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.png")).resolves.toBe(false);

    h.getMmAdminToken.mockResolvedValueOnce("admin-token");
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.png")).resolves.toBe(false);
  });

  it("logs Mattermost upload failures and thrown fetch errors", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response("too large", { status: 413 }));

    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.png")).resolves.toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("avatar upload 413: too large"));

    fetchMock.mockReset().mockRejectedValueOnce(new Error("network down"));
    await expect(mmUploadAvatar("user-1", "https://images.test/avatar.png")).resolves.toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("avatar upload failed: Error: network down"));
  });
});
