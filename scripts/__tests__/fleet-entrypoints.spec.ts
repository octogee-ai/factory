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
    }, { gatewayId: "local", revisionId: "default-r5" })).toEqual({
      gatewayId: "default",
      revisionId: "default-r5",
      builderSlug: "alice",
      port: 3999,
      publicKey: "pub",
      version: "abc123",
    });
  });

  it("uses production defaults for unset optional values", () => {
    expect(resolveFleetControllerEntrypointConfig({}, { gatewayId: "gw-1" })).toEqual({
      gatewayId: "gw-1",
      revisionId: "",
      builderSlug: "",
      port: 3003,
      publicKey: "",
      version: "unknown",
    });
  });

  it("threads GATEWAY_REVISION_ID onto the config so the pod writes the revision-keyed heartbeat", () => {
    expect(
      resolveFleetControllerEntrypointConfig({}, { gatewayId: "bender", revisionId: "bender-r2" }).revisionId,
    ).toBe("bender-r2");
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

  it("resolves the default gateway with per-uid overrides (cohorts are dead)", () => {
    const config = {
      defaultGatewayId: "default",
      overrides: { "uid-pinned": "glm-shared" },
    };

    expect(resolveOpsAssignmentTarget("uid-anyone", config)).toEqual({
      kind: "default",
      gatewayId: "default",
    });
    expect(resolveOpsAssignmentTarget("uid-pinned", config)).toEqual({
      kind: "gateway-override",
      gatewayId: "glm-shared",
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
