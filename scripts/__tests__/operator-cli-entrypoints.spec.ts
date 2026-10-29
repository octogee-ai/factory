import { describe, expect, it, vi } from "vitest";
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
  runSetupStripePlans,
  SETUP_STRIPE_PLANS_USAGE,
  SUBSCRIPTIONS,
} from "../ops/setup-stripe-plans.js";
import {
  BUILDER_TIERS,
  CREDIT_DENOMINATIONS_USD,
  getTierConfig,
  STRIPE_PRICE_IDS,
} from "@octogee/shared/types/billing-tiers";

describe("seed-orchestrator-config args", () => {
  it("validates env and the deployment target before Firebase init", () => {
    expect(parseSeedOrchestratorConfigArgs([
      "--env=test",
      "--force",
      "--dry-run",
    ])).toEqual({
      kind: "ok",
      args: {
        env: "test",
        deploymentTargetId: "test-central",
        firebaseProjectId: "octogee-test",
        force: true,
        dryRun: true,
        check: false,
      },
    });
    expect(parseSeedOrchestratorConfigArgs([])).toMatchObject({ kind: "error" });
    expect(parseSeedOrchestratorConfigArgs(["--help"])).toEqual({ kind: "help" });
    expect(SEED_ORCHESTRATOR_CONFIG_USAGE).toContain("--env=test|prod");
  });
});

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

  it("sells the Personal lineup at the shared TokenMath prices, monthly only", () => {
    const personal = SUBSCRIPTIONS.filter((sub) => !sub.key.startsWith("builder_"));
    expect(personal.map((sub) => sub.key)).toEqual([
      "personal",
      "personal_pro",
      "personal_pro_max",
    ]);
    for (const sub of personal) {
      const tier = getTierConfig(sub.key);
      expect(sub.prices).toEqual([
        expect.objectContaining({
          key: `${sub.key}_monthly`,
          amount: tier.monthlyPrice * 100,
          interval: "month",
        }),
      ]);
      expect(sub.metadata.tier).toBe(sub.key);
    }
  });

  it("sells the self-serve Builder ladder at infra-only prices, monthly only", () => {
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
      expect(sub.prices).toEqual([
        expect.objectContaining({
          key: `${sub.key}_monthly`,
          amount: monthly * 100,
          interval: "month",
        }),
      ]);
      expect(sub.metadata.builderTier).toBe(builderTier.name);
    }
    for (const builder of builders) {
      expect(builder.metadata).toMatchObject({
        trialDays: "7",
        trialEligibility: "first_builder_gateway",
        trialPaymentMethodRequired: "true",
      });
      expect(builder.marketingFeatures.join(" ")).toMatch(/7-day free trial/i);
      expect(builder.description).toMatch(/first self-serve Builder gateway/i);
    }
    expect(builders[0].metadata.instance).toBe("small");
    expect(builders[0].description).toMatch(/Small isolated gateway/i);
    expect(builders.map((builder) => builder.marketingFeatures[1])).toEqual([
      "Small (2 vCPU / 8GB RAM) isolated gateway",
      "2 vCPU / 8GB RAM isolated gateway",
      "4 vCPU / 16GB RAM isolated gateway",
    ]);
  });

  it("reconciles every existing subscription product's description on re-run", async () => {
    const existingPrices = [
      ...SUBSCRIPTIONS.flatMap((sub) =>
        sub.prices.map((price) => ({
          id: `price_${price.key}`,
          lookup_key: price.key,
          product: `prod_${sub.key}`,
        })),
      ),
      ...ONE_TIME.map((item) => ({
        id: `price_${item.key}`,
        lookup_key: item.key,
        product: `prod_${item.key}`,
      })),
    ];
    const stripe = {
      prices: {
        list: () => (async function* () { yield* existingPrices; })(),
        create: vi.fn(),
      },
      products: { create: vi.fn(), update: vi.fn(async () => ({})) },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runSetupStripePlans(stripe as never, "execute");

    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    for (const sub of SUBSCRIPTIONS) {
      expect(stripe.products.update).toHaveBeenCalledWith(
        `prod_${sub.key}`,
        expect.objectContaining({ name: sub.name, description: sub.description }),
      );
    }
    vi.restoreAllMocks();
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
