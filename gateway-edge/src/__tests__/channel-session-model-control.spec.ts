import { describe, expect, it, vi } from "vitest";
import {
  ChannelSessionMattermostError,
  createChannelSessionMattermostClient,
  parseNativeModelResult,
  pickCorrelatedAgentReply,
} from "../lib/channel-session-model-control.js";

describe("channel session native model control", () => {
  it("accepts only the earliest correlated reply from the bound Agent", () => {
    const reply = pickCorrelatedAgentReply([
      { id: "foreign", root_id: "root", channel_id: "channel", user_id: "other", create_at: 11, message: "no" },
      { id: "late", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 13, message: "late" },
      { id: "early", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 12, message: "early" },
      { id: "old", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 9, message: "old" },
    ], { rootPostId: "root", channelId: "channel", agentUserId: "agent", commandCreatedAt: 10 });
    expect(reply?.id).toBe("early");
  });

  it("parses providers, nested model refs, current model, and native outcomes", () => {
    expect(parseNativeModelResult("listModels", "Providers:\n- anthropic (2)\n- claude-cli (5)\n\nUse: /models <provider>")).toMatchObject({ providers: ["anthropic", "claude-cli"], outcome: "unknown" });
    expect(parseNativeModelResult("listModelsByProvider", "Models (OpenRouter) — showing 1-2 of 2 (page 1/1)\n- platform-openrouter/z-ai/glm-5.2\n- platform-openrouter/deepseek/deepseek-v4-pro")).toMatchObject({ models: ["platform-openrouter/z-ai/glm-5.2", "platform-openrouter/deepseek/deepseek-v4-pro"] });
    expect(parseNativeModelResult("getSessionModel", "🦞 OpenClaw 2026.7.1\n🧠 Model: claude-cli/claude-sonnet-5 · 🔑 api-key")).toMatchObject({ currentModel: "claude-cli/claude-sonnet-5" });
    expect(parseNativeModelResult("setSessionModel", "Model set to claude-cli/claude-sonnet-5 for this session.")).toMatchObject({ outcome: "applied", currentModel: "claude-cli/claude-sonnet-5" });
    expect(parseNativeModelResult("resetSessionModel", "Model reset to default (platform-openrouter/z-ai/glm-5.2).")).toMatchObject({ outcome: "applied", currentModel: "platform-openrouter/z-ai/glm-5.2" });
    expect(parseNativeModelResult("setSessionModel", "Model ‘x/y’ is not allowed.")).toMatchObject({ outcome: "rejected" });
  });

  it("proves the bearer identity and bounds Mattermost responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "caller" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("x".repeat(1025), { status: 200 }));
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl,
      maxResponseBytes: 1024,
    });
    await expect(client.getCurrentUserId()).resolves.toBe("caller");
    await expect(client.getJson(["channels", "channel", "members", "caller"])).rejects.toThrow(/size limit/);
  });

  it("rejects external Mattermost endpoints before fetch", () => {
    expect(() => createChannelSessionMattermostClient({ baseUrl: "https://evil.example", token: "a".repeat(32) })).toThrow(/base URL/);
  });

  it("classifies Mattermost transport failures as upstream failures", async () => {
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });
    await expect(client.getJson(["users", "me"])).rejects.toBeInstanceOf(ChannelSessionMattermostError);
  });
});
