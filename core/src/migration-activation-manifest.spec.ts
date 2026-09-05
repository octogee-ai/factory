import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activationManifestAgentIds,
  activationManifestTarPath,
  applyOpenClawActivationManifest,
  extractOpenClawActivationManifest,
  readActivationManifest,
  writeActivationManifest,
  type MigrationActivationManifest,
} from "./migration-activation-manifest";
import { platformOpenAiEmbeddingSecretId } from "./platform-embedding-refs";
import {
  CUSTOMER_CODE_DENIED_TOOLS,
  CUSTOMER_WORKFLOW_TOOLS,
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
  platformInvariantViolations,
  reconcilePlatformInvariants,
} from "./system-config-invariants";

const tmpDirs: string[] = [];
const APPLIED_FINGERPRINT = "fp-alice-v1";

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activation-manifest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function manifest(): MigrationActivationManifest {
  return {
    version: 2,
    slug: "alice",
    appliedFingerprint: APPLIED_FINGERPRINT,
    agentId: "octogee-alice-coach",
    accountId: "alice-coach",
    agent: { id: "octogee-alice-coach", model: "custom-model" },
    mattermostAccount: { botToken: "coach-pat", groupAllowFrom: ["mm-user"] },
    bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    projectAgents: [],
  };
}

function withoutTools(agents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return agents.map(({ tools: _tools, ...agent }) => agent);
}

describe("activationManifestAgentIds", () => {
  it("lists the coach and every project agent the activation installs", () => {
    expect(
      activationManifestAgentIds({
        ...manifest(),
        projectAgents: [
          {
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            agent: { id: "octogee-alice-proj-orbit-coach" },
            mattermostAccount: {},
            bindings: [],
          },
        ],
      }),
    ).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
  });
});

