import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_RELOAD_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import {
  createAssignedFingerprintReader,
  createFleetFlushSystemConfigSync,
  createFleetControllerRequestedFlush,
  createFleetSystemConfigVerifyFlush,
  createFleetSystemConfigFlush,
  createFleetControllerMutationGatedRpc,
  createSystemConfigMutationGatedRpc,
  resolveFleetControllerEntrypointConfig,
  FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
  SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS,
} from "../entrypoints/fleet-controller.js";
import {
  ASSIGN_CUSTOMER_GATEWAY_USAGE,
  isBulkAssignmentCandidate,
  parseAssignCustomerGatewayArgs,
  readGatewayProfile,
} from "../ops/assign-customer-gateway.js";
import {
  buildFleetMigrateOperationInput,
  executeFleetAdminMutation,
  executeFleetReleaseMutation,
  executeFleetGatewayMutation,
  parseForceRestartPodList,
  parseFleetArgs,
  releaseStatusRows,
  resolveFleetBuilderMutationRequest,
  resolveFleetBuilderMutation,
  resolveFleetReleaseMutation,
  runForcedGatewayRestart,
  fleetServiceAccountCredential,
  resolveFleetGatewayMutation,
  resolveFleetGatewayRestart,
  resolveFleetVerb,
  resolveFleetCredentialMode,
  resolveFleetDeploymentTarget,
  resolveExplicitFleetOperatorUid,
  resolveFleetOperatorUidFromUserConfigs,
} from "../ops/fleet.js";

