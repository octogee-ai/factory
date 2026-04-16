/**
 * workspace-slugs — unit tests for the helper that resolves a user's
 * workspace slug(s). Per docs/DATA-MODEL-REVIEW.md §11, the user doc's
 * `username` field IS the workspace slug — there is no separate slug
 * resolution, just a readthrough. The helper stays because callers fan
 * out reads via a list shape (forward-compat for multi-workspace).
 */
import { describe, it, expect } from "vitest";

import { primaryWorkspaceSlug, workspaceSlugsForUser } from "../lib/workspace-slugs";

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
