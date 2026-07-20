import { describe, expect, it, vi } from "vitest";
import {
  bootstrapDefaultGateway,
  bootstrapGlmGateways,
  versionFromImageTag,
} from "../index";

function controllerDeps() {
  return {
    db: {} as Parameters<typeof bootstrapGlmGateways>[0]["db"],
    helm: {
      readDeployedInstances: vi.fn(async () => ({})),
    } as Parameters<typeof bootstrapGlmGateways>[0]["helm"],
    handlers: {} as Parameters<typeof bootstrapGlmGateways>[0]["handlers"],
    log: vi.fn(),
  };
}

describe("legacy bootstrap is disabled", () => {
  it("does not inspect Helm or create bare desired documents", async () => {
    const deps = controllerDeps();

    await bootstrapGlmGateways(deps);

    expect(deps.helm.readDeployedInstances).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bootstrap disabled"));
  });

  it("does not self-seed a default gateway from environment state", async () => {
    const deps = controllerDeps();

    await bootstrapDefaultGateway(deps);

    expect(deps.helm.readDeployedInstances).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bootstrap disabled"));
  });
});

describe("versionFromImageTag", () => {
  it("publishes the complete OpenClaw-qualified tag as the operator observed version", () => {
    expect(versionFromImageTag("cf36a88-oc2026.7.1")).toBe("cf36a88-oc2026.7.1");
  });

  it("preserves an unqualified immutable tag exactly", () => {
    expect(versionFromImageTag("cf36a88")).toBe("cf36a88");
  });

  it("uses the immutable tag name for a digest-pinned candidate heartbeat", () => {
    expect(versionFromImageTag(`agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`)).toBe(
      "agent-conversation-w9a-8c356bb1",
    );
  });
});