describe("fleet-controller entrypoint config", () => {
  it("reports the complete gateway image tag instead of its ambiguous build SHA", () => {
    expect(resolveFleetControllerEntrypointConfig({
      BUILD_SHA: "abc1234",
      GATEWAY_IMAGE_TAG: "abc1234-oc2026.7.1",
    }, { gatewayId: "gw-1" })).toMatchObject({
      version: "abc1234-oc2026.7.1",
    });
  });

  it("uses a snapshot fingerprint roster for Builder gateways so post-mount project creation reconverges", async () => {
    const snapshot = {
      uid: "u1",
      slug: "alice",
      channels: [],
      projects: [
        { projectSlug: "launchroom", giteaRepoName: "launchroom", provisioningState: "active" },
      ],
      projectAgents: [],
      coachToken: "pat",
      coachMmUserId: "coach",
      customerMmUserId: "customer",
      tier: "paid",
    } as never;
    const assignedUsers = vi.fn(async () => [snapshot]);
    const seed = vi.fn();

    const read = createAssignedFingerprintReader({ assignedUsers }, seed);
    const fingerprints = await read();

    expect([...fingerprints.keys()]).toEqual(["alice"]);
    expect(fingerprints.get("alice")).toMatch(/^[0-9a-f]{16}$/);
    expect(seed).toHaveBeenCalledWith(snapshot);
    expect(assignedUsers).toHaveBeenCalledWith({ completeOnly: false });
  });

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

  it("converges to the controller-pinned remote config commit inside the durable checkpoint", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const acceptedCommit = "b".repeat(40);
    const sync = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit,
    }));
    const flush = createFleetSystemConfigFlush(
      "alice",
      () => {},
      sync,
      expectedSystemConfigCommit,
    );

    await expect(flush?.()).resolves.toEqual({ acceptedCommit });
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      expectedRemoteCommit: expectedSystemConfigCommit,
      source: "migration-checkpoint",
    }));
  });

  it("verifies the accepted remote system config commit for a dedicated builder pod", async () => {
    const acceptedCommit = "a".repeat(40);
    const readAcceptedCommit = vi.fn(() => acceptedCommit);
    const flush = createFleetSystemConfigVerifyFlush(
      "alice",
      undefined,
      readAcceptedCommit,
    );

    await expect(flush()).resolves.toEqual({ acceptedCommit });
    expect(readAcceptedCommit).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it("rejects a dedicated target whose durable system config commit drifted during migration", async () => {
    const expectedCommit = "a".repeat(40);
    const observedCommit = "b".repeat(40);
    const flush = createFleetSystemConfigVerifyFlush(
      "alice",
      expectedCommit,
      () => observedCommit,
    );

    await expect(flush()).rejects.toThrow(
      `durable system config head changed: expected ${expectedCommit}, observed ${observedCommit}`,
    );
  });

  it("skips the migration durable-config step on a shared pod, whose builders have no system_config repo", () => {
    const readAcceptedCommit = vi.fn();
    const sync = createFleetFlushSystemConfigSync({
      slug: "aug04",
      builderSlug: "",
      builder: false,
      readAcceptedCommit,
    });

    expect(sync).toBeUndefined();
    expect(readAcceptedCommit).not.toHaveBeenCalled();
  });

  it("rejects a converge fence commit sent to a pod that holds no durable config", () => {
    expect(() => createFleetFlushSystemConfigSync({
      slug: "aug04",
      builderSlug: "",
      builder: false,
      expectedSystemConfigCommit: "a".repeat(40),
    })).toThrow("no durable system config");
  });

  it("verifies the durable head for a dedicated builder pod flush", async () => {
    const acceptedCommit = "c".repeat(40);
    const readAcceptedCommit = vi.fn(() => acceptedCommit);
    const sync = createFleetFlushSystemConfigSync({
      slug: "alice",
      builderSlug: "alice",
      builder: false,
      readAcceptedCommit,
    });

    await expect(sync?.()).resolves.toEqual({ acceptedCommit });
    expect(readAcceptedCommit).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it("checkpoints the durable config for an operator pod flush", async () => {
    const acceptedCommit = "d".repeat(40);
    const checkpointSync = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit,
    }));
    const sync = createFleetFlushSystemConfigSync({
      slug: "bender",
      builderSlug: "bender",
      builder: true,
      log: () => {},
      sync: checkpointSync as never,
    });

    await expect(sync?.()).resolves.toEqual({ acceptedCommit });
    expect(checkpointSync).toHaveBeenCalledWith("bender", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });

  it("uses only the expected config checkpoint for target migration convergence", async () => {
    const syncWorkspaces = vi.fn(async () => undefined);
    const syncBlobs = vi.fn(async () => undefined);
    const expectedSystemConfigCommit = "a".repeat(40);
    const syncSystemConfig = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: expectedSystemConfigCommit,
    }));
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "builder",
      builderSlug: "alice",
      builder: true,
      syncWorkspaces,
      syncBlobs,
      syncSystemConfig,
      log: () => {},
    });

    const result = await flush({
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    });

    expect(result.ok).toBe(true);
    expect(result.systemConfigCommit).toBe(expectedSystemConfigCommit);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workspace-git", status: "skipped" }),
      expect.objectContaining({ name: "blob-sync", status: "skipped" }),
      expect.objectContaining({ name: "system-config", status: "done" }),
    ]));

    expect(syncWorkspaces).not.toHaveBeenCalled();
    expect(syncBlobs).not.toHaveBeenCalled();
    expect(syncSystemConfig).toHaveBeenCalledWith("alice", expect.objectContaining({
      expectedRemoteCommit: expectedSystemConfigCommit,
      source: "migration-checkpoint",
    }));
  });

  it("retains strict workspace durability for a final migration flush", async () => {
    const syncWorkspaces = vi.fn(async () => { throw new Error("workspace push failed"); });
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "builder",
      builderSlug: "alice",
      builder: true,
      syncWorkspaces,
      syncSystemConfig: vi.fn(() => ({
        committed: true,
        pushed: true,
        acceptedCommit: "a".repeat(40),
      })),
      log: () => {},
    });

    const result = await flush({ slug: "alice", reason: "migration-final" });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "workspace-git",
        status: "failed",
        error: "workspace push failed",
      }),
    ]));
    expect(syncWorkspaces).toHaveBeenCalledOnce();
  });

  it("rejects an unpinned migration convergence request before it can sync", async () => {
    const syncWorkspaces = vi.fn(async () => undefined);
    const syncSystemConfig = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "a".repeat(40),
    }));
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "builder",
      builderSlug: "alice",
      builder: true,
      syncWorkspaces,
      syncSystemConfig,
      log: () => {},
    });

    await expect(flush({ slug: "alice", reason: "migration-converge" }))
      .rejects.toThrow("migration converge is missing expected system config commit");
    expect(syncWorkspaces).not.toHaveBeenCalled();
    expect(syncSystemConfig).not.toHaveBeenCalled();
  });

  it("ignores a leftover roll-era freeze marker — identity-pure mutation (GATEWAY-SIMPLE-ROLL-SPEC)", async () => {
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
      await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
      expect(configApply).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("budgets its connect for a config reload while retaining the provisioning mutation gate", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-timeout-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const createRpc = vi.fn(() => ({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    }));
    const rpc = createFleetControllerMutationGatedRpc(openclawDir, createRpc as never);
    try {
      expect(FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS).toBe(120_000);
      expect(createRpc).toHaveBeenCalledWith({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
        connectTimeoutMs: CONFIG_RELOAD_DEADLINE_MS,
      });
      await expect(rpc.configPatch({ agents: {} }, "current"))
        .resolves.toEqual({ ok: true, hash: "next" });
      expect(configPatch).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("serializes ordinary runtime config.apply against the local writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir, { wait: async () => undefined });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer-lock-busy/i);
      expect(configApply).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("retries a transient writer lock within a fixed acquisition budget", async () => {
    const release = vi.fn(async () => undefined);
    const acquireLease = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" })
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" })
      .mockResolvedValueOnce({ ok: true, lease: { release } });
    const wait = vi.fn(async () => undefined);
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
    expect(acquireLease).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [750]]);
    expect(configApply).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("allows a five-second auto-push overlap within a finite writer-lock acquisition window", async () => {
    let elapsedMs = 0;
    const release = vi.fn(async () => undefined);
    const acquireLease = vi.fn(async () => elapsedMs >= 5_000
      ? { ok: true as const, lease: { release } }
      : { ok: false as const, code: "writer-lock-busy" as const });
    const wait = vi.fn(async (delayMs: number) => {
      elapsedMs += delayMs;
    });
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
    expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(elapsedMs).toBeLessThanOrEqual(10_000);
    expect(configApply).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("stops retrying a writer lock after the bounded eight-second acquisition window", async () => {
    const acquireLease = vi.fn(async () => ({ ok: false as const, code: "writer-lock-busy" as const }));
    const wait = vi.fn(async () => undefined);
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer-lock-busy/i);
    expect(acquireLease).toHaveBeenCalledTimes(
      SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.length + 1,
    );
    expect(wait.mock.calls).toEqual(
      SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.map((delayMs) => [delayMs]),
    );
    expect(SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.reduce(
      (totalMs, delayMs) => totalMs + delayMs,
      0,
    )).toBe(8_000);
    expect(configApply).not.toHaveBeenCalled();
  });

  it("serializes ordinary runtime config.patch against the local writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir, { wait: async () => undefined });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configPatch({ agents: {} }, "current", { replacePaths: ["agents.list"] }))
        .rejects.toThrow(/writer-lock-busy/i);
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

});

describe("assign-customer-gateway root config", () => {
  function gatewayRoot(profile: "standard" | "builder" = "standard") {
    const builder = profile === "builder";
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
      gatewayClass: builder ? "builder" : "shared",
      imageProfile: builder ? "builder" : "standard",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      builderAccess: null,
      ownerUid: builder ? "uid-builder" : null,
      builderSlug: builder ? "builder" : null,
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
      readGatewayProfile(db({ "gateways/default": gatewayRoot("builder") }) as never, "default"),
    ).resolves.toBe("builder");
    await expect(
      readGatewayProfile(
        db({ "glmGateways/default": { profile: "builder" } }) as never,
        "default",
      ),
    ).resolves.toBeNull();
  });
});

describe("fleet force gateway restart", () => {
  function durableGatewayRoot(gatewayId = "canary") {
    return {
      gatewayId,
      createdAt: 1,
      createdBy: "test",
      updatedAt: 1,
      updatedBy: "test",
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      profile: "standard",
      gatewayClass: "shared",
      imageProfile: "standard",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      builderAccess: null,
      ownerUid: null,
      builderSlug: null,
      openclawOverrides: null,
      modelBrokerLimits: null,
      preemption: null,
    };
  }

  function forceRestartHarness(overrides: {
    maintenance?: Record<string, unknown>;
    selector?: unknown;
    reread?: unknown;
    afterExactPodRead?: (documents: Map<string, Record<string, unknown>>) => void;
    deleteResult?: { status: number | null; stdout: string; stderr: string };
  } = {}) {
    const documents = new Map<string, Record<string, unknown>>([
      ["config/glmMaintenance", overrides.maintenance ?? { mode: "open" }],
      ["gateways/canary", durableGatewayRoot()],
      ["glmOperations/audit-force-restart", {
        status: "in-progress",
        actionClaimId: "claim-force-restart",
        target: { gatewayId: "canary" },
      }],
    ]);
    const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
    const ref = (path: string) => ({
      id: path.split("/").at(-1)!,
      path,
      get: async () => ({
        exists: documents.has(path),
        id: path.split("/").at(-1)!,
        data: () => documents.get(path),
      }),
    });
    const db = {
      doc: ref,
      collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
      runTransaction: async <T>(body: (transaction: {
        get: (target: ReturnType<typeof ref>) => Promise<Awaited<ReturnType<typeof target.get>>>;
        update: (target: ReturnType<typeof ref>, data: Record<string, unknown>) => void;
      }) => Promise<T>) => body({
        get: (target) => target.get(),
        update: (target, data) => {
          documents.set(target.path, { ...documents.get(target.path), ...data });
          writes.push({ path: target.path, data });
        },
      }),
    };
    const selector = overrides.selector ?? {
      items: [{ metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } }],
    };
    const reread = overrides.reread ?? {
      metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" },
    };
    const kubectl = vi.fn((argv: string[], input?: string) => {
      if (argv.includes("pods")) return { status: 0, stdout: JSON.stringify(selector), stderr: "" };
      if (argv.includes("get")) {
        overrides.afterExactPodRead?.(documents);
        return { status: 0, stdout: JSON.stringify(reread), stderr: "" };
      }
      if (argv.includes("delete")) {
        expect(input).toBe(JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: "pod-uid-1" },
        }));
        return overrides.deleteResult ??
          { status: 0, stdout: "pod deleted", stderr: "" };
      }
      throw new Error(`unexpected kubectl args: ${argv.join(" ")}`);
    });
    const runMutation = vi.fn(async <T>(input: {
      actor: string;
      forced: boolean;
      idempotencyKey?: string;
      action: (claim: { auditId: string; claimId: string }) => Promise<T>;
    }) => input.action({ auditId: "audit-force-restart", claimId: "claim-force-restart" }));
    return { db, documents, writes, kubectl, runMutation };
  }

  it("maps a normal restart to the journaled Admin API route", () => {
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--idempotency-key=restart-canary",
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/canary/restart",
      idempotencyKey: "restart-canary",
    });
  });

  it("accepts only the exact restart grammar", () => {
    expect(resolveFleetGatewayRestart(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--force", "--apply",
      "--idempotency-key=restart-canary",
    ]))).toEqual({
      gatewayId: "canary",
      force: true,
      apply: true,
      idempotencyKey: "restart-canary",
    });

    for (const argv of [
      ["--env=test", "gw", "restart", "canary", "unexpected"],
      ["--env=test", "gw", "restart", "canary", "--unknown"],
      ["--env=test", "gw", "restart", "canary", "--force=true"],
      ["--env=test", "gw", "restart", "canary", "--apply=true"],
      ["--env=test", "gw", "restart", "canary", "--idempotency-key"],
      ["--env=test", "gw", "restart", "canary", "--idempotency-key="],
    ]) {
      expect(() => resolveFleetGatewayRestart(parseFleetArgs(argv))).toThrow();
    }
  });

  it("requires exactly one fresh pod with a durable UID for a forced restart", () => {
    expect(parseForceRestartPodList(JSON.stringify({
      items: [{ metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } }],
    }), "canary")).toEqual({ name: "octogee-gateway-canary-a", uid: "pod-uid-1" });

    expect(() => parseForceRestartPodList(JSON.stringify({ items: [] }), "canary"))
      .toThrow("expected exactly one pod");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [
        { metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } },
        { metadata: { name: "octogee-gateway-canary-b", uid: "pod-uid-2" } },
      ],
    }), "canary")).toThrow("expected exactly one pod");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [{ metadata: { name: "octogee-gateway-canary-a" } }],
    }), "canary")).toThrow("missing metadata.uid");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [{
        metadata: {
          name: "octogee-gateway-canary-a",
          uid: "pod-uid-1",
          deletionTimestamp: "2026-07-28T04:00:00Z",
        },
      }],
    }), "canary")).toThrow("is already terminating");
  });

  it("journals and performs a forced restart against only the selected pod identity", async () => {
    const { db, documents, writes, kubectl, runMutation } = forceRestartHarness();

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      idempotencyKey: "restart-canary-force",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).resolves.toEqual({
      auditId: "audit-force-restart",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });

    expect(runMutation).toHaveBeenCalledWith(expect.objectContaining({
      actor: "operator",
      forced: true,
      idempotencyKey: "restart-canary-force",
      mutation: { kind: "restart-gateway", gatewayId: "canary", mode: "force-pod-delete" },
    }));
    expect(documents.get("gateways/canary")).toMatchObject({
      managedBy: "operator",
      updatedAt: 1234,
      updatedBy: "operator",
    });
    expect(documents.get("glmOperations/audit-force-restart")?.target).toEqual({
      gatewayId: "canary",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });
    expect(writes.map((write) => write.path)).toEqual([
      "gateways/canary",
      "glmOperations/audit-force-restart",
    ]);
    expect(kubectl.mock.calls.map(([argv]) => argv)).toEqual([
      [
        "--context", "gke_octogee_us-central1_octogee-gateway",
        "-n", "octogee-test",
        "get", "pods",
        "-l", "app=octogee-gateway,gateway-instance=canary",
        "-o", "json",
      ],
      [
        "--context", "gke_octogee_us-central1_octogee-gateway",
        "-n", "octogee-test",
        "get", "pod", "octogee-gateway-canary-a",
        "-o", "json",
      ],
      [
        "--context", "gke_octogee_us-central1_octogee-gateway",
        "-n", "octogee-test",
        "delete",
        "--raw=/api/v1/namespaces/octogee-test/pods/octogee-gateway-canary-a",
        "-f", "-",
      ],
    ]);
  });

  it("fails before delete when the exact pod name now has a different UID", async () => {
    const { db, documents, kubectl, runMutation } = forceRestartHarness({
      reread: { metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-2" } },
    });

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("pod UID changed");

    expect(kubectl).toHaveBeenCalledTimes(2);
    expect(documents.get("glmOperations/audit-force-restart")?.target).toEqual({
      gatewayId: "canary",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });
  });

  it("rejects an exact pod that entered termination after selection", async () => {
    const { db, kubectl, runMutation } = forceRestartHarness({
      reread: {
        metadata: {
          name: "octogee-gateway-canary-a",
          uid: "pod-uid-1",
          deletionTimestamp: "2026-07-28T04:00:00Z",
        },
      },
    });

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("is already terminating");

    expect(kubectl).toHaveBeenCalledTimes(2);
  });

  it("rechecks the maintenance gate in the forced lifecycle transaction", async () => {
    const { db, documents, kubectl, runMutation } = forceRestartHarness({
      maintenance: { mode: "frozen", reason: "operator freeze" },
    });

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("maintenance freeze blocks fleet mutation: operator freeze");

    expect(kubectl).not.toHaveBeenCalled();
    expect(documents.get("gateways/canary")?.managedBy).toBeUndefined();
  });

  it.each([
    ["maintenance freeze", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("config/glmMaintenance", { mode: "frozen", reason: "late freeze" });
    }, "maintenance freeze blocks fleet mutation: late freeze"],
    ["gateway retirement", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("gateways/canary", {
        ...documents.get("gateways/canary")!,
        desiredStatus: "retired",
      });
    }, "cannot force restart a retired gateway: canary"],
    ["operator ownership loss", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("gateways/canary", {
        ...documents.get("gateways/canary")!,
        managedBy: "cowboy",
      });
    }, "gateway canary is no longer operator-managed"],
    ["audit target drift", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("glmOperations/audit-force-restart", {
        ...documents.get("glmOperations/audit-force-restart")!,
        target: { gatewayId: "canary", podName: "octogee-gateway-canary-a", podUid: "other-uid" },
      });
    }, "force restart audit audit-force-restart is not owned by this action"],
    ["audit target expansion", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("glmOperations/audit-force-restart", {
        ...documents.get("glmOperations/audit-force-restart")!,
        target: {
          gatewayId: "canary",
          podName: "octogee-gateway-canary-a",
          podUid: "pod-uid-1",
          unexpected: true,
        },
      });
    }, "force restart audit audit-force-restart is not owned by this action"],
  ])("does not delete when %s lands after the UID re-read", async (_name, afterExactPodRead, error) => {
    const { db, kubectl, runMutation } = forceRestartHarness({ afterExactPodRead });

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow(error);

    expect(kubectl).toHaveBeenCalledTimes(2);
  });

  it("binds the delete to the audited UID when replacement lands after the final fence", async () => {
    const { db, kubectl, runMutation } = forceRestartHarness({
      deleteResult: {
        status: 1,
        stdout: "",
        stderr: "409 Conflict: UID precondition failed",
      },
    });

    await expect(runForcedGatewayRestart({
      db: db as never,
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("409 Conflict: UID precondition failed");

    expect(kubectl).toHaveBeenCalledTimes(3);
    expect(kubectl.mock.calls[2]?.[1]).toBe(JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: "pod-uid-1" },
    }));
  });
});

