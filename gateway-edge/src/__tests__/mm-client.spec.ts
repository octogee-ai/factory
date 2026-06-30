import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMmClientFactory } from "../chat-proxy/openclaw/mm-client.js";

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
