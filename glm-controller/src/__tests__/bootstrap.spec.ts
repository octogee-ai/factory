import { describe, expect, it, vi } from "vitest";
import {
  bootstrapDefaultGateway,
  bootstrapGlmGateways,
  convergeHeartbeatMatchesImageTag,
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
  it("uses the immutable tag name for a digest-pinned candidate heartbeat", () => {
    expect(versionFromImageTag(`agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`)).toBe(
      "agent-conversation-w9a-8c356bb1",
    );
  });
});

describe("convergeHeartbeatMatchesImageTag", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("matches the build SHA for a plain release tag", () => {
    expect(convergeHeartbeatMatchesImageTag("abc1234", "abc1234-oc2026.6.11")).toBe(true);
  });

  it("matches the full tag for a plain release tag", () => {
    expect(convergeHeartbeatMatchesImageTag("abc1234-oc2026.6.11", "abc1234-oc2026.6.11")).toBe(
      true,
    );
  });

  it("matches the build SHA for a digest-pinned release tag", () => {
    expect(convergeHeartbeatMatchesImageTag("abc1234", `abc1234-oc2026.6.11@${digest}`)).toBe(true);
  });

  it("matches the digest-stripped tag name for a digest-pinned release tag", () => {
    expect(
      convergeHeartbeatMatchesImageTag("abc1234-oc2026.6.11", `abc1234-oc2026.6.11@${digest}`),
    ).toBe(true);
  });

  it("matches the immutable tag name for a digest-pinned W9 candidate", () => {
    expect(
      convergeHeartbeatMatchesImageTag(
        "agent-conversation-w9a-8c356bb1",
        `agent-conversation-w9a-8c356bb1@${digest}`,
      ),
    ).toBe(true);
  });

  it("rejects a mismatched heartbeat version", () => {
    expect(convergeHeartbeatMatchesImageTag("fdab862", `abc1234-oc2026.6.11@${digest}`)).toBe(
      false,
    );
  });
});