describe("fleet CLI args", () => {
  it("resolves Firestore and Kubernetes from the active deployment target", () => {
    expect(resolveFleetDeploymentTarget("test")).toEqual({
      projectId: "octogee-test",
      namespace: "octogee-test",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
    });
    expect(resolveFleetDeploymentTarget("prod")).toEqual({
      projectId: "octogee",
      namespace: "octogee",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
    });
  });

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

  it("accepts release status as an unforced read verb", () => {
    const statusArgs = parseFleetArgs(["--env=test", "release", "status"]);

    expect(statusArgs).toEqual({
      env: "test",
      positional: ["release", "status"],
      flags: {},
    });
    expect(resolveFleetVerb(statusArgs)).toMatchObject({
      verb: "release status",
      writes: false,
    });
    expect(resolveFleetCredentialMode(statusArgs)).toBe("service-account-key");
    expect(
      resolveFleetCredentialMode(statusArgs, {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/wif-credentials.json",
      }),
    ).toBe("application-default");
  });

  it("uses a service-account credential supplied through application-default configuration as a local signer", () => {
    expect(fleetServiceAccountCredential({
      type: "service_account",
      client_email: "fleet@test.iam.gserviceaccount.com",
      private_key: "private-key",
    }, "octogee-test")).toEqual({
      projectId: "octogee-test",
      clientEmail: "fleet@test.iam.gserviceaccount.com",
      privateKey: "private-key",
    });
    expect(fleetServiceAccountCredential({ type: "external_account" }, "octogee-test")).toBeNull();
  });

  it("maps normal CENTRAL release commands to journaled Admin API requests with deterministic idempotency keys", () => {
    const sourceSha = "a".repeat(40);
    expect(resolveFleetReleaseMutation(
      parseFleetArgs(["--env=test", "release", "cut", "v0.4.0", `--sha=${sourceSha}`]),
    )).toEqual({
      method: "POST",
      path: "/api/admin/releases/cut",
      body: { version: "v0.4.0", sourceSha },
      idempotencyKey: `release-cut:v0.4.0:${sourceSha}:shared`,
    });
    expect(resolveFleetReleaseMutation(
      parseFleetArgs(["--env=test", "release", "cut", "v0.4.0", `--sha=${sourceSha}`, "--gateway-scope=all"]),
    )).toEqual({
      method: "POST",
      path: "/api/admin/releases/cut",
      body: { version: "v0.4.0", sourceSha, gatewayScope: "all" },
      idempotencyKey: `release-cut:v0.4.0:${sourceSha}:all`,
    });
    expect(resolveFleetReleaseMutation(
      parseFleetArgs(["--env=prod", "release", "promote", "v0.4.0", `--sha=${sourceSha}`]),
    )).toEqual({
      method: "POST",
      path: "/api/admin/releases/v0.4.0/promote",
      body: { sourceSha },
      idempotencyKey: `release-promote:v0.4.0:${sourceSha}`,
    });
  });

  it("uses the sole enabled Firestore admin only as the unspecified-actor fallback", () => {
    expect(resolveFleetOperatorUidFromUserConfigs([
      { uid: "builder", role: "builder", disabled: false },
      { uid: "retired-operator", role: "admin", disabled: true },
      { uid: "operator", role: "admin", disabled: false },
    ])).toBe("operator");
    expect(() => resolveFleetOperatorUidFromUserConfigs([])).toThrow(/found 0/);
    expect(() => resolveFleetOperatorUidFromUserConfigs([
      { uid: "operator-a", role: "admin", disabled: false },
      { uid: "operator-b", role: "admin", disabled: false },
    ])).toThrow(/found 2/);
  });

  it("accepts an explicit enabled admin when other active admins exist", () => {
    expect(resolveExplicitFleetOperatorUid({
      uid: "operator-selected-by-email",
      role: "admin",
      disabled: false,
    })).toBe("operator-selected-by-email");
    expect(() => resolveExplicitFleetOperatorUid({
      uid: "retired-operator",
      role: "admin",
      disabled: true,
    })).toThrow(/disabled/);
    expect(() => resolveExplicitFleetOperatorUid({
      uid: "builder",
      role: "builder",
      disabled: false,
    })).toThrow(/admin role/);
  });

  it("preserves an explicit release idempotency key over its deterministic default", () => {
    expect(resolveFleetReleaseMutation(
      parseFleetArgs([
        "--env=test",
        "release",
        "cut",
        "v0.4.0",
        "--sha=" + "a".repeat(40),
        "--idempotency-key=operator-retry",
      ]),
    )).toMatchObject({ idempotencyKey: "operator-retry" });
  });

  it("rejects duplicate flags and non-semver release versions", () => {
    expect(() => parseFleetArgs([
      "--env=test",
      "release",
      "cut",
      "v0.4.0",
      "--sha=" + "a".repeat(40),
      "--sha=" + "b".repeat(40),
    ])).toThrow("duplicate --sha flag");
    expect(() => parseFleetArgs([
      "--env=test",
      "--env=prod",
      "release",
      "cut",
      "v0.4.0",
    ])).toThrow("duplicate --env flag");
    for (const version of ["v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3-01", "v1.2.3-alpha.01"]) {
      expect(() => resolveFleetReleaseMutation(
        parseFleetArgs(["--env=test", "release", "cut", version, "--sha=" + "a".repeat(40)]),
      )).toThrow("release cut requires a v-prefixed semantic version");
    }
  });

  it("keeps release mutations dry-run by default and sends exactly one Admin API request with --apply", async () => {
    const request = vi.fn(async () => ({ release: 2 }));
    const mutation = resolveFleetReleaseMutation(
      parseFleetArgs(["--env=test", "release", "cut", "v0.4.0", "--sha", "a".repeat(40)]),
    );

    await expect(executeFleetReleaseMutation({ request }, mutation, false)).resolves.toEqual({
      applied: false,
      response: null,
    });
    expect(request).not.toHaveBeenCalled();
    await expect(executeFleetReleaseMutation({ request }, mutation, true)).resolves.toEqual({
      applied: true,
      response: { release: 2 },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects release commands outside their CENTRAL environment and never derives a version from git tags", () => {
    expect(() => resolveFleetReleaseMutation(
      parseFleetArgs(["--env=prod", "release", "cut", "v0.4.0", "--sha=" + "a".repeat(40)]),
    )).toThrow("release cut requires --env=test");
    expect(() => resolveFleetReleaseMutation(
      parseFleetArgs(["--env=test", "release", "promote", "v0.4.0"]),
    )).toThrow("release promote requires --env=prod");
    expect(() => resolveFleetReleaseMutation(
      parseFleetArgs(["--env=test", "release", "cut", "v0.4.0", "--sha=deadbeef"]),
    )).toThrow("release cut requires a full lowercase --sha");
    expect(() => resolveFleetReleaseMutation(
      parseFleetArgs(["--env=prod", "release", "promote", "v0.4.0"]),
    )).toThrow("release promote requires a full lowercase --sha");
    expect(() => resolveFleetReleaseMutation(
      parseFleetArgs(["--env=prod", "release", "promote", "v0.4.0", "--sha=deadbeef"]),
    )).toThrow("release promote requires a full lowercase --sha");
  });

  it("renders the raw Cowboy lifecycle alongside release and heartbeat observations", () => {
    expect(releaseStatusRows({
      defaultGatewayId: "default",
      defaultSelection: "selected",
      gateways: [{
        gatewayId: "default",
        isDefault: true,
        desiredStatus: "running",
        desiredRelease: 4,
        liveRelease: 3,
        desiredImageTag: "abc1234-oc2026.7.1",
        runtimeRelease: 3,
        runtimeLifecycle: "reconciling",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: 1_000,
        observation: "rolling",
      }],
    })).toEqual([{
      gatewayId: "default",
      default: "*",
      desired: 4,
      live: 3,
      runtime: 3,
      lifecycle: "reconciling",
      heartbeat: "ready",
      heartbeatAt: "1970-01-01T00:00:01.000Z",
      tag: "abc1234-oc2026.7.1",
      version: "abc1234-oc2026.7.1",
      status: "rolling",
    }]);
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
        parseFleetArgs([
          "--env=prod",
          "builder",
          "evict",
          "alice",
          "--to=canary",
          "--apply",
        ]),
      ),
    ).toBe("service-account-key");

    expect(
      resolveFleetCredentialMode(
        parseFleetArgs(["--env=prod", "migrate-customer", "alice", "--to=canary"]),
      ),
    ).toBe("service-account-key");

    expect(
      resolveFleetCredentialMode(
        parseFleetArgs([
          "--env=test",
          "release",
          "cut",
          "v0.6.8",
          `--sha=${"a".repeat(40)}`,
          "--apply",
        ]),
        { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/wif-credentials.json" },
      ),
    ).toBe("application-default");
  });

  it("uses the environment service-account key to sign Admin API tokens", () => {
    expect(
      resolveFleetCredentialMode(
        parseFleetArgs(["--env=prod", "gw", "park", "canary", "--apply"]),
      ),
    ).toBe("service-account-key");
  });

  it("parses normal gateway mutations through the gw command family", () => {
    const args = parseFleetArgs([
      "--env=test",
      "gw",
      "add",
      "--gateway-id=canary",
      "--image-tag=abc1234",
      "--gateway-class=shared",
      "--idempotency-key=add-canary",
    ]);

    expect(resolveFleetVerb(args)).toMatchObject({ verb: "gw add", writes: true });
    expect(resolveFleetGatewayMutation(args)).toEqual({
      method: "POST",
      path: "/api/admin/gateways",
      body: {
        gatewayId: "canary",
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
      idempotencyKey: "add-canary",
    });
  });

  it("treats gw list and inspect as aliases for the existing read commands", () => {
    expect(resolveFleetVerb(parseFleetArgs(["--env=test", "gw", "ls"]))).toMatchObject({
      verb: "gw ls",
      writes: false,
    });
    expect(resolveFleetVerb(parseFleetArgs([
      "--env=test", "gw", "inspect", "canary",
    ]))).toMatchObject({
      verb: "gw inspect",
      writes: false,
    });
  });

  it("maps each existing Admin gateway action to its API request", () => {
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "roll", "canary", "--image-tag=abc1234",
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/canary/rollout",
      body: { imageTag: "abc1234" },
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary",
    ]))).toEqual({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { desiredStatus: "paused" },
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "retire", "canary",
    ]))).toEqual({
      method: "DELETE",
      path: "/api/admin/gateways/canary",
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "override", "canary",
    ]))).toEqual({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { managedBy: "operator" },
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "release-to-cowboy", "canary",
    ]))).toEqual({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { managedBy: "cowboy" },
    });
  });

  it("parses Builder placement intents without writing directly to Firestore", () => {
    expect(resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice", "--to=canary",
    ]))).toEqual({
      kind: "evict",
      slug: "alice",
      target: { kind: "gateway", gatewayId: "canary" },
    });
    expect(resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice", "--park",
    ]))).toEqual({
      kind: "evict",
      slug: "alice",
      target: { kind: "park" },
    });
    expect(resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "place", "alice",
    ]))).toEqual({ kind: "place", slug: "alice" });
  });

  it("maps Builder placement intents to the Admin desired-state request", () => {
    expect(resolveFleetBuilderMutationRequest(
      resolveFleetBuilderMutation(parseFleetArgs([
        "--env=test", "builder", "evict", "alice", "--to=canary", "--idempotency-key=move-alice",
      ])),
      "uid/alice",
      "move-alice",
    )).toEqual({
      method: "PATCH",
      path: "/api/admin/customers/uid%2Falice/placement",
      body: { managedBy: "operator", gatewayId: "canary" },
      idempotencyKey: "move-alice",
    });
    expect(resolveFleetBuilderMutationRequest(
      resolveFleetBuilderMutation(parseFleetArgs([
        "--env=test", "builder", "evict", "alice", "--park",
      ])),
      "uid-alice",
    )).toEqual({
      method: "PATCH",
      path: "/api/admin/customers/uid-alice/placement",
      body: { managedBy: "operator", gatewayId: null },
    });
    expect(resolveFleetBuilderMutationRequest(
      resolveFleetBuilderMutation(parseFleetArgs([
        "--env=test", "builder", "place", "alice",
      ])),
      "uid-alice",
    )).toEqual({
      method: "PATCH",
      path: "/api/admin/customers/uid-alice/placement",
      body: { managedBy: "cowboy" },
    });
  });

  it("submits an applied Builder intent once and returns the desired-state response", async () => {
    const request = vi.fn(async () => ({ operationId: "migrate-alice" }));
    const mutation = resolveFleetBuilderMutationRequest(
      resolveFleetBuilderMutation(parseFleetArgs([
        "--env=test", "builder", "evict", "alice", "--to=canary",
      ])),
      "uid-alice",
    );

    await expect(executeFleetAdminMutation({ request }, mutation, true)).resolves.toEqual({
      applied: true,
      response: { operationId: "migrate-alice" },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(mutation);
  });

  it("rejects ambiguous Builder eviction targets and invalid gateway ids", () => {
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice", "--to=canary", "--park",
    ]))).toThrow("builder evict accepts exactly one of --to=<gw-id> or --park");
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice",
    ]))).toThrow("builder evict requires exactly one of --to=<gw-id> or --park");
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice", "--to=a/../b",
    ]))).toThrow("builder evict received an invalid gateway id: a/../b");
  });

  it("rejects placement targets from builder place", () => {
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "place", "alice", "--to=canary",
    ]))).toThrow("builder place does not accept --to or --park");
  });

  it("rejects ignored Builder arguments, flags, and empty idempotency keys", () => {
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "evict", "alice", "accidental", "--to=canary",
    ]))).toThrow("builder evict accepts exactly one <slug>");
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "place", "alice", "--gateway=other",
    ]))).toThrow("builder place does not accept --gateway");
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "place", "alice", "--idempotency-key",
    ]))).toThrow("builder place requires --idempotency-key=<key>");
    expect(() => resolveFleetBuilderMutation(parseFleetArgs([
      "--env=test", "builder", "place", "alice", "--apply=true",
    ]))).toThrow("builder place accepts --apply without a value");
  });

  it("rejects incomplete gateway mutation input before any request", () => {
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "roll", "canary",
    ]))).toThrow("gw roll requires --image-tag=<tag>");
  });

  it("rejects cross-environment image repositories and unsafe gateway paths", () => {
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test",
      "gw",
      "add",
      "--gateway-id=canary",
      "--image-tag=abc1234",
      "--image-repository=us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    ]))).toThrow("gw add requires the selected environment repository");

    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "a/../b",
    ]))).toThrow("gw park received an invalid gateway id");
  });

  it("does not make a normal gateway mutation request without --apply", async () => {
    const request = vi.fn(async () => ({ operationId: "op-1" }));
    const mutation = resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary",
    ]));

    await expect(executeFleetGatewayMutation({ request }, mutation, false)).resolves.toEqual({
      applied: false,
      response: null,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("executes the normal gateway mutation through the Admin API with --apply", async () => {
    const request = vi.fn(async () => ({ gatewayId: "canary", updated: ["desiredStatus"] }));
    const mutation = resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary", "--idempotency-key=park-canary",
    ]));

    await expect(executeFleetGatewayMutation({ request }, mutation, true)).resolves.toEqual({
      applied: true,
      response: { gatewayId: "canary", updated: ["desiredStatus"] },
    });
    expect(request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { desiredStatus: "paused" },
      idempotencyKey: "park-canary",
    });
  });
});
