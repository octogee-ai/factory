import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: vi.fn(),
  getMmAdminToken: vi.fn(),
  mmApiCall: vi.fn(),
}));

vi.mock("../config.js", () => ({ log: h.log }));
vi.mock("./client.js", () => ({
  getMmAdminToken: h.getMmAdminToken,
  mmApiCall: h.mmApiCall,
}));

import { destroyMmChannel, destroyMmUser, getMmUserChannels } from "./nuke.js";

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

describe("Mattermost nuke helpers", () => {
  it("deletes users and channels with the admin token, treating 404 as already gone", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await destroyMmUser("user-1");
    expect(fetchMock).toHaveBeenCalledWith("https://mm.test/api/v4/users/user-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer admin-token" },
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await destroyMmChannel("channel-1");

    expect(h.log).toHaveBeenCalledWith("[mm-nuke] User user-1 deleted (or already gone)");
    expect(h.log).toHaveBeenCalledWith("[mm-nuke] Channel channel-1 deleted (or already gone)");
  });

  it("logs failed user deletion responses with response text", async () => {
    fetchMock.mockResolvedValue(new Response("permission denied", { status: 403 }));

    await destroyMmUser("user-1");

    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Failed to delete user user-1: 403 permission denied"));
  });

  it("returns user channel ids only when Mattermost returns an array", async () => {
    h.mmApiCall.mockResolvedValueOnce([{ id: "c1" }, { id: "c2" }]);
    await expect(getMmUserChannels("user-1", "team-1")).resolves.toEqual(["c1", "c2"]);
    expect(h.mmApiCall).toHaveBeenCalledWith("GET", "/users/user-1/teams/team-1/channels");

    h.mmApiCall.mockResolvedValueOnce({ error: "bad" });
    await expect(getMmUserChannels("user-1", "team-1")).resolves.toEqual([]);
  });

  it("does nothing when required environment or ids are missing", async () => {
    delete process.env.MM_URL;

    await destroyMmUser("user-1");
    await destroyMmChannel("channel-1");
    await expect(getMmUserChannels("user-1", "team-1")).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.mmApiCall).not.toHaveBeenCalled();
  });
});
