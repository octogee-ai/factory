import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActivityMmClientFactory,
  createMmClientFactory,
} from "../chat-proxy/openclaw/mm-client.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMmClientFactory", () => {
  it("creates Mattermost posts with auth, JSON body, and trimmed base URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "post-1" }), { status: 200 }));

    const client = createMmClientFactory({ baseUrl: "https://mm.test///" })("token-1");
    const result = await client.createPost({
      channelId: "chan-1",
      rootId: "root-1",
      message: "hello",
      props: { source: "agent" },
    });

    expect(result).toEqual({ id: "post-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mm.test/api/v4/posts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel_id: "chan-1",
          root_id: "root-1",
          message: "hello",
          props: { source: "agent" },
        }),
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token-1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("edits and deletes posts with the active token", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const client = createMmClientFactory({ baseUrl: "https://mm.test" })("token-1");

    await client.editPost("post-1", { message: "updated", props: { done: true } });
    await client.deletePost("post-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://mm.test/api/v4/posts/post-1/patch",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ id: "post-1", message: "updated", props: { done: true } }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://mm.test/api/v4/posts/post-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect((fetchMock.mock.calls[1][1].headers as Headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("switches tokens through withUserToken", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "post-2" }), { status: 200 }));

    const client = createMmClientFactory({ baseUrl: "https://mm.test" })("system-token").withUserToken("user-token");
    await client.createPost({ channelId: "chan-1", message: "hello" });

    expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("Bearer user-token");
  });

  it("throws on failed post writes and missing Mattermost ids", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad token", { status: 401 }));
    const client = createMmClientFactory({ baseUrl: "https://mm.test" })("token-1");

    await expect(client.createPost({ channelId: "chan-1", message: "hello" })).rejects.toThrow(
      "MM createPost 401: bad token",
    );

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(client.createPost({ channelId: "chan-1", message: "hello" })).rejects.toThrow(
      "MM createPost returned no id",
    );
  });

  it("throws with provider response text for edit and delete failures", async () => {
    const client = createMmClientFactory({ baseUrl: "https://mm.test" })("token-1");

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(client.editPost("post-1", { message: "updated" })).rejects.toThrow("MM editPost 404: missing");

    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(client.deletePost("post-1")).rejects.toThrow("MM deletePost 403: denied");
  });
});

describe("createActivityMmClientFactory", () => {
  it("creates routine Activity posts with silent=true, pending id, and one attachment", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "post-1" }), { status: 201 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");

    await client.createActivityPost({
      channelId: "activity-1",
      rootId: "root-1",
      message: "tool result",
      props: { octogee: { eventKey: "event-1" } },
      pendingPostId: "event-1",
      fileIds: ["file-1"],
      silent: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://mm.test/api/v4/posts?silent=true",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel_id: "activity-1",
          root_id: "root-1",
          message: "tool result",
          pending_post_id: "event-1",
          file_ids: ["file-1"],
          props: { octogee: { eventKey: "event-1" } },
        }),
      }),
    );
  });

  it("keeps action-required Activity and every main create off the silent query", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "post-1" }), { status: 201 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");
    await client.createActivityPost({
      channelId: "activity-1",
      message: "approval required",
      pendingPostId: "event-1",
      silent: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://mm.test/api/v4/posts");
  });

  it("pages channel history backward and preserves event props", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      order: ["post-2", "post-1"],
      posts: {
        "post-2": { id: "post-2", channel_id: "activity-1", root_id: "root-1", props: { octogee: { eventKey: "e2" } }, file_ids: [] },
        "post-1": { id: "post-1", channel_id: "activity-1", root_id: "", props: {}, file_ids: [] },
      },
    }), { status: 200 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");

    const page = await client.listChannelPosts("activity-1", "post-3", 2);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://mm.test/api/v4/channels/activity-1/posts?before=post-3&per_page=2",
    );
    expect(page).toEqual({
      posts: [
        { id: "post-2", channelId: "activity-1", rootId: "root-1", props: { octogee: { eventKey: "e2" } }, fileIds: [] },
        { id: "post-1", channelId: "activity-1", rootId: "", props: {}, fileIds: [] },
      ],
      nextBefore: "post-1",
      reachedEnd: false,
    });
  });

  it("creates, resumes, and completes Mattermost upload sessions", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload-1", file_offset: 0 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload-1", file_offset: 4 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "file-1", size: 8 }), { status: 201 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");

    expect(await client.createUploadSession("activity-1", "tool.txt", 8)).toEqual({ id: "upload-1", fileOffset: 0 });
    expect(await client.getUploadSession("upload-1")).toEqual({ id: "upload-1", fileOffset: 4 });
    expect(await client.uploadData("upload-1", Buffer.from("1234"))).toEqual({ outcome: "incomplete" });
    expect(await client.uploadData("upload-1", Buffer.from("5678"))).toEqual({ outcome: "complete", fileId: "file-1" });
    expect((fetchMock.mock.calls[2][1].headers as Headers).get("Content-Type")).toBe("application/octet-stream");
  });

  it("returns null when a completed upload session has no durable lookup", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");
    await expect(client.getUploadSession("completed-upload")).resolves.toBeNull();
  });

  it("rejects unsafe upload offsets and file sizes from Mattermost", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "upload-1", file_offset: -1 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "file-1", size: 1.5 }), { status: 200 }));
    const client = createActivityMmClientFactory({ baseUrl: "https://mm.test" })("bot-token");

    await expect(client.createUploadSession("activity-1", "tool.txt", 8)).rejects.toThrow(
      "MM createUploadSession returned malformed session",
    );
    await expect(client.getFileInfo("file-1")).rejects.toThrow(
      "MM getFileInfo returned malformed file info",
    );
  });
});
