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
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
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
  materializeBrokerProfilesForAgents: vi.fn(() => 1),
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
    ...overrides,
  } as GatewayRpcClient;
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
    mocks.readActivationManifest.mockResolvedValue({ slug: "tester10" });
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

    await adapter.activateImportedCustomer("tester10", { signal });

    expect(mocks.readActivationManifest).toHaveBeenCalledWith(
      expect.stringContaining(".openclaw"),
      "tester10",
    );
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
      { slug: "tester10" },
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
      { cwd: tempStateDir, path: path.join("memory", "octogee-tester10-proj-orbit-coach.sqlite-wal") },
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("octogee-other-") }),
    ]));
    await expect(adapter.quiesceCustomer("tester10", 1)).resolves.toEqual({
      drained: false,
      runningCount: 2,
    });
  });
});

describe("buildBrokeredLifecycleAdapter runtime plugin prewarm", () => {
  it("loads the mounted coach plugin catalog with the migration startup budget", async () => {
    const toolsCatalog = vi.fn(async () => ({ tools: [] }));
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc({ toolsCatalog }),
      log: vi.fn(),
    });

    await adapter.warmAgentRuntimePlugins?.("tester10");

    expect(toolsCatalog).toHaveBeenCalledWith(
      {
        agentId: "octogee-tester10-coach",
        includePlugins: true,
      },
      180_000,
    );
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
  });

  it("removes only the customer's agent/bindings/account and confirms shrink paths", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string }> };
        bindings: Array<{ agentId?: string }>;
        channels: { mattermost: { accounts: Record<string, null> } };
      };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        list: [
          { id: "octogee-ops-eggman" },
          { id: "octogee-alice-coach" },
        ],
      },
      bindings: [
        { agentId: "octogee-ops-eggman" },
        { agentId: "octogee-alice-coach" },
      ],
      channels: {
        mattermost: { accounts: { "alice-coach": { groupAllowFrom: ["mm-1"] } } },
      },
    };
    expect(args.buildPatch(current)).toEqual({
      agents: { list: [{ id: "octogee-ops-eggman" }] },
      bindings: [{ agentId: "octogee-ops-eggman" }],
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigFullAgentListReplacePaths(current, "alice"),
    );
  });

  it("null-deletes beta keyed customer entries without sending the retired agents.list key", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.applyRemoveCustomerConfigPatch("alice", "octogee-alice-coach");

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { entries: Record<string, unknown> };
        bindings: Array<{ agentId?: string }>;
      };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        entries: {
          "octogee-ops-eggman": { model: "house" },
          "octogee-alice-coach": { model: "house" },
          "octogee-alice-proj-old-coach": { model: "house" },
        },
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

    const patch = args.buildPatch(current);
    expect(patch.agents).toEqual({
      entries: {
        "octogee-alice-coach": null,
        "octogee-alice-proj-old-coach": null,
      },
    });
    expect(patch.bindings).toEqual([{ agentId: "octogee-ops-eggman" }]);
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "alice-proj-old": null,
    });
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigReplacePaths(current, "alice"),
    );
  });

  it("self-heals a surviving coach's shifted platform embedding ref on removal — sequential removes leave no stale ref (r2 wedge)", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });
    type RemovePatchArgs = {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string; memorySearch?: { remote?: { apiKey?: { id?: string } } } }> };
        bindings: unknown[];
        channels: { mattermost: { accounts: Record<string, null> } };
      };
    };

    await adapter.applyRemoveCustomerConfigPatch("tester5", "octogee-tester5-coach");
    const first = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as RemovePatchArgs;
    const current = {
      agents: {
        list: [
          { id: "octogee-ops-eggman" },
          {
            id: "octogee-tester5-coach",
            memorySearch: platformOpenAiEmbeddingMemorySearch("octogee-tester5-coach"),
          },
          {
            id: "octogee-livefixture-coach",
            memorySearch: platformOpenAiEmbeddingMemorySearch("octogee-tester5-coach"),
          },
        ],
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const afterFirst = first.buildPatch(current);
    expect(afterFirst.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-ops-eggman",
      "octogee-livefixture-coach",
    ]);
    expect(
      afterFirst.agents.list.find((agent) => agent.id === "octogee-livefixture-coach")
        ?.memorySearch?.remote?.apiKey?.id,
    ).toBe(platformOpenAiEmbeddingSecretId("octogee-livefixture-coach"));
    expect(JSON.stringify(afterFirst.agents.list)).not.toContain("tester5");

    await adapter.applyRemoveCustomerConfigPatch("livefixture", "octogee-livefixture-coach");
    const second = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as RemovePatchArgs;
    const afterSecond = second.buildPatch({
      agents: { list: afterFirst.agents.list },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    });
    expect(afterSecond.agents.list.map((agent) => agent.id)).toEqual(["octogee-ops-eggman"]);
    expect(JSON.stringify(afterSecond.agents.list)).not.toMatch(/tester5|livefixture/u);
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

  it("restarts the customer Mattermost monitor after applying changed channel bindings", async () => {
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

    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-coach",
    });
    expect(rpc.channelsStart).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-coach",
    });
    expect(events).toEqual(["config-patch", "channels-stop", "channels-start"]);
  });

  it("waits for the lifecycle config.changed hash before restarting Mattermost monitors", async () => {
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
      channelsStop: vi.fn(async () => {
        events.push("channels-stop");
        return { channel: "mattermost", accountId: "alice-coach", stopped: true as const };
      }),
      channelsStart: vi.fn(async () => {
        events.push("channels-start");
        return { channel: "mattermost", accountId: "alice-coach", started: true as const };
      }),
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
    expect(rpc.channelsStop).not.toHaveBeenCalled();

    publishConfigChanged?.();
    await applying;

    expect(events).toEqual([
      "config-persisted",
      "config-changed",
      "channels-stop",
      "channels-start",
    ]);
    expect(rpc.configPatch).not.toHaveBeenCalled();
    expect(rpc.configPatchAndWaitForChange).toHaveBeenCalledOnce();
  });

  it("restarts stale affected monitors when the lifecycle config patch is already a no-op", async () => {
    const rpc = {
      configPatchAndWaitForChange: vi.fn(),
      channelsStop: vi.fn(async ({ channel, accountId }: { channel: string; accountId: string }) => ({
        channel,
        accountId,
        stopped: true as const,
      })),
      channelsStart: vi.fn(async ({ channel, accountId }: { channel: string; accountId: string }) => ({
        channel,
        accountId,
        started: true as const,
      })),
    } as unknown as GatewayRpcClient;
    patchMocks.applyConfigPatch.mockResolvedValueOnce({
      mode: "rpc",
      attempts: 1,
      noop: true,
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
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
      ],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddCustomerConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-1" },
    );

    expect(rpc.configPatchAndWaitForChange).not.toHaveBeenCalled();
    expect(rpc.channelsStop).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStart).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-coach",
    });
    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-proj-orbit",
    });
    expect(rpc.channelsStart).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-coach",
    });
    expect(rpc.channelsStart).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "alice-proj-orbit",
    });
  });

  it("attempts every coach and project monitor before aggregating restart failures", async () => {
    const stopAccounts: string[] = [];
    const startAccounts: string[] = [];
    const rpc = {
      channelsStop: vi.fn(async ({ channel, accountId }: { channel: string; accountId: string }) => {
        stopAccounts.push(accountId);
        if (accountId === "alice-proj-orbit") {
          throw new Error("orbit stop failed");
        }
        return { channel, accountId, stopped: true as const };
      }),
      channelsStart: vi.fn(async ({ channel, accountId }: { channel: string; accountId: string }) => {
        startAccounts.push(accountId);
        return { channel, accountId, started: true as const };
      }),
    } as unknown as GatewayRpcClient;
    patchMocks.applyConfigPatch.mockResolvedValueOnce({
      mode: "rpc",
      attempts: 1,
      noop: true,
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
        { scope: "project", projectId: "nova", kind: "general", channelId: "nova-general" },
      ],
      projects: [],
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        { projectId: "nova", enabled: true, mmUserId: "mm-nova", token: "pat-nova" },
      ],
      ownerName: "Alice",
      coachToken: "pat-1",
      coachMmUserId: "mm-alice-coach",
    };

    let caught: unknown;
    try {
      await adapter.applyAddCustomerConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain("alice-proj-orbit");
    expect(stopAccounts).toEqual([
      "alice-coach",
      "alice-proj-orbit",
      "alice-proj-nova",
    ]);
    expect(startAccounts).toEqual([
      "alice-coach",
      "alice-proj-orbit",
      "alice-proj-nova",
    ]);
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

  it("patches beta keyed entries with id-free values and removes stale project entries", async () => {
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
        agents: { entries: Record<string, Record<string, unknown> | null> };
      };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        entries: {
          "octogee-ops-eggman": { model: "house" },
          "octogee-alice-coach": { model: "stale" },
          "octogee-alice-proj-old-coach": { model: "stale" },
        },
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const patch = args.buildPatch(current);
    expect(patch.agents.entries["octogee-alice-proj-old-coach"]).toBeNull();
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
      return 1;
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
    expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
      groups: { "po-1": { requireMention: true } },
    });
    expect(patch.channels.mattermost.accounts["alice-proj-old"]).toBeNull();
  });
});
