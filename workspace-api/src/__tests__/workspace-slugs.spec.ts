/**
 * workspace-slugs — unit tests for the helper that resolves a user's
 * workspace slug(s). These are the rules every v3.1 `workspaces/{slug}/*`
 * Firestore read depends on; a regression would silently read zero data
 * or (worse) read from the wrong workspace. The helper is intentionally
 * pure — observability (logging when no slug is resolved) lives at the
 * call site, so this file only pins the resolution behavior.
 */
import { describe, it, expect } from "vitest";

import { primaryWorkspaceSlug, workspaceSlugsForUser } from "../lib/workspace-slugs";

describe("primaryWorkspaceSlug", () => {
  it("prefers provisioning.openclaw.slug over username (authoritative)", () => {
    expect(primaryWorkspaceSlug({
      provisioning: { openclaw: { slug: "from-provisioner" } },
      username: "from-signup",
    })).toBe("from-provisioner");
  });

  it("falls back to username when slug is missing (pre-provisioning state)", () => {
    expect(primaryWorkspaceSlug({ username: "jane" })).toBe("jane");
  });

  it("falls back to username when slug is empty string", () => {
    expect(primaryWorkspaceSlug({
      provisioning: { openclaw: { slug: "" } },
      username: "jane",
    })).toBe("jane");
  });

  it("returns null when neither is set", () => {
    expect(primaryWorkspaceSlug({})).toBeNull();
    expect(primaryWorkspaceSlug({ username: "" })).toBeNull();
    expect(primaryWorkspaceSlug(null)).toBeNull();
    expect(primaryWorkspaceSlug(undefined)).toBeNull();
  });

  it("returns null when slug/username is a non-string (defensive)", () => {
    expect(primaryWorkspaceSlug({ username: 123 as any })).toBeNull();
    expect(primaryWorkspaceSlug({
      provisioning: { openclaw: { slug: { nested: "oops" } as any } },
    })).toBeNull();
  });

  it("tolerates partial provisioning shape", () => {
    expect(primaryWorkspaceSlug({
      provisioning: { openclaw: null },
      username: "jane",
    })).toBe("jane");
    expect(primaryWorkspaceSlug({
      provisioning: null,
      username: "jane",
    })).toBe("jane");
  });
});

describe("workspaceSlugsForUser", () => {
  it("returns [slug] when resolvable", () => {
    expect(
      workspaceSlugsForUser({
        provisioning: { openclaw: { slug: "eckert" } },
        username: "eckert",
      }),
    ).toEqual(["eckert"]);
  });

  it("returns [] when no slug can be resolved — caller handles logging", () => {
    expect(workspaceSlugsForUser({})).toEqual([]);
  });

  it("handles null/undefined user data without throwing", () => {
    expect(workspaceSlugsForUser(null)).toEqual([]);
    expect(workspaceSlugsForUser(undefined)).toEqual([]);
  });
});
