import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import {
  buildBrokeredLifecycleAdapter,
  projectCheckoutScopeForRuntime,
  pruneWorkspaceOnlyProjectCheckouts,
} from "../lib/customer-lifecycle-broker-adapter.js";
import { OpenclawWireError, type GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  applyConfigPatch,
  customerConfigFullAgentListReplacePaths,
  customerConfigReplacePaths,
} from "../lib/apply-config-patch.js";
import {
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingSecretId,
} from "../lib/openclaw-config-builders.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import { snapshotConfigFingerprint } from "../lib/snapshot-fingerprint.js";
import { LegacyActivationManifestFingerprintError } from "../lib/migration-activation-manifest.js";

const mocks = vi.hoisted(() => ({
  readActivationManifest: vi.fn(),
  applyOpenClawActivationManifest: vi.fn(),
  removeActivationManifest: vi.fn(),
}));
const patchMocks = vi.hoisted(() => ({
  applyConfigPatch: vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 })),
}));
const modelCredentialMocks = vi.hoisted(() => ({
  syncModelCredentialsForCustomer: vi.fn(async () => undefined),
}));
const brokerCatalogMocks = vi.hoisted(() => ({
  materializeBrokerProfilesForAgents: vi.fn(() => ({ materialized: 1, deferred: [] })),
}));
const contextFileConvergenceMocks = vi.hoisted(() => ({
  reassertConvergedContextFilesForSlug: vi.fn(() => []),
}));
const secretMocks = vi.hoisted(() => ({
  updateMattermostAccountSecrets: vi.fn(async () => undefined),
  materializeActivationManifestSecret: vi.fn(async (_dir: string, manifest: unknown) => manifest),
}));

vi.mock("../lib/migration-activation-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/migration-activation-manifest.js")>();
  return {
    ...actual,
    LegacyActivationManifestFingerprintError: actual.LegacyActivationManifestFingerprintError,
    readActivationManifest: mocks.readActivationManifest,
    applyOpenClawActivationManifest: mocks.applyOpenClawActivationManifest,
    removeActivationManifest: mocks.removeActivationManifest,
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
  return {
    ...actual,
    materializeActivationManifestSecret: secretMocks.materializeActivationManifestSecret,
  };
});

function mkClient(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    uidForSlug: vi.fn(async () => "uid-tester10"),
    githubCloneToken: vi.fn(async () => null),
    userSnapshot: vi.fn(async () => null),
    setProvisioningStatus: vi.fn(async () => undefined),
    setRepoUrl: vi.fn(async () => undefined),
    provisionMattermost: vi.fn(async () => ({})),
    setMattermostFields: vi.fn(async () => undefined),
    ensureCommunityMembership: vi.fn(async () => undefined),
    setGreetingResult: vi.fn(async () => undefined),
    setAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
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
    ...rosterRpc(),
    ...overrides,
  } as GatewayRpcClient;
}

// The add path reads the live roster to decide which agents leave by
// `agents.delete` and which arrive by `agents.create`, so every add fixture
// needs all three calls.
function rosterRpc(config: unknown = { agents: { entries: {} } }) {
  return {
    configGet: vi.fn(async () => ({ config, hash: "cfg-hash" })),
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
    mattermostUserId: "mm-alice",
    customerMmUserId: "mm-alice",
    greetingPosted: false,
    channels: [],
    projects: [],
    ownerName: "Alice",
    coachToken: "pat-1",
    coachMmUserId: "mm-alice-coach",
    ...overrides,
  };
}

