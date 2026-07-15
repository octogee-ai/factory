import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSystemConfigMutationLease,
  acquireSystemConfigShellCapabilitySync,
} from "@octogee/core/system-config-mutation-lease";
import {
  createFleetSystemConfigFlush,
  createConfigControlCallbacks,
  createSystemConfigMutationGatedRpc,
  assertFleetConfigSlug,
  proveRevisionSystemConfigCandidate,
  resolveFleetControllerEntrypointConfig,
} from "../entrypoints/fleet-controller.js";
import {
  ASSIGN_CUSTOMER_GATEWAY_USAGE,
  isBulkAssignmentCandidate,
  parseAssignCustomerGatewayArgs,
  readGatewayProfile,
  resolveOpsAssignmentTarget,
} from "../ops/assign-customer-gateway.js";
import {
  buildFleetMigrateOperationInput,
  parseFleetArgs,
  resolveFleetCredentialMode,
} from "../ops/fleet.js";

describe("fleet-controller entrypoint config", () => {
  const rollEnv = {
    GATEWAY_CLASS: "builder",
    GATEWAY_ID: "default",
    GATEWAY_BUILDER_SLUG: "alice",
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

  it("wires retirement terminalization only for a dedicated builder gateway", () => {
    const rpc = {} as never;
    expect(createConfigControlCallbacks({
      gatewayId: "gw-a",
      revisionId: "gw-a-r1",
      builderSlug: "",
      port: 3003,
      publicKey: "public-key",
      version: "build-1",
    }, rpc)).toEqual({});

    const callbacks = createConfigControlCallbacks({
      gatewayId: "gw-a",
      revisionId: "gw-a-r1",
      builderSlug: "alice",
      port: 3003,
      publicKey: "public-key",
      version: "build-1",
    }, rpc);
    expect(callbacks).toEqual(expect.objectContaining({
      retireSystemConfigV2: expect.any(Function),
    }));
    expect(() => callbacks.retireSystemConfigV2?.({
      migrationId: "retire-operation-1",
      slug: "mallory",
      sourceRevisionId: "gw-a-r1",
      targetRevisionId: "gw-a-r0",
      checkpointCommit: "a".repeat(40),
      freezeObject: "b".repeat(40),
    })).toThrow(/does not match gateway builder/i);
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
      slug: "alice",
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

  it("blocks ordinary runtime config.patch while the controller freeze marker exists", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-freeze-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "mig-1",
      slug: "alice",
      directoryMode: 0o700,
      configMode: 0o600,
    }));

    try {
      await expect(rpc.configPatch({ agents: {} }, "current", { replacePaths: ["agents.list"] }))
        .rejects.toThrow(/frozen by mig-1/i);
      expect(configPatch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("blocks native config mutation while an accepted BuilderShell can edit the config", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-shell-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    expect(acquireSystemConfigShellCapabilitySync({
      openclawDir,
      shellId: "native-config",
    })).toMatchObject({ ok: true, created: true, ownerToken: expect.any(String) });

    try {
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer lock is busy/i);
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

  it("serializes ordinary runtime config.patch against the roll writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configPatch({ agents: {} }, "current", { replacePaths: ["agents.list"] }))
        .rejects.toThrow(/writer lock is busy/i);
      expect(configPatch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("holds the writer lease through awaited config.patch and preserves its arguments and result", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    let resolvePatch: ((value: { ok: true; hash: string }) => void) | undefined;
    const configPatch = vi.fn(() => new Promise<{ ok: true; hash: string }>((resolve) => {
      resolvePatch = resolve;
    }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    const patch = { agents: { list: [] } };
    const opts = { replacePaths: ["agents.list"] };

    try {
      const pending = rpc.configPatch(patch, "current", opts);
      await vi.waitFor(() => expect(configPatch).toHaveBeenCalled());
      await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
        ok: false,
        code: "writer-lock-busy",
      });
      resolvePatch?.({ ok: true, hash: "next" });
      await expect(pending).resolves.toEqual({ ok: true, hash: "next" });
      expect(configPatch).toHaveBeenCalledWith(patch, "current", opts);
      const after = await acquireSystemConfigMutationLease({ openclawDir });
      expect(after.ok).toBe(true);
      if (after.ok) await after.lease.release();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("proves an exact boot candidate only after a fresh revision-scoped runtime observation", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-config-"));
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n');
    const order: string[] = [];
    const configGet = vi.fn(async () => {
      order.push("config-get");
      return { config: { gateway: { mode: "local" } }, hash: "runtime-after" };
    });
    const rpc = {
      configGet,
      channelsStatus: vi.fn(async () => {
        order.push("channels-status");
        return { channels: [] };
      }),
    };
    const candidateHash = "d".repeat(64);
    const verifyControlObjects = vi.fn(() => {
      order.push("remote-controls");
      return { candidateRef: "refs/octogee/system-config/candidate/default-r2" };
    });

    try {
      const result = await proveRevisionSystemConfigCandidate({
        migrationId: "mig-1",
        sourceRevisionId: "default-r1",
        targetRevisionId: "default-r2",
        checkpointCommit: "a".repeat(40),
        freezeObject: "b".repeat(40),
        openclawDir,
        revisionId: "default-r2",
        env: {
          ...rollEnv,
          GATEWAY_IMAGE_TAG: "release-1",
          BUILD_SHA: "build-1",
          OPENCLAW_VERSION: "2026.7.1",
        },
        rpc,
        now: () => 501,
        startedAt: 500,
        bootAccepted: () => true,
        readBootRole: () => ({
          role: "target-candidate",
          migrationId: "mig-1",
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          checkpointCommit: "a".repeat(40),
          freezeObject: "b".repeat(40),
          candidateCommit: "c".repeat(40),
          candidateHash,
          candidateExists: true,
        }),
        hashConfig: () => candidateHash,
        verifyControlObjects,
      });

      expect(order).toEqual(["remote-controls", "config-get", "channels-status"]);
      expect(result).toMatchObject({
        configReady: true,
        observedRevisionId: "default-r2",
        candidateCommit: "c".repeat(40),
        candidateHash,
        targetStartedAt: 500,
        imageTag: "release-1",
        buildSha: "build-1",
        openclawVersion: "2026.7.1",
        provenAt: 501,
        runtimeConfigHash: "runtime-after",
      });
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("rejects proof when the live runtime config differs from the exact candidate", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-config-"));
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, '{"candidate":true}\n');
    const rpc = {
      configGet: vi.fn(async () => ({ config: { stale: true }, hash: "runtime-stale" })),
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    };

    try {
      await expect(proveRevisionSystemConfigCandidate({
        migrationId: "mig-1",
        sourceRevisionId: "default-r1",
        targetRevisionId: "default-r2",
        checkpointCommit: "a".repeat(40),
        freezeObject: "b".repeat(40),
        openclawDir,
        revisionId: "default-r2",
        env: {
          ...rollEnv,
          GATEWAY_IMAGE_TAG: "release-1",
          BUILD_SHA: "build-1",
          OPENCLAW_VERSION: "2026.7.1",
        },
        rpc,
        startedAt: 500,
        bootAccepted: () => true,
        readBootRole: () => ({
          role: "target-candidate",
          migrationId: "mig-1",
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          checkpointCommit: "a".repeat(40),
          freezeObject: "b".repeat(40),
          candidateCommit: "c".repeat(40),
          candidateHash: "d".repeat(64),
          candidateExists: true,
        }),
        hashConfig: () => "d".repeat(64),
        verifyControlObjects: () => ({
          candidateRef: "refs/octogee/system-config/candidate/default-r2",
        }),
      })).rejects.toThrow(/runtime config does not match candidate/i);
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("rejects proof before runtime observation when a remote control ref disappeared", async () => {
    const configGet = vi.fn(async () => ({ config: {}, hash: "runtime" }));
    await expect(proveRevisionSystemConfigCandidate({
      migrationId: "mig-1",
      sourceRevisionId: "default-r1",
      targetRevisionId: "default-r2",
      checkpointCommit: "a".repeat(40),
      freezeObject: "b".repeat(40),
      openclawDir: "/tmp/openclaw",
      revisionId: "default-r2",
      env: {
        ...rollEnv,
        GATEWAY_IMAGE_TAG: "release-1",
        BUILD_SHA: "build-1",
        OPENCLAW_VERSION: "2026.7.1",
      },
      rpc: { configGet, channelsStatus: vi.fn() },
      startedAt: 500,
      bootAccepted: () => true,
      readBootRole: () => ({
        role: "target-candidate",
        migrationId: "mig-1",
        sourceRevisionId: "default-r1",
        targetRevisionId: "default-r2",
        checkpointCommit: "a".repeat(40),
        freezeObject: "b".repeat(40),
        candidateCommit: "c".repeat(40),
        candidateHash: "d".repeat(64),
        candidateExists: true,
      }),
      verifyControlObjects: () => {
        throw new Error("target candidate ref changed");
      },
    })).rejects.toThrow(/candidate ref changed/i);
    expect(configGet).not.toHaveBeenCalled();
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
  it("binds migration operations to the source and target gateways before enqueue", () => {
    expect(buildFleetMigrateOperationInput("uid-alice", "bender", "operator-green")).toEqual({
      uid: "uid-alice",
      fromGatewayId: "bender",
      toGatewayId: "operator-green",
    });
  });

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
