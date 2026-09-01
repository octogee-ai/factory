import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import type { UserSnapshot } from "../lib/customer-lifecycle.js";

vi.mock("../lib/mattermost-account-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mattermost-account-secrets.js")>();
  return { ...actual, updateMattermostAccountSecrets: vi.fn(async () => undefined) };
});

interface RuntimeMock {
  tempRoot: string;
  agentsDir: string;
  applyConfigPatch: ReturnType<typeof vi.fn>;
}

const ALICE_MM_USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE_COACH_MM_USER_ID = "cccccccccccccccccccccccccc";

const userSnapshot: UserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "standard",
  gatewayId: "default-blue",
  status: "complete",
  agentIds: [],
  repoUrl: "",
  mattermostUserId: ALICE_MM_USER_ID,
  greetingPosted: false,
  channels: [],
  ownerName: "Alice",
};

const brokerSnapshot: FleetBrokerUserSnapshot = {
  ...userSnapshot,
  customerMmUserId: ALICE_MM_USER_ID,
  coachToken: "pat-1",
  coachMmUserId: ALICE_COACH_MM_USER_ID,
  projects: [],
};

function mkClient(snapshot: FleetBrokerUserSnapshot): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    uidForSlug: vi.fn(async () => snapshot.uid),
    userSnapshot: vi.fn(async () => snapshot),
    reconcileProjectCoachMembership: vi.fn(async () => undefined),
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
    recordUsageEvent: vi.fn(async () => undefined),
    blobDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      method: "GET",
      gcsPath: "customers/alice/file",
      expiresAt: new Date(0).toISOString(),
    })),
    blobUploadUrl: vi.fn(async () => ({
      url: "https://example.com/upload",
      method: "PUT",
      gcsPath: "customers/alice/file",
      expiresAt: new Date(0).toISOString(),
    })),
  };
}