describe("buildBrokeredLifecycleAdapter migration import activation", () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | null = null;

  beforeEach(() => {
    mocks.readActivationManifest.mockReset();
    mocks.applyOpenClawActivationManifest.mockReset();
    mocks.removeActivationManifest.mockReset();
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
    secretMocks.materializeActivationManifestSecret.mockClear();
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    tempStateDir = null;
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      projectAgents: [],
    });
    mocks.applyOpenClawActivationManifest.mockResolvedValue({ elapsedMs: 42 });
    mocks.removeActivationManifest.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  });

  it("deletes target roster residue the manifest does not carry before activating", async () => {
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
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
  });

  it("activates imported standard-gateway state from the transferred activation manifest", async () => {
    const client = mkClient();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => ({
        config: { agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] } },
        hash: "cfg-hash",
      })),
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
      expect.stringContaining(".openclaw"),
      "tester10",
    );
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "tester10", appliedFingerprint: "fp-tester10" }),
      expect.objectContaining({ rpc, signal }),
    );
    expect(mocks.removeActivationManifest).toHaveBeenCalledWith(
      expect.stringContaining(".openclaw"),
      "tester10",
    );
    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(rpc.channelsStatus).toHaveBeenCalled();
    expect(client.uidForSlug).not.toHaveBeenCalled();
  });

  it("binds a previous-release manifest to the target's current desired fingerprint", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-tester10",
      slug: "tester10",
      tier: "trial",
      gatewayId: "shared-a",
      status: "complete",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: null,
      customerMmUserId: null,
      greetingPosted: false,
      channels: [],
      projects: [],
      ownerName: "Tester",
      coachToken: null,
      coachMmUserId: null,
    };
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => ({ config: {}, hash: "cfg-hash" })),
    } as unknown as GatewayRpcClient;
    mocks.readActivationManifest
      .mockRejectedValueOnce(new LegacyActivationManifestFingerprintError("legacy"))
      .mockResolvedValueOnce({
        slug: "tester10",
        appliedFingerprint: "desired-fingerprint",
        agentId: "octogee-tester10-coach",
        projectAgents: [],
      });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });

    await expect(adapter.activateImportedCustomer("tester10")).resolves.toEqual({
      appliedFingerprint: "desired-fingerprint",
    });

    expect(mocks.readActivationManifest).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(".openclaw"),
      "tester10",
    );
    expect(mocks.readActivationManifest).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(".openclaw"),
      "tester10",
      {
        legacyAppliedFingerprint: snapshotConfigFingerprint({
          ...snapshot,
          projectCheckoutScope: "workspace-only",
        }),
      },
    );
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

  it("removes transferred project checkouts before activating a workspace-only import", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-only-import-"));
    const projectsDir = path.join(root, "alice", "projects");
    await fs.mkdir(path.join(projectsDir, "camp", ".git"), { recursive: true });
    const log = vi.fn();

    try {
      await pruneWorkspaceOnlyProjectCheckouts(root, "alice", "workspace-only", log);

      expect(fsSync.existsSync(path.join(projectsDir, "camp"))).toBe(false);
      expect(fsSync.existsSync(projectsDir)).toBe(true);
      expect(log).toHaveBeenCalledWith(
        "[import:alice] removed project checkouts from workspace-only target",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
    await fs.writeFile(
      path.join(tempStateDir, "agents", "octogee-tester10-coach", "sessions", "sessions.json"),
      JSON.stringify({ sessions: [{ status: "running" }] }),
    );
    await fs.writeFile(
      path.join(
        tempStateDir,
        "agents",
        "octogee-tester10-proj-orbit-coach",
        "sessions",
        "sessions.json",
      ),
      JSON.stringify({ sessions: [{ status: "running" }] }),
    );
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

    const paths = await adapter.listExportPaths("tester10");

    expect(paths).toEqual(expect.arrayContaining([
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-coach") },
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-proj-orbit-coach") },
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("octogee-other-") }),
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/\.sqlite-(wal|shm)$/u) }),
    ]));
    await expect(adapter.quiesceCustomer("tester10", 1)).resolves.toEqual({
      drained: false,
      runningCount: 2,
    });
  });
});

