import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFleetSystemConfigFlush,
  createSystemConfigMutationGatedRpc,
  assertFleetConfigSlug,
  restoreRevisionSystemConfig,
  resolveFleetControllerEntrypointConfig,
} from "../entrypoints/fleet-controller.js";
import {
  ASSIGN_CUSTOMER_GATEWAY_USAGE,
  isBulkAssignmentCandidate,
  parseAssignCustomerGatewayArgs,
  readGatewayProfile,
  resolveOpsAssignmentTarget,
} from "../ops/assign-customer-gateway.js";
import { parseFleetArgs, resolveFleetCredentialMode } from "../ops/fleet.js";

describe("fleet-controller entrypoint config", () => {
  const rollEnv = {
    GATEWAY_CLASS: "builder",
    GATEWAY_ID: "default",
    API_PUBLIC_URL: "https://api.octogee.com",
  };
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

  it("fails a controller-requested flush until the durable config commit is accepted", async () => {
    const sync = vi.fn(() => ({
      committed: false,
      pushed: false,
      skipped: "sync-locked",
      pending: true,
    }));
    const flush = createFleetSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).rejects.toThrow("sync-locked");
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });

  it("rejects a signed config RPC for a builder other than the gateway owner", () => {
    expect(() => assertFleetConfigSlug("alice", "mallory")).toThrow(/does not match gateway builder/i);
    expect(() => assertFleetConfigSlug("alice", "alice")).not.toThrow();
  });

  it("blocks ordinary runtime config.apply while the controller freeze marker exists", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-freeze-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "mig-1",
      directoryMode: 0o700,
      configMode: 0o600,
    }));

    try {
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/frozen by mig-1/i);
      expect(configApply).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("serializes ordinary runtime config.apply against the roll writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer lock is busy/i);
      expect(configApply).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("records config readiness only after proof and a fresh revision-scoped runtime observation", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-config-"));
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n');
    const order: string[] = [];
    const configGet = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("config-get-before-load");
        return { config: { stale: true }, hash: "runtime-before" };
      })
      .mockImplementationOnce(async () => {
        order.push("config-get-after-proof");
        return { config: { gateway: { mode: "local" } }, hash: "runtime-after" };
      });
    const rpc = {
      configGet,
      configApply: vi.fn(async (config: object, baseHash: string) => {
        order.push("config-apply");
        expect(config).toEqual({ gateway: { mode: "local" } });
        expect(baseHash).toBe("runtime-before");
        return { ok: true as const, hash: "runtime-after" };
      }),
      channelsStatus: vi.fn(async () => {
        order.push("channels-status");
        return { channels: [] };
      }),
    };
    const now = vi.fn()
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(501);
    const restore = vi.fn(async (options: {
      env?: NodeJS.ProcessEnv;
      source?: string;
      loadRuntimeConfig?: (path: string) => Promise<void>;
    }) => {
      expect(options).toMatchObject({ env: rollEnv, source: "migration-restore" });
      await options.loadRuntimeConfig?.(configPath);
      order.push("proof");
      return {
        restoredCommit: "a".repeat(40),
        acceptedCommit: "c".repeat(40),
        configHash: "d".repeat(64),
      };
    });

    try {
      const result = await restoreRevisionSystemConfig({
        checkpointCommit: "a".repeat(40),
        slug: "alice",
        openclawDir,
        revisionId: "default-r2",
        env: rollEnv,
        source: "migration-restore",
        rpc,
        now,
        restore,
      });

      expect(order).toEqual([
        "config-get-before-load",
        "config-apply",
        "proof",
        "config-get-after-proof",
        "channels-status",
      ]);
      expect(result).toMatchObject({
        configReady: true,
        observedRevisionId: "default-r2",
        restoreProvenAt: 500,
        configReadyAt: 501,
        runtimeConfigHash: "runtime-after",
      });
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale runtime hash observed after proof", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-config-"));
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n");
    const rpc = {
      configGet: vi
        .fn()
        .mockResolvedValueOnce({ config: {}, hash: "before" })
        .mockResolvedValueOnce({ config: {}, hash: "still-before" }),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "expected-after" })),
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    };
    const restore = async (options: { loadRuntimeConfig?: (path: string) => Promise<void> }) => {
      await options.loadRuntimeConfig?.(configPath);
      return {
        restoredCommit: "a".repeat(40),
        acceptedCommit: "c".repeat(40),
        configHash: "d".repeat(64),
      };
    };

    try {
      await expect(restoreRevisionSystemConfig({
        checkpointCommit: "a".repeat(40),
        slug: "alice",
        openclawDir,
        revisionId: "default-r2",
        env: rollEnv,
        source: "migration-restore",
        rpc,
        restore,
      })).rejects.toThrow(/runtime config hash.*does not match/i);
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});

describe("assign-customer-gateway args", () => {
  it("bulk-selects only identity-complete builders whose provisioning has started", () => {
    expect(isBulkAssignmentCandidate({
      username: "alice",
      onboardingStep: "complete",
      provisioning: { status: "in_progress", openclaw: {} },
    })).toBe(true);
    expect(isBulkAssignmentCandidate({ username: "partial" })).toBe(false);
    expect(isBulkAssignmentCandidate({
      username: "service",
      onboardingStep: "complete",
      provisioning: { status: "queued", openclaw: {} },
    })).toBe(false);
  });

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

describe("assign-customer-gateway root config", () => {
  function gatewayRoot(profile: "standard" | "operator" = "standard") {
    return {
      gatewayId: "default",
      createdAt: 1,
      createdBy: "test",
      updatedAt: 1,
      updatedBy: "test",
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: 1,
      liveRevisionId: "default-r1",
      trafficRevisionId: "default-r1",
      desiredStatus: "running",
      roll: null,
      configSchemaVersion: 1,
      profile,
      gatewayClass: "shared",
      imageProfile: "standard",
      sizingTier: null,
      computeClass: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      operatorAccess: null,
      ownerUid: null,
      coOwnerUids: [],
      builderSlug: null,
      openclawOverrides: null,
      modelBrokerLimits: null,
      preemption: null,
    };
  }

  function db(docs: Record<string, Record<string, unknown>>) {
    return {
      doc: (path: string) => ({
        get: async () => ({
          exists: docs[path] !== undefined,
          data: () => docs[path],
        }),
      }),
    };
  }

  it("reads the profile from a validated durable root only", async () => {
    await expect(
      readGatewayProfile(db({ "gateways/default": gatewayRoot("operator") }) as never, "default"),
    ).resolves.toBe("operator");
    await expect(
      readGatewayProfile(
        db({ "glmGateways/default": { profile: "operator" } }) as never,
        "default",
      ),
    ).resolves.toBeNull();
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
