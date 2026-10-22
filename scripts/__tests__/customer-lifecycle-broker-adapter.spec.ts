import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import {
  buildBrokeredLifecycleAdapter,
  projectCheckoutScopeForRuntime,
  waitForAppliedConfigRevision,
} from "../lib/customer-lifecycle-broker-adapter.js";
import { OPENCLAW_CONFIG } from "../lib/config.js";
import { OpenclawWireError, type GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  applyConfigPatch,
  customerConfigFullAgentListReplacePaths,
  customerConfigReplacePaths,
} from "../lib/apply-config-patch.js";
import {
  SAFE_DEFAULT_AGENT_ID,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingSecretId,
} from "../lib/openclaw-config-builders.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import { snapshotConfigFingerprint } from "../lib/snapshot-fingerprint.js";
import {
  applyConfigPatch as realApplyConfigPatch,
  mergePatchValueAlreadyApplied,
} from "@octogee/core/apply-config-patch";
import { applyAgentModelOverrides, customerOauthRuntimeConfigPatch, platformModelAllowlistPatch } from "@octogee/core/byot-sync-runtime";
import { canonicalCustomerModelDefinition } from "../../shared/types/agent-models.js";
import { _resetBrokerProfileLogStateForTests, createReconcileConvergenceHooks, finalizeConvergedMount, materializeDeferredBrokerProfiles } from "../lib/fleet-provisioner.js";
import { saveAppliedFingerprints } from "../lib/applied-fingerprint-store.js";
import { openClawRuntimeUpdateGuard } from "../lib/openclaw-runtime-update-guard.js";
import { clearBuilderClaim, stubBuilderClaim, withBuilderClaim } from "./helpers/builder-claim.js";
import { mattermostAccountSecretRef } from "../lib/mattermost-account-secrets.js";

describe("migration manifest export runtime wait", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for a 115-second competing publication before exporting its manifest", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    const publishing = openClawRuntimeUpdateGuard.run(async () => undefined, { holdUntil: custody });
    await publishing;
    const manifest = { slug: "alice", appliedFingerprint: "stable-after-publication" };
    secretMocks.exportActivationManifestWithSecret.mockClear();
    secretMocks.exportActivationManifestWithSecret.mockResolvedValueOnce(manifest);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    const exported = adapter.exportOpenClawActivationManifest!("alice", { timeoutMs: 330_000 }).then((value) => value, (error) => error);
    try {
      await vi.advanceTimersByTimeAsync(115_000);
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally { release(); }
    await expect(exported).resolves.toEqual(manifest);
    expect(secretMocks.exportActivationManifestWithSecret).toHaveBeenCalledOnce();
  });

  it.each(["deadline", "disconnect"])("cancels a queued export on %s without releasing publication custody", async (reason) => {
    vi.useFakeTimers();
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { holdUntil: custody });
    secretMocks.exportActivationManifestWithSecret.mockClear();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    const controller = new AbortController();
    const exported = adapter.exportOpenClawActivationManifest!("alice", { timeoutMs: 50, signal: controller.signal }).then((value) => value, (error) => error);
    try {
      if (reason === "disconnect") controller.abort(new Error("export caller disconnected"));
      else await vi.advanceTimersByTimeAsync(50);
      await expect(exported).resolves.toMatchObject({ message: reason === "disconnect" ? "export caller disconnected" : "Timed out waiting for an OpenClaw runtime update" });
      expect(openClawRuntimeUpdateGuard.tryRun(async () => undefined)).toBeUndefined();
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally { release(); }
    await Promise.resolve(); await Promise.resolve();
    expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
  });
});

const testRuntime = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const originalDir = process.env.OPENCLAW_DIR;
  const originalAgentsDir = process.env.OPENCLAW_AGENTS_DIR;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "octogee-broker-test-"));
  process.env.OPENCLAW_DIR = dir;
  process.env.OPENCLAW_AGENTS_DIR = join(dir, "agents");
  process.env.OPENCLAW_STATE_DIR = dir;
  return { dir, originalDir, originalAgentsDir, originalStateDir };
});

afterAll(async () => {
  if (testRuntime.originalDir === undefined) delete process.env.OPENCLAW_DIR;
  else process.env.OPENCLAW_DIR = testRuntime.originalDir;
  if (testRuntime.originalAgentsDir === undefined) delete process.env.OPENCLAW_AGENTS_DIR;
  else process.env.OPENCLAW_AGENTS_DIR = testRuntime.originalAgentsDir;
  if (testRuntime.originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = testRuntime.originalStateDir;
  await fs.rm(testRuntime.dir, { recursive: true, force: true });
});

const ALICE_OWNER_MM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const FRESH_OWNER_MM_ID = "ffffffffffffffffffffffffff";
const FIRST_OWNER_MM_ID = "iiiiiiiiiiiiiiiiiiiiiiiiii";
const TESTER_OWNER_MM_ID = "tttttttttttttttttttttttttt";

const mocks = vi.hoisted(() => ({
  readActivationManifest: vi.fn(),
  applyOpenClawActivationManifest: vi.fn(),
  removeActivationManifest: vi.fn(),
}));
const supervisorMocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../lib/surge-openclaw-process-gate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/surge-openclaw-process-gate.js')>(),
  createSurgeOpenClawProcessSupervisorClient: () => ({ status: supervisorMocks.status }),
}));
const gitMocks = vi.hoisted(() => ({
  cloneProjectRepo: vi.fn(),
  customerRepositoryHasCanonicalRemote: vi.fn(),
  projectCheckoutMatchesSource: vi.fn(),
  setRepoSshCommand: vi.fn(),
}));
const patchMocks = vi.hoisted(() => ({
  applyConfigPatch: vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 })),
}));
const modelCredentialMocks = vi.hoisted(() => ({
  syncModelCredentialsForCustomer: vi.fn(async () => undefined),
  restoreModelCredentialOauthStoreForSlug: vi.fn(async () => ({ restored: true, present: true, providers: ["openai"] })),
}));
const brokerCatalogMocks = vi.hoisted(() => ({
  materializeBrokerProfilesForAgents: vi.fn(() => ({ materialized: 1, deferred: [] })),
}));
const contextFileConvergenceMocks = vi.hoisted(() => ({
  reassertConvergedContextFilesForSlug: vi.fn(() => []),
}));
const secretMocks = vi.hoisted(() => ({
  exportActivationManifestWithSecret: vi.fn(),
  updateMattermostAccountSecrets: vi.fn(async () => ({ changed: true })),
  materializeActivationManifestSecret: vi.fn(async (_dir: string, manifest: unknown) => ({
    manifest,
    secretsChanged: true,
  })),
}));
const routingActivationMocks = vi.hoisted(() => ({
  pending: false,
  capture: vi.fn(async (_rpc: unknown, accountIds: readonly string[]) =>
    Object.fromEntries(accountIds.map((accountId) => [accountId, 0]))),
  activate: vi.fn(async () => undefined),
  mark: vi.fn(() => {
    routingActivationMocks.pending = true;
    return "activation-token";
  }),
  discardForCustomers: vi.fn(),
  stopStale: vi.fn(async () => undefined),
  activateAfterPatch: vi.fn(async (rpc, openclawDir, log, params) => {
    if (params.configNoop) {
      await routingActivationMocks.stopStale(rpc, {
        currentSlug: params.currentSlug,
        desiredAccountIds: params.accountIds,
        evictionSlugs: params.evictionSlugs,
      }, log);
      routingActivationMocks.mark(openclawDir, params.reason, params.accountIds, params.baseline);
    }
    if (params.required || params.configNoop) {
      await routingActivationMocks.activate(rpc, openclawDir, log, {
        restartAccountIds: params.configNoop ? params.accountIds : [],
      });
    }
  }),
}));

vi.mock("../lib/migration-activation-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/migration-activation-manifest.js")>();
  return {
    ...actual,
    readActivationManifest: mocks.readActivationManifest,
    applyOpenClawActivationManifest: mocks.applyOpenClawActivationManifest,
    removeActivationManifest: mocks.removeActivationManifest,
  };
});
vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return {
    ...actual,
    cloneProjectRepo: gitMocks.cloneProjectRepo,
    customerRepositoryHasCanonicalRemote: gitMocks.customerRepositoryHasCanonicalRemote,
    projectCheckoutMatchesSource: gitMocks.projectCheckoutMatchesSource,
    setRepoSshCommand: gitMocks.setRepoSshCommand,
  };
});
vi.mock("../lib/apply-config-patch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/apply-config-patch.js")>();
  return {
    ...actual,
    applyConfigPatch: patchMocks.applyConfigPatch,
  };
});
vi.mock("../lib/model-credential-sync-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/model-credential-sync-runtime.js")>();
  return {
    ...actual,
    syncModelCredentialsForCustomer: modelCredentialMocks.syncModelCredentialsForCustomer,
    restoreModelCredentialOauthStoreForSlug: modelCredentialMocks.restoreModelCredentialOauthStoreForSlug,
  };
});
vi.mock("../lib/agent-model-token-materializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agent-model-token-materializer.js")>();
  return {
    ...actual,
    materializeBrokerProfilesForAgents: brokerCatalogMocks.materializeBrokerProfilesForAgents,
  };
});
vi.mock("../lib/context-file-convergence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/context-file-convergence.js")>();
  return {
    ...actual,
    reassertConvergedContextFilesForSlug: contextFileConvergenceMocks.reassertConvergedContextFilesForSlug,
  };
});
vi.mock("../lib/mattermost-account-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mattermost-account-secrets.js")>();
  return { ...actual, updateMattermostAccountSecrets: secretMocks.updateMattermostAccountSecrets };
});
vi.mock("../lib/migration-activation-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/migration-activation-secrets.js")>();
  secretMocks.exportActivationManifestWithSecret.mockImplementation(actual.exportActivationManifestWithSecret);
  return {
    ...actual,
    exportActivationManifestWithSecret: secretMocks.exportActivationManifestWithSecret,
    materializeActivationManifestSecret: secretMocks.materializeActivationManifestSecret,
  };
});
vi.mock("../lib/mattermost-routing-activation.js", () => ({
  activateMattermostRoutingAfterConfigPatch: routingActivationMocks.activateAfterPatch,
  captureMattermostRoutingActivationBaseline: routingActivationMocks.capture,
  activatePendingMattermostRouting: routingActivationMocks.activate,
  markMattermostRoutingActivationPending: routingActivationMocks.mark,
  discardMattermostRoutingActivationForCustomers: routingActivationMocks.discardForCustomers,
  mattermostRoutingActivationPending: () => routingActivationMocks.pending,
  stopStaleMattermostRoutingAccounts: routingActivationMocks.stopStale,
}));

function mkClient(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    uidForSlug: vi.fn(async () => "uid-tester10"),
    githubTokenForSync: vi.fn(async () => null),
    userSnapshot: vi.fn(async () => null),
    reconcileProjectCoachMembership: vi.fn(async () => undefined),
    setProvisioningStatus: vi.fn(async () => undefined),
    setRepoUrl: vi.fn(async () => undefined),
    provisionMattermost: vi.fn(async () => ({})),
    setMattermostFields: vi.fn(async () => undefined),
    ensureCommunityMembership: vi.fn(async () => undefined),
    setAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
    reportProjectAgentReadiness: vi.fn(async () => undefined),
    recordReconcileError: vi.fn(async () => undefined),
    clearReconcileError: vi.fn(async () => undefined),
    notifySignup: vi.fn(async () => undefined),
    recordUsageEvent: vi.fn(async () => undefined),
    blobDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      method: "GET",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    blobUploadUrl: vi.fn(async () => ({
      url: "https://example.com/upload",
      method: "PUT",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    ...overrides,
  };
}

function mkGatewayRpc(overrides: Partial<GatewayRpcClient> = {}): GatewayRpcClient {
  return {
    gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
    isGatewayUp: vi.fn(async () => true),
    cronJobCount: vi.fn(async () => 0),
    channelsStop: vi.fn(async ({ channel, accountId }) => ({
      channel,
      accountId,
      stopped: true as const,
    })),
    channelsStart: vi.fn(async ({ channel, accountId }) => ({
      channel,
      accountId,
      started: true as const,
    })),
    sessionsList: vi.fn(async () => ({ sessions: [] })),
    sessionsAbort: vi.fn(async () => ({ ok: true as const, abortedRunId: "run-1", status: "aborted" as const })),
    schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
      operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: true,
    })),
    ...rosterRpc(),
    ...overrides,
  } as GatewayRpcClient;
}

function configSnapshot(config: unknown) {
  return {
    config,
    hash: "cfg-hash",
    configRevisionHash: "revision-hash",
    appliedConfigHash: "revision-hash",
  };
}

// The add path reads the live roster to decide which agents leave by
// `agents.delete` and which arrive by `agents.create`, so every add fixture
// needs all three calls.
function rosterRpc(config: unknown = { agents: { entries: {} } }) {
  return {
    configGet: vi.fn(async () => configSnapshot(config)),
    secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    cronJobCount: vi.fn(async () => 0),
    agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
      ok: true as const,
      agentId,
      removedBindings: 0,
    })),
    agentsCreate: vi.fn(async ({ name, workspace }: { name: string; workspace: string }) => ({
      ok: true as const,
      agentId: name,
      name,
      workspace,
    })),
  };
}

// The roster is now removed one `agents.delete` at a time, so every eviction
// path reads the live roster and then calls the gateway per departing agent.
function mkRemovalRpc(
  config: unknown,
  overrides: Partial<GatewayRpcClient> = {},
): GatewayRpcClient {
  return {
    ...rosterRpc(config),
    ...overrides,
  } as unknown as GatewayRpcClient;
}

function keyedRoster(agentIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(agentIds.map((agentId) => [agentId, { model: "house" }]));
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {}),
  };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function aliceSnapshot(
  overrides: Partial<FleetBrokerUserSnapshot> = {},
): FleetBrokerUserSnapshot {
  return {
    uid: "uid-alice",
    slug: "alice",
    tier: "standard",
    gatewayId: "default",
    status: "",
    agentIds: [],
    repoUrl: "",
    mattermostUserId: ALICE_OWNER_MM_ID,
    customerMmUserId: ALICE_OWNER_MM_ID,
    channels: [],
    projects: [],
    ownerName: "Alice",
    coachToken: "pat-1",
    coachMmUserId: "mm-alice-coach",
    ...overrides,
  };
}

function configuredBuilderClient(): FleetBrokerClient {
  return mkClient({
    userSnapshot: vi.fn(async () => aliceSnapshot({ uid: "uid-tester10", slug: "tester10" })),
  });
}