describe("buildBrokeredLifecycleAdapter github clone credential", () => {
  it("brokers the customer's own GitHub token for their slug", async () => {
    const client = mkClient({
      uidForSlug: vi.fn(async () => "uid-tester10"),
      githubCloneToken: vi.fn(async () => "ghu_customer"),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.resolveGithubCloneToken?.("tester10")).resolves.toBe("ghu_customer");
    expect(client.githubCloneToken).toHaveBeenCalledWith("uid-tester10");
  });

  it("reports an unconnected GitHub account instead of failing the provisioning pass", async () => {
    const log = vi.fn();
    const client = mkClient({ githubCloneToken: vi.fn(async () => null) });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log,
    });

    await expect(adapter.resolveGithubCloneToken?.("tester10")).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/GitHub not connected/));
  });

  it("does not ask for a token when the slug has no uid", async () => {
    const client = mkClient({
      uidForSlug: vi.fn(async () => null),
      githubCloneToken: vi.fn(async () => "ghu_customer"),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.resolveGithubCloneToken?.("ghost")).resolves.toBeNull();
    expect(client.githubCloneToken).not.toHaveBeenCalled();
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

  it("does not retry cleanup after an admission wins the config CAS", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkRemovalRpc(current),
      log: vi.fn(),
    });
    patchMocks.applyConfigPatch.mockRejectedValueOnce(
      new OpenclawWireError("hash-mismatch", "admission won"),
    );

    await expect(
      adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach"),
    ).rejects.toMatchObject({ code: "hash-mismatch" });

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    expect(patchMocks.applyConfigPatch.mock.calls[0]![1]).toMatchObject({ maxRetries: 1 });
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
    vi.stubEnv("OPENAI_EMBEDDINGS_ENABLED", "true");
    vi.stubEnv("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-small");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves Mattermost monitor reload to OpenClaw after applying changed channel bindings", async () => {
    const events: string[] = [];
    patchMocks.applyConfigPatch.mockImplementationOnce(async () => {
      events.push("config-patch");
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
      ...rosterRpc(),
    } as unknown as GatewayRpcClient;
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
      channels: [
        { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
      ],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(events).toEqual(["config-patch"]);
  });

  it("waits for the lifecycle config.changed hash without explicitly restarting Mattermost", async () => {
    const events: string[] = [];
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
      ...rosterRpc(),
    } as unknown as GatewayRpcClient;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
    await vi.waitFor(() => expect(events).toEqual(["config-persisted"]));

    publishConfigChanged?.();
    await applying;

    expect(events).toEqual(["config-persisted", "config-changed"]);
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
      "octogee-mac-default",
      "octogee-alice-coach",
      "octogee-bob-coach",
    ]);
    const rebuiltCoach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach") as
      | { model?: string; memorySearch?: unknown }
      | undefined;
    expect(rebuiltCoach?.model).toBe("platform-openrouter/openai/gpt-5.6-luna");
    expect(rebuiltCoach?.memorySearch).toEqual({
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
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigFullAgentListReplacePaths(current, "alice"),
    );
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
          defaults?: { models?: Record<string, unknown> };
          list: Array<{ id?: string; model?: unknown }>;
        };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const coach = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(coach?.model).toEqual(snapshot.builderAgentDefault);
    expect(patch.agents.defaults?.models).toEqual({
      "platform-openrouter/openai/gpt-5.6-luna": {},
      "platform-openrouter/z-ai/glm-5.2": {},
    });
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
      mattermostUserId: "mm-fresh",
      customerMmUserId: "mm-fresh",
      greetingPosted: false,
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
      "octogee-readmitted-coach",
      "octogee-keeper-coach",
      "octogee-fresh-coach",
    ]);
    expect(patch.bindings).toEqual([
      { agentId: "octogee-readmitted-coach" },
      { agentId: "octogee-keeper-coach" },
    ]);
    expect(patch.channels.mattermost.accounts).toMatchObject({
      "fresh-coach": expect.any(Object),
      "stale-coach": null,
    });
    expect(patch.channels.mattermost.accounts).not.toHaveProperty("readmitted-coach");
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
      mattermostUserId: "mm-fresh",
      customerMmUserId: "mm-fresh",
      greetingPosted: false,
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

    expect(Object.keys(patch.agents.entries)).toEqual(["octogee-fresh-coach"]);
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
    expect(Object.keys(patch.agents.entries)).toEqual(["octogee-alice-coach"]);
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

  it("leaves an already-rostered agent to the pure-patch update path", async () => {
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-alice-coach"]) } });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddCustomerConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
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
      model: "platform-openrouter/openai/gpt-5.6-luna",
      memory: {
        search: platformOpenAiEmbeddingMemorySearch("octogee-alice-coach"),
      },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents.entries).not.toHaveProperty("octogee-ops-eggman");
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigReplacePaths(current, "alice"),
    );
  });

  it("materializes every active agent's broker catalog before its config hot-reload", async () => {
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
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-first",
      slug: "first",
      tier: "standard",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: "mm-first",
      customerMmUserId: "mm-first",
      greetingPosted: false,
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

    await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-first" });

    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledWith(
      ["octogee-first-coach", "octogee-first-proj-orbit-coach"],
      expect.objectContaining({
        openRouter: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
        openAi: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
      }),
    );
    expect(events).toEqual(["materialize", "config-patch"]);
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
        agents: { list: Array<{ id?: string; memorySearch?: { remote?: { apiKey?: { id?: string } } } }> };
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
    expect(alice?.memorySearch?.remote?.apiKey?.id).toBe(
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
      greetingPosted: false,
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
      mattermostUserId: "mm-tester10",
      customerMmUserId: "mm-tester10",
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
  it("keeps runtime imports workspace-only", () => {
    expect(projectCheckoutScopeForRuntime()).toBe("workspace-only");
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
      mattermostUserId: "mm-alice",
      customerMmUserId: "mm-alice",
      greetingPosted: false,
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
        agents: { list: Array<{ id?: string; workspace?: string }> };
        bindings: Array<{ agentId: string; match: { accountId: string; peer: { id: string } } }>;
        channels: { mattermost: { accounts: Record<string, { botToken?: unknown } | null> } };
      };
    };
    const patch = args.buildPatch({
      agents: { list: [{ id: "octogee-alice-proj-old-coach" }, { id: "octogee-bob-coach" }] },
      bindings: [{ agentId: "octogee-alice-proj-old-coach", match: { accountId: "alice-proj-old", peer: { id: "dead-1" } } }],
      channels: { mattermost: { accounts: { "alice-proj-old": { botToken: "revoked" } } } },
    });

    expect(patch.agents.list.map((a) => a.id)).toEqual([
      "octogee-alice-coach",
      "octogee-alice-proj-orbit-coach",
      "octogee-bob-coach",
    ]);
    expect(
      Object.fromEntries(
        patch.bindings.map((b) => [b.match.peer.id, `${b.agentId}|${b.match.accountId}`]),
      ),
    ).toEqual({
      "ws-1": "octogee-alice-coach|alice-coach",
      "po-1": "octogee-alice-proj-orbit-coach|alice-proj-orbit",
      "pn-1": "octogee-alice-coach|alice-coach",
    });
    expect(patch.channels.mattermost.accounts["alice-proj-orbit"]?.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-proj-orbit",
    });
    // The plugin schema has no per-channel mute, so the coach account clears
    // `groups` rather than listing the project channel; the project channel
    // still reaches its own agent through the partitioned bindings above.
    expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({ groups: null });
    expect(patch.channels.mattermost.accounts["alice-proj-old"]).toBeNull();
  });
});