describe("migration activation manifest", () => {
  it("never nulls a roster entry the target still carries — removals go through agents.delete", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house" },
              "octogee-alice-proj-residue-coach": { model: "house" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { entries: Record<string, unknown> };
    };
    expect(Object.values(patch.agents.entries)).not.toContain(null);
    expect(patch.agents.entries).not.toHaveProperty("octogee-alice-proj-residue-coach");
  });

  it("extracts only the per-customer OpenClaw fragments needed for local activation", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "octogee-bob-coach", model: "other" },
            { id: "octogee-alice-coach", model: "custom-model" },
          ],
        },
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": { botToken: "coach-pat" },
              "bob-coach": { botToken: "other-pat" },
            },
          },
        },
        bindings: [
          { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
          { agentId: "octogee-bob-coach", match: { channel: "mattermost", accountId: "bob-coach" } },
        ],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      slug: "alice",
      agent: { id: "octogee-alice-coach", model: "custom-model" },
      mattermostAccount: { botToken: "coach-pat" },
      bindings: [{ agentId: "octogee-alice-coach" }],
    });
  });

  it("extracts a beta keyed source entry as the id-bearing migration manifest agent", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { entries: { "octogee-alice-coach": { model: "custom-model" } } },
        channels: { mattermost: { accounts: { "alice-coach": { botToken: "coach-pat" } } } },
        bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      agent: { id: "octogee-alice-coach", model: "custom-model" },
    });
  });

  it("rejects a source agent binding that claims another customer's account", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      agents: { list: [{ id: "octogee-alice-coach", model: "custom-model" }] },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "coach-pat" } } } },
      bindings: [{
        agentId: "octogee-alice-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      }],
    }));

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).rejects.toThrow("foreign binding scope");
  });

  it("adds the stable account route when reading a peer-only customer manifest", async () => {
    const dir = await mkTmp();
    const peerOnly = {
      ...manifest(),
      bindings: [{
        agentId: "octogee-alice-coach",
        match: {
          channel: "mattermost",
          accountId: "alice-coach",
          peer: { kind: "group", id: "alice-general" },
        },
      }],
    };
    await writeActivationManifest(dir, peerOnly);

    await expect(readActivationManifest(dir, "alice")).resolves.toMatchObject({
      bindings: [
        {
          agentId: "octogee-alice-coach",
          match: { channel: "mattermost", accountId: "alice-coach" },
        },
        peerOnly.bindings[0],
      ],
    });
  });

  it("carries every active project agent's account and bindings without carrying another builder", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "octogee-alice-coach", model: "workspace" },
            { id: "octogee-alice-proj-orbit-coach", model: "orbit" },
            { id: "octogee-alice-proj-scout-coach", model: "scout" },
            { id: "octogee-bob-proj-orbit-coach", model: "foreign" },
          ],
        },
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": { botToken: "workspace-pat" },
              "alice-proj-orbit": { botToken: "orbit-pat" },
              "alice-proj-scout": { botToken: "scout-pat" },
              "bob-proj-orbit": { botToken: "foreign-pat" },
            },
          },
        },
        bindings: [
          { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
          { agentId: "octogee-alice-proj-orbit-coach", match: { channel: "mattermost", accountId: "alice-proj-orbit" } },
          { agentId: "octogee-alice-proj-scout-coach", match: { channel: "mattermost", accountId: "alice-proj-scout" } },
          { agentId: "octogee-bob-proj-orbit-coach", match: { channel: "mattermost", accountId: "bob-proj-orbit" } },
        ],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { model: "orbit" },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach" }],
        },
        {
          agentId: "octogee-alice-proj-scout-coach",
          accountId: "alice-proj-scout",
          agent: { model: "scout" },
          mattermostAccount: { botToken: "scout-pat" },
          bindings: [{ agentId: "octogee-alice-proj-scout-coach" }],
        },
      ],
    });
  });

  it("round-trips through the tar-relative manifest path", async () => {
    const dir = await mkTmp();
    const source = await writeActivationManifest(dir, manifest());

    expect(source).toEqual({
      cwd: dir,
      path: activationManifestTarPath("alice"),
    });
    await expect(readActivationManifest(dir, "alice")).resolves.toMatchObject({
      slug: "alice",
      mattermostAccount: { botToken: "coach-pat" },
    });
  });

  it.each([true, false])("rejects a version-one manifest with fingerprint present=%s", async (hasFingerprint) => {
    const dir = await mkTmp();
    const previous = { ...manifest(), version: 1 } as Record<string, unknown>;
    if (!hasFingerprint) delete previous.appliedFingerprint;
    const manifestPath = path.join(dir, activationManifestTarPath("alice"));
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(previous)}\n`, "utf-8");

    await expect(readActivationManifest(dir, "alice")).rejects.toThrow(
      "activation manifest version/slug mismatch",
    );
  });

  it("patches agent, account, and bindings without keeping stale entries for the same agent", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "old" }, { id: "octogee-bob-coach" }] },
          channels: { mattermost: { accounts: { default: { botToken: "mac" } } } },
          bindings: [
            { agentId: "octogee-alice-coach", stale: true },
            { agentId: "octogee-bob-coach", keep: true },
          ],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: string }> };
      channels: { mattermost: { accounts: Record<string, unknown> } };
      bindings: Array<{ agentId: string; stale?: boolean; keep?: boolean }>;
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      { id: "octogee-bob-coach" },
      { id: "octogee-alice-coach", model: "old" },
    ]);
    expect(patch.channels.mattermost.accounts).not.toHaveProperty("default");
    expect(patch.channels.mattermost.accounts).toHaveProperty("alice-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
    ]);
    // Dropping stale customer entries can shrink customer-scoped arrays — the OC
    // destructive-array guard requires the intent confirmed via replacePaths. (No
    // alice-coach account in this base config, so the derived set is agents+bindings.)
    expect(configPatch.mock.calls[0][2]).toEqual({
      replacePaths: [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
        "bindings",
      ],
    });
  });

  it("does not import a dedicated source coach's default flag into a shared roster", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-unmatched-route", default: true },
              { id: "octogee-bob-coach" },
            ],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, default: true },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(patch.agents.list.filter((agent) => agent.default === true)).toEqual([
      { id: "octogee-unmatched-route", default: true },
    ]);
  });

  it("declares explicit roster ownership on a Barn activation that carries no auth anchor", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-unmatched-route": { name: "Unmatched Mattermost route" },
              "octogee-bob-coach": { model: "foreign" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, unknown>; ownership?: string; defaults?: unknown };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults).toBeUndefined();
  });

  it("anchors Builder auth inheritance while retaining the coach routing default", async () => {
    const anchor = {
      id: "octogee-unmatched-route",
      name: "Unmatched Mattermost route",
      heartbeat: { every: "0m" },
    };
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house", default: true },
              "octogee-bob-coach": { model: "foreign" },
            },
            defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "builder",
      authInheritanceAnchor: { agentId: anchor.id, agent: anchor },
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: {
        entries: Record<string, Record<string, unknown>>;
        ownership: string;
        defaults: { authInheritance: { agentId: string } };
      };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults.authInheritance).toEqual({ agentId: anchor.id });
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: "house",
      default: true,
    });
    expect(patch.agents.entries[anchor.id]).toEqual({
      name: anchor.name,
      heartbeat: anchor.heartbeat,
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("tools");
    expect(patch.agents.entries).not.toHaveProperty("octogee-bob-coach");
  });

  it("adds the Builder auth anchor to a default-less list roster", async () => {
    const anchor = { id: "octogee-unmatched-route", heartbeat: { every: "0m" } };
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-bob-coach", model: "foreign" },
              { ...anchor, name: "old anchor" },
              { id: "octogee-alice-coach", model: "house" },
            ],
            defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "builder",
      authInheritanceAnchor: { agentId: anchor.id, agent: anchor },
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: {
        list: Array<Record<string, unknown>>;
        ownership: string;
        defaults: { authInheritance: { agentId: string } };
      };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults.authInheritance).toEqual({ agentId: anchor.id });
    expect(withoutTools(patch.agents.list)).toContainEqual({ id: "octogee-bob-coach", model: "foreign" });
    expect(withoutTools(patch.agents.list)).toContainEqual({
      id: "octogee-alice-coach",
      model: "house",
    });
    expect(withoutTools(patch.agents.list).filter((agent) => agent.id === anchor.id)).toEqual([anchor]);
    expect(patch.agents.list.find((agent) => agent.id === anchor.id)).not.toHaveProperty("tools");
    expect(patch.agents.list.find((agent) => agent.id === "octogee-alice-coach"))
      .not.toHaveProperty("tools");
  });

  it("lifts the exact shared coach tool fence when activating a Builder", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const sharedCoachTools = {
      profile: "coding",
      alsoAllow: [...CUSTOMER_WORKFLOW_TOOLS],
      deny: [...CUSTOMER_CODE_DENIED_TOOLS],
      fs: { workspaceOnly: true },
      toolsBySender: {},
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, tools: sharedCoachTools },
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "builder",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("tools");
  });

  it("lifts the exact shared project-agent tool fence when activating a Builder", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const projectAgentId = "octogee-alice-proj-orbit-coach";
    const sharedProjectTools = {
      profile: "minimal",
      alsoAllow: [...PROJECT_AGENT_ALLOWED_TOOLS],
      deny: [...PROJECT_AGENT_DENIED_TOOLS],
      exec: { mode: "deny", host: "node" },
      fs: { workspaceOnly: true },
      toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      projectAgents: [{
        agentId: projectAgentId,
        accountId: "alice-proj-orbit",
        agent: { id: projectAgentId, tools: sharedProjectTools },
        mattermostAccount: {},
        bindings: [],
      }],
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "builder",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries[projectAgentId]).not.toHaveProperty("tools");
  });

  it("preserves a Builder-owned coach tool policy during activation", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const tools = { profile: "full", deny: ["browser"] };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, tools },
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "builder",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries["octogee-alice-coach"]?.tools).toEqual(tools);
  });

  it("requests routing activation before patching only when the stable account route is absent", async () => {
    const accountBinding = {
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach" },
    };
    const activationManifest = {
      ...manifest(),
      bindings: [accountBinding],
    };
    const applyWith = async (
      bindings: unknown[],
      accounts: Record<string, unknown> = {},
      configNoop = false,
    ) => {
      const events: string[] = [];
      const onRoutingActivationRequired = vi.fn((accountIds: readonly string[]) => {
        events.push(`activation:${accountIds.join(",")}`);
      });
      const rpc = {
        configGet: vi.fn(async () => ({
          hash: "h1",
          config: {
            agents: { list: [{ id: "octogee-bob-coach" }] },
            channels: { mattermost: { accounts } },
            bindings,
          },
        })),
        configPatch: vi.fn(async (patch: unknown) => {
          events.push("configPatch");
          return { hash: "h2", config: patch, ...(configNoop ? { noop: true } : {}) };
        }),
        close: vi.fn(async () => undefined),
      };

      const result = await applyOpenClawActivationManifest(activationManifest, {
        rpc: rpc as never,
        log: vi.fn(),
        onRoutingActivationRequired,
      });
      return { events, onRoutingActivationRequired, result, rpc };
    };

    const missing = await applyWith([]);
    expect(missing.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(missing.result.routingActivationRequired).toBe(true);
    expect(missing.result.restartExistingAccountIds).toEqual([]);

    const existingAccount = await applyWith([], {
      "alice-coach": { botToken: "stale-secret-ref" },
    });
    expect(existingAccount.result.routingActivationRequired).toBe(true);
    expect(existingAccount.result.restartExistingAccountIds).toEqual(["alice-coach"]);

    const present = await applyWith([accountBinding]);
    expect(present.events).toEqual(["configPatch"]);
    expect(present.onRoutingActivationRequired).not.toHaveBeenCalled();
    expect(present.result.routingActivationRequired).toBe(false);
    expect(present.result.configNoop).toBe(false);

    const noop = await applyWith([accountBinding], {}, true);
    expect(noop.result.routingActivationRequired).toBe(false);
    expect(noop.result.configNoop).toBe(true);

    const foreignPeer = {
      agentId: "octogee-bob-coach",
      match: {
        channel: "mattermost",
        accountId: "alice-coach",
        peer: { kind: "group", id: "alice-general" },
      },
    };
    const conflicted = await applyWith([accountBinding, foreignPeer]);
    expect(conflicted.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(conflicted.result.routingActivationRequired).toBe(true);
    expect(conflicted.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [accountBinding],
    });

    const retiredProjectOnForeignAccount = {
      agentId: "octogee-alice-proj-retired-coach",
      match: { channel: "mattermost", accountId: "mike-coach" },
    };
    const retired = await applyWith(
      [accountBinding, retiredProjectOnForeignAccount],
      { "mike-coach": { botToken: "mike-pat" } },
    );
    expect(retired.events).toEqual(["configPatch"]);
    expect(retired.result.routingActivationRequired).toBe(false);
    expect(retired.result.restartExistingAccountIds).toEqual([]);
    expect(retired.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [accountBinding],
    });

    const wildcardRoute = {
      agentId: "octogee-unmatched-route",
      match: { channel: "mattermost", accountId: "*" },
    };
    const wildcard = await applyWith(
      [wildcardRoute],
      { "alice-coach": { botToken: "stale-secret-ref" } },
    );
    expect(wildcard.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(wildcard.result.routingActivationRequired).toBe(true);
    expect(wildcard.result.restartExistingAccountIds).toEqual(["alice-coach"]);
    expect(wildcard.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [wildcardRoute, accountBinding],
    });
  });

  it("rebinds redacted platform embedding refs before replacing the stable agent list", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [{
              id: "octogee-bob-coach",
              memorySearch: {
                provider: "openai-compatible",
                remote: {
                  baseUrl: "http://llm-broker:3010/v1",
                  apiKey: {
                    source: "exec",
                    provider: "gcp-secret-manager",
                    id: "__OPENCLAW_REDACTED__",
                  },
                },
              },
            }],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; memorySearch?: { remote?: { apiKey?: { id?: string } } } }> };
    };
    expect(patch.agents.list[0]?.memorySearch?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-bob-coach"),
    );
  });

  it("replays all project agents while leaving foreign accounts and bindings out of the patch", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-bob-coach", model: "foreign" },
              { id: "octogee-alice-coach", model: "workspace-target" },
              { id: "octogee-alice-proj-old-coach", model: "retired" },
              { id: "octogee-alice-proj-orbit-coach", model: "orbit-target" },
            ],
          },
          channels: {
            mattermost: {
              accounts: {
                default: { botToken: { source: "file", id: "/default" } },
                "alice-proj-old": { botToken: { source: "file", id: "/old" } },
                "alice-proj-orbit": { botToken: { source: "file", id: "/orbit" } },
                "bob-coach": { botToken: { source: "file", id: "/bob" } },
              },
            },
          },
          bindings: [
            { agentId: "octogee-bob-coach", keep: true },
            { agentId: "octogee-alice-coach", stale: true },
            { agentId: "octogee-alice-proj-old-coach", stale: true },
            { agentId: "octogee-alice-proj-orbit-coach", stale: true },
          ],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const projectManifest: MigrationActivationManifest = {
      ...manifest(),
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { id: "octogee-alice-proj-orbit-coach", model: "orbit-source" },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach", match: { peer: "orbit" } }],
        },
        {
          agentId: "octogee-alice-proj-scout-coach",
          accountId: "alice-proj-scout",
          agent: { id: "octogee-alice-proj-scout-coach", model: "scout-source" },
          mattermostAccount: { botToken: "scout-pat" },
          bindings: [{ agentId: "octogee-alice-proj-scout-coach", match: { peer: "scout" } }],
        },
      ],
    };

    await applyOpenClawActivationManifest(projectManifest, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: string }> };
      bindings: Array<{ agentId: string; stale?: boolean; keep?: boolean }>;
      channels: { mattermost: { accounts: Record<string, unknown> } };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      { id: "octogee-bob-coach", model: "foreign" },
      { id: "octogee-alice-coach", model: "workspace-target" },
      { id: "octogee-alice-proj-orbit-coach", model: "orbit-target" },
      { id: "octogee-alice-proj-scout-coach", model: "scout-source" },
    ]);
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      ...projectManifest.bindings,
      ...projectManifest.projectAgents.flatMap((entry) => entry.bindings),
    ]);
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-proj-old": null,
      "alice-coach": projectManifest.mattermostAccount,
      "alice-proj-orbit": projectManifest.projectAgents[0]!.mattermostAccount,
      "alice-proj-scout": projectManifest.projectAgents[1]!.mattermostAccount,
    });
  });

  it("replays the finish-rsync activation manifest into beta keyed entries without sending agents.list", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house" },
              "octogee-bob-coach": { model: "other" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [{ agentId: "octogee-bob-coach", keep: true }],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        model: "custom-model",
        memorySearch: { provider: "openai-compatible" },
      },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
      bindings: Array<{ agentId: string; keep?: boolean }>;
    };
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: "house",
      memory: { search: { provider: "openai-compatible" } },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents).not.toHaveProperty("list");
    expect(patch.agents.entries).not.toHaveProperty("octogee-bob-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
    ]);
    expect(configPatch.mock.calls[0][2]).toEqual({ replacePaths: ["bindings"] });
  });

  it("downgrades a beta memory.search agent to stable memorySearch during activation", async () => {
    const sourceDir = await mkTmp();
    const sourceConfigPath = path.join(sourceDir, "openclaw.json");
    await fs.writeFile(sourceConfigPath, JSON.stringify({
      agents: {
        list: [{
          id: "octogee-alice-coach",
          model: "beta-model",
          tools: {
            profile: "coding",
            alsoAllow: CUSTOMER_WORKFLOW_TOOLS,
            deny: ["preview_start", "preview_stop", "preview_list", "octogee_publish"],
            fs: { workspaceOnly: true },
            toolsBySender: {},
          },
          memory: { search: { provider: "openai-compatible", model: "text-embedding-3-small" } },
        }],
      },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "coach-pat" } } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    }));
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "house" }] },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    const betaManifest = await extractOpenClawActivationManifest(sourceConfigPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    });
    await applyOpenClawActivationManifest(betaManifest, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      {
        id: "octogee-alice-coach",
        model: "house",
        memorySearch: { provider: "openai-compatible", model: "text-embedding-3-small" },
      },
    ]);
    expect(patch.agents.list[0]).not.toHaveProperty("memory");
    const candidate: Record<string, unknown> = {};
    reconcilePlatformInvariants(candidate, { gatewayClass: "shared" });
    candidate.agents = patch.agents;
    expect(platformInvariantViolations(candidate, { gatewayClass: "shared" })).toEqual([]);
  });

  it("refuses beta-only memory fields that stable agents cannot represent", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "house" }] },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await expect(applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        memory: {
          search: { provider: "openai-compatible" },
          consolidation: { enabled: true },
        },
      },
    }, { rpc: rpc as never, log: vi.fn() })).rejects.toThrow(
      /stable target cannot represent beta agent memory fields: consolidation/,
    );
    expect(configPatch).not.toHaveBeenCalled();
  });

  it("preserves the target gateway's current coach model when activation replays stale agent metadata", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              {
                id: "octogee-alice-coach",
                model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] },
              },
            ],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        name: "Gene (alice)",
        model: { primary: "anthropic/claude-haiku-4-5", fallbacks: [] },
        identity: { name: "Gene", emoji: ":sparkles:" },
      },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: unknown; name?: string }> };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      {
        id: "octogee-alice-coach",
        name: "Gene (alice)",
        model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] },
        identity: { name: "Gene", emoji: ":sparkles:" },
      },
    ]);
  });

  it("confirms the residual account's arrays when importing over residue (re-import case)", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [] },
          channels: {
            mattermost: {
              accounts: {
                default: { botToken: "mac" },
                // Residue from a prior mount of the same slug — its allowlist array must be
                // confirmed or the merged (possibly shrunk) account fragment trips the guard.
                "alice-coach": { botToken: "stale-pat", groupAllowFrom: ["mm-old-1", "mm-old-2"] },
              },
            },
          },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    expect(configPatch.mock.calls[0][2]).toEqual({
      replacePaths: [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
        "bindings",
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      ],
    });
  });
});