describe("buildBrokeredLifecycleAdapter migration import activation", () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalLogLevel = process.env.LOG_LEVEL;
  let tempStateDir: string | null = null;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
    mocks.readActivationManifest.mockReset();
    mocks.applyOpenClawActivationManifest.mockReset();
    mocks.removeActivationManifest.mockReset();
    gitMocks.cloneProjectRepo.mockReset().mockResolvedValue(true);
    gitMocks.customerRepositoryHasCanonicalRemote.mockReset().mockReturnValue(true);
    gitMocks.projectCheckoutMatchesSource.mockReset().mockReturnValue(true);
    gitMocks.setRepoSshCommand.mockClear();
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
    secretMocks.materializeActivationManifestSecret.mockClear();
    routingActivationMocks.pending = false;
    routingActivationMocks.capture.mockClear();
    routingActivationMocks.activate.mockReset().mockImplementation(async () => undefined);
    routingActivationMocks.mark.mockClear();
    routingActivationMocks.discardForCustomers.mockClear();
    routingActivationMocks.stopStale.mockClear();
    routingActivationMocks.activateAfterPatch.mockClear();
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    tempStateDir = null;
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [],
    });
    mocks.applyOpenClawActivationManifest.mockResolvedValue({
      elapsedMs: 42,
      routingActivationRequired: true,
      restartExistingAccountIds: [],
    });
    mocks.removeActivationManifest.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  });

  it("defers credential repair until an account import finishes its configuration updates", async () => {
    _resetBrokerProfileLogStateForTests();
    let releasePatch!: () => void;
    mocks.applyOpenClawActivationManifest.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releasePatch = resolve; });
      return { elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [] };
    });
    const rpc = {
      ...rosterRpc(),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const activation = adapter.activateImportedCustomer("tester10");
    try {
      await vi.waitFor(() => expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce());
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
      const result = await materializeDeferredBrokerProfiles(vi.fn(), {
        readConfig: () => ({}), secretsReload: rpc,
      });
      expect(result).toMatchObject({ settled: false, skipped: true });
      expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).not.toHaveBeenCalled();
      expect(rpc.secretsReload).not.toHaveBeenCalled();
    } finally {
      releasePatch();
      await activation;
      _resetBrokerProfileLogStateForTests();
    }
    await expect(materializeDeferredBrokerProfiles(vi.fn(), {
      readConfig: () => ({}), secretsReload: rpc,
    })).resolves.toMatchObject({ settled: true });
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledOnce();
  });

  it("prepares imported credentials after agent revival and before activating the manifest", async () => {
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
    const rpc = {
      ...rosterRpc(),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
    });
    await adapter.activateImportedCustomer("tester10");
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledOnce();
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents.mock.invocationCallOrder[0])
      .toBeGreaterThan(rpc.agentsCreate.mock.invocationCallOrder.at(-1)!);
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]);
  });

  it.each([false, true])("waits for the final import revision and only gates intermediate roster revisions on Builder gateways (builder=%s)", async (isBuilderGateway) => {
    let created = false;
    let applied = false;
    const base = rosterRpc();
    const rpc = {
      ...base,
      agentsCreate: vi.fn(async (params: { name: string; workspace: string }) => {
        const result = await base.agentsCreate(params);
        created = true;
        return result;
      }),
      configGet: vi.fn(async () => {
        const revision = mocks.applyOpenClawActivationManifest.mock.calls.length > 0
          ? "revision-import"
          : "revision-roster";
        return {
          ...configSnapshot({}),
          configRevisionHash: revision,
          appliedConfigHash: !created || applied ? revision : "revision-before",
        };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
      isBuilderGateway: () => isBuilderGateway,
    });
    const activation = adapter.activateImportedCustomer("tester10");
    try {
      await vi.waitFor(() => expect(rpc.agentsCreate).toHaveBeenCalledOnce());
      if (isBuilderGateway) {
        expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce());
      }
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      applied = true;
      await activation;
    }
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
    expect(mocks.removeActivationManifest).toHaveBeenCalledOnce();
  });

  it("keeps a shared import pending when its final revision fails to apply", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const rpc = {
      ...rosterRpc(),
      configGet: vi.fn(async () => {
        if (mocks.applyOpenClawActivationManifest.mock.calls.length === 0) return configSnapshot({});
        now += 60_001;
        return {
          ...configSnapshot({}),
          configRevisionHash: "revision-import",
          appliedConfigHash: "revision-roster",
        };
      }),
      channelsStatus: vi.fn(),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
      isBuilderGateway: () => false,
    });
    try {
      await expect(adapter.activateImportedCustomer("tester10")).resolves.toMatchObject({
        verificationPending: expect.stringContaining("active config did not reach revision revision-import"),
      });
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("deletes target roster residue the manifest does not carry before activating", async () => {
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [],
    });
    const client = mkClient();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      ...rosterRpc({
        agents: {
          entries: keyedRoster([
            "octogee-tester10-coach",
            "octogee-tester10-proj-residue-coach",
            "octogee-keeper-coach",
          ]),
        },
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });

    await adapter.activateImportedCustomer("tester10", {});

    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-tester10-proj-residue-coach",
    ]);
    expect(rpc.agentsDelete.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.capture.mock.invocationCallOrder[0]!,
    );
    expect(routingActivationMocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!,
    );
  });

  it.each([false, true])("revives imported projects before applying model secrets and activation (already rostered: %s)", async (rostered) => {
    const agentId = "octogee-tester10-proj-orbit-coach";
    let deleted = true;
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [{
        agentId,
        agent: { id: agentId, workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit") },
      }],
    });
    const rpc = mkGatewayRpc({
      ...rosterRpc({ agents: { entries: keyedRoster(rostered ? [agentId] : []) } }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [
        { accountId: "tester10-coach", running: true, connected: true },
      ] } })),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        if (name === agentId) {
          deleted = false;
          if (rostered) throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
        }
        return { ok: true, agentId: name, name, workspace };
      }),
    });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => ({
      materialized: deleted ? 0 : 1,
      deferred: deleted ? [agentId] : [],
    }));
    mocks.applyOpenClawActivationManifest.mockImplementationOnce(async () => {
      if (deleted) throw new Error("agent database is unavailable while agent is deleted");
      return { elapsedMs: 1, routingActivationRequired: false, restartExistingAccountIds: [] };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedCustomer("tester10");

    expect(deleted).toBe(false);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });

  it("restores the subscription store after the transferred state lands on a Builder gateway", async () => {
    modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
      isBuilderGateway: () => true,
    });

    await adapter.activateImportedCustomer("tester10");

    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).toHaveBeenCalledWith(
      "tester10",
      expect.objectContaining({ logFn: expect.any(Function) }),
    );
    expect(
      modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!);
  });

  it("does not restore the subscription store when importing onto a shared gateway", async () => {
    modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedCustomer("tester10");

    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).not.toHaveBeenCalled();
  });

  it("re-adopts a detached source from its saved activation manifest before resuming channels", async () => {
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: {} }, channels: { mattermost: { accounts: { "tester10-coach": {} } } } })),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] } })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.resumeCustomer("tester10");
    expect(rpc.agentsCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "octogee-tester10-coach" }));
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
    expect(rpc.channelsStart).toHaveBeenCalledWith({ channel: "mattermost", accountId: "tester10-coach" });
    expect(mocks.removeActivationManifest.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rpc.channelsStart).mock.invocationCallOrder[0]!);
  });

  it("activates imported standard-gateway state from the transferred activation manifest", async () => {
    const client = mkClient();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
    });
    const signal = new AbortController().signal;

    await expect(adapter.activateImportedCustomer("tester10", { signal })).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(mocks.readActivationManifest).toHaveBeenCalledWith(
      testRuntime.dir,
      "tester10",
    );
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "tester10", appliedFingerprint: "fp-tester10" }),
      expect.objectContaining({ rpc, signal }),
    );
    expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
      "ownerCommandsPatch",
    );
    expect(gitMocks.setRepoSshCommand).toHaveBeenCalledWith(
      expect.stringContaining("/customers/tester10"),
      "tester10",
    );
    expect(gitMocks.setRepoSshCommand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeActivationManifest).toHaveBeenCalledWith(
      testRuntime.dir,
      "tester10",
    );
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: [], restartConfiguredPending: true },
    );
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeActivationManifest.mock.invocationCallOrder[0]!,
    );
    expect(rpc.channelsStatus).toHaveBeenCalled();
    expect(client.uidForSlug).not.toHaveBeenCalled();
  });

  describe("import secrets.reload gate", () => {
    const importedConfig = {
      agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      channels: { mattermost: { accounts: {
        "tester10-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/tester10-coach" } },
      } } },
    };

    function importRpc(config: unknown = importedConfig) {
      return {
        gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
        isGatewayUp: vi.fn(async () => true),
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot(config)),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      };
    }

    function unchangedImportInputs() {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: false }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
    }

    it("skips secrets.reload when a re-import changes no secret material on a shared gateway", async () => {
      unchangedImportInputs();
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isBuilderGateway: () => false,
      });

      await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
      });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload skipped — no secret material changed");
      expect(mocks.removeActivationManifest).toHaveBeenCalledOnce();
    });

    it("reloads when the transferred Mattermost tokens landed in the secrets file", async () => {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: true }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [], configNoop: true,
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isBuilderGateway: () => false,
      });

      await adapter.activateImportedCustomer("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload — Mattermost account secrets file changed");
    });

    it("reloads when the activation patch committed config — it carries the imported SecretRefs", async () => {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: false }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [], configNoop: false,
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isBuilderGateway: () => false,
      });

      await adapter.activateImportedCustomer("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "[import:tester10] secrets.reload — activation config patch changed the config",
      );
    });

    it("reloads when a Builder import restored the subscription store", async () => {
      unchangedImportInputs();
      modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockResolvedValueOnce({
        restored: true, present: true, providers: ["openai"],
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isBuilderGateway: () => true,
      });

      await adapter.activateImportedCustomer("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload — model credential OAuth store restored");
    });
  });

  it("keeps a committed activation when the reload outlasts a post-commit step", async () => {
    const log = vi.fn();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => {
        throw new OpenclawWireError("timeout", "connect response timed out after 30000ms");
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(adapter.activateImportedCustomer("tester10")).resolves.toMatchObject({
      appliedFingerprint: expect.any(String),
      verificationPending: expect.stringContaining("connect response timed out"),
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("activation committed; verification incomplete"),
    );
  });

  it("re-reads the applied revision and reloads once more when a newer config write supersedes secrets.reload", async () => {
    const log = vi.fn();
    const superseded = new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn()
        .mockRejectedValueOnce(superseded)
        .mockResolvedValueOnce({ ok: true, warningCount: 0 }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    const activation = await adapter.activateImportedCustomer("tester10");

    expect(activation.verificationPending).toBeUndefined();
    expect(rpc.secretsReload).toHaveBeenCalledTimes(2);
    const configReads = vi.mocked(rpc.configGet).mock.invocationCallOrder;
    const reloads = vi.mocked(rpc.secretsReload).mock.invocationCallOrder;
    expect(configReads.some((order) => order > reloads[0] && order < reloads[1])).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[import:tester10] secrets.reload complete"));
  });

  it("names the config write that preceded a secrets.reload superseded twice", async () => {
    const superseded = new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn().mockRejectedValue(superseded),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    const activation = await adapter.activateImportedCustomer("tester10");

    expect(rpc.secretsReload).toHaveBeenCalledTimes(2);
    expect(activation.verificationPending).toMatch(
      /secrets\.reload was refused twice after: .*activation config patch changed the config/,
    );
  });

  it("does not retry a secrets.reload that failed for a reason other than gateway unavailability", async () => {
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn().mockRejectedValue(
        new OpenclawWireError("rpc-error", "invalid secrets.reload params", { serverCode: "INVALID_REQUEST" }),
      ),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    const activation = await adapter.activateImportedCustomer("tester10");

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(activation.verificationPending).toBe("invalid secrets.reload params");
  });

  it("fails a committed activation when the migration itself was cancelled", async () => {
    const controller = new AbortController();
    const cancelled = new Error("migration cancelled");
    const rpc = {
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => {
        controller.abort(cancelled);
        throw cancelled;
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.activateImportedCustomer("tester10", { signal: controller.signal }),
    ).rejects.toBe(cancelled);
  });

  it("waits for the imported config to apply before reloading its secret runtime", async () => {
    const configGet = vi.fn()
      .mockResolvedValueOnce(configSnapshot({ agents: { list: [] } }))
      .mockResolvedValueOnce({
        ...configSnapshot({ agents: { list: [] } }),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        ...configSnapshot({ agents: { list: [] } }),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      })
      .mockResolvedValue(configSnapshot({ agents: { list: [] } }));
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet,
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedCustomer("tester10");

    expect(configGet).toHaveBeenCalledTimes(3);
    expect(configGet.mock.invocationCallOrder[2]).toBeLessThan(
      rpc.secretsReload.mock.invocationCallOrder[0]!,
    );
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeActivationManifest.mock.invocationCallOrder[0]!,
    );
  });

  it("rides out a reload that refuses connections while waiting for the applied config", async () => {
    const configGet = vi.fn()
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect response timed out after 30000ms"))
      .mockResolvedValueOnce({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect response timed out after 30000ms"))
      .mockResolvedValue({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      });
    const rpc = { configGet } as unknown as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { pollIntervalMs: 0 }),
    ).resolves.toBeUndefined();
    expect(configGet).toHaveBeenCalledTimes(4);
  });

  it("fails the import wait when the runtime never applies the persisted config", async () => {
    const rpc = {
      configGet: vi.fn(async () => ({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: null,
      })),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { timeoutMs: 0 }),
    ).rejects.toThrow(
      /active config did not reach revision revision-new within 0ms \(applied=none\)/,
    );
  });

  it("stops the import wait when the migration is cancelled", async () => {
    const controller = new AbortController();
    const cancelled = new Error("migration cancelled");
    const rpc = {
      configGet: vi.fn(async () => {
        controller.abort(cancelled);
        return {
          ...configSnapshot({}),
          configRevisionHash: "revision-new",
          appliedConfigHash: "revision-old",
        };
      }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { signal: controller.signal }),
    ).rejects.toBe(cancelled);
    expect(rpc.configGet).toHaveBeenCalledTimes(1);
  });

  it("settles a rostered agent's wait once the runtime applies a sibling lane's later revision", async () => {
    const rpc = {
      configGet: vi.fn()
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-alice", appliedConfigHash: "revision-before",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-bob", appliedConfigHash: "revision-alice",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-bob", appliedConfigHash: "revision-bob",
        }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(waitForAppliedConfigRevision(rpc, "alice", {
      pollIntervalMs: 0,
      acceptSupersedingRevision: true,
    })).resolves.toBeUndefined();
    expect(rpc.configGet).toHaveBeenCalledTimes(3);
  });

  it("rejects an import wait when another config revision supersedes the import", async () => {
    const rpc = {
      configGet: vi.fn()
        .mockResolvedValueOnce({
          ...configSnapshot({}),
          configRevisionHash: "revision-import",
          appliedConfigHash: "revision-before-import",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}),
          configRevisionHash: "revision-other",
          appliedConfigHash: "revision-other",
        }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { pollIntervalMs: 0 }),
    ).rejects.toThrow(
      /config revision changed while waiting \(expected=revision-import, observed=revision-other\)/,
    );
  });

  it("detaches superseded PostgreSQL entries during an import without purging their stores", async () => {
    const config = { agents: { entries: keyedRoster(["octogee-tester10-coach", "octogee-tester10-proj-surplus-coach", "octogee-bob-coach"]) } };
    await withPostgresAgentConfig(config, async () => {
      const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
      const rpc = mkGatewayRpc({ ...rosterRpc(config), agentsDetach,
        channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] } })),
      });
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
      await adapter.activateImportedCustomer("tester10");
      expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-tester10-proj-surplus-coach" });
      expect(rpc.agentsDelete).not.toHaveBeenCalled();
    });
  });

  it("waits through a cold Builder control handshake before changing its roster", async () => {
    stubBuilderClaim("tester10");
    try {
      const rpc = mkGatewayRpc({
        channelsStatus: vi.fn(async () => ({ channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        } })),
        configGet: vi.fn()
        .mockRejectedValueOnce(new OpenclawWireError("connect-failed", "socket closed before connect response"))
        .mockResolvedValue(configSnapshot({ agents: { list: [] } })) });
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredBuilderClient(), rpc, log: vi.fn() });
      await expect(adapter.activateImportedCustomer("tester10")).resolves.toMatchObject({ appliedFingerprint: expect.any(String) });
      expect(vi.mocked(rpc.configGet).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(rpc.agentsCreate).mock.invocationCallOrder[0]);
    } finally {
      clearBuilderClaim();
    }
  });

  it.each(["connect-failed", "timeout"] as const)("exhausts cold Builder admission without roster changes for %s", async (code) => {
    stubBuilderClaim("tester10");
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const rpc = mkGatewayRpc({ configGet: vi.fn(async () => {
        now += 600_001;
        throw new OpenclawWireError(code, "cold control runtime unavailable");
      }) });
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredBuilderClient(), rpc, log: vi.fn() });
      await expect(adapter.activateImportedCustomer("tester10")).rejects.toThrow(/config revision was unreadable for 600000ms/);
      expect(rpc.agentsCreate).not.toHaveBeenCalled();
      expect(rpc.agentsDelete).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      clearBuilderClaim();
    }
  });

  it.each(["auth-failed", "invalid-response", "rpc-error"] as const)("fails runtime admission immediately for %s", async (code) => {
    const failure = new OpenclawWireError(code, "strict runtime admission failure");
    const rpc = { configGet: vi.fn().mockRejectedValue(failure) };
    await expect(waitForAppliedConfigRevision(rpc, "tester10", { timeoutMs: 0 })).rejects.toBe(failure);
    expect(rpc.configGet).toHaveBeenCalledTimes(1);
  });

  it("does not admit a valid config response after the import is cancelled", async () => {
    const controller = new AbortController(), cancelled = new Error("migration cancelled");
    const rpc = { configGet: vi.fn(async () => { controller.abort(cancelled); return configSnapshot({}); }) };
    await expect(waitForAppliedConfigRevision(rpc, "tester10", { signal: controller.signal })).rejects.toBe(cancelled);
  });

  it("anchors inherited auth to the neutral agent for the configured Builder", async () => {
    stubBuilderClaim("tester10");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredBuilderClient(), rpc, log: vi.fn() });

      await adapter.activateImportedCustomer("tester10", {});

      expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          authInheritanceAnchor: {
            agentId: SAFE_DEFAULT_AGENT_ID,
            agent: expect.objectContaining({ id: SAFE_DEFAULT_AGENT_ID }),
          },
        }),
      );
    } finally {
      clearBuilderClaim();
    }
  });

  it("anchors a Builder computer's activation to the neutral agent with its desktop tools denied", async () => {
    stubBuilderClaim("tester10");
    vi.stubEnv("GATEWAY_CLASS", "builder");
    vi.stubEnv("GATEWAY_RUNTIME_KIND", "gce-vm");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredBuilderClient(), rpc, log: vi.fn() });

      await adapter.activateImportedCustomer("tester10", {});

      const [, options] = mocks.applyOpenClawActivationManifest.mock.calls.at(-1)!;
      expect(options.authInheritanceAnchor.agent.tools.deny).toEqual(
        expect.arrayContaining(["browser", "computer", "nodes", "file-transfer", "ollama"]),
      );
    } finally {
      clearBuilderClaim();
    }
  });

  it("grants the configured Builder owner authority in its import activation patch", async () => {
    stubBuilderClaim("tester10");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredBuilderClient(), rpc, log: vi.fn() });

      await adapter.activateImportedCustomer("tester10", {});

      const ownerCommandsPatch = mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]
        ?.ownerCommandsPatch as ((current: unknown) => unknown) | undefined;
      expect(ownerCommandsPatch?.({})).toEqual({ ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] });
      expect(ownerCommandsPatch?.({ commands: { ownerAllowFrom: ["mattermost:other"] } })).toBeUndefined();
    } finally {
      clearBuilderClaim();
    }
  });

  it("refuses a configured Builder import activation whose owner Mattermost id is unavailable", async () => {
    stubBuilderClaim("tester10");
    try {
      const rpc = {
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

      await expect(adapter.activateImportedCustomer("tester10", {})).rejects.toThrow(
        /owner Mattermost id is unavailable for tester10/,
      );
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
    } finally {
      clearBuilderClaim();
    }
  });

  it("does not add a Builder auth anchor for another Builder's customer", async () => {
    stubBuilderClaim("someone-else");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

      await adapter.activateImportedCustomer("tester10", {});

      expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
        "authInheritanceAnchor",
      );
      expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
        "ownerCommandsPatch",
      );
    } finally {
      clearBuilderClaim();
    }
  });

  it.each([["info", 2], ["debug", 3]] as const)("keeps activation diagnostics at %s with %i config reads", async (level, reads) => {
    process.env.LOG_LEVEL = level;
    const client = mkClient();
    const log = vi.fn();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-tester10-coach": { model: "test/model" } } } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log,
      projectCheckoutScope: () => "workspace-and-projects",
    });

    await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(rpc.configGet).toHaveBeenCalledTimes(reads);
    if (level === "debug") expect(log).toHaveBeenCalledWith(expect.stringContaining('model="test/model"'));
    expect(client.uidForSlug).not.toHaveBeenCalled();
    expect(client.userSnapshot).not.toHaveBeenCalled();
    expect(gitMocks.cloneProjectRepo).not.toHaveBeenCalled();
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
  });

  it("reports pending verification and preserves the manifest when secrets.reload does not acknowledge success", async () => {
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: false, warningCount: 2 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.activateImportedCustomer("tester10")).resolves.toMatchObject({
      verificationPending: expect.stringMatching(/secrets\.reload did not acknowledge success/),
    });

    expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    expect(rpc.channelsStatus).not.toHaveBeenCalled();
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });

  it("logs global secret warnings before verifying the current imported account", async () => {
    const events: string[] = [];
    const log = vi.fn((message: string) => events.push(message));
    mocks.applyOpenClawActivationManifest
      .mockImplementationOnce(async (_manifest, options) => {
        options.onRoutingActivationRequired?.(["tester10-coach"]);
        return {
          elapsedMs: 42,
          routingActivationRequired: true,
          restartExistingAccountIds: ["tester10-coach"],
        };
      });
    routingActivationMocks.activate.mockImplementationOnce(async (_rpc, _dir, _log, options) => {
      events.push(options?.restartAccountIds?.join(",") ?? "activate");
      routingActivationMocks.pending = false;
    });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 4 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(log).toHaveBeenCalledWith(
      "[import:tester10] secrets.reload complete with 4 warnings",
    );
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(rpc.channelsStatus).toHaveBeenCalled();
    expect(events.indexOf("[import:tester10] secrets.reload complete with 4 warnings")).toBeLessThan(
      events.indexOf("tester10-coach"),
    );
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: ["tester10-coach"], restartConfiguredPending: true },
    );
  });

  it("restarts every still-pending account when replay finds the config already patched", async () => {
    routingActivationMocks.pending = true;
    mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
      elapsedMs: 42,
      routingActivationRequired: false,
      restartExistingAccountIds: [],
    });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedCustomer("tester10");

    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: [], restartConfiguredPending: true },
    );
  });

  it("restarts only the configured Builder manifest accounts after a retained-overlay no-op", async () => {
    stubBuilderClaim("tester10");
    try {
      const desiredAccountIds = ["tester10-coach", "tester10-proj-orbit"];
      mocks.readActivationManifest.mockResolvedValueOnce({
        slug: "tester10",
        appliedFingerprint: "fp-tester10",
        agentId: "octogee-tester10-coach",
        accountId: "tester10-coach",
        agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
        mattermostAccount: { botToken: "coach-pat" },
        bindings: [],
        projectAgents: [{
          agentId: "octogee-tester10-proj-orbit-coach",
          accountId: "tester10-proj-orbit",
          agent: { id: "octogee-tester10-proj-orbit-coach", workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit") },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [],
        }],
      });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
      let accountsRestarted = false;
      routingActivationMocks.activate.mockImplementationOnce(async () => {
        accountsRestarted = true;
      });
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [
              {
                accountId: "tester10-coach",
                running: true,
                connected: true,
              },
              {
                accountId: "tester10-proj-orbit",
                running: true,
                connected: true,
              },
              {
                accountId: "unrelated-coach",
                running: true,
                connected: true,
              },
            ],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({
          agents: {
            list: [
              { id: "octogee-tester10-coach", model: "house" },
              { id: "octogee-tester10-proj-orbit-coach", model: "house" },
            ],
          },
        })),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({
        client: configuredBuilderClient(),
        rpc,
        log: vi.fn(),
        isBuilderGateway: () => true,
      });

      await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
      });
      expect(accountsRestarted).toBe(true);
      expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
        rpc,
        {
          currentSlug: "tester10",
          desiredAccountIds,
          evictionSlugs: [],
        },
        expect.any(Function),
      );
      expect(routingActivationMocks.activateAfterPatch).toHaveBeenCalledWith(
        rpc,
        testRuntime.dir,
        expect.any(Function),
        {
          accountIds: desiredAccountIds,
          baseline: {
            "tester10-coach": 0,
            "tester10-proj-orbit": 0,
          },
          configNoop: true,
          required: false,
          reason: "[import:tester10] account-level Mattermost binding changed",
          currentSlug: "tester10",
          evictionSlugs: [],
        },
      );
      expect(routingActivationMocks.activate).toHaveBeenCalledWith(
        rpc,
        testRuntime.dir,
        expect.any(Function),
        { restartAccountIds: desiredAccountIds },
      );
      expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
        routingActivationMocks.activate.mock.invocationCallOrder[0]!,
      );
    } finally {
      clearBuilderClaim();
    }
  });

  it("keeps a configured Builder no-op activation pending when its account restart fails", async () => {
    stubBuilderClaim("tester10");
    try {
      mocks.readActivationManifest.mockResolvedValueOnce({
        slug: "tester10",
        appliedFingerprint: "fp-tester10",
        agentId: "octogee-tester10-coach",
        accountId: "tester10-coach",
        agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
        mattermostAccount: { botToken: "coach-pat" },
        bindings: [],
        projectAgents: [],
      });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
      routingActivationMocks.activate.mockRejectedValueOnce(
        new Error("Mattermost account restart failed"),
      );
      const rpc = {
        channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({
        client: configuredBuilderClient(),
        rpc,
        log: vi.fn(),
        isBuilderGateway: () => true,
      });

      await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
        verificationPending: "Mattermost account restart failed",
      });

      expect(routingActivationMocks.mark).toHaveBeenCalledWith(
        testRuntime.dir,
        "[import:tester10] account-level Mattermost binding changed",
        ["tester10-coach"],
        { "tester10-coach": 0 },
      );
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      clearBuilderClaim();
    }
  });

  it("propagates manifest import errors without synthesizing an applied fingerprint", async () => {
    const client = mkClient();
    const failure = new Error("activation manifest version/slug mismatch");
    mocks.readActivationManifest.mockRejectedValueOnce(failure);
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.activateImportedCustomer("tester10")).rejects.toBe(failure);

    expect(mocks.readActivationManifest).toHaveBeenCalledExactlyOnceWith(
      testRuntime.dir,
      "tester10",
    );
    expect(client.userSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("fails before mutating config when the activation manifest is absent", async () => {
    mocks.readActivationManifest.mockRejectedValue(new Error("missing activation manifest"));
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.activateImportedCustomer("missing")).rejects.toThrow(
      /missing activation manifest/,
    );
    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("moves and quiesces every project agent state path owned by the builder", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-project-state-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-tester10-coach", "sessions"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-tester10-proj-orbit-coach", "sessions"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-other-proj-orbit-coach"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "memory"), { recursive: true });
    for (const agentId of ["octogee-tester10-coach", "octogee-tester10-proj-orbit-coach"]) {
      const agentDir = path.join(tempStateDir, "agents", agentId, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
        db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(`agent:${agentId}:main`, agentId, "running");
      } finally {
        db.close();
      }
    }
    await fs.writeFile(
      path.join(tempStateDir, "memory", "octogee-tester10-proj-orbit-coach.sqlite-wal"),
      "",
    );
    await fs.writeFile(
      path.join(tempStateDir, "memory", "octogee-other-proj-orbit-coach.sqlite-wal"),
      "",
    );
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await fs.mkdir(path.join(testRuntime.dir, "git-metadata", "tester10", "projects", "orbit.git"), { recursive: true });
    const paths = await adapter.listExportPaths("tester10");

    expect(paths).toEqual(expect.arrayContaining([
      { cwd: testRuntime.dir, path: path.join("git-metadata", "tester10") },
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-coach") },
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-proj-orbit-coach") },
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("octogee-other-") }),
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/\.sqlite-(wal|shm)$/u) }),
    ]));
    await expect(adapter.quiesceCustomer("tester10", 0)).resolves.toEqual({
      drained: false,
      runningCount: 2,
    });
  });
});

