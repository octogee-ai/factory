import { describe, expect, it } from "vitest";
import {
  resolveFleetControllerEntrypointConfig,
} from "../entrypoints/fleet-controller.js";
import {
  ASSIGN_CUSTOMER_GATEWAY_USAGE,
  parseAssignCustomerGatewayArgs,
  resolveOpsAssignmentTarget,
} from "../ops/assign-customer-gateway.js";
import { parseFleetArgs, resolveFleetCredentialMode } from "../ops/fleet.js";

describe("fleet-controller entrypoint config", () => {
  it("normalizes local gateways and trims dedicated builder slugs", () => {
    expect(resolveFleetControllerEntrypointConfig({
      BUILD_SHA: "abc123",
      FLEET_CONTROLLER_PORT: "3999",
      FLEET_CONTROLLER_PUBLIC_KEY: "pub",
      GATEWAY_BUILDER_SLUG: " alice ",
    }, { gatewayId: "local" })).toEqual({
      gatewayId: "default",
      builderSlug: "alice",
      port: 3999,
      publicKey: "pub",
      version: "abc123",
    });
  });

  it("uses production defaults for unset optional values", () => {
    expect(resolveFleetControllerEntrypointConfig({}, { gatewayId: "gw-1" })).toEqual({
      gatewayId: "gw-1",
      builderSlug: "",
      port: 3003,
      publicKey: "",
      version: "unknown",
    });
  });
});

describe("assign-customer-gateway args", () => {
  it("accepts uid-targeted dry runs", () => {
    expect(parseAssignCustomerGatewayArgs([
      "--env=prod",
      "--uid=uid-1",
      "--dry-run",
    ])).toEqual({
      kind: "ok",
      args: {
        env: "prod",
        uid: "uid-1",
        slug: "",
        all: false,
        dryRun: true,
      },
    });
  });

  it("rejects missing selector before Firebase init", () => {
    expect(parseAssignCustomerGatewayArgs(["--env=test"])).toMatchObject({ kind: "error" });
    expect(parseAssignCustomerGatewayArgs(["--help"])).toEqual({ kind: "help" });
    expect(ASSIGN_CUSTOMER_GATEWAY_USAGE).toContain("--uid=UID");
  });

  it("uses Current by default and Preview only for explicit cohort overrides", () => {
    const config = {
      defaultGatewayId: "default",
      currentOnboardingCohortId: "sonnet-standard",
      previewOnboardingCohortId: "glm-openrouter",
      onboardingCohorts: {
        "sonnet-standard": {
          label: "Standard Sonnet",
          gatewayId: "default",
          provider: "anthropic" as const,
          model: "anthropic/claude-sonnet-4-6",
        },
        "glm-openrouter": {
          label: "GLM via OpenRouter",
          gatewayId: "glm-shared",
          provider: "openrouter" as const,
          model: "z-ai/glm-5.2",
          reasoningEffort: "high" as const,
        },
      },
      cohortOverrides: { "uid-preview": "glm-openrouter" },
    };

    expect(resolveOpsAssignmentTarget("uid-current", config)).toEqual({
      kind: "cohort",
      gatewayId: "default",
      onboardingCohortId: "sonnet-standard",
    });
    expect(resolveOpsAssignmentTarget("uid-preview", config)).toEqual({
      kind: "cohort",
      gatewayId: "glm-shared",
      onboardingCohortId: "glm-openrouter",
    });
  });
});

describe("fleet CLI args", () => {
  it("parses value flags in both equals and split forms", () => {
    expect(parseFleetArgs([
      "--env=prod",
      "migrate-customer",
      "alice",
      "--to",
      "canary",
      "--apply",
    ])).toEqual({
      env: "prod",
      positional: ["migrate-customer", "alice"],
      flags: { to: "canary", apply: true },
    });
  });

  it("keeps read verbs positional while recording optional filters", () => {
    expect(parseFleetArgs([
      "--env",
      "test",
      "ls",
      "customers",
      "--gateway=default",
    ])).toEqual({
      env: "test",
      positional: ["ls", "customers"],
      flags: { gateway: "default" },
    });
  });

  it("uses application-default credentials for committed fleet write verbs", () => {
    expect(
      resolveFleetCredentialMode(
        parseFleetArgs([
          "--env=prod",
          "migrate-customer",
          "alice",
          "--to=canary",
          "--apply",
        ]),
      ),
    ).toBe("application-default");

    expect(
      resolveFleetCredentialMode(
        parseFleetArgs(["--env=prod", "migrate-customer", "alice", "--to=canary"]),
      ),
    ).toBe("service-account-key");
  });
});
