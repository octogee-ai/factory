import { afterEach, describe, expect, it, vi } from "vitest";
const sockets = vi.hoisted(() => ({ rejectAuth: false, instances: [] as { url: string; options: unknown; frames: Record<string, unknown>[]; closed: boolean }[] }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class WebSocket extends EventEmitter {
    static readonly OPEN = 1; readyState = 1;
    frames: Record<string, unknown>[] = []; closed = false;
    constructor(public url: string, public options: unknown) {
      super(); sockets.instances.push(this); queueMicrotask(() => this.emit("open"));
    }
    send(data: string) {
      const frame = JSON.parse(data); this.frames.push(frame);
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ seq_reply: frame.seq, status: sockets.rejectAuth ? "FAIL" : "OK" }))));
    }
    terminate() { this.closed = true; this.readyState = 3; this.emit("close"); }
  }
  return { WebSocket };
});
import { connectLoadClient, defaultAgentMessages } from "../lib/gateway-load-client.js";
const channelId = "a".repeat(26), userId = "u".repeat(26), userDefaultAgentId = "c".repeat(26), inputPostId = "i".repeat(26);
const target = { name: "alice", workspaceSlug: "alice", tokenEnv: "OCTOGEE_LOAD_TOKEN_ALICE", channelId };
const route = { gatewayId: "shared-0", mmUserId: userId, defaultAgentMmUserId: userDefaultAgentId };
const credentials = { mmUrl: "https://api-test.octogee.com", mmToken: "mm-secret", mmUserId: userId };
const connect = () => connectLoadClient({ target, gatewayId: "shared-0", token: "test-token", signal: new AbortController().signal });
afterEach(() => { vi.unstubAllGlobals(); sockets.instances.length = 0; sockets.rejectAuth = false; });
describe("TEST PWA load transport", () => {
  it("authenticates the gateway websocket and uses normal chat REST", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(route)).mockResolvedValueOnce(Response.json(credentials))
      .mockResolvedValueOnce(Response.json({ order: [], posts: {} }))
      .mockResolvedValueOnce(Response.json({ id: inputPostId, channel_id: channelId, user_id: userId }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const client = await connectLoadClient({ target, gatewayId: "shared-0", token: "test-token", signal: controller.signal });
    await expect(client.read()).resolves.toEqual({ messages: [] }); await client.send("bounded test", "once");
    expect(request.mock.calls[0]).toEqual(["https://api-test.octogee.com/api/mattermost/token", expect.objectContaining({ redirect: "manual", headers: { Authorization: "Bearer test-token" } })]);
    expect(sockets.instances[0]).toMatchObject({ url: "wss://api-test.octogee.com/g/shared-0/api/v4/websocket", options: { headers: { Origin: "https://app-test.octogee.com" } } });
    expect(sockets.instances[0].frames).toEqual([{ seq: 1, action: "authentication_challenge", data: { token: "mm-secret" } }]);
    expect(request.mock.calls[2][0]).toBe(`https://api-test.octogee.com/api/v4/channels/${channelId}/posts?page=0&per_page=100`);
    expect(request.mock.calls[3][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer mm-secret" } });
    expect(JSON.parse(request.mock.calls[3][1].body)).toEqual({ channel_id: channelId, message: "bounded test", pending_post_id: "once" });
    controller.abort(); expect(sockets.instances[0].closed).toBe(true); await expect(client.read()).rejects.toThrow();
  });
  it("refuses wrong-gateway routes and credentials outside TEST", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ...route, gatewayId: "shared-1" })); vi.stubGlobal("fetch", request);
    await expect(connect()).rejects.toThrow("gateway"); expect(request).toHaveBeenCalledOnce();
    for (const mmUrl of ["https://api.octogee.com", "https://api-test.octogee.com.evil.invalid", "https://user:pass@api-test.octogee.com", "https://api-test.octogee.com/?token=secret"]) {
      request.mockReset().mockResolvedValueOnce(Response.json(route)).mockResolvedValueOnce(Response.json({ ...credentials, mmUrl }));
      await expect(connect()).rejects.toThrow("TEST");
    }
    expect(sockets.instances).toHaveLength(0);
  });
  it("reports an HTTP status without retaining the upstream response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream body", { status: 429 })));
    await expect(connect()).rejects.toMatchObject({ httpStatus: 429, message: "Load HTTP 429" });
  });
  it("requires an authentication acknowledgement", async () => {
    sockets.rejectAuth = true; vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(route)).mockResolvedValueOnce(Response.json(credentials)));
    await expect(connect()).rejects.toThrow("authentication"); expect(sockets.instances[0].closed).toBe(true);
  });
  it("accepts native agent replies while excluding user echoes, activity and deleted posts", () => {
    const reply = { id: "r".repeat(26), channel_id: channelId, user_id: userDefaultAgentId, delete_at: 0, type: "", message: "nonce", props: {} };
    const echo = { ...reply, id: "e".repeat(26), user_id: userId };
    const activity = { ...reply, id: "x".repeat(26), props: { octogee: { kind: "agent.activity" } } };
    const history = { order: [reply.id, echo.id, activity.id], posts: { [reply.id]: reply, [echo.id]: echo, [activity.id]: activity } };
    const project = () => defaultAgentMessages(history, channelId, userDefaultAgentId);
    expect(project()).toEqual({ messages: [{ role: "assistant", content: "nonce" }] });
    reply.delete_at = 1; expect(project().messages).toEqual([]);
    reply.delete_at = 0; reply.type = "system_join_channel"; expect(project().messages).toEqual([]);
    reply.type = ""; reply.channel_id = "other"; expect(project().messages).toEqual([]);
  });
});
