import { describe, expect, it } from "vitest";
import { channelSessionModelCommand, parseChannelSessionModelOperation } from "./channel-session-models.js";

describe("channel session model operations", () => {
  it.each([
    [{ operation: "getSessionModel", agentId: "octogee-alice-coach" }, "/status"],
    [{ operation: "listModels", agentId: "octogee-alice-coach" }, "/models"],
    [{ operation: "listModelsByProvider", agentId: "octogee-alice-coach", provider: "claude-cli" }, "/models claude-cli"],
    [{ operation: "setSessionModel", agentId: "octogee-alice-coach", modelRef: "claude-cli/claude-sonnet-5" }, "/model claude-cli/claude-sonnet-5"],
    [{ operation: "setSessionModel", agentId: "octogee-alice-coach", modelRef: "platform-openrouter/z-ai/glm-5.2" }, "/model platform-openrouter/z-ai/glm-5.2"],
    [{ operation: "resetSessionModel", agentId: "octogee-alice-coach" }, "/model default"],
  ])("parses and constructs the exact native command", (body, command) => {
    const parsed = parseChannelSessionModelOperation(body);
    expect(parsed).toEqual(body);
    expect(channelSessionModelCommand(parsed!)).toBe(command);
  });

  it.each([
    null, [], {},
    { operation: "listModels", agentId: "agent", extra: true },
    { operation: "setSessionModel", agentId: "agent", modelRef: "openai/gpt-5\n/stop" },
    { operation: "setSessionModel", agentId: "agent", modelRef: "openai/gpt-5/extra/segment" },
    { operation: "setSessionModel", agentId: "agent", modelRef: "openai/gpt-5?x" },
    { operation: "listModelsByProvider", agentId: "agent", provider: "openai; /stop" },
    { operation: "getSessionModel", agentId: "agent", provider: "openai" },
  ])("rejects malformed or ambiguous input", (body) => {
    expect(parseChannelSessionModelOperation(body)).toBeNull();
  });

  it("accepts the same bounded nested model-ref grammar as durable defaults", () => {
    expect(parseChannelSessionModelOperation({
      operation: "setSessionModel",
      agentId: "octogee-alice-coach",
      modelRef: "platform-openrouter/z-ai/glm-5.2",
    })).not.toBeNull();
    expect(parseChannelSessionModelOperation({
      operation: "setSessionModel",
      agentId: "octogee-alice-coach",
      modelRef: `openai/${"x".repeat(122)}`,
    })).toBeNull();
  });
});
