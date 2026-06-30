import { describe, expect, it } from "vitest";
import { chatProxyOwnsHttpPath } from "./http-paths.js";

describe("chatProxyOwnsHttpPath", () => {
  it("claims only health checks and OpenClaw approval callbacks", () => {
    expect(chatProxyOwnsHttpPath("/healthz")).toBe(true);
    expect(chatProxyOwnsHttpPath("/healthz/bridge")).toBe(true);
    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback")).toBe(true);

    expect(chatProxyOwnsHttpPath("/api/openclaw/approval/callback/")).toBe(false);
    expect(chatProxyOwnsHttpPath("/api/workspace/files")).toBe(false);
    expect(chatProxyOwnsHttpPath("/healthz/other")).toBe(false);
  });
});