describe("broker migration admission", () => {
  const boundedStopDirs: string[] = [];
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  afterEach(async () => {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    for (const dir of boundedStopDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });
  function seedMigrationqaSession(stateDir: string, status: string): void {
    const agentDir = path.join(stateDir, "agents", "octogee-migrationqa-coach", "agent");
    fsSync.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
      db.exec("DELETE FROM session_nodes");
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run("agent:octogee-migrationqa-coach:main", "s1", status);
    } finally {
      db.close();
    }
  }

  it("refuses migration while a customer has scheduled work without stopping chat", async () => {
    const rpc = mkGatewayRpc({ cronJobCount: vi.fn(async () => 1) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await expect(adapter.quiesceCustomer("migrationqa", 0)).rejects.toThrow("scheduled jobs");
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });
  it("refuses cutover when a draining turn creates a scheduled job", async () => {
    const rpc = mkGatewayRpc({ cronJobCount: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(1) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await expect(adapter.quiesceCustomer("migrationqa", 0)).rejects.toThrow("scheduled jobs");
    expect(rpc.cronJobCount).toHaveBeenCalledTimes(2);
  });
  it("returns a Builder whose agent keeps host-bound jobs: the hold retains them instead of refusing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-partial-hold-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "done");
    const rpc = mkGatewayRpc({
      cronJobCount: vi.fn(async () => 2),
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-migrationqa-coach": {} } } })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceCustomer("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1", retainNonportable: true }))
      .resolves.toEqual({ drained: true, runningCount: 0 });
    expect(rpc.cronJobCount).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-migrationqa-coach"], retainNonportable: true });
  });
  it("proves scheduler readiness with a read-only gateway RPC and surfaces why it is not ready", async () => {
    const ready = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot({})) });
    await expect(buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: ready, log: vi.fn() }).schedulerReady()).resolves.toBeUndefined();
    expect(ready.configGet).toHaveBeenCalledOnce();
    expect(ready.schedulerMigration).not.toHaveBeenCalled();

    const booting = mkGatewayRpc({ configGet: vi.fn(async () => { throw new Error("OpenClaw workspace identities are not initialized for this boot"); }) });
    await expect(buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: booting, log: vi.fn() }).schedulerReady())
      .rejects.toThrow("workspace identities are not initialized for this boot");
  });
  it("leaves ingress to the whole-process rollout owner when requested", async () => {
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.quiesceCustomer("migrationqa", 100, { stopMattermost: false });
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });
  it("defers a turn that outlives the drain budget without aborting it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-bounded-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const seed = (status: string) => seedMigrationqaSession(stateDir, status);
    seed("running");
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({
        channels: { mattermost: { accounts: { "migrationqa-coach": {} } } },
        agents: { entries: { "octogee-migrationqa-coach": {} } },
      })),
      sessionsAbort: vi.fn(async () => {
        seed("killed");
        return { ok: true as const, abortedRunId: "run-9", status: "aborted" as const };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceCustomer("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1" }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-migrationqa-coach"] });
  });

  it("defers while an active scheduled run keeps the source undrained", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-cron-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "running");
    let cronRunning = true;
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-migrationqa-coach": {} } } })),
      schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
        operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: !cronRunning,
      })),
      sessionsAbort: vi.fn(async () => {
        cronRunning = false;
        seedMigrationqaSession(stateDir, "killed");
        return { ok: true as const, abortedRunId: "cron-run", status: "aborted" as const };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceCustomer("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1" }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    const holds = vi.mocked(rpc.schedulerMigration).mock.calls.map(([request]) => request.phase);
    expect(holds.every((phase) => phase === "hold")).toBe(true);
    expect(holds).toEqual(["hold"]);
  });

  it("never aborts turns for the whole-process handoff owner, which stops the process itself", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-surge-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "running");
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceCustomer("migrationqa", 0, { stopMattermost: false }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });

  it("stops incoming coach turns before reporting an idle customer drained", async () => {
    mocks.readActivationManifest.mockRejectedValueOnce(Object.assign(new Error("no rollback manifest"), { code: "ENOENT" }));
    const rpc = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot({
      channels: { mattermost: { accounts: { "migrationqa-coach": {} } } },
    })) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await expect(adapter.quiesceCustomer("migrationqa", 100)).resolves.toEqual({ drained: true, runningCount: 0 });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
    await adapter.resumeCustomer("migrationqa");
    expect(rpc.channelsStart).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
  });
});

describe("broker adapter malformed coach identity quarantine", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
  });

  it("deletes every stale customer account before reporting an empty allowlist", async () => {
    const current = {
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": { groupPolicy: "open", groupAllowFrom: ["legacy-guest"] },
            "alice-proj-orbit": {
              groupPolicy: "allowlist",
              groupAllowFrom: ["mm-project-member"],
            },
            "bob-coach": { groupPolicy: "open", groupAllowFrom: ["mm-bob"] },
            "bob-proj-map": { groupPolicy: "open", groupAllowFrom: ["mm-bob"] },
          },
        },
      },
    };
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      expect(args.buildPatch(current)).toEqual({
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": null,
              "alice-proj-orbit": null,
            },
          },
        },
      });
      expect(args.buildReplacePaths?.(current)).toEqual([
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
        "channels.mattermost.accounts.alice-proj-orbit.groupAllowFrom",
      ]);
      return { mode: "rpc", attempts: 1 };
    });
    const rpc = mkGatewayRpc({
      configPatchAndWaitForChange: vi.fn(async () => ({ ok: true })),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddCustomerConfigPatch(
        aliceSnapshot({ mattermostUserId: null, customerMmUserId: null }),
        { _coachPersonalToken: "pat-1" },
      ),
    ).rejects.toThrow(/account fragment was empty/);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("does not reuse a stale lifecycle owner id when the broker explicitly clears it", async () => {
    const brokerSnapshot = aliceSnapshot({
      mattermostUserId: null,
      customerMmUserId: null,
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => brokerSnapshot) }),
      rpc: mkGatewayRpc({
        configPatchAndWaitForChange: vi.fn(async () => ({ ok: true })),
      }),
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddCustomerConfigPatch(
        aliceSnapshot({ mattermostUserId: ALICE_OWNER_MM_ID }),
        { _coachPersonalToken: "pat-1" },
      ),
    ).rejects.toThrow(/account fragment was empty/);
  });
});

