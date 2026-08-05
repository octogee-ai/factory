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

  it("enables an adminBypass flag for admins without consulting the provider", async () => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });
    const admin = { ...subject, isAdmin: true };

    await expect(policy.evaluate("release-project-repo-source", admin, "repo-source"))
      .resolves.toEqual({ state: "enabled", value: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("leaves non-bypass flags to the provider for admins", async () => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });
    const admin = { ...subject, isAdmin: true };

    await expect(policy.evaluate("release-workspace-sharing", admin, "sharing"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(admin, ["release-workspace-sharing"]);
  });

  it("keeps an adminBypass flag enabled for admins when the provider is unavailable", async () => {
    const policy = new FeaturePolicy({
      evaluate: async () => { throw new Error("network unavailable"); },
    });
    const admin = { ...subject, isAdmin: true };

    const decisions = await policy.userVisibleDecisions(admin, "pwa-snapshot");

    expect(decisions["release-project-repo-source"]).toEqual({ state: "enabled", value: true });
    expect(decisions["release-workspace-sharing"])
      .toEqual({ state: "unavailable", value: false, reason: "provider_error" });
  });

  it("does not bypass an adminBypass flag for non-admins", async () => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });

    await expect(policy.evaluate("release-project-repo-source", subject, "repo-source"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(subject, ["release-project-repo-source"]);
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
