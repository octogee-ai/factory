import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSystemConfigMutationLease,
  acquireSystemConfigShellCapabilitySync,
} from "@octogee/core/system-config-mutation-lease";
import {
  createAssignedFingerprintReader,
  createFleetSystemConfigFlush,
  createSystemConfigMutationGatedRpc,
  resolveFleetControllerEntrypointConfig,
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
  parseFleetArgs,
  resolveFleetCredentialMode,
  resolveFleetDeploymentTarget,
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

  it("uses a snapshot fingerprint roster for operator gateways so post-mount project creation reconverges", async () => {
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
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/shell-active/i);
      expect(configApply).not.toHaveBeenCalled();
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
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      operatorAccess: null,
      ownerUid: null,
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
  it("resolves Firestore and Kubernetes from the active deployment target", () => {
    expect(resolveFleetDeploymentTarget("test")).toEqual({
      projectId: "octogee-test",
      namespace: "octogee-test",
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
