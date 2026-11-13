import { describe, expect, it, vi } from "vitest";
import {
  parseRotateUserMmPatArgs,
  ROTATE_USER_MM_PAT_USAGE,
} from "../ops/rotate-user-mm-pat.js";
import {
  resolveScopeCli,
  scopeSummary,
} from "../ops/scope.js";
import {
  parseSeedGithubProjectArgs,
  SEED_GITHUB_PROJECTS_USAGE,
} from "../ops/seed-github-projects.js";
import {
  parseSetAdminRoleArgs,
  SET_ADMIN_ROLE_USAGE,
} from "../ops/set-admin-role.js";

describe("one-shot operator CLI parsers", () => {
  it("parses GitHub project seeding and rejects incomplete create requests", () => {
    expect(parseSeedGithubProjectArgs([
      "--slug",
      "octogee",
      "--name",
      "Octogee",
      "--owner",
      "octogee-ai",
      "--repo",
      "octogee",
      "--tagline",
      "Eight arms",
    ])).toEqual({
      slug: "octogee",
      name: "Octogee",
      owner: "octogee-ai",
      repo: "octogee",
      tagline: "Eight arms",
    });
    expect(parseSeedGithubProjectArgs(["--slug", "octogee"])).toBeNull();
    expect(SEED_GITHUB_PROJECTS_USAGE).toContain("--owner");
  });

  it("parses role and token maintenance targets", () => {
    expect(parseRotateUserMmPatArgs([
      "alice@example.com",
      "--project=octogee",
    ], {})).toEqual({ target: "alice@example.com", project: "octogee" });
    expect(parseRotateUserMmPatArgs([], {})).toBeNull();
    expect(ROTATE_USER_MM_PAT_USAGE).toContain("<email-or-uid>");

    expect(parseSetAdminRoleArgs([
      "uid-1",
      "--revoke",
    ], { GOOGLE_CLOUD_PROJECT: "octogee" })).toEqual({
      target: "uid-1",
      revoke: true,
      project: "octogee",
    });
    expect(parseSetAdminRoleArgs([], {})).toBeNull();
    expect(SET_ADMIN_ROLE_USAGE).toContain("[--revoke]");
  });
});

describe("scope CLI glue", () => {
  it("fails open when no usable diff base is supplied", () => {
    const result = resolveScopeCli([]);

    expect(result.everything).toBe(true);
    expect(scopeSummary(result)).toContain("no usable diff base");
  });

  it("converts git failures into full-scope runs", () => {
    const execFile = vi.fn(() => {
      throw new Error("merge-base failed");
    });

    const result = resolveScopeCli(["--base", "abc123"], execFile);

    expect(result.everything).toBe(true);
    expect(scopeSummary(result)).toContain("git diff failed");
  });
});
