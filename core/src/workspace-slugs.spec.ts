import { describe, it, expect } from "vitest";

import { primaryWorkspaceSlug, workspaceSlugsForUser } from "./workspace-slugs.js";

describe("primaryWorkspaceSlug", () => {
  it("returns the username when set", () => {
    expect(primaryWorkspaceSlug({ username: "jane" })).toBe("jane");
  });

  it("returns null when username is missing, empty, or null", () => {
    expect(primaryWorkspaceSlug({})).toBeNull();
    expect(primaryWorkspaceSlug({ username: "" })).toBeNull();
    expect(primaryWorkspaceSlug({ username: null })).toBeNull();
    expect(primaryWorkspaceSlug(null)).toBeNull();
    expect(primaryWorkspaceSlug(undefined)).toBeNull();
  });

  it("returns null when username is a non-string (defensive)", () => {
    expect(primaryWorkspaceSlug({ username: 123 as unknown as string })).toBeNull();
  });

  it("prefers provisioning.openclaw.slug — the canonical post-provision identity", () => {
    expect(
      primaryWorkspaceSlug({
        username: "old-handle",
        provisioning: { openclaw: { slug: "smile-wring-011b" } },
      }),
    ).toBe("smile-wring-011b");
  });

  it("falls back to username when provisioning.openclaw.slug is absent/blank", () => {
    expect(
      primaryWorkspaceSlug({ username: "jane", provisioning: { openclaw: {} } }),
    ).toBe("jane");
    expect(
      primaryWorkspaceSlug({
        username: "jane",
        provisioning: { openclaw: { slug: "" } },
      }),
    ).toBe("jane");
  });

  it("resolves provisioned users that have no username (onboarding-created)", () => {
    expect(
      primaryWorkspaceSlug({ provisioning: { openclaw: { slug: "blue-otter-77" } } }),
    ).toBe("blue-otter-77");
  });
});

describe("workspaceSlugsForUser", () => {
  it("returns [username] when resolvable", () => {
    expect(workspaceSlugsForUser({ username: "eckert" })).toEqual(["eckert"]);
  });

  it("returns [] when no slug can be resolved — caller handles logging", () => {
    expect(workspaceSlugsForUser({})).toEqual([]);
    expect(workspaceSlugsForUser({ username: "" })).toEqual([]);
  });

  it("handles null/undefined user data without throwing", () => {
    expect(workspaceSlugsForUser(null)).toEqual([]);
    expect(workspaceSlugsForUser(undefined)).toEqual([]);
  });
});
