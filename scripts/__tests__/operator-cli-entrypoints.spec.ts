import { describe, expect, it, vi } from "vitest";
import {
  parseBackfillActivityPairsArgs,
} from "../ops/backfill-activity-pairs.js";
import {
  parsePurgeRestoreJobsArgs,
  VESTIGIAL_GATEWAY_FIELDS,
} from "../ops/purge-restore-jobs.js";
import {
  parseRotateBuilderMmPatArgs,
  ROTATE_BUILDER_MM_PAT_USAGE,
} from "../ops/rotate-builder-mm-pat.js";
import {
  resolveScopeCli,
  scopeSummary,
} from "../ops/scope.js";
import {
  parseSeedGithubProjectArgs,
  SEED_GITHUB_PROJECTS_USAGE,
} from "../ops/seed-github-projects.js";
import {
  parseSeedOrchestratorConfigArgs,
  SEED_ORCHESTRATOR_CONFIG_USAGE,
} from "../ops/seed-orchestrator-config.js";
import {
  parseSetAdminRoleArgs,
  SET_ADMIN_ROLE_USAGE,
} from "../ops/set-admin-role.js";
import {
  ONE_TIME,
  parseSetupStripePersonalMode,
  SETUP_STRIPE_PERSONAL_USAGE,
  SUBSCRIPTIONS,
} from "../ops/setup-stripe-personal.js";

describe("seed-orchestrator-config args", () => {
  it("validates env and default gateway before Firebase init", () => {
    expect(parseSeedOrchestratorConfigArgs([
      "--env=test",
      "--default-gateway=canary",
      "--force",
      "--dry-run",
    ])).toEqual({
      kind: "ok",
      args: { env: "test", defaultGateway: "canary", force: true, dryRun: true },
    });
    expect(parseSeedOrchestratorConfigArgs([])).toMatchObject({ kind: "error" });
    expect(parseSeedOrchestratorConfigArgs(["--help"])).toEqual({ kind: "help" });
    expect(SEED_ORCHESTRATOR_CONFIG_USAGE).toContain("--env=test|prod");
  });
});

describe("one-shot operator CLI parsers", () => {
  it("parses purge-restore-jobs without a default project", () => {
    expect(parsePurgeRestoreJobsArgs(["--project=octogee-test", "--apply"])).toEqual({
      project: "octogee-test",
      apply: true,
    });
    expect(parsePurgeRestoreJobsArgs([])).toEqual({ project: null, apply: false });
    expect(VESTIGIAL_GATEWAY_FIELDS).toEqual([
      "inFlightJobId",
      "lastJobCompletedAt",
      "failedCustomers",
    ]);
  });

  it("parses activity-pair backfills with help as data", () => {
    expect(parseBackfillActivityPairsArgs([
      "--dry-run",
      "--workspace",
      "octogee",
    ])).toEqual({ dryRun: true, workspaceSlug: "octogee", help: false });
    expect(parseBackfillActivityPairsArgs(["--help"])).toEqual({ dryRun: false, help: true });
  });

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
    expect(parseRotateBuilderMmPatArgs([
      "alice@example.com",
      "--project=octogee",
    ], {})).toEqual({ target: "alice@example.com", project: "octogee" });
    expect(parseRotateBuilderMmPatArgs([], {})).toBeNull();
    expect(ROTATE_BUILDER_MM_PAT_USAGE).toContain("<email-or-uid>");

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

describe("setup-stripe-personal catalog", () => {
  it("requires exactly one execution mode", () => {
    expect(parseSetupStripePersonalMode(["--dry-run"])).toBe("dry-run");
    expect(parseSetupStripePersonalMode(["--execute"])).toBe("execute");
    expect(parseSetupStripePersonalMode([])).toBeNull();
    expect(parseSetupStripePersonalMode(["--dry-run", "--execute"])).toBeNull();
    expect(SETUP_STRIPE_PERSONAL_USAGE).toContain("--dry-run");
  });

  it("keeps tier and one-time price keys unique", () => {
    const recurringKeys = SUBSCRIPTIONS.flatMap((sub) => sub.prices.map((price) => price.key));
    const oneTimeKeys = ONE_TIME.map((item) => item.key);
    const allKeys = [...recurringKeys, ...oneTimeKeys];

    expect(SUBSCRIPTIONS.map((sub) => sub.key)).toEqual(["hobby", "pro", "max"]);
    expect(recurringKeys).toHaveLength(12);
    expect(oneTimeKeys).toEqual(["fastpass_rush", "fastpass_allday", "overage_block_100k"]);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});
