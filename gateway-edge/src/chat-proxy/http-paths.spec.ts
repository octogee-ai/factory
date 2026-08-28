import { describe, expect, it } from "vitest";
import { chatProxyOwnsHttpPath } from "./http-paths.js";

describe("chatProxyOwnsHttpPath", () => {
  it("claims only health checks, private callbacks, and bare loopback plugin intakes", () => {
    expect(chatProxyOwnsHttpPath("/healthz")).toBe(true);
    expect(chatProxyOwnsHttpPath("/healthz/bridge")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/agent-control/callback")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/mattermost/interactions/default")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/events")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/scheduled-anchor")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/voice/v1/events")).toBe(true);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/activity/v1/events",
      "/api/g/gw-1/internal/openclaw/activity/v1/events",
    )).toBe(false);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/voice/v1/events",
      "/api/g/gw-1/internal/openclaw/voice/v1/events",
    )).toBe(false);

    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback/")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/workspace/files")).toBe(false);
    expect(chatProxyOwnsHttpPath("/healthz/other")).toBe(false);
  });
});
