import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activationManifestTarPath,
  applyOpenClawActivationManifest,
  extractOpenClawActivationManifest,
  readActivationManifest,
  writeActivationManifest,
  type MigrationActivationManifest,
} from "./migration-activation-manifest";

const tmpDirs: string[] = [];

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
    version: 1,
    slug: "alice",
    agentId: "octogee-alice-coach",
    accountId: "alice-coach",
    agent: { id: "octogee-alice-coach", model: "custom-model" },
    mattermostAccount: { botToken: "coach-pat", groupAllowFrom: ["mm-user"] },
    bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost" } }],
  };
}

describe("migration activation manifest", () => {
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
          { agentId: "octogee-alice-coach", match: { channel: "mattermost" } },
          { agentId: "octogee-bob-coach", match: { channel: "mattermost" } },
        ],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice")).resolves.toMatchObject({
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
        bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost" } }],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice")).resolves.toMatchObject({
      agent: { id: "octogee-alice-coach", model: "custom-model" },
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
    expect(patch.agents.list).toEqual([
      { id: "octogee-bob-coach" },
      { id: "octogee-alice-coach", model: "old" },
    ]);
    expect(patch.channels.mattermost.accounts).toHaveProperty("default");
    expect(patch.channels.mattermost.accounts).toHaveProperty("alice-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost" } },
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
    expect(patch.agents.entries["octogee-alice-coach"]).toEqual({
      model: "house",
      memory: { search: { provider: "openai-compatible" } },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents).not.toHaveProperty("list");
    expect(patch.agents.entries).not.toHaveProperty("octogee-bob-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost" } },
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
          memory: { search: { provider: "openai-compatible", model: "text-embedding-3-small" } },
        }],
      },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "coach-pat" } } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost" } }],
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

    const betaManifest = await extractOpenClawActivationManifest(sourceConfigPath, "alice");
    await applyOpenClawActivationManifest(betaManifest, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(patch.agents.list).toEqual([
      {
        id: "octogee-alice-coach",
        model: "house",
        memorySearch: { provider: "openai-compatible", model: "text-embedding-3-small" },
      },
    ]);
    expect(patch.agents.list[0]).not.toHaveProperty("memory");
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
    expect(patch.agents.list).toEqual([
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