describe("buildBrokeredLifecycleAdapter template files", () => {
  const previousTemplatesDir = process.env.OCTOGEE_TEMPLATES_DIR;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-templates-"));
    process.env.OCTOGEE_TEMPLATES_DIR = tempRoot;
    await fs.mkdir(path.join(tempRoot, "tiers", "trial"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "tiers", "trial", "AGENTS.md"), "Agent {{slug}}\n");
    await fs.writeFile(path.join(tempRoot, "tiers", "trial", "TOOLS.md"), "Tools\n");
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (previousTemplatesDir === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
    else process.env.OCTOGEE_TEMPLATES_DIR = previousTemplatesDir;
  });

  it("seeds customer-owned context files and removes legacy gitignore entries", async () => {
    const customerDir = path.join(tempRoot, "customers", "alice");
    await fs.mkdir(customerDir, { recursive: true });
    await fs.writeFile(
      path.join(customerDir, ".gitignore"),
      "AGENTS.md\nTOOLS.md\n.ssh/\n",
    );
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.writeCustomerTemplateFiles({
      uid: "uid-alice",
      slug: "alice",
      tier: "trial",
      ownerName: "Alice",
      customerDir,
      today: "2026-06-25",
      username: "alice",
      templateVars: { slug: "alice" },
      userData: {},
    });

    expect(fsSync.readFileSync(path.join(customerDir, "AGENTS.md"), "utf-8")).toBe(
      "Agent alice\n",
    );
    expect(fsSync.existsSync(path.join(customerDir, "TOOLS.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(customerDir, "memory"))).toBe(false);
    expect(fsSync.readFileSync(path.join(customerDir, ".gitignore"), "utf-8")).toBe(
      ".ssh/\n",
    );
  });
});

describe("buildBrokeredLifecycleAdapter remove config patch", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
    routingActivationMocks.stopStale.mockClear();
    routingActivationMocks.discardForCustomers.mockClear();
  });

  it.each(["ordinary", "orphaned import"])("holds export through %s removal's config and secret mutations", async (mode) => {
    await fs.mkdir(path.join(testRuntime.dir, "customers", "alice"), { recursive: true });
    const procRoot = path.join(testRuntime.dir, "removal-proc");
    await fs.mkdir(procRoot, { recursive: true });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    secretMocks.updateMattermostAccountSecrets.mockImplementationOnce(async () => {
      await pending;
      return { changed: true };
    });
    secretMocks.exportActivationManifestWithSecret.mockClear();
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } }, bindings: [] });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, procRoot, log: vi.fn() });
    const removing = mode === "ordinary"
      ? adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach")
      : adapter.removeImportedCustomerBySlug!("alice");
    let exported: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalled());
      exported = adapter.exportOpenClawActivationManifest!("alice").catch((error) => error);
      await Promise.resolve();
      await Promise.resolve();
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally {
      release();
      await removing;
    }
    await exported;
    expect(secretMocks.exportActivationManifestWithSecret).toHaveBeenCalledOnce();
  });

  // 2026.7.2 refuses any config write whose canonical roster drops entries
  // unless the write carries `allowedAgentRosterRemovals`, which only openclaw's
  // own `agents.delete` supplies. A removal is therefore one RPC per departing
  // agent plus an accounts-only patch.
  it("deletes the customer's rostered agents and sends a patch with no agents key", async () => {
    const current = {
      agents: {
        entries: keyedRoster([
          "octogee-ops-eggman",
          "octogee-alice-coach",
          "octogee-alice-proj-old-coach",
        ]),
      },
      bindings: [
        { agentId: "octogee-ops-eggman" },
        {
          agentId: "octogee-ops-eggman",
          match: { channel: "mattermost", accountId: "alice-coach" },
        },
        { agentId: "octogee-alice-coach" },
        { agentId: "octogee-alice-proj-old-coach" },
      ],
      channels: {
        mattermost: {
          accounts: { "alice-coach": {}, "alice-proj-old": {}, "ops-coach": {} },
        },
      },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-coach", deleteFiles: false });
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-proj-old-coach", deleteFiles: false });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => Record<string, unknown>;
      buildReplacePaths?: (current: unknown) => string[];
    };
    const patch = args.buildPatch(current);
    expect(patch).toEqual({
      channels: {
        mattermost: { accounts: { "alice-coach": null, "alice-proj-old": null } },
      },
    });
    expect(patch).not.toHaveProperty("agents");
    expect(patch).not.toHaveProperty("bindings");
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigReplacePaths(current, "alice"),
    );
    expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
      rpc,
      {
        currentSlug: "alice",
        desiredAccountIds: [],
        evictionSlugs: [],
      },
      expect.any(Function),
    );
    expect(routingActivationMocks.discardForCustomers).toHaveBeenCalledWith(
      testRuntime.dir,
      ["alice"],
    );
    expect(routingActivationMocks.stopStale.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.discardForCustomers.mock.invocationCallOrder[0]!,
    );
    expect(routingActivationMocks.discardForCustomers.mock.invocationCallOrder[0]).toBeLessThan(
      secretMocks.updateMattermostAccountSecrets.mock.invocationCallOrder[0]!,
    );
  });

  it("waits for config.changed before stopping the removed account monitor", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configPatchAndWaitForChange = vi.fn(async () => ({ hash: "h2", config: {} }));
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) =>
      options.rpc.configPatch({}, "h1")
    );

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    expect(configPatchAndWaitForChange).toHaveBeenCalledWith({}, "h1", undefined);
    expect(configPatchAndWaitForChange.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.stopStale.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes every departing agent in the batch with one config mutation", async () => {
    const current = {
      agents: {
        entries: keyedRoster([
          "octogee-alice-coach",
          "octogee-bob-coach",
          "octogee-bob-proj-orbit-coach",
          "octogee-carol-coach",
        ]),
      },
      bindings: [],
      channels: {
        mattermost: {
          accounts: { "alice-coach": {}, "bob-coach": {}, "bob-proj-orbit": {}, "carol-coach": {} },
        },
      },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const batch = ["alice", "bob"] as const;

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach", batch);
    await adapter.applyRemoveCustomerConfigPatch("bob", "octogee-bob-coach", batch);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-alice-coach",
      "octogee-bob-coach",
      "octogee-bob-proj-orbit-coach",
    ]);

    const args = vi.mocked(applyConfigPatch).mock.calls[0]![0] as {
      buildPatch: (current: unknown) => {
        channels: { mattermost: { accounts: Record<string, null> } };
      };
    };
    expect(args.buildPatch(current).channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "bob-coach": null,
      "bob-proj-orbit": null,
    });
  });

  it("tolerates an agent openclaw already deleted so a retried eviction still finishes", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current, {
      agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => {
        throw new OpenclawWireError("rpc-error", `agent "${agentId}" not found`);
      }),
    } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
  });

  it("fails the eviction before mutating config when a delete is refused", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-old-coach"]) },
    };
    const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => {
      throw new OpenclawWireError("rpc-error", `agent "${agentId}" is the default`);
    });
    const rpc = mkRemovalRpc(current, { agentsDelete } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).rejects.toThrow(/octogee-alice-coach.*octogee-alice-proj-old-coach/s);

    expect(agentsDelete).toHaveBeenCalledTimes(2);
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("re-reads the roster after deleting so the accounts patch never rides a pre-delete hash", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    const options = patchMocks.applyConfigPatch.mock.calls.at(-1)![1];
    expect(options.cache).toEqual({ current: undefined, hash: "" });
  });

  it("does not replay a completed config mutation when secret cleanup retries", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    secretMocks.updateMattermostAccountSecrets.mockRejectedValueOnce(
      new Error("secret file busy"),
    );

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).rejects.toThrow("secret file busy");
    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    expect(rpc.agentsDelete).toHaveBeenCalledTimes(1);
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledTimes(2);
  });

  function realPatchOnce(): void {
    patchMocks.applyConfigPatch.mockImplementationOnce(
      (...[args, options]: Parameters<typeof realApplyConfigPatch>) => realApplyConfigPatch(args, options),
    );
  }

  function casLostOnce() {
    return vi.fn()
      .mockRejectedValueOnce(new OpenclawWireError(
        "hash-mismatch",
        "config changed since last load; re-run config.get and retry",
      ))
      .mockResolvedValue({ ok: true });
  }

  it("rebuilds the removal from a fresh config.get and completes the eviction after losing the config CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => ["alice"]),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(2);
    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("retries a signed unmount removal from a fresh config.get after a concurrent unmount wins the config CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(2);
    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("stops retrying and keeps the Builder's accounts when it is desired here again after losing the CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const log = vi.fn();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => []),
    ).resolves.toEqual([]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[remove:alice\].*alice.*desired on this gateway/));
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: [], removePrefixes: [] },
    );
  });

  it("retries only the batch slugs that are still evicted after losing the CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-bob-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {}, "bob-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach", ["alice", "bob"], async () => ["alice"]),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
  });

  it("fails the eviction loudly without touching secrets when the removal patch is rejected", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configPatchAndWaitForChange = vi.fn(async () => {
      throw new OpenclawWireError("invalid-patch", "channels.mattermost.accounts: bad shape");
    });
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => ["alice"]),
    ).rejects.toMatchObject({ code: "invalid-patch" });

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(1);
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("preserves refreshed secrets when the Builder is re-admitted after config quarantine", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkRemovalRpc(current),
      log: vi.fn(),
    });

    await expect(
      adapter.applyRemoveCustomerConfigPatch(
        "alice",
        "octogee-alice-coach",
        ["alice"],
        async () => [],
      ),
    ).resolves.toEqual([]);

    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: [], removePrefixes: [] },
    );
  });

  it("deletes the legacy list roster's customer agents too", async () => {
    const current = {
      agents: { list: [{ id: "octogee-ops-eggman" }, { id: "octogee-alice-coach" }] },
      bindings: [],
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(1);
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-coach", deleteFiles: false });
  });
});

