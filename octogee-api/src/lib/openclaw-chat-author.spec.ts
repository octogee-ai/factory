import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), getJson: vi.fn(), where: vi.fn(), get: vi.fn() }));
vi.mock("../../../gateway-edge/src/lib/channel-session-authorization.js", () => ({ authorizeChannel: mocks.authorize }));
vi.mock("../../../gateway-edge/src/lib/db.js", () => ({ db: { collection: () => ({ where: mocks.where }) } }));
import { resolveOpenClawChatAuthor } from "./openclaw-chat-author.js";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({ forbidden: false, client: { getJson: mocks.getJson } });
  mocks.getJson.mockResolvedValue({ id: "post", channel_id: "channel", user_id: "mm-author" });
  mocks.where.mockReturnValue({ limit: () => ({ get: mocks.get }) });
  mocks.get.mockResolvedValue({ docs: [{ id: "uid-author", data: () => ({ username: "builder-slug" }) }] });
});
describe("Control chat author identity", () => {
  it("resolves the actual post author to their Octogee UID and builder slug", async () => {
    expect(await resolveOpenClawChatAuthor("viewer", "workspace", "channel", "post")).toEqual({ uid: "uid-author", username: "builder-slug", mattermostUserId: "mm-author" });
    expect(mocks.authorize).toHaveBeenCalledWith("viewer", "channel", "workspace", expect.objectContaining({ requireActiveLedger: true }));
    expect(mocks.where).toHaveBeenCalledWith("mattermost.userId", "==", "mm-author");
  });
  it("includes the active private coach conversation when authorizing history attribution", async () => {
    mocks.getJson.mockResolvedValue({ id: "post", channel_id: "coach-channel", user_id: "mm-author" });
    mocks.authorize.mockImplementation(async (_uid, _channel, _workspace, options) =>
      options.requireActiveLedger && options.includeCoachConversation
        ? { forbidden: false, client: { getJson: mocks.getJson } }
        : null);
    await expect(resolveOpenClawChatAuthor("owner", "workspace", "coach-channel", "post"))
      .resolves.toMatchObject({ uid: "uid-author", mattermostUserId: "mm-author" });
  });
  it.each([null, { forbidden: true }])("rejects inaccessible channels before reading posts", async (access) => {
    mocks.authorize.mockResolvedValue(access);
    await expect(resolveOpenClawChatAuthor("viewer", "workspace", "channel", "post")).rejects.toThrow("access denied");
    expect(mocks.getJson).not.toHaveBeenCalled();
  });
  it("rejects posts outside the authorized channel", async () => {
    mocks.getJson.mockResolvedValue({ id: "post", channel_id: "other", user_id: "victim" });
    await expect(resolveOpenClawChatAuthor("viewer", "workspace", "channel", "post")).rejects.toThrow("does not belong");
    expect(mocks.where).not.toHaveBeenCalled();
  });
  it("does not invent an Octogee identity for an unmapped Mattermost user", async () => {
    mocks.get.mockResolvedValue({ docs: [] });
    expect(await resolveOpenClawChatAuthor("viewer", "workspace", "channel", "post")).toBeNull();
  });
  it("rejects ambiguous Mattermost mappings", async () => {
    mocks.get.mockResolvedValue({ docs: [{}, {}] });
    await expect(resolveOpenClawChatAuthor("viewer", "workspace", "channel", "post")).rejects.toThrow("ambiguous");
  });
});