async function withRuntimeMock(fn: (runtime: RuntimeMock) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "customer-agent-dir-"));
  const agentsDir = path.join(tempRoot, "agents");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const applyConfigPatch = vi.fn(async () => {
    expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent"))).toBe(true);
    return { mode: "rpc" as const, attempts: 1 };
  });
  vi.resetModules();
  vi.doMock("../lib/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/config.js")>();
    return {
      ...actual,
      OPENCLAW_DIR: tempRoot,
      OPENCLAW_CONFIG: path.join(tempRoot, "openclaw.json"),
      AGENTS_DIR: agentsDir,
      CUSTOMERS_DIR: path.join(tempRoot, "customers"),
      CUSTOMER_KEYS_DIR: path.join(tempRoot, "customer-keys"),
    };
  });
  vi.doMock("../lib/apply-config-patch.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/apply-config-patch.js")>();
    return { ...actual, applyConfigPatch };
  });
  try {
    await fn({ tempRoot, agentsDir, applyConfigPatch });
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    vi.doUnmock("../lib/config.js");
    vi.doUnmock("../lib/apply-config-patch.js");
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("customer lifecycle config patch agent directories", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("broker adapter creates the coach agent dir before adding the customer config", async () => {
    await withRuntimeMock(async ({ agentsDir, applyConfigPatch }) => {
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {
          channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
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
          configGet: vi.fn(async () => ({
            config: { agents: { entries: { "octogee-alice-coach": { model: "house" } } } },
            hash: "cfg-hash",
          })),
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
            ok: true as const,
            agentId,
          })),
          agentsCreate: vi.fn(async ({ name, workspace }: { name: string; workspace: string }) => ({
            ok: true as const,
            agentId: name,
            name,
            workspace,
          })),
          secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.applyAddCustomerConfigPatch(userSnapshot, { _coachPersonalToken: "pat-1" });

      expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent"))).toBe(true);
      expect(applyConfigPatch).toHaveBeenCalledTimes(1);
    });
  });

  // Project checkouts clone AFTER the mount patch, so agents.create would
  // otherwise be handed a workspace path that does not exist yet.
  it("broker adapter creates each new agent's workspace before agents.create", async () => {
    await withRuntimeMock(async ({ tempRoot }) => {
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-broker-adapter.js"
      );
      const workspaces: string[] = [];
      const channelsStatus = vi.fn(async () => ({ channelAccounts: { mattermost: [] } }));
      const agentsCreate = vi.fn(
        async ({ name, workspace }: { name: string; workspace: string }) => {
          expect(fsSync.existsSync(workspace)).toBe(true);
          workspaces.push(workspace);
          return { ok: true as const, agentId: name, name, workspace };
        },
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient({
          ...brokerSnapshot,
          projectAgents: [
            { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
          ],
        }),
        rpc: {
          channelsStatus,
          configGet: vi.fn(async () => ({ config: { agents: { entries: {} } }, hash: "cfg-hash" })),
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
            ok: true as const,
            agentId,
          })),
          agentsCreate,
          secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.applyAddCustomerConfigPatch(userSnapshot, { _coachPersonalToken: "pat-1" });

      expect(workspaces).toEqual([
        path.join(tempRoot, "customers", "alice"),
        path.join(tempRoot, "customers", "alice", "projects", "orbit"),
      ]);
      expect(agentsCreate.mock.invocationCallOrder.at(-1)).toBeLessThan(
        channelsStatus.mock.invocationCallOrder[0]!,
      );
    });
  });

  it("prod adapter creates the coach agent dir before adding the customer config", async () => {
    await withRuntimeMock(async ({ agentsDir, applyConfigPatch }) => {
      const { buildProductionLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-prod-adapter.js"
      );
      const adapter = buildProductionLifecycleAdapter({
        db: {} as Firestore,
        rpc: {
          channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.applyAddCustomerConfigPatch(userSnapshot, { _coachPersonalToken: "pat-1" });

      expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent"))).toBe(true);
      expect(applyConfigPatch).toHaveBeenCalledTimes(1);
    });
  });

  it("broker import preparation keeps the coach agent dir present across a gateway restart", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const customerKey = path.join(tempRoot, "customer-keys", "alice", "id_ed25519");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "stale.json"), "stale");
      await fs.mkdir(path.dirname(customerKey), { recursive: true });
      await fs.writeFile(customerKey, "private-key");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {} as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.prepareImportDir("alice", "pre");

      expect(fsSync.existsSync(agentDir)).toBe(true);
      expect(fsSync.existsSync(path.join(agentDir, "stale.json"))).toBe(false);
      expect(fsSync.existsSync(customerKey)).toBe(true);
    });
  });

  it("prod import preparation keeps the coach agent dir present across a gateway restart", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const customerKey = path.join(tempRoot, "customer-keys", "alice", "id_ed25519");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "stale.json"), "stale");
      await fs.mkdir(path.dirname(customerKey), { recursive: true });
      await fs.writeFile(customerKey, "private-key");
      const { buildProductionLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-prod-adapter.js"
      );
      const adapter = buildProductionLifecycleAdapter({
        db: {} as Firestore,
        rpc: {} as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.prepareImportDir("alice", "pre");

      expect(fsSync.existsSync(agentDir)).toBe(true);
      expect(fsSync.existsSync(path.join(agentDir, "stale.json"))).toBe(false);
      expect(fsSync.existsSync(customerKey)).toBe(true);
    });
  });

  it("carries the configured Builder agent root, workspace, and session store as one portable plan", async () => {
    await withRuntimeMock(async ({ tempRoot }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      vi.stubEnv("GATEWAY_BUILDER_SLUG", "alice");
      const customAgentDir = path.join(tempRoot, "agents", "discord-helper", "runtime");
      const workspace = path.join(tempRoot, "workspaces", "discord-helper");
      const sessions = path.join(tempRoot, "agents", "discord-helper", "sessions", "sessions.json");
      await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify({
        agents: {
          list: [{
            id: "discord-helper",
            agentDir: customAgentDir,
            workspace,
          }],
        },
        session: { store: path.join(tempRoot, "agents", "{agentId}", "sessions", "sessions.json") },
      }));
      for (const [absolutePath, contents] of [
        [path.join(customAgentDir, "auth.json"), "agent-auth"],
        [path.join(workspace, "NOTES.md"), "workspace"],
        [sessions, JSON.stringify({ sessions: [] })],
        [path.join(tempRoot, "memory", "discord-helper.sqlite"), "sqlite"],
      ]) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, contents);
      }
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {} as GatewayRpcClient,
        log: vi.fn(),
      });

      await expect(adapter.listExportPaths("alice")).resolves.toEqual(expect.arrayContaining([
        { cwd: tempRoot, path: path.join("agents", "discord-helper") },
        { cwd: tempRoot, path: path.join("workspaces", "discord-helper") },
        { cwd: tempRoot, path: path.join("memory", "discord-helper.sqlite") },
      ]));

      await fs.rm(customAgentDir, { recursive: true, force: true });
      await adapter.prepareImportDir("alice", "final");
      expect(fsSync.existsSync(customAgentDir)).toBe(true);
    });
  });

  it.each(["broker", "prod"] as const)(
    "does not export the neutral route agent state from a configured Builder (%s)",
    async (adapterKind) => {
      await withRuntimeMock(async ({ tempRoot }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        vi.stubEnv("GATEWAY_BUILDER_SLUG", "alice");
        const fallbackAgentId = "octogee-unmatched-route";
        const coachAgentId = "octogee-alice-coach";
        const projectAgentId = "octogee-alice-proj-orbit-coach";
        await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify({
          agents: {
            list: [
              { id: fallbackAgentId },
              {
                id: coachAgentId,
                default: true,
                workspace: path.join(tempRoot, "customers", "alice"),
              },
              {
                id: projectAgentId,
                workspace: path.join(tempRoot, "customers", "alice", "projects", "orbit"),
              },
            ],
          },
        }));
        for (const [relativePath, contents] of [
          [`agents/${fallbackAgentId}/agent/state.json`, "fallback-agent"],
          [`workspace-${fallbackAgentId}/notes.md`, "fallback-workspace"],
          [`memory/${fallbackAgentId}.sqlite`, "fallback-memory"],
          [`agents/${coachAgentId}/agent/state.json`, "coach-agent"],
          [`customers/alice/notes.md`, "coach-workspace"],
          [`memory/${coachAgentId}.sqlite`, "coach-memory"],
          [`agents/${projectAgentId}/agent/state.json`, "project-agent"],
          [`customers/alice/projects/orbit/notes.md`, "project-workspace"],
          [`memory/${projectAgentId}.sqlite`, "project-memory"],
        ]) {
          const absolutePath = path.join(tempRoot, relativePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, contents);
        }

        const adapter = adapterKind === "broker"
          ? (await import("../lib/customer-lifecycle-broker-adapter.js")).buildBrokeredLifecycleAdapter({
            client: mkClient(brokerSnapshot),
            rpc: {} as GatewayRpcClient,
            log: vi.fn(),
          })
          : (await import("../lib/customer-lifecycle-prod-adapter.js")).buildProductionLifecycleAdapter({
            db: {} as Firestore,
            rpc: {} as GatewayRpcClient,
            log: vi.fn(),
          });

        const paths = await adapter.listExportPaths("alice");

        expect(paths).toEqual(expect.arrayContaining([
          { cwd: tempRoot, path: `agents/${coachAgentId}` },
          { cwd: tempRoot, path: `agents/${projectAgentId}` },
          { cwd: tempRoot, path: "customers/alice" },
          { cwd: tempRoot, path: `memory/${coachAgentId}.sqlite` },
          { cwd: tempRoot, path: `memory/${projectAgentId}.sqlite` },
        ]));
        expect(paths).not.toEqual(expect.arrayContaining([
          { cwd: tempRoot, path: `agents/${fallbackAgentId}` },
          { cwd: tempRoot, path: `workspace-${fallbackAgentId}` },
          { cwd: tempRoot, path: `memory/${fallbackAgentId}.sqlite` },
        ]));
      });
    },
  );

  it("retains a configured Builder overlay during imported cleanup, stopping only its chat accounts", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir, applyConfigPatch }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      vi.stubEnv("GATEWAY_BUILDER_SLUG", "alice");
      const customerDir = path.join(tempRoot, "customers", "alice");
      const customerKey = path.join(tempRoot, "customer-keys", "alice", "id_ed25519");
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      await fs.mkdir(customerDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(path.dirname(customerKey), { recursive: true });
      await fs.mkdir(path.join(customerDir, ".system"), { recursive: true });
      await fs.writeFile(customerKey, "private-key");
      await fs.writeFile(path.join(customerDir, ".system", ".mounted"), "");
      await fs.writeFile(path.join(customerDir, ".system", ".migrating-in"), "");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/customer-lifecycle-broker-adapter.js"
      );
      const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({
        ok: true as const,
        agentId,
        removedBindings: 0,
      }));
      const channelsStop = vi.fn(async () => ({ ok: true as const }));
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {
          configGet: vi.fn(async () => ({
            config: { agents: { entries: { "octogee-alice-coach": { model: "house" } } } },
            hash: "cfg-hash",
          })),
          agentsDelete,
          channelsStatus: vi.fn(async () => ({
            channelAccounts: {
              mattermost: [{ accountId: "alice-coach", running: true }],
            },
          })),
          channelsStop,
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await expect(adapter.removeImportedCustomerBySlug("alice")).resolves.toMatchObject({
        wasMounted: true,
        retained: true,
      });

      expect(agentsDelete).not.toHaveBeenCalled();
      expect(channelsStop).toHaveBeenCalledWith({ channel: "mattermost", accountId: "alice-coach" });
      expect(applyConfigPatch).not.toHaveBeenCalled();
      expect(fsSync.existsSync(customerDir)).toBe(true);
      expect(fsSync.existsSync(customerKey)).toBe(true);
      expect(fsSync.existsSync(agentDir)).toBe(true);
      expect(fsSync.existsSync(path.join(customerDir, ".system", ".mounted"))).toBe(false);
      expect(fsSync.existsSync(path.join(customerDir, ".system", ".migrating-in"))).toBe(false);
    });
  });
});