describe("buildBrokeredLifecycleAdapter add config patch", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
    routingActivationMocks.pending = false;
    routingActivationMocks.capture.mockClear();
    routingActivationMocks.activate.mockReset().mockImplementation(async () => undefined);
    routingActivationMocks.mark.mockClear();
    vi.stubEnv("OPENAI_EMBEDDINGS_ENABLED", "true");
    vi.stubEnv("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-small");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["builder", "shared"])("keeps %s account endpoint ownership through a full remount", async (gatewayClass) => {
    vi.stubEnv("GATEWAY_CLASS", gatewayClass);
    stubBuilderClaim(gatewayClass === "builder" ? "alice" : "");
    const snapshot = aliceSnapshot({ projectAgents: [
      { projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "orbit-pat", status: "ready" },
      { projectId: "scout", enabled: true, mmUserId: "bot-scout", token: "scout-pat", status: "ready" },
    ] });
    const config = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-orbit-coach", "octogee-alice-proj-scout-coach"]) },
      channels: { mattermost: { accounts: {
        default: { baseUrl: "${MM_URL}" },
        "alice-coach": { baseUrl: "https://owner-coach.example" },
        "alice-proj-orbit": { baseUrl: "https://owner-orbit.example" },
      } } },
    };
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc(config)), log: vi.fn(),
      isBuilderGateway: () => gatewayClass === "builder",
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "coach-pat" });

    const accounts = patch!.channels.mattermost.accounts;
    expect(accounts["alice-coach"].baseUrl).toBe(gatewayClass === "builder" ? "https://owner-coach.example" : "${MM_URL}");
    expect(accounts["alice-proj-orbit"].baseUrl).toBe(gatewayClass === "builder" ? "https://owner-orbit.example" : "${MM_URL}");
    expect(accounts["alice-proj-scout"].baseUrl).toBe("${MM_URL}");
  });

  it("retains a ready project agent when restoring a seeded migration snapshot", async () => {
    const projectId = "octogee-alice-proj-orbit-coach";
    const snapshot = aliceSnapshot({
      status: "complete",
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", status: "ready" }],
    });
    const config = { agents: { entries: keyedRoster(["octogee-alice-coach", projectId]) } };
    const rpc = mkGatewayRpc(rosterRpc(config));
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    adapter.seedUserSnapshotForMigration!(snapshot);
    let patch: Record<string, any>;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, null);

    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patch!.agents.entries).toHaveProperty(projectId);
    expect(patch!.channels.mattermost.accounts).toHaveProperty("alice-proj-orbit");
    expect(patch!.bindings).toContainEqual({
      agentId: projectId,
      match: { channel: "mattermost", accountId: "alice-proj-orbit", peer: { kind: "group", id: "orbit-general" } },
    });
  });

  it.each([
    { mode: "mount", failPublication: false, initial: false }, { mode: "configured Builder", failPublication: false, initial: false },
    { mode: "mount", failPublication: true, initial: false }, { mode: "configured Builder", failPublication: true, initial: false },
    { mode: "mount", failPublication: false, initial: true }, { mode: "configured Builder", failPublication: false, initial: true },
    { mode: "mount", failPublication: false, failFinalization: true, initial: false },
    { mode: "configured Builder", failPublication: false, failFinalization: true, initial: false },
  ])("exports only after $mode project publication settles (failed: $failPublication, initial: $initial, finalization failed: $failFinalization)", async ({ mode, failPublication, failFinalization, initial }) => {
    const { updateMattermostAccountSecrets } = await vi.importActual<typeof import("../lib/mattermost-account-secrets.js")>("../lib/mattermost-account-secrets.js");
    const snapshot = aliceSnapshot({ status: "complete", channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }], projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    const coachId = "octogee-alice-coach";
    const projectId = "octogee-alice-proj-orbit-coach";
    let config: Record<string, any> = {
      agents: { entries: { [coachId]: { workspace: path.join(testRuntime.dir, "customers/alice") } } },
      channels: { mattermost: { accounts: { "alice-coach": {
        botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" }, allowFrom: [ALICE_OWNER_MM_ID],
      } } } },
      bindings: [{ agentId: coachId, match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    await updateMattermostAccountSecrets(testRuntime.dir, { set: { "alice-coach": "coach-pat" } });
    const fingerprints = new Map(initial ? [] : [["alice", "stable-before-project"]]);
    const fingerprintPath = path.join(testRuntime.dir, "applied-fingerprints.json");
    saveAppliedFingerprints(fingerprintPath, fingerprints);
    const hooks = createReconcileConvergenceHooks({
      customerSource: async () => new Map([...fingerprints].map(([slug, fingerprint]) => [slug, { fingerprint, lane: "move" as const }])),
      appliedFp: fingerprints,
      cloneRetry: new Map(),
      persistAppliedFp: () => saveAppliedFingerprints(fingerprintPath, fingerprints),
    });
    let releasePublication!: () => void;
    const runtimePublication = {
      settled: new Promise<void>((resolve) => { releasePublication = resolve; }),
      invalidateFingerprint: () => hooks.recordApplied("alice", ""),
    };
    secretMocks.updateMattermostAccountSecrets.mockImplementation(updateMattermostAccountSecrets);
    secretMocks.exportActivationManifestWithSecret.mockClear();
    let releaseProfiles!: () => void;
    const profiles = new Promise<void>((resolve) => { releaseProfiles = resolve; });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(async () => {
      await profiles;
      return { materialized: 1, deferred: [] };
    });
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        if (!config.agents.entries[name]) {
          config.agents.entries[name] = { workspace };
          await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
        }
        return { ok: true, agentId: name, name, workspace };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [
        { accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 },
      ] } })),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      if (failPublication) throw new Error("project configuration refused");
      const patch = args.buildPatch(config) as Record<string, any>;
      config = {
        ...config,
        agents: { ...config.agents, entries: { ...config.agents.entries, ...patch.agents.entries } },
        channels: { mattermost: { accounts: { ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts } } },
        bindings: patch.bindings,
      };
      await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    const publishing = mode === "mount"
      ? adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "coach-pat" }, { runtimePublication })
      : adapter.reconcileConfiguredBuilderProjectAgents!(snapshot, { runtimePublication });
    const publicationResult = publishing.then((result) => result, (error) => error);
    let exported: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(config.agents.entries[projectId]).toBeDefined());
      expect(config.channels.mattermost.accounts["alice-proj-orbit"]).toBeUndefined();
      exported = adapter.exportOpenClawActivationManifest!("alice").then((value) => value, (error) => error);
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally {
      releaseProfiles();
      const result = await publicationResult;
      secretMocks.updateMattermostAccountSecrets.mockReset().mockResolvedValue({ changed: true });
      try {
        expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
        if (failPublication) expect(result).toMatchObject({ message: "project configuration refused" });
        else {
          const finalizing = finalizeConvergedMount({
            now: 1_000, slug: "alice", uid: "uid-alice", prior: undefined,
            desiredFingerprint: snapshotConfigFingerprint(snapshot),
            result: { ...result, pendingProjectClones: [] }, hooks,
            stampMounted: async () => {
              expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
              if (failFinalization) throw new Error("mount stamp failed");
            },
            writeMountMarker: vi.fn(),
          });
          if (failFinalization) await expect(finalizing).rejects.toThrow("mount stamp failed");
          else await finalizing;
        }
      } finally {
        releasePublication();
      }
    }
    if (failPublication || failFinalization) {
      await expect(exported).resolves.toMatchObject({ message: expect.stringContaining("no applied fingerprint") });
      return;
    }
    await expect(exported).resolves.toMatchObject({
      slug: "alice", appliedFingerprint: snapshotConfigFingerprint(snapshot), mattermostAccount: { botToken: "coach-pat" },
      projectAgents: [{ agentId: projectId, accountId: "alice-proj-orbit", mattermostAccount: { botToken: "project-pat" } }],
    });
  });

  it.each([
    ["Builder", "alice", [`mattermost:${ALICE_OWNER_MM_ID}`]],
    ["shared", "", undefined],
  ] as const)("names the owner as the native OpenClaw command owner only on a %s gateway", async (_label, builderSlug, ownerAllowFrom) => {
    stubBuilderClaim(builderSlug);
    const snapshot = aliceSnapshot();
    let patch: { commands?: { ownerAllowFrom?: unknown } } | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch({}) as typeof patch;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc({})),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    expect(patch?.commands?.ownerAllowFrom).toEqual(ownerAllowFrom);
  });

  it("reports project readiness after reloading credentials and activating routing", async () => {
    const events: string[] = [];
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const agentId = "octogee-alice-proj-orbit-coach";
    const match = { channel: "mattermost", accountId: "alice-proj-orbit" };
    const config = {
      agents: { entries: { [agentId]: { id: agentId } } },
      channels: { mattermost: { accounts: { "alice-proj-orbit": {} } } },
      bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }],
    };
    routingActivationMocks.activateAfterPatch.mockImplementationOnce(async () => { events.push("routing"); });
    const rpc = mkGatewayRpc({
      ...rosterRpc(config),
      secretsReload: vi.fn(async () => { events.push("secrets"); return { ok: true, warningCount: 0 }; }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    const client = mkClient({
      userSnapshot: vi.fn(async () => snapshot),
      reportProjectAgentReadiness: vi.fn(async () => { events.push("report"); }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });
    expect(events).toEqual(["secrets", "routing", "report"]);
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [{
      projectId: "orbit", activationId: "activation-1", tokenHash: expect.any(String), channelIds: ["orbit-general"],
    }]);
  });

  it("stops the superseded secrets.reload wait and skips the second reload when the add mount is cancelled", async () => {
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const controller = new AbortController();
    const cancelled = new Error("mount deadline exceeded");
    const rpc = mkGatewayRpc({
      ...rosterRpc({}),
      secretsReload: vi.fn(async () => {
        controller.abort(cancelled);
        throw new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn(),
    });

    await expect(adapter.applyAddCustomerConfigPatch(
      snapshot, { _coachPersonalToken: "pat-1" }, { signal: controller.signal },
    )).rejects.toBe(cancelled);

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });

  it("reports a connected project even when another routing activation failed", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const match = { channel: "mattermost", accountId: "alice-proj-orbit" };
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const rpc = mkGatewayRpc({
      ...rosterRpc({ agents: { entries: { [agentId]: {} } }, channels: { mattermost: { accounts: { "alice-proj-orbit": {} } } },
        bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }] }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    routingActivationMocks.activateAfterPatch.mockRejectedValueOnce(new Error("unrelated account could not connect"));
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" }))
      .rejects.toThrow("unrelated account could not connect");
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [expect.objectContaining({ projectId: "orbit" })]);
  });

  it.each([false, true])("reconciles a configured Builder project without changing its owner (already rostered: %s)", async (rostered) => {
    const snapshot = aliceSnapshot({
      status: "complete",
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const coach = { model: "owner-model", tools: { allow: ["owner-tool"] }, workspace: "/owner/workspace" };
    const projectAgentId = "octogee-alice-proj-orbit-coach";
    let deleted = rostered;
    let config: Record<string, any> = {
      agents: { entries: {
        "octogee-alice-coach": coach,
        ...(rostered ? { [projectAgentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/orbit") } } : {}),
      }, defaults: { model: "owner-default" } },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "owner-coach-token" } } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        deleted = false;
        if (rostered) throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
        return { ok: true, agentId: name, name, workspace };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      if (deleted) throw new Error("agent database is unavailable while agent is deleted");
      const patch = args.buildPatch(config) as Record<string, any>;
      config = {
        ...config,
        agents: { ...config.agents, entries: { ...config.agents.entries, ...patch.agents.entries } },
        channels: { mattermost: { accounts: Object.fromEntries(Object.entries({ ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts })
          .map(([accountId, account]) => [accountId, { ...config.channels.mattermost.accounts[accountId], ...(account as object) }])) } },
        bindings: patch.bindings,
      };
      return { mode: "rpc", attempts: 1 };
    });
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);
    expect(config.agents.entries["octogee-alice-coach"]).toEqual(coach);
    expect(config.agents.defaults).toEqual({ model: "owner-default" });
    expect(config.channels.mattermost.accounts["alice-coach"]).toEqual({ botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] });
    expect(config.agents.entries["octogee-alice-proj-orbit-coach"]).toMatchObject({ workspace: expect.stringContaining("/projects/orbit") });
    expect(rpc.agentsCreate).toHaveBeenCalledExactlyOnceWith({
      name: projectAgentId, workspace: expect.stringContaining("/projects/orbit"),
    });
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(rpc, expect.any(String), expect.any(Function), { restartAccountIds: ["alice-proj-orbit"] });
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [expect.objectContaining({ projectId: "orbit", activationId: "activation-1" })]);
  });

  it("withholds project readiness while model profile materialization is deferred", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: ["octogee-alice-proj-orbit-coach"] });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.reconcileConfiguredBuilderProjectAgents!(snapshot)).rejects.toThrow("Agent model profiles are not ready");
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).not.toHaveBeenCalled();
    expect(rpc.secretsReload).not.toHaveBeenCalled();
  });

  it("withholds initial Project Agent activation while model profiles are deferred", async () => {
    routingActivationMocks.activateAfterPatch.mockClear();
    const snapshot = aliceSnapshot({ projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: ["octogee-alice-proj-orbit-coach"] });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const rpc = mkGatewayRpc(rosterRpc({}));
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" })).rejects.toThrow("Agent model profiles are not ready");
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    expect(routingActivationMocks.activateAfterPatch).not.toHaveBeenCalled();
  });

  it.each([
    ["configured", "config timeout"], ["configured", "secret reload failed"],
    ["initial", "config timeout"], ["initial", "secret reload failed"],
    ["configured", "partial sweep"], ["initial", "partial sweep"],
  ])("retries %s project secrets before readiness after %s", async (phase, failure) => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const accountId = "alice-proj-orbit";
    const match = { channel: "mattermost", accountId };
    const snapshot = aliceSnapshot({
      status: "complete",
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const config = {
      agents: { entries: { "octogee-alice-coach": {}, [agentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/orbit") } } },
      channels: { mattermost: { accounts: { "alice-coach": { allowFrom: [ALICE_OWNER_MM_ID] }, [accountId]: {} } } },
      bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 1, deferred: [] }).mockReturnValueOnce({ materialized: 0, deferred: [] }).mockReturnValueOnce({ materialized: 0, deferred: [] });
    if (failure === "partial sweep") {
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReset();
      brokerCatalogMocks.materializeBrokerProfilesForAgents
        .mockReturnValueOnce({ materialized: 1, deferred: [agentId] })
        .mockReturnValue({ materialized: 0, deferred: [] });
    }
    secretMocks.updateMattermostAccountSecrets.mockResolvedValue({ changed: false });
    patchMocks.applyConfigPatch.mockImplementation(async (args) => {
      args.buildPatch(config);
      return { mode: "rpc", attempts: 1, noop: true };
    });
    if (failure === "config timeout") patchMocks.applyConfigPatch.mockRejectedValueOnce(new Error(failure));
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId, running: true, connected: true, lastStartAt: 2 }] } })),
    });
    if (failure === "secret reload failed") rpc.secretsReload = vi.fn().mockRejectedValueOnce(new Error(failure)).mockResolvedValue({ ok: true });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    const reconcile = () => phase === "initial"
      ? adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" })
      : adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);

    await expect(reconcile()).rejects.toThrow(failure === "partial sweep" ? "Agent model profiles are not ready" : failure);
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    rpc.secretsReload.mockClear();
    await reconcile();

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(client.reportProjectAgentReadiness.mock.invocationCallOrder[0]);
    rpc.secretsReload.mockClear();
    await reconcile();
    expect(rpc.secretsReload).not.toHaveBeenCalled();
    secretMocks.updateMattermostAccountSecrets.mockResolvedValue({ changed: true });
    patchMocks.applyConfigPatch.mockImplementation(async () => ({ mode: "rpc", attempts: 1 }));
  });

  it("removes a retired project account from config and secrets before deleting its agent", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [], channels: [] });
    const retiredAgentId = "octogee-alice-proj-old-coach";
    const retiredAccountId = "alice-proj-old";
    let config: Record<string, any> = {
      agents: { entries: {
        "octogee-alice-coach": { model: "owner-model" },
        [retiredAgentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/old") },
      } },
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] },
        [retiredAccountId]: { botToken: mattermostAccountSecretRef(retiredAccountId) },
      } } },
      bindings: [
        { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
        { agentId: retiredAgentId, match: { channel: "mattermost", accountId: retiredAccountId } },
      ],
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
    });
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      const accounts = { ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts };
      for (const [accountId, account] of Object.entries(accounts)) if (account === null) delete accounts[accountId];
      config = { ...config, channels: { mattermost: { accounts } }, bindings: patch.bindings };
      return { mode: "rpc", attempts: 1 };
    });
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);

    expect(patch!.channels.mattermost.accounts[retiredAccountId]).toBeNull();
    expect(config.channels.mattermost.accounts[retiredAccountId]).toBeUndefined();
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: retiredAgentId, deleteFiles: false });
    const deletedAt = vi.mocked(rpc.agentsDelete).mock.invocationCallOrder[0]!;
    expect(patchMocks.applyConfigPatch.mock.invocationCallOrder[0]).toBeLessThan(deletedAt);
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: retiredAccountId });
    expect(vi.mocked(rpc.channelsStop).mock.invocationCallOrder[0]).toBeLessThan(deletedAt);
    const removal = secretMocks.updateMattermostAccountSecrets.mock.calls.findIndex(
      ([, change]) => (change as { remove?: string[] }).remove?.includes(retiredAccountId),
    );
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(secretMocks.updateMattermostAccountSecrets.mock.invocationCallOrder[removal]).toBeLessThan(deletedAt);
  });

  it("routes a new workspace session on a configured Builder without platform projects", async () => {
    secretMocks.updateMattermostAccountSecrets.mockClear();
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [], channels: [
      { scope: "workspace", kind: "general", channelId: "general-channel" },
      { scope: "workspace", kind: "session", channelId: "task-channel" },
      { scope: "workspace", kind: "admin", channelId: "admin-channel" },
      { scope: "project", kind: "general", projectId: "disabled", channelId: "disabled-project-channel" },
    ] });
    const coach = { model: "owner-model", tools: { allow: ["owner-tool"] } };
    const customRoute = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "general-channel" } } };
    const config = {
      agents: { entries: { "octogee-alice-coach": coach } },
      commands: { ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] } } } },
      bindings: [customRoute],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const rpc = mkGatewayRpc(rosterRpc(config));
    let patch: unknown;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config);
      expect(args.buildReplacePaths?.(config)).toEqual(["bindings"]);
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    const result = await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
    expect(patch).toEqual({ bindings: [customRoute, {
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "task-channel" } },
    }] });
    expect(result.appliedFingerprint).toBe(snapshotConfigFingerprint(snapshot));
    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("makes the owner the native OpenClaw owner on a configured Builder without platform projects", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const coachAccount = { botToken: "owner-coach-token", dmPolicy: "disabled", groupPolicy: "open" };
    const config = {
      agents: { entries: { "octogee-alice-coach": {} } },
      channels: { mattermost: { accounts: { "alice-coach": coachAccount } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const rpc = mkGatewayRpc(rosterRpc(config));
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      expect(args.buildPatch(config)).toEqual({
        commands: { ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] },
        channels: { mattermost: { accounts: { "alice-coach": { allowFrom: [ALICE_OWNER_MM_ID] } } } },
      });
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
  });

  it("discovers deleted platform projects from authored config despite RPC secret redaction and retires runtime before credentials", async () => {
    const events: string[] = [];
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const orphanId = "octogee-alice-proj-deleted-coach";
    const importedId = "octogee-alice-proj-imported-coach";
    const config = {
      agents: { entries: { [orphanId]: { id: orphanId }, [importedId]: { id: importedId } } },
      channels: { mattermost: { accounts: {
        "alice-proj-deleted": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-deleted" } },
        "alice-proj-imported": { botToken: { source: "file", provider: "octogee-mattermost", id: "/owner-custom" } },
      } } },
      bindings: [
        { agentId: orphanId, match: { channel: "mattermost", accountId: "alice-proj-deleted" } },
        { agentId: orphanId, match: { channel: "mattermost", accountId: "alice-proj-deleted", peer: { kind: "group", id: "deleted-channel" } } },
        { agentId: importedId, match: { channel: "mattermost", accountId: "alice-proj-imported" } },
      ],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const redacted = structuredClone(config);
    for (const account of Object.values(redacted.channels.mattermost.accounts)) {
      account.botToken.id = "__OPENCLAW_REDACTED__";
    }
    const rpc = mkGatewayRpc(rosterRpc(redacted));
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch(config) as Record<string, any>;
      expect(patch.channels.mattermost.accounts).toEqual({ "alice-proj-deleted": null });
      expect(patch.bindings).toEqual([config.bindings[2]]);
      events.push("patch");
      return { mode: "rpc", attempts: 1 };
    });
    secretMocks.updateMattermostAccountSecrets.mockImplementationOnce(async () => ({ changed: true }))
      .mockImplementationOnce(async (_dir, change) => {
        expect(change.remove).toEqual(["alice-proj-deleted"]);
        events.push("remove-secret");
        return { changed: true };
      });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: orphanId, deleteFiles: false });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "alice-proj-deleted" });
    expect(events).toEqual(["patch", "remove-secret"]);
  });

  it("refreshes runtime credentials before activating changed routing bindings", async () => {
    const events: string[] = [];
    routingActivationMocks.activate.mockImplementationOnce(async () => {
      events.push("routing-activation");
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      events.push("config-patch");
      args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });
      return { mode: "rpc" as const, attempts: 1 };
    });
    const rpc = {
      channelsStop: vi.fn(async () => {
        events.push("channels-stop");
        return { channel: "mattermost", accountId: "alice-coach", stopped: true };
      }),
      channelsStart: vi.fn(async () => {
        events.push("channels-start");
        return { channel: "mattermost", accountId: "alice-coach", started: true };
      }),
      gatewayRestartRequest: vi.fn(async () => {
        events.push("gateway-restart");
        return { status: "requested" };
      }),
      isGatewayUp: vi.fn(async () => true),
      ...rosterRpc(),
      secretsReload: vi.fn(async () => {
        events.push("secrets-reload");
        return { ok: true, warningCount: 0 };
      }),
    } as unknown as GatewayRpcClient;
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
      ],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    expect(client.reconcileProjectCoachMembership).toHaveBeenCalledWith("uid-alice");
    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).toHaveBeenCalledOnce();
    expect(events).toEqual(["config-patch", "secrets-reload", "routing-activation"]);
  });

  describe("mount secrets.reload gate", () => {
    const aliceSnapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };
    const coachRef = { source: "file", provider: "octogee-mattermost", id: "/alice-coach" };
    const mountedConfig = {
      agents: { list: [{ id: "octogee-alice-coach" }] },
      bindings: [],
      channels: { mattermost: { accounts: { "alice-coach": { botToken: coachRef } } } },
    };

    function unchangedMountInputs() {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: false });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
    }

    function mountAdapter(rpc: ReturnType<typeof rosterRpc>) {
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: { isGatewayUp: vi.fn(async () => true), ...rpc } as unknown as GatewayRpcClient,
        log,
      });
      return { adapter, log };
    }

    it("skips secrets.reload when a remount writes no secret material and patches nothing", async () => {
      unchangedMountInputs();
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload skipped — no secret material changed");
    });

    it("skips secrets.reload when the config patch touches no SecretRef", async () => {
      unchangedMountInputs();
      const before = { ...mountedConfig, bindings: [] };
      const after = { ...mountedConfig, bindings: [{ agentId: "octogee-alice-coach", match: {} }] };
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(before);
        return { mode: "rpc" as const, attempts: 1 };
      });
      const rpc = rosterRpc(after);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload skipped — no secret material changed");
    });

    it("reloads when the config patch adds a SecretRef", async () => {
      unchangedMountInputs();
      const before = { ...mountedConfig, channels: { mattermost: { accounts: {} } } };
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(before);
        return { mode: "rpc" as const, attempts: 1 };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "[add:alice] secrets.reload — SecretRef added at channels.mattermost.accounts.alice-coach.botToken",
      );
    });

    it("reloads when the Mattermost account secrets file changed", async () => {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: true });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload — Mattermost account secrets file changed");
    });

    it("reloads when broker model profiles were materialized", async () => {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: false });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 2, deferred: [] });
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload — broker model profiles materialized for 2 agent(s)");
    });
  });

  it("preserves isolated coach policy while refreshing no-op routing monitors", async () => {
    stubBuilderClaim("alice");
    routingActivationMocks.pending = true;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: {
          mattermost: {
            accounts: { "alice-coach": { dmPolicy: "open", allowFrom: ["*"] } },
          },
        },
      }) as {
        agents: { list: Array<{ id?: string; tools?: unknown }> };
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
      expect(
        patch.agents.list.find((agent) => agent.id === "octogee-alice-proj-orbit-coach"),
      ).not.toHaveProperty("tools");
      expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
        dmPolicy: "disabled",
        allowFrom: [ALICE_OWNER_MM_ID],
        groupPolicy: "open",
        groups: null,
      });
      expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).not.toBeNull();
      return { mode: "rpc", attempts: 1, noop: true };
    });
    const rpc = mkGatewayRpc();
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
      isBuilderGateway: () => true,
    });

    await adapter.applyAddCustomerConfigPatch(
      aliceSnapshot({
        channels: [
          { scope: "workspace", kind: "general", channelId: "workspace-general" },
          { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
        ],
        projectAgents: [
          { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        ],
      }),
      { _coachPersonalToken: "pat-1" },
    );

    expect(client.reconcileProjectCoachMembership).toHaveBeenCalledWith("uid-alice");
    expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
      rpc,
      {
        currentSlug: "alice",
        desiredAccountIds: ["alice-coach", "alice-proj-orbit"],
        evictionSlugs: [],
      },
      expect.any(Function),
    );
    expect(routingActivationMocks.mark).toHaveBeenCalledWith(
      expect.any(String),
      "[add:alice] account-level Mattermost binding changed",
      ["alice-coach", "alice-proj-orbit"],
      { "alice-coach": 0, "alice-proj-orbit": 0 },
    );
    expect(routingActivationMocks.activateAfterPatch).toHaveBeenCalledWith(
      rpc,
      expect.any(String),
      expect.any(Function),
      {
        accountIds: ["alice-coach", "alice-proj-orbit"],
        baseline: { "alice-coach": 0, "alice-proj-orbit": 0 },
        configNoop: true,
        required: true,
        reason: "[add:alice] account-level Mattermost binding changed",
        currentSlug: "alice",
        evictionSlugs: [],
        restartAccountIds: [],
      },
    );
  });

  it("takes shared coach approval authorization from the owner's Mattermost id", async () => {
    const builderMmUserId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const brokerSnapshot = aliceSnapshot({
      mattermostUserId: builderMmUserId,
      customerMmUserId: builderMmUserId,
    });
    const client = mkClient({ userSnapshot: vi.fn(async () => brokerSnapshot) });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      }) as {
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };

      expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
        dmPolicy: "disabled",
        allowFrom: [builderMmUserId],
        groupPolicy: "open",
      });
      return { mode: "rpc", attempts: 1, noop: true };
    });

    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(
      aliceSnapshot({
        mattermostUserId: builderMmUserId,
        channels: [{ scope: "workspace", kind: "general", channelId: "workspace-general" }],
      }),
      { _coachPersonalToken: "pat-1" },
    );
  });

  it("holds a project agent out of the patch while its checkout is absent — its workspace dir does not exist yet", async () => {
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      }) as {
        agents: { list: Array<{ id: string }> };
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
      const ids = patch.agents.list.map((a) => a.id);
      expect(ids).toContain("octogee-alice-coach");
      expect(ids).not.toContain("octogee-alice-proj-orbit");
      expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).toBeUndefined();
      return { mode: "rpc", attempts: 1, noop: true };
    });
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(
      aliceSnapshot({
        channels: [
          { scope: "workspace", kind: "general", channelId: "workspace-general" },
          { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
        ],
        projectAgents: [
          { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        ],
      }),
      { _coachPersonalToken: "pat-1" },
      { withoutProjectIds: ["orbit"] },
    );

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
  });

  it("does not patch one customer's runtime when membership isolation fails", async () => {
    const client = mkClient({
      reconcileProjectCoachMembership: vi.fn(async () => {
        throw new Error("Mattermost unavailable");
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }),
    ).rejects.toThrow("Mattermost unavailable");
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
  });

  it("fails provisioning when the refreshed secret surface remains incomplete", async () => {
    const rpc = mkGatewayRpc({
      secretsReload: vi.fn(async () => ({ ok: false, warningCount: 0 })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }),
    ).rejects.toThrow(/secrets\.reload did not acknowledge success/);
  });

  it("waits for config persistence before requesting routing activation", async () => {
    const events: string[] = [];
    routingActivationMocks.capture.mockImplementationOnce(async (_rpc, accountIds) => {
      events.push("routing-baseline");
      return Object.fromEntries(accountIds.map((accountId) => [accountId, 0]));
    });
    routingActivationMocks.activate.mockImplementationOnce(async () => {
      events.push("routing-activation");
    });
    let publishConfigChanged: (() => void) | undefined;
    const configChanged = new Promise<void>((resolve) => {
      publishConfigChanged = resolve;
    });
    const rpc = {
      configPatch: vi.fn(async () => {
        events.push("config-persisted");
        return { ok: true as const, hash: "persisted-hash" };
      }),
      configPatchAndWaitForChange: vi.fn(async () => {
        events.push("config-persisted");
        await configChanged;
        events.push("config-changed");
        return { ok: true as const, hash: "persisted-hash" };
      }),
      gatewayRestartRequest: vi.fn(async () => {
        events.push("gateway-restart");
        return { status: "requested" };
      }),
      isGatewayUp: vi.fn(async () => true),
      ...rosterRpc(),
    } as unknown as GatewayRpcClient;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      _args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });
      await options.rpc.configPatch({}, "base-hash");
      return { mode: "rpc" as const, attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
      ],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    const applying = adapter.applyAddCustomerConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-1" },
    );
    await vi.waitFor(() => expect(events).toEqual(["routing-baseline", "config-persisted"]));

    publishConfigChanged?.();
    await applying;

    expect(events).toEqual([
      "routing-baseline",
      "config-persisted",
      "config-changed",
      "routing-activation",
    ]);
    expect(rpc.configPatch).not.toHaveBeenCalled();
    expect(rpc.configPatchAndWaitForChange).toHaveBeenCalledOnce();
  });

  it("preserves unrelated agents while explicitly confirming the full agent list replacement", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => { agents: { list: Array<{ id?: string }> } };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        list: [
          { id: "octogee-mac-default" },
          { id: "octogee-alice-coach", stale: true },
          { id: "octogee-bob-coach" },
        ],
      },
      bindings: [],
      channels: {
        mattermost: { accounts: { "alice-coach": { groupAllowFrom: ["mm-1"] } } },
      },
    };

    const patch = args.buildPatch(current);
    expect(patch.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-mac-default",
      "octogee-alice-coach",
      "octogee-bob-coach",
    ]);
    const rebuiltCoach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach") as
      | { model?: string; memory?: { search?: unknown } }
      | undefined;
    expect(rebuiltCoach?.model).toEqual({ primary: "platform-openrouter/deepseek/deepseek-v4-pro", fallbacks: [] });
    expect(rebuiltCoach?.memory?.search).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-alice-coach",
        },
      },
      model: "text-embedding-3-small",
    });
    expect(args.buildReplacePaths?.(current)).toEqual(expect.arrayContaining([
      ...customerConfigFullAgentListReplacePaths(current, "alice"),
      "plugins.allow", "secrets.providers.gcp-secret-manager.passEnv",
      "agents.defaults.model.fallbacks",
    ]));
  });

  it("pins a subscription-only coach pick to the platform default when mounting on a shared gateway", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "trial",
      selectedTier: "personal",
      gatewayId: "shared-0",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      onboardingVibe: null,
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
      byotActive: false,
      builderAgentDefault: {
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: [],
      },
      systemConfig: {
        agentModels: { "octogee-alice-coach": { primary: "openai/gpt-5.6-luna", fallbacks: [] } },
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string; model?: unknown }> };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const coach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(coach?.model).toEqual({ primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] });
  });

  it("puts a catalog Builder's final coach model and fallbacks in the initial mount patch", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "trial",
      selectedTier: "personal",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      onboardingVibe: null,
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
      byotActive: false,
      builderAgentDefault: {
        primary: "platform-openrouter/openai/gpt-5.6-luna",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: {
          defaults?: { models?: Record<string, unknown>; modelPolicy?: unknown };
          list: Array<{ id?: string; model?: unknown }>;
        };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const coach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(coach?.model).toEqual(snapshot.builderAgentDefault);
    expect(patch.agents.defaults?.models).toMatchObject({
      "platform-openrouter/openai/gpt-5.6-luna": canonicalCustomerModelDefinition("platform-openrouter/openai/gpt-5.6-luna"),
      "platform-openrouter/z-ai/glm-5.2": { alias: "glm", params: { thinking: "xhigh" } },
    });
    expect(patch.agents.defaults?.modelPolicy).toEqual({
      allow: ["anthropic/*", "platform-openrouter/*", "platform-openai/*"],
    });
  });

  it("puts a house-only coach's final model and tools in the initial mount patch", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "free",
      selectedTier: "free",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      onboardingVibe: null,
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
      byotActive: false,
      freeTierModelRef: "platform-openrouter/openai/gpt-5.6-luna",
      builderAgentDefault: {
        primary: "platform-openrouter/openai/gpt-5.6-luna",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: {
          defaults?: { models?: Record<string, unknown> };
          list: Array<{ id?: string; model?: unknown; tools?: unknown }>;
        };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const coach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(coach?.model).toEqual({ primary: "platform-openrouter/openai/gpt-5.6-luna", fallbacks: [] });
    expect(coach?.tools).toMatchObject({ profile: "minimal" });
    expect(patch.agents.defaults?.models).toMatchObject({
      "platform-openrouter/openai/gpt-5.6-luna": canonicalCustomerModelDefinition("platform-openrouter/openai/gpt-5.6-luna"),
    });
  });

  it("re-attach preserves the mounted coach's byot-sync-owned model instead of re-seeding the compiled default", async () => {
    // A byosub Builder on a shared gateway: the attach path has no coach-model
    // selection (byotActive), while byot-sync owns the entry's model. Re-seeding
    // the compiled default string here reverted the sync's {primary, fallbacks}
    // pin on every re-attach — one config write + agent restart per converge,
    // flipped straight back by the sync for a second (observed live 2026-08-14).
    const snapshot = aliceSnapshot({ byotActive: true });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: { entries?: Record<string, { model?: unknown }> };
      };
    };
    const syncOwnedModel = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const patch = args.buildPatch({
      agents: {
        entries: {
          "octogee-alice-coach": { model: syncOwnedModel },
        },
      },
      bindings: [],
    });

    expect(patch.agents.entries?.["octogee-alice-coach"]?.model).toEqual(syncOwnedModel);
  });

  it("deletes the still-undesired batch's agents, then adds the fresh Builder in one config mutation", async () => {
    const roster = {
      agents: {
        entries: keyedRoster([
          "octogee-stale-coach",
          "octogee-stale-proj-orbit-coach",
          "octogee-readmitted-coach",
          "octogee-keeper-coach",
        ]),
      },
    };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-fresh",
      slug: "fresh",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FRESH_OWNER_MM_ID,
      customerMmUserId: FRESH_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Fresh",
      coachToken: "pat-fresh",
      coachMmUserId: "mm-fresh-coach",
    };
    const currentEvictionBatch = vi.fn(async () => ["stale"]);

    await adapter.applyAddCustomerConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-fresh" },
      {
        evictionBatch: ["stale", "readmitted"],
        currentEvictionBatch,
      },
    );

    expect(currentEvictionBatch).toHaveBeenCalledOnce();
    // Only the still-undesired slug departs; the re-admitted one keeps its roster entry.
    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-stale-coach",
      "octogee-stale-proj-orbit-coach",
    ]);
    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    const args = vi.mocked(applyConfigPatch).mock.calls[0]![0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string }> };
        bindings: Array<{ agentId?: string }>;
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
    };
    // The patch is built against the post-delete roster the gateway now serves.
    const patch = args.buildPatch({
      agents: {
        list: [
          { id: "octogee-readmitted-coach" },
          { id: "octogee-keeper-coach" },
        ],
      },
      bindings: [
        { agentId: "octogee-readmitted-coach" },
        { agentId: "octogee-keeper-coach" },
      ],
      channels: {
        mattermost: {
          accounts: {
            "stale-coach": {},
            "readmitted-coach": {},
            "keeper-coach": {},
          },
        },
      },
    });

    expect(patch.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-readmitted-coach",
      "octogee-keeper-coach",
      "octogee-fresh-coach",
    ]);
    expect(patch.bindings).toEqual([
      { agentId: "octogee-readmitted-coach" },
      { agentId: "octogee-keeper-coach" },
      {
        agentId: "octogee-fresh-coach",
        match: { channel: "mattermost", accountId: "fresh-coach" },
      },
    ]);
    expect(patch.channels.mattermost.accounts).toMatchObject({
      "fresh-coach": expect.any(Object),
      "stale-coach": null,
    });
    expect(patch.channels.mattermost.accounts["readmitted-coach"]).toEqual({ dmPolicy: "disabled" });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        remove: expect.arrayContaining(["stale-coach"]),
        removePrefixes: ["stale-proj-"],
      }),
    );
  });

  it("never re-adds a deleted eviction agent to the roster patch", async () => {
    const roster = { agents: { entries: keyedRoster(["octogee-stale-coach"]) } };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-fresh",
      slug: "fresh",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FRESH_OWNER_MM_ID,
      customerMmUserId: FRESH_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Fresh",
      coachToken: "pat-fresh",
      coachMmUserId: "mm-fresh-coach",
    };

    await adapter.applyAddCustomerConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-fresh" },
      { evictionBatch: ["stale"] },
    );

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => { agents: { entries: Record<string, unknown> } };
    };
    const patch = args.buildPatch({
      agents: { entries: keyedRoster(["octogee-keeper-coach"]) },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    });

    expect(Object.keys(patch.agents.entries)).toEqual([
      "octogee-unmatched-route",
      "octogee-fresh-coach",
    ]);
  });

  it("deletes the Builder's own retired project agents before patching — 2026.7.2 refuses a roster drop", async () => {
    const roster = {
      agents: {
        entries: keyedRoster([
          "octogee-alice-coach",
          "octogee-alice-proj-old-coach",
          "octogee-bob-coach",
        ]),
      },
    };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-alice-proj-old-coach",
    ]);
    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => { agents: { entries: Record<string, unknown> } };
    };
    const patch = args.buildPatch({
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-bob-coach"]) },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    });

    expect(Object.values(patch.agents.entries)).not.toContain(null);
    expect(Object.keys(patch.agents.entries)).toEqual([
      "octogee-unmatched-route",
      "octogee-alice-coach",
    ]);
  });

  it("re-reads the live roster before destructive cleanup instead of trusting a stale patch cache", async () => {
    const liveRoster = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configGet = vi.fn(async () => ({ ...configSnapshot(liveRoster), hash: "live-hash" }));
    const rpc = mkRemovalRpc(liveRoster, { configGet } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      options.cache!.current = {
        agents: {
          entries: keyedRoster([
            "octogee-alice-coach",
            "octogee-alice-proj-now-owned-elsewhere-coach",
          ]),
        },
      };
      options.cache!.hash = "stale-hash";
      return { mode: "rpc" as const, attempts: 1 };
    });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });
    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

    expect(configGet).toHaveBeenCalledTimes(6);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });

  it("creates an agent the roster does not carry yet through agents.create, not the patch alone", async () => {
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-bob-coach"]) } });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(vi.mocked(rpc.agentsCreate).mock.calls.map(([params]) => params)).toEqual([
      { name: "octogee-alice-coach", workspace: expect.stringContaining("customers/alice") },
    ]);
  });

  it.each([false, true])("revives returning coaches before applying model secrets and patching (already rostered: %s)", async (rostered) => {
    let deleted = true;
    const agentId = "octogee-alice-coach";
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(rostered ? [agentId] : []) } }, {
      agentsCreate: vi.fn(async () => {
        deleted = false;
        if (rostered) throw new OpenclawWireError("rpc-error", `agent "${agentId}" already exists`);
        return { ok: true, agentId };
      }),
    });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => ({
      materialized: deleted ? 0 : 1,
      deferred: deleted ? [agentId] : [],
    }));
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(deleted).toBe(false);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patchMocks.applyConfigPatch).toHaveBeenCalled();
  });

  it("re-reads the roster after creating, because agents.create rewrites the config", async () => {
    const rpc = mkRemovalRpc({ agents: { entries: {} } });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    const cache = vi.mocked(applyConfigPatch).mock.calls.at(-1)![1] as {
      cache?: { current: unknown; hash: string };
    };
    expect(cache.cache).toEqual({ current: undefined, hash: "" });
  });

  it("resumes an existing agent's pending deletion cleanup, then re-creates it and activates", async () => {
    const agentId = "octogee-alice-coach";
    let resumed = false;
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster([agentId]) } }, {
      agentsCreate: vi.fn(async () => {
        if (!resumed) {
          throw new OpenclawWireError("rpc-error", `agent "${agentId}" deletion cleanup is still pending`);
        }
        return { ok: true, agentId };
      }),
      agentsDelete: vi.fn(async () => {
        resumed = true;
        return { ok: true, agentId, complete: true, removed: [], failed: [] };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId, deleteFiles: false });
    expect(rpc.agentsCreate).toHaveBeenCalledTimes(2);
    expect(applyConfigPatch).toHaveBeenCalled();
  });

  it("blocks config activation when the resumed deletion cleanup still cannot complete", async () => {
    const agentId = "octogee-alice-coach";
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster([agentId]) } }, {
      agentsCreate: vi.fn(async () => {
        throw new OpenclawWireError("rpc-error", `agent "${agentId}" deletion cleanup is still pending`);
      }),
      agentsDelete: vi.fn(async () => ({
        ok: true, agentId, complete: false, removed: [], failed: [], purgeFailed: true,
      })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }))
      .rejects.toThrow("native cleanup incomplete: purgeFailed=true");

    expect(applyConfigPatch).not.toHaveBeenCalled();
    expect(rpc.agentsCreate).toHaveBeenCalledTimes(1);
  });

  it("patches beta keyed entries with id-free values and skips foreign agents", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot = aliceSnapshot();

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { entries: Record<string, Record<string, unknown> | null> };
      };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        entries: {
          "octogee-ops-eggman": { model: "house" },
          "octogee-alice-coach": { model: "stale" },
        },
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const patch = args.buildPatch(current);
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: { primary: "platform-openrouter/deepseek/deepseek-v4-pro", fallbacks: [] },
      memory: {
        search: platformOpenAiEmbeddingMemorySearch("octogee-alice-coach"),
      },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents.entries).not.toHaveProperty("octogee-ops-eggman");
    expect(args.buildReplacePaths?.(current)).toEqual(expect.arrayContaining([
      ...customerConfigReplacePaths(current, "alice"),
      "plugins.allow", "agents.entries.octogee-alice-coach.model.fallbacks",
    ]));
  });

  it("declares roster ownership on a Barn, which is multi-agent once a customer lands", async () => {
    clearBuilderClaim();
    try {
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: mkGatewayRpc(),
        log: vi.fn(),
      });

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

      const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
        buildPatch: (current: unknown) => { agents: { ownership: string } };
      };
      const patch = args.buildPatch({
        agents: { list: [{ id: "octogee-unmatched-route" }] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });

      expect(patch.agents.ownership).toBe("explicit");
    } finally {
      clearBuilderClaim();
    }
  });

  it("leads a Builder roster with the configured coach and keeps the auth anchor last during list-roster reconciliation", async () => {
    stubBuilderClaim("alice");
    try {
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: mkGatewayRpc(),
        log: vi.fn(),
      });

      await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

      const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
        buildPatch: (current: unknown) => {
          agents: {
            list: Array<Record<string, unknown>>;
            ownership: string;
            defaults: { authInheritance: { agentId: string } };
          };
        };
      };
      const patch = args.buildPatch({
        agents: {
          list: [
            { id: SAFE_DEFAULT_AGENT_ID, name: "old anchor" },
            { id: "octogee-alice-coach", default: true },
            { id: "octogee-bob-coach", model: "foreign" },
          ],
          defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
        },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });

      expect(patch.agents.ownership).toBe("explicit");
      expect(patch.agents.defaults.authInheritance).toEqual({ agentId: SAFE_DEFAULT_AGENT_ID });
      expect(patch.agents.list.map((agent) => agent.id)).toEqual([
        "octogee-alice-coach",
        "octogee-bob-coach",
        SAFE_DEFAULT_AGENT_ID,
      ]);
      expect(patch.agents.list.find((agent) => agent.id === "octogee-alice-coach")).not.toHaveProperty(
        "default",
      );
      expect(patch.agents.list).toContainEqual(expect.objectContaining({
        id: "octogee-bob-coach",
        model: "foreign",
      }));
    } finally {
      clearBuilderClaim();
    }
  });

  it("materializes admitted agents' broker catalogs before config patching, once early materialization settles", async () => {
    const events: string[] = [];
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => {
      events.push("materialize");
      return { materialized: 1, deferred: [] };
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async () => {
      events.push("config-patch");
      return { mode: "rpc" as const, attempts: 1 };
    });
    vi.stubEnv("OPENROUTER_BASE_URL", "http://llm-broker:3010/v1");
    vi.stubEnv("PLATFORM_OPENAI_BASE_URL", "http://llm-broker:3010/v1");
    const roster = rosterRpc();
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc({
        ...roster,
        agentsCreate: vi.fn(async (params: { name: string; workspace: string }) => {
          events.push("agents.create");
          return roster.agentsCreate(params);
        }),
        secretsReload: vi.fn(async () => { events.push("secrets"); return { ok: true, warningCount: 0 }; }),
      }),
      log: vi.fn(),
    });
    const brokerProfilesReady = new Promise<void>((resolve) => setTimeout(() => { events.push("early"); resolve(); }, 5));
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-first",
      slug: "first",
      tier: "standard",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FIRST_OWNER_MM_ID,
      customerMmUserId: FIRST_OWNER_MM_ID,
      channels: [],
      projects: [],
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        { projectId: "unminted", enabled: true, mmUserId: null, token: null },
        { projectId: "retired", enabled: false, mmUserId: "mm-retired", token: "pat-retired" },
      ],
      ownerName: "First",
      coachToken: "pat-first",
      coachMmUserId: "mm-first-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-first" }, { brokerProfilesReady });

    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledWith(
      ["octogee-first-coach", "octogee-first-proj-orbit-coach"],
      expect.objectContaining({
        openRouter: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
        openAi: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
      }),
    );
    expect(events).toEqual(["early", "agents.create", "agents.create", "materialize", "config-patch", "secrets"]);
  });

  it("leaves nothing for the post-mount oauth purge or model override to patch", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://llm-broker:3010");
    const coach = "octogee-alice-coach";
    const selection = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const current = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "platform-openrouter/deepseek/deepseek-v4-pro", fallbacks: [] },
          models: { "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" } },
        },
        entries: {},
      },
      models: { providers: { anthropic: { baseUrl: "http://llm-broker:3010" } } },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };
    let mountPatch: unknown;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args: { buildPatch(current: unknown): unknown }) => {
      mountPatch = args.buildPatch(current);
      return { mode: "rpc" as const, attempts: 1 };
    });
    const snapshot = aliceSnapshot({
      tier: "trial",
      channels: [{ scope: "workspace", kind: "coach-dm", channelId: "dm-alice" }],
      builderAgentDefault: selection,
      trialGrant: {
        schemaVersion: 3,
        offerId: "builder-signup",
        offerVersion: 1,
        personalTier: "personal",
        builderTier: "hobby",
        configHash: "0123456789abcdef",
        claimedAt: Date.now() - 60_000,
        endsAt: Date.now() + 7 * 24 * 60 * 60_000,
      },
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc({ ...rosterRpc(current) }),
      log: vi.fn(),
    });
    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const applied = mergePatch(current, mountPatch) as {
      agents: { entries: Record<string, { model?: unknown }>; defaults: { models: Record<string, unknown> } };
    };
    expect(applied.agents.entries[coach]?.model).toEqual(selection);
    expect(applied.agents.defaults.models[selection.fallbacks[0]!]).toEqual(
      canonicalCustomerModelDefinition(selection.fallbacks[0]!),
    );
    const purge = customerOauthRuntimeConfigPatch(applied, "alice", selection.primary);
    expect(mergePatchValueAlreadyApplied(applied, purge)).toBe(true);
    const overridePatches: unknown[] = [];
    await applyAgentModelOverrides("alice", { [coach]: selection }, { houseOnly: false }, {
      applyConfigPatch: (async (args: { buildPatch(current: unknown): unknown }) => {
        overridePatches.push(args.buildPatch(applied));
        return { mode: "rpc" as const, attempts: 1 };
      }) as never,
      logFn: vi.fn(),
    });
    expect(overridePatches).toHaveLength(1);
    expect(mergePatchValueAlreadyApplied(applied, overridePatches[0])).toBe(true);
  });

  it("leaves nothing for the post-mount purge, platform allowlist, or model override to patch when a shared gateway suppresses the owner's byosub", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://llm-broker:3010");
    vi.stubEnv("OPENROUTER_BASE_URL", "http://llm-broker:3010/v1");
    vi.stubEnv("PLATFORM_OPENAI_BASE_URL", "http://llm-broker:3010/v1");
    const coach = "octogee-alice-coach";
    const selection = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const current = {
      agents: {
        ownership: "explicit",
        defaults: {
          models: {
            "platform-openrouter/deepseek/deepseek-v4-pro": {},
            "openai/gpt-6-astra": { alias: "astra" },
          },
        },
        entries: {},
      },
      models: { providers: { anthropic: { baseUrl: "http://llm-broker:3010" } } },
      plugins: { entries: { codex: { enabled: true } } },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };
    let mountPatch: unknown;
    let replacePaths: string[] = [];
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args: {
      buildPatch(current: unknown): unknown;
      buildReplacePaths?(current: unknown): string[];
    }) => {
      mountPatch = args.buildPatch(current);
      replacePaths = args.buildReplacePaths?.(current) ?? [];
      return { mode: "rpc" as const, attempts: 1 };
    });
    const snapshot = aliceSnapshot({
      status: "complete",
      tier: "trial",
      byotActive: true,
      systemConfig: { byot: { provider: "openai-codex" } },
      channels: [{ scope: "workspace", kind: "coach-dm", channelId: "dm-alice" }],
      builderAgentDefault: selection,
      trialGrant: {
        schemaVersion: 3,
        offerId: "builder-signup",
        offerVersion: 1,
        personalTier: "personal",
        builderTier: "hobby",
        configHash: "0123456789abcdef",
        claimedAt: Date.now() - 60_000,
        endsAt: Date.now() + 7 * 24 * 60 * 60_000,
      },
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc({ ...rosterRpc(current) }),
      log: vi.fn(),
    });
    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const applied = mergePatch(current, mountPatch) as {
      agents: { entries: Record<string, { model?: unknown }>; defaults: { models: Record<string, unknown> } };
    };
    expect(applied.agents.entries[coach]?.model).toEqual(selection);
    expect(replacePaths).toContain("agents.defaults.modelPolicy.allow");
    const purge = customerOauthRuntimeConfigPatch(applied, "alice", selection.primary, {
      forceSafeAll: true,
      gatewayEnv: process.env,
    });
    expect(mergePatchValueAlreadyApplied(applied, purge)).toBe(true);
    expect(mergePatchValueAlreadyApplied(applied, platformModelAllowlistPatch(applied, false))).toBe(true);
    const overridePatches: unknown[] = [];
    await applyAgentModelOverrides("alice", { [coach]: selection }, { houseOnly: false }, {
      applyConfigPatch: (async (args: { buildPatch(current: unknown): unknown }) => {
        overridePatches.push(args.buildPatch(applied));
        return { mode: "rpc" as const, attempts: 1 };
      }) as never,
      logFn: vi.fn(),
    });
    expect(overridePatches).toHaveLength(1);
    expect(mergePatchValueAlreadyApplied(applied, overridePatches[0])).toBe(true);
  });

  it("receipts the post-provision snapshot whose Mattermost identity was applied", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "pro",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "https://gitea.test/octogee/alice-workspace.git",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [{ scope: "coach", kind: "direct", channelId: "dm-alice" }],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-after-provision",
      coachMmUserId: "mm-alice-coach",
      trialGrant: { gatewayId: "builder-alice" },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    adapter.seedUserSnapshotForMigration?.(snapshot);

    const result = await adapter.applyAddCustomerConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-after-provision" },
    );

    expect(result.appliedFingerprint).toBe(snapshotConfigFingerprint(snapshot));
  });

  it("rebinds carried-forward coaches' shifted platform embedding refs to their OWN agent ids on mount", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{
          id?: string;
          memorySearch?: { remote?: { apiKey?: { id?: string } } };
          memory?: { search?: { remote?: { apiKey?: { id?: string } } } };
        }> };
      };
    };
    const current = {
      agents: {
        list: [
          { id: "octogee-mac-default" },
          {
            id: "octogee-bob-coach",
            memorySearch: platformOpenAiEmbeddingMemorySearch("octogee-tester5-coach"),
          },
        ],
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const patch = args.buildPatch(current);
    const bob = patch.agents.list.find((agent) => agent.id === "octogee-bob-coach");
    expect(bob?.memorySearch?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-bob-coach"),
    );
    const alice = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");
    expect(alice?.memory?.search?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-alice-coach"),
    );
  });
});

