import { describe, expect, it, vi } from "vitest";

import { FeaturePolicy } from "./feature-policy.js";

const subject = { uid: "uid-alice", isAdmin: false, workspaceSlug: "private-workspace" };

describe("FeaturePolicy", () => {
  it("uses the verified subject and maps enabled and disabled provider values", async () => {
    const evaluate = vi.fn(async () => ({
      isEnabled: (key: string) => key === "release-openclaw-dashboard",
    }));
    const policy = new FeaturePolicy({ evaluate });

    await expect(policy.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "enabled", value: true });
    await expect(policy.evaluate("release-agent-import", subject, "agent-import"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(subject, ["release-openclaw-dashboard"]);
  });

  it("does not turn a timeout or provider exception into an ordinary disabled flag", async () => {
    const timeout = new FeaturePolicy(
      { evaluate: () => new Promise(() => undefined) },
      { timeoutMs: 1 },
    );
    const providerError = new FeaturePolicy({
      evaluate: async () => { throw new Error("network unavailable"); },
    });

    await expect(timeout.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "unavailable", value: false, reason: "timeout" });
    await expect(providerError.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "unavailable", value: false, reason: "provider_error" });
  });
});
