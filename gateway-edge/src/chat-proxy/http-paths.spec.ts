import { describe, expect, it } from "vitest";
import { chatProxyOwnsHttpPath } from "./http-paths.js";

describe("chatProxyOwnsHttpPath", () => {
  it("claims only health checks, Mattermost callbacks, and bare local producer intakes", () => {
    expect(chatProxyOwnsHttpPath("/healthz")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/voice/v1/migration")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/voice/v1/migration", "/api/g/gw-1/internal/openclaw/voice/v1/migration")).toBe(false);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/notifications/v1/final-reply")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/notifications/v1/final-reply",
      "/api/g/gw-1/internal/openclaw/notifications/v1/final-reply")).toBe(false);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/mattermost/interactions/default")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/voice/v1/events")).toBe(true);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/voice/v1/events",
      "/api/g/gw-1/internal/openclaw/voice/v1/events",
    )).toBe(false);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/events")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/direct-target")).toBe(true);

    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback/")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/workspace/files")).toBe(false);
    expect(chatProxyOwnsHttpPath("/healthz/bridge")).toBe(false);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/agent-control/callback")).toBe(false);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/activity/v1/events",
      "/api/g/gw-1/internal/openclaw/activity/v1/events",
    )).toBe(false);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/activity/v1/direct-target",
      "/api/g/gw-1/internal/openclaw/activity/v1/direct-target",
    )).toBe(false);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/scheduled-anchor")).toBe(false);
    expect(chatProxyOwnsHttpPath("/healthz/other")).toBe(false);
  });
});