describe("buildBrokeredLifecycleAdapter byot re-assert (db-less LLM-auth self-heal)", () => {
  beforeEach(() => modelCredentialMocks.syncModelCredentialsForCustomer.mockClear());

  function fullSnapshot(overrides: Partial<FleetBrokerUserSnapshot> = {}): FleetBrokerUserSnapshot {
    return {
      uid: "uid-tester10",
      slug: "tester10",
      tier: "trial",
      gatewayId: "default",
      status: "complete",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: null,
      customerMmUserId: null,
      channels: [],
      projects: [],
      ownerName: "Tester",
      email: "",
      displayName: "",
      lastName: "",
      photoURL: "",
      onboardingVibe: null,
      coachToken: null,
      coachMmUserId: null,
      ...overrides,
    };
  }

  it("refreshes a prepared Builder snapshot after the source changes desired configuration", async () => {
    let ownerName = "Before";
    const client = mkClient({ userSnapshot: vi.fn(async () => fullSnapshot({ ownerName })) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });
    expect((await adapter.loadUserSnapshot("uid-tester10"))?.ownerName).toBe("Before");
    ownerName = "After";
    expect((await adapter.loadUserSnapshot("uid-tester10", { refresh: true }))?.ownerName).toBe("After");
    expect(client.userSnapshot).toHaveBeenCalledTimes(2);
  });

  it("loadUserSnapshot carries byotActive + systemConfig from the broker snapshot (the in-pod re-assert must see the real BYOT state)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({
          byotActive: true,
          systemConfig: { byot: { provider: "openai", model: "gpt-4o" } },
        }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.byotActive).toBe(true);
    expect(snap?.systemConfig).toEqual({ byot: { provider: "openai", model: "gpt-4o" } });
  });

  it("loadUserSnapshot carries builderSubscription — a credits-rail builder must not resolve house_only at mount", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({
          selectedTier: "personal_free",
          builderSubscription: { tier: "hobby", status: "active" },
        }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.builderSubscription).toEqual({ tier: "hobby", status: "active" });
  });

  it("loadUserSnapshot carries the trial grant into the pod-side lifecycle snapshot", async () => {
    const trialGrant = {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: { _seconds: 1_783_500_000 },
      endsAt: { _seconds: 1_784_104_800 },
    };
    const client = mkClient({
      userSnapshot: vi.fn(async () => fullSnapshot({ trialGrant })),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.trialGrant).toBe(trialGrant);
  });

  it("loadUserSnapshot carries the free-tier dial ref (the house pin must follow the operator)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("loadUserSnapshot carries projectAgents from the broker snapshot (a re-ensure must see the Vegas toggle state)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({
          projectAgents: [
            { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" },
          ],
        }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectAgents).toEqual([
      { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" },
    ]);
  });

  it("seedUserSnapshotForMigration replaces a stale cached snapshot so a re-ensure applies fresh content", async () => {
    // The reconcile's fingerprint source fetches fresh snapshots every tick and seeds
    // them here; without the seed, loadUserSnapshot would serve the boot-time cache
    // forever and a content-drift re-ensure would re-apply stale state while the
    // bookkeeping records the new fingerprint as applied.
    const userSnapshot = vi.fn(async () => fullSnapshot({ projectAgents: [] }));
    const client = mkClient({ userSnapshot });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.loadUserSnapshot("uid-tester10"); // populates the cache
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm", token: "pat" }],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");
    expect(snap?.projectAgents).toEqual([
      { projectId: "camp", enabled: true, mmUserId: "mm", token: "pat" },
    ]);
    expect(userSnapshot).toHaveBeenCalledTimes(1); // second read served from the seeded cache
  });

  it("projects migration snapshots to workspace-only before lifecycle restore and fingerprinting", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
      projectCheckoutScope: () => "workspace-only",
    });
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectCheckoutScope: "workspace-and-projects",
        projects: [
          { projectSlug: "camp", giteaRepoName: "tester10-camp", provisioningState: "active" },
        ],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectCheckoutScope).toBe("workspace-only");
    expect(snap?.projects).toEqual([]);
  });

  it("defaults migration snapshot projection to workspace-only when runtime scope is absent", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectCheckoutScope: "workspace-and-projects",
        projects: [
          { projectSlug: "camp", giteaRepoName: "tester10-camp", provisioningState: "active" },
        ],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectCheckoutScope).toBe("workspace-only");
    expect(snap?.projects).toEqual([]);
  });

  it("reassertByotForCustomer delegates model config writes through the adapter RPC", async () => {
    const rpc = {} as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
    });
    const userData = {
      username: "tester10",
      byotActive: false,
      provisioning: { openclaw: { status: "complete" } },
    };

    await adapter.reassertByotForCustomer(userData);

    expect(modelCredentialMocks.syncModelCredentialsForCustomer).toHaveBeenCalledTimes(1);
    expect(modelCredentialMocks.syncModelCredentialsForCustomer).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({
        applyConfigPatch: expect.any(Function),
        refreshCoachRuntimeSessions: expect.any(Function),
      }),
    );

    const deps = modelCredentialMocks.syncModelCredentialsForCustomer.mock.calls[0]?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, { maxRetries: 2 });

    expect(patchMocks.applyConfigPatch).toHaveBeenLastCalledWith(
      { buildPatch: expect.any(Function) },
      expect.objectContaining({
        maxRetries: 2,
        rpc,
        cache: expect.objectContaining({ current: undefined, hash: "" }),
      }),
    );
  });

  it("shares the lifecycle config cache with model convergence after the mount patch", async () => {
    const snapshot = fullSnapshot({
      coachToken: "pat-tester10",
      coachMmUserId: "mm-tester10-coach",
      mattermostUserId: TESTER_OWNER_MM_ID,
      customerMmUserId: TESTER_OWNER_MM_ID,
    });
    const rpc = mkGatewayRpc();
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      if (!options.cache) throw new Error("expected lifecycle config cache");
      options.cache.current = { mounted: snapshot.slug };
      options.cache.hash = "mounted-hash";
      return { mode: "rpc" as const, attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({
        userSnapshot: vi.fn(async () => snapshot),
      }),
      rpc,
      log: vi.fn(),
    });

    await adapter.applyAddCustomerConfigPatch(snapshot, {
      _coachPersonalToken: snapshot.coachToken,
    });
    const mountOptions = patchMocks.applyConfigPatch.mock.calls.at(-1)?.[1];

    await adapter.reassertByotForCustomer({
      username: snapshot.slug,
      byotActive: false,
      provisioning: { openclaw: { status: "complete" } },
    });
    const deps = modelCredentialMocks.syncModelCredentialsForCustomer.mock.calls.at(-1)?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, {});
    const modelOptions = patchMocks.applyConfigPatch.mock.calls.at(-1)?.[1];

    expect(mountOptions?.cache).toBeDefined();
    expect(modelOptions?.cache).toBe(mountOptions?.cache);
    expect(modelOptions?.cache).toEqual({
      current: { mounted: snapshot.slug },
      hash: "mounted-hash",
    });
  });

  it("reconcileCommunityMembership delegates to the fleet broker's ensure-community-membership RPC (no admin creds in-pod)", async () => {
    const ensureCommunityMembership = vi.fn(async () => undefined);
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ ensureCommunityMembership }),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.reconcileCommunityMembership?.({
      uid: "uid-tester10",
      slug: "tester10",
      tier: "trial",
      ownerName: "Tester",
      customerDir: "/home/node/.openclaw/customers/tester10",
      today: "2026-07-24",
      username: "tester10",
      templateVars: {},
      userData: {},
    });

    expect(ensureCommunityMembership).toHaveBeenCalledWith("uid-tester10");
  });
});

