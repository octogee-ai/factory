import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  applyConfigPatch,
  customerConfigFullAgentListReplacePaths,
} from "../lib/apply-config-patch.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";

const mocks = vi.hoisted(() => ({
  readActivationManifest: vi.fn(),
  applyOpenClawActivationManifest: vi.fn(),
  removeActivationManifest: vi.fn(),
}));
const patchMocks = vi.hoisted(() => ({
  applyConfigPatch: vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 })),
}));
const byotMocks = vi.hoisted(() => ({
  syncByotForCustomer: vi.fn(async () => undefined),
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
vi.mock("../lib/byot-sync-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/byot-sync-runtime.js")>();
  return {
    ...actual,
    syncByotForCustomer: byotMocks.syncByotForCustomer,
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
    setGreetingResult: vi.fn(async () => undefined),
    setAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
    recordReconcileError: vi.fn(async () => undefined),
    clearReconcileError: vi.fn(async () => undefined),
    notifySignup: vi.fn(async () => undefined),
    macOpsToken: vi.fn(async () => ({
      gatewayId: "gw",
      username: "tester10",
      mmUserId: "mm-user",
      token: "token",
    })),
    createProjectFromAgent: vi.fn(async () => ({
      success: true,
      workspaceId: "workspace",
      slug: "project",
      channelId: "channel",
    })),
    applyMilestoneSignal: vi.fn(async () => undefined),
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

describe("buildBrokeredLifecycleAdapter migration import activation", () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | null = null;

  beforeEach(() => {
    mocks.readActivationManifest.mockReset();
    mocks.applyOpenClawActivationManifest.mockReset();
    mocks.removeActivationManifest.mockReset();
    patchMocks.applyConfigPatch.mockClear();
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
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
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
    expect(rpc.channelsStatus).toHaveBeenCalled();
    expect(client.uidForSlug).not.toHaveBeenCalled();
  });

  it("accepts operator-source state-only imports when the activation manifest is absent", async () => {
    const err = new Error("ENOENT: no such file or directory, open activation.json") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mocks.readActivationManifest.mockRejectedValue(err);
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-import-state-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-tester10-coach"), {
      recursive: true,
    });
    const log = vi.fn();
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log,
    });

    await adapter.activateImportedCustomer("tester10");

    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
    expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[import:tester10] no customer activation manifest; imported operator agent state only",
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
});

describe("buildBrokeredLifecycleAdapter add config patch", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
  });

  it("preserves unrelated agents while explicitly confirming the full agent list replacement", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
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
      "octogee-bob-coach",
      "octogee-alice-coach",
    ]);
    expect(args.buildReplacePaths?.(current)).toEqual(
      customerConfigFullAgentListReplacePaths(current, "alice"),
    );
  });
});

describe("buildBrokeredLifecycleAdapter byot re-assert (db-less LLM-auth self-heal)", () => {
  beforeEach(() => byotMocks.syncByotForCustomer.mockClear());

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

  it("reassertByotForCustomer delegates to the brokered (Firestore-free) syncByotForCustomer with the userData verbatim", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });
    const userData = {
      username: "tester10",
      byotActive: false,
      provisioning: { openclaw: { status: "complete" } },
    };

    await adapter.reassertByotForCustomer(userData);

    expect(byotMocks.syncByotForCustomer).toHaveBeenCalledTimes(1);
    expect(byotMocks.syncByotForCustomer).toHaveBeenCalledWith(userData);
  });
});
