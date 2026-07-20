import { describe, expect, it, vi } from "vitest";
import {
  assertMattermostEnvironment,
  parseActivityPairReportArgs,
  projectIdForActivityPairReport,
} from "../ops/activity-pair-report.js";
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
  parseSetupStripePlansMode,
  SETUP_STRIPE_PLANS_USAGE,
  SUBSCRIPTIONS,
} from "../ops/setup-stripe-plans.js";
import {
  ANNUAL_PRICE_MULTIPLIER,
  BUILDER_TIERS,
  CREDIT_DENOMINATIONS_USD,
  getTierConfig,
  STRIPE_PRICE_IDS,
} from "@octogee/shared/types/billing-tiers";

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

  it("parses the report-only activity-pair inventory", () => {
    expect(parseActivityPairReportArgs([
      "--env=test",
      "--workspace",
      "octogee",
    ])).toEqual({
      kind: "ok",
      args: { env: "test", workspaceSlug: "octogee", apply: false },
    });
    expect(parseActivityPairReportArgs([
      "--env=prod",
      "--workspace=octogee",
      "--apply",
      "--confirm-prod",
    ])).toEqual({
      kind: "ok",
      args: { env: "prod", workspaceSlug: "octogee", apply: true },
    });
    expect(parseActivityPairReportArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseActivityPairReportArgs(["--env=test", "--apply"])).toMatchObject({ kind: "error" });
    expect(parseActivityPairReportArgs([
      "--env=prod",
      "--workspace=octogee",
      "--apply",
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("--confirm-prod") });
  });

  it("binds the activity-pair report to the explicitly selected Firebase project", () => {
    expect(projectIdForActivityPairReport("test")).toBe("octogee-test");
    expect(projectIdForActivityPairReport("prod")).toBe("octogee");
  });

  it("verifies the selected Mattermost environment against the connected server", async () => {
    await expect(assertMattermostEnvironment(
      "test",
      vi.fn(async () => ({ SiteURL: "https://mattermost-test.octogee.com" })),
    )).resolves.toBeUndefined();
    await expect(assertMattermostEnvironment(
      "prod",
      vi.fn(async () => ({ SiteURL: "https://mattermost-test.octogee.com" })),
    )).rejects.toThrow("Mattermost environment mismatch");
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

describe("setup-stripe-plans catalog", () => {
  it("requires exactly one execution mode", () => {
    expect(parseSetupStripePlansMode(["--dry-run"])).toBe("dry-run");
    expect(parseSetupStripePlansMode(["--execute"])).toBe("execute");
    expect(parseSetupStripePlansMode([])).toBeNull();
    expect(parseSetupStripePlansMode(["--dry-run", "--execute"])).toBeNull();
    expect(SETUP_STRIPE_PLANS_USAGE).toContain("--dry-run");
  });

  it("sells the Personal lineup at the shared TokenMath prices, monthly + annual", () => {
    const personal = SUBSCRIPTIONS.filter((sub) => !sub.key.startsWith("builder_"));
    expect(personal.map((sub) => sub.key)).toEqual([
      "personal",
      "personal_pro",
      "personal_pro_max",
    ]);
    for (const sub of personal) {
      const tier = getTierConfig(sub.key);
      expect(sub.prices).toHaveLength(2);
      expect(sub.prices[0]).toMatchObject({
        key: `${sub.key}_monthly`,
        amount: tier.monthlyPrice * 100,
        interval: "month",
      });
      expect(sub.prices[1]).toMatchObject({
        key: `${sub.key}_annual`,
        amount: tier.monthlyPrice * ANNUAL_PRICE_MULTIPLIER * 100,
        interval: "year",
      });
      expect(sub.metadata.tier).toBe(sub.key);
    }
  });

  it("sells the self-serve Builder ladder at infra-only prices, monthly + annual", () => {
    const builders = SUBSCRIPTIONS.filter((sub) => sub.key.startsWith("builder_"));
    expect(builders.map((sub) => sub.key)).toEqual([
      "builder_hobby",
      "builder_pro",
      "builder_team",
    ]);
    for (const sub of builders) {
      const builderTier = BUILDER_TIERS[sub.key.replace("builder_", "") as keyof typeof BUILDER_TIERS];
      const monthly = builderTier.monthlyPrice;
      if (monthly === null) throw new Error(`${sub.key} is not self-serve sellable`);
      expect(sub.prices).toHaveLength(2);
      expect(sub.prices[0]).toMatchObject({
        key: `${sub.key}_monthly`,
        amount: monthly * 100,
        interval: "month",
      });
      expect(sub.prices[1]).toMatchObject({
        key: `${sub.key}_annual`,
        amount: monthly * ANNUAL_PRICE_MULTIPLIER * 100,
        interval: "year",
      });
      expect(sub.metadata.builderTier).toBe(builderTier.name);
    }
  });

  it("sells one-time credit SKUs for every shared denomination", () => {
    expect(ONE_TIME.map((item) => item.key)).toEqual(
      CREDIT_DENOMINATIONS_USD.map((usd) => `credit_${usd}`),
    );
    ONE_TIME.forEach((item, i) => {
      expect(item.price).toBe(CREDIT_DENOMINATIONS_USD[i] * 100);
      expect(item.metadata).toMatchObject({
        type: "credit",
        creditUsd: String(CREDIT_DENOMINATIONS_USD[i]),
      });
    });
  });

  it("emits only price keys that STRIPE_PRICE_IDS can hold", () => {
    const allKeys = [
      ...SUBSCRIPTIONS.flatMap((sub) => sub.prices.map((price) => price.key)),
      ...ONE_TIME.map((item) => item.key),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect([...allKeys].sort()).toEqual(Object.keys(STRIPE_PRICE_IDS).sort());
  });
});