describe("projectCheckoutScopeForRuntime", () => {
  it("restores project checkouts on a shared runtime", () => {
    expect(projectCheckoutScopeForRuntime("alice", { GATEWAY_CLASS: "shared" })).toBe(
      "workspace-and-projects",
    );
  });

  it("restores project checkouts for the exact configured isolated Builder", () => {
    expect(projectCheckoutScopeForRuntime("alice", withBuilderClaim({
      GATEWAY_CLASS: "builder",
    }, "alice"))).toBe("workspace-and-projects");
  });

  it.each([
    ["a mismatched isolated Builder", "bob", withBuilderClaim({
      GATEWAY_CLASS: "builder",
    }, "alice")],
    ["an isolated Builder with no configured slug", "alice", { GATEWAY_CLASS: "builder" }],
    ["a runtime with no class", "alice", withBuilderClaim({ }, "alice")],
    ["an unknown runtime class", "alice", withBuilderClaim({
      GATEWAY_CLASS: "unknown",
    }, "alice")],
  ])("keeps %s workspace-only", (_label, slug, env) => {
    expect(projectCheckoutScopeForRuntime(slug, env)).toBe("workspace-only");
  });
});

describe("buildBrokeredLifecycleAdapter — Vegas project agents", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
  });

  it("partitions bindings, includes active project agents, and nulls stale project accounts", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      tier: "standard",
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "workspace", kind: "general", channelId: "ws-1" },
        { scope: "project", projectId: "orbit", kind: "general", channelId: "po-1" },
        { scope: "project", projectId: "nova", kind: "general", channelId: "pn-1" },
      ],
      projects: [],
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "proj-pat-1" },
        { projectId: "nova", enabled: true, mmUserId: null, token: null },
      ],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string; workspace?: string; tools?: unknown }> };
        bindings: Array<{ agentId: string; match: { accountId: string; peer: { id: string } } }>;
        channels: {
          mattermost: {
            accounts: Record<string, {
              botToken?: unknown;
              groupPolicy?: string;
              groupAllowFrom?: string[];
              groups?: null;
            } | null>;
          };
        };
      };
    };
    const patch = args.buildPatch({
      agents: { list: [{ id: "octogee-alice-proj-old-coach" }, { id: "octogee-bob-coach" }] },
      bindings: [{ agentId: "octogee-alice-proj-old-coach", match: { accountId: "alice-proj-old", peer: { id: "dead-1" } } }],
      channels: { mattermost: { accounts: { "alice-proj-old": { botToken: "revoked" } } } },
    });

    expect(patch.agents.list.map((a) => a.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-alice-coach",
      "octogee-alice-proj-orbit-coach",
      "octogee-bob-coach",
    ]);
    expect(
      patch.agents.list.find((agent) => agent.id === "octogee-alice-proj-orbit-coach")?.tools,
    ).toMatchObject({ profile: "minimal", exec: { mode: "deny" } });
    expect(
      Object.fromEntries(
        patch.bindings
          .filter((b) => "peer" in b.match)
          .map((b) => [b.match.peer.id, `${b.agentId}|${b.match.accountId}`]),
      ),
    ).toEqual({
      "ws-1": "octogee-alice-coach|alice-coach",
      "po-1": "octogee-alice-proj-orbit-coach|alice-proj-orbit",
    });
    expect(patch.channels.mattermost.accounts["alice-proj-orbit"]?.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-proj-orbit",
    });
    expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: [ALICE_OWNER_MM_ID],
    });
    expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: [ALICE_OWNER_MM_ID],
      groupPolicy: "open",
      groups: null,
    });
    expect(patch.channels.mattermost.accounts["alice-proj-old"]).toBeNull();
  });
});

