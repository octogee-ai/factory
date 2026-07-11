import { describe, expect, it } from "vitest";
import { chatProxyOwnsHttpPath } from "./http-paths.js";

describe("chatProxyOwnsHttpPath", () => {
  it("claims only health checks, callbacks, and the bare loopback Activity intake", () => {
    expect(chatProxyOwnsHttpPath("/healthz")).toBe(true);
    expect(chatProxyOwnsHttpPath("/healthz/bridge")).toBe(true);
    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback")).toBe(true);
    expect(chatProxyOwnsHttpPath("/internal/openclaw/activity/v1/events")).toBe(true);
    expect(chatProxyOwnsHttpPath(
      "/internal/openclaw/activity/v1/events",
      "/api/g/gw-1/internal/openclaw/activity/v1/events",
    )).toBe(false);

    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback/")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/workspace/files")).toBe(false);
    expect(chatProxyOwnsHttpPath("/healthz/other")).toBe(false);
  });
});