describe("credential runtime reload", () => {


  it("routes the credential re-assert's secrets reload through the adapter rpc", async () => {
    const rpc = mkGatewayRpc({
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const captured = vi.mocked(modelCredentialMocks.syncModelCredentialsForCustomer);
    captured.mockClear();
    await adapter.reassertByotForCustomer({} as never);
    const deps = captured.mock.calls[0]![1] as { triggerSecretsReload?: () => Promise<void> };
    await deps.triggerSecretsReload!();
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });
});

describe("restoreByosubForAgent", () => {
  beforeEach(() => modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear());

  it("restores the subscription store from the broker on a Builder gateway", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: rosterRpc() as unknown as GatewayRpcClient,
      log: vi.fn(),
      isBuilderGateway: () => true,
    });
    await expect(adapter.restoreByosubForAgent("tester10")).resolves.toMatchObject({
      restored: true,
      present: true,
    });
    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).toHaveBeenCalledWith("tester10");
  });

  it("leaves the store alone on a shared gateway, where the customer sync owns the subscription", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: rosterRpc() as unknown as GatewayRpcClient,
      log: vi.fn(),
    });
    await expect(adapter.restoreByosubForAgent("tester10")).resolves.toEqual({
      restored: false,
      present: false,
    });
    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).not.toHaveBeenCalled();
  });
});

describe("durable Shared context eviction hold", () => {
  afterEach(() => vi.unstubAllEnvs());
  const hold = { operationId: "return-op", uid: "uid-held", slug: "held", fromGatewayId: "native", toGatewayId: "shared", migrationId: "return-mig", archiveId: "archive", contextSha256: "a".repeat(64) };
  it("reads fresh broker ownership rather than a cached snapshot or an expired migration pin", async () => {
    vi.stubEnv("GATEWAY_ID", "shared");
    const userSnapshot = vi.fn(async () => ({ uid: hold.uid, slug: hold.slug, gatewayId: "shared" }) as FleetBrokerUserSnapshot);
    const client = mkClient({ uidForSlug: vi.fn(async () => hold.uid), userSnapshot });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });
    expect(await adapter.customerContextRestoreHeld!(hold.slug)).toBe(false);
    userSnapshot.mockResolvedValue({ uid: hold.uid, slug: hold.slug, gatewayId: "shared", nativeSharedContextRestore: hold } as FleetBrokerUserSnapshot);
    expect(await adapter.customerContextRestoreHeld!(hold.slug)).toBe(true);
    expect(userSnapshot).toHaveBeenCalledTimes(2);
    vi.stubEnv("GATEWAY_ID", "native");
    expect(await adapter.customerContextRestoreHeld!(hold.slug)).toBe(false);
  });
  it.each([null, { ...hold, uid: "foreign" }, { ...hold, contextSha256: "bad" }])("fails closed on a malformed or changed hold", async nativeSharedContextRestore => {
    vi.stubEnv("GATEWAY_ID", "shared");
    const client = mkClient({ uidForSlug: vi.fn(async () => hold.uid), userSnapshot: vi.fn(async () => ({ uid: hold.uid, slug: hold.slug, gatewayId: "shared", nativeSharedContextRestore }) as unknown as FleetBrokerUserSnapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });
    await expect(adapter.customerContextRestoreHeld!(hold.slug)).rejects.toThrow("hold is malformed");
  });
});

it("waits for runtime publication before detaching a PostgreSQL roster entry", async () => {
  await withPostgresAgentConfig({}, async () => {
    let finishPublication!: () => void;
    const custody = new Promise<void>((resolve) => { finishPublication = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { holdUntil: custody });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(async ({ agentId }) => ({ ok: true, agentId })) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const detached = adapter.releaseAgent!("octogee-alice-coach");
    try {
      await Promise.resolve();
      expect(rpc.agentsDetach).not.toHaveBeenCalled();
    } finally { finishPublication(); await detached; }
    expect(rpc.agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-coach" });
  });
});

it("defers broker-profile reloads until PostgreSQL detach settles", async () => {
  await withPostgresAgentConfig({}, async () => {
    let finishDetach!: () => void;
    const pending = new Promise<{ ok: true; agentId: string }>((resolve) => {
      finishDetach = () => resolve({ ok: true, agentId: "octogee-alice-coach" });
    });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(() => pending) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const detached = adapter.releaseAgent!("octogee-alice-coach");
    const readConfig = vi.fn(() => ({ agents: { entries: {} } }));
    try {
      await vi.waitFor(() => expect(rpc.agentsDetach).toHaveBeenCalledOnce());
      const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig });
      expect(sweep).toMatchObject({ settled: false, skipped: true });
      expect(readConfig).not.toHaveBeenCalled();
    } finally { finishDetach(); await detached; }
  });
});

it("defers broker-profile reloads while import preparation detaches prior agents", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = testRuntime.dir;
  try { await withPostgresAgentConfig({}, async () => {
    const agentId = "octogee-guardprep-coach";
    const directory = path.join(testRuntime.dir, "agents", agentId, "agent");
    const procRoot = path.join(testRuntime.dir, "guardprep-proc");
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(procRoot, { recursive: true });
    let finishDetach!: () => void;
    const pending = new Promise<{ ok: true; agentId: string }>((resolve) => {
      finishDetach = () => resolve({ ok: true, agentId });
    });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(() => pending) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn(), procRoot });
    const prepared = adapter.prepareImportDir("guardprep", "default");
    try {
      await vi.waitFor(() => expect(rpc.agentsDetach).toHaveBeenCalledOnce());
      const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig: () => ({ agents: { entries: {} } }) });
      expect(sweep).toMatchObject({ settled: false, skipped: true });
    } finally { finishDetach(); await prepared; await fs.rm(path.dirname(directory), { recursive: true, force: true }); }
  }); } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

it("defers broker-profile reloads while rollback resumes a customer", async () => {
  let finishRead!: () => void;
  const pending = new Promise<null>((resolve) => { finishRead = () => resolve(null); });
  mocks.readActivationManifest.mockReturnValueOnce(pending);
  const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
  const resumed = adapter.resumeCustomer("guardresume");
  try {
    await vi.waitFor(() => expect(mocks.readActivationManifest).toHaveBeenCalledWith(expect.any(String), "guardresume"));
    const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig: () => ({ agents: { entries: {} } }) });
    expect(sweep).toMatchObject({ settled: false, skipped: true });
  } finally { finishRead(); await resumed; }
});

it("releases a PostgreSQL roster entry through detach while preserving its anchor", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = testRuntime.dir;
  const agentId = "octogee-pgfixture-coach";
  const directory = path.join(testRuntime.dir, "agents", agentId, "agent");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture"); db.close();
  const rpc = mkGatewayRpc({ agentsDetach: vi.fn(async ({ agentId }) => ({ ok: true, agentId })) });
  try {
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.releaseAgent!(agentId);
    expect(rpc.agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId });
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.rm(path.dirname(directory), { recursive: true, force: true });
  }
});

async function withPostgresAgentConfig(config: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const previous = await fs.readFile(OPENCLAW_CONFIG).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
  await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ ...config, database: { engine: "sqlite", families: { agent: { engine: "postgres" } } } }));
  try { await run(); }
  finally {
    if (previous) await fs.writeFile(OPENCLAW_CONFIG, previous);
    else await fs.rm(OPENCLAW_CONFIG, { force: true });
  }
}

it.each(['empty', 'agent-store', 'running', 'wrong-pod', 'gate-changed'])("cleans an interrupted held Builder target only when no Native state exists: %s", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-empty-target-'));
  const oldState = process.env.OPENCLAW_STATE_DIR;
  const oldPod = process.env.POD_UID;
  stubBuilderClaim('alice');
  process.env.OPENCLAW_STATE_DIR = root; process.env.POD_UID = 'pod-current';
  const failure = new Error('OpenClaw workspace identities are not initialized for this boot');
  routingActivationMocks.stopStale.mockRejectedValueOnce(failure);
  supervisorMocks.status.mockReset().mockResolvedValue({ version: 1, podUid: scenario === 'wrong-pod' ? 'old-pod' : 'pod-current', role: 'normal', mode: scenario === 'running' ? 'permitted' : 'held', phase: scenario === 'running' ? 'running' : 'held' });
  if (scenario === 'gate-changed') supervisorMocks.status.mockResolvedValueOnce({ version: 1, podUid: 'pod-current', role: 'normal', mode: 'held', phase: 'held' }).mockResolvedValue({ version: 1, podUid: 'pod-current', role: 'normal', mode: 'permitted', phase: 'starting' });
  const rpc = mkGatewayRpc({ agentsDetach: vi.fn().mockRejectedValue(failure) });
  try {
    const agent = path.join(root, 'agents/octogee-alice-coach/agent');
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(path.join(agent, scenario === 'agent-store' ? 'openclaw-agent.sqlite' : 'models.json'), 'retained');
    await withPostgresAgentConfig({ agents: { entries: { 'octogee-alice-coach': {} } } }, async () => {
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
      const removing = adapter.removeImportedCustomerBySlug!('alice');
      if (scenario === 'empty') {
        await expect(removing).resolves.toMatchObject({ retained: true });
        expect(rpc.agentsDetach).not.toHaveBeenCalled();
      } else await expect(removing).rejects.toThrow(/workspace identities/);
    });
    expect(await fs.readFile(path.join(agent, scenario === 'agent-store' ? 'openclaw-agent.sqlite' : 'models.json'), 'utf8')).toBe('retained');
  } finally {
    if (oldState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = oldState;
    if (oldPod === undefined) delete process.env.POD_UID; else process.env.POD_UID = oldPod;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("purges a retired PostgreSQL project while detaching evicted customer stores", async () => {
  const current = { agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-retired-coach", "octogee-stale-coach", "octogee-bob-coach"]) } };
  await withPostgresAgentConfig(current, async () => {
    const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
    const rpc = mkRemovalRpc(current, { agentsDetach });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }, { evictionBatch: ["stale"] });
    expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-stale-coach" });
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-proj-retired-coach", deleteFiles: false });
  });
});

it("purges a retired configured Builder PostgreSQL project without deleting imported agents", async () => {
  const retiredId = "octogee-alice-proj-retired-coach";
  const importedId = "octogee-alice-proj-imported-coach";
  const config = {
    agents: { entries: keyedRoster(["octogee-alice-coach", retiredId, importedId]) },
    channels: { mattermost: { accounts: {
      "alice-proj-retired": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-retired" } },
      "alice-proj-imported": { botToken: { source: "file", provider: "octogee-mattermost", id: "/owner-custom" } },
    } } },
    bindings: [
      { agentId: retiredId, match: { channel: "mattermost", accountId: "alice-proj-retired" } },
      { agentId: importedId, match: { channel: "mattermost", accountId: "alice-proj-imported" } },
    ],
  };
  await withPostgresAgentConfig(config, async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
    const rpc = mkGatewayRpc({ ...rosterRpc(config), agentsDetach });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    await adapter.reconcileConfiguredBuilderProjectAgents!(snapshot);
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: retiredId, deleteFiles: false });
    expect(agentsDetach).not.toHaveBeenCalled();
  });
});
