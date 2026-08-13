import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  activatePendingMattermostRouting,
  captureMattermostRoutingActivationBaseline,
  markMattermostRoutingActivationPending,
  mattermostRoutingActivationPending,
  stopStaleMattermostRoutingAccounts,
} from "../lib/mattermost-routing-activation.js";

const temporaryDirectories: string[] = [];

async function temporaryOpenClawDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-routing-activation-"));
  temporaryDirectories.push(directory);
  return directory;
}

function configGetWithMattermostAccounts(accountIds: readonly string[]) {
  return vi.fn(async () => ({
    hash: "h1",
    config: {
      channels: {
        mattermost: {
          accounts: Object.fromEntries(accountIds.map((accountId) => [accountId, {}])),
        },
      },
    },
  }));
}

function channelOperationRpc(
  accountIds: readonly string[],
  channelsStatus: GatewayRpcClient["channelsStatus"],
) {
  return {
    configGet: configGetWithMattermostAccounts(accountIds),
    channelsStatus,
    channelsStatusConnectionGeneration: vi.fn(() => 7),
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
    gatewayRestartRequest: vi.fn(),
  } as unknown as GatewayRpcClient;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Mattermost routing activation", () => {
  it("fails closed when a present account has no valid lastStartAt baseline", async () => {
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", running: true, connected: true },
        ] },
      })),
    );

    await expect(
      captureMattermostRoutingActivationBaseline(rpc, ["ceckert-coach"]),
    ).rejects.toThrow("Mattermost account ceckert-coach has an invalid lastStartAt");
  });

  it("stops removed project and evicted accounts without restarting them", async () => {
    const rpc = channelOperationRpc(
      ["alice-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          { accountId: "alice-coach", running: true, connected: true, lastStartAt: 100 },
          { accountId: "alice-proj-retired", running: true, connected: true, lastStartAt: 100 },
          { accountId: "bob-coach", running: true, connected: true, lastStartAt: 100 },
          { accountId: "carol-coach", running: true, connected: true, lastStartAt: 100 },
        ] },
      })),
    );

    await stopStaleMattermostRoutingAccounts(rpc, {
      currentSlug: "alice",
      desiredAccountIds: ["alice-coach"],
      evictionSlugs: ["bob"],
    }, vi.fn());

    expect(vi.mocked(rpc.channelsStop).mock.calls.map(([params]) => params.accountId)).toEqual([
      "alice-proj-retired",
      "bob-coach",
    ]);
    expect(rpc.channelsStart).not.toHaveBeenCalled();
  });

  it("accepts the config hot-reload activation without manually restarting the account", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-proj-gardyn"],
      { "ceckert-proj-gardyn": 100 },
    );
    const snapshots = [
      {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-proj-gardyn",
            running: true,
            connected: true,
            lastStartAt: 100,
          },
          {
            accountId: "unrelated-coach",
            running: true,
            connected: true,
            lastStartAt: 200,
          },
        ] },
      },
      {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-proj-gardyn",
            running: true,
            connected: true,
            lastStartAt: 101,
          },
          {
            accountId: "unrelated-coach",
            running: true,
            connected: true,
            lastStartAt: 200,
          },
        ] },
      },
    ];
    const rpc = channelOperationRpc(
      ["ceckert-proj-gardyn", "unrelated-coach"],
      vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(rpc.channelsStatusConnectionGeneration).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("restarts a marked account when persisted config was already a no-op", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "persisted binding may have a stale monitor",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-coach",
            running: true,
            connected: true,
            lastStartAt: 101,
          },
        ] },
      })),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      restartAfterConfigNoop: true,
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "ceckert-coach",
    });
    expect(rpc.channelsStart).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "ceckert-coach",
    });
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("keeps the marker and attempts start when a no-op monitor stop fails", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "persisted binding may have a stale monitor",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
    );
    vi.mocked(rpc.channelsStop).mockRejectedValueOnce(new Error("stop refused"));

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        restartAfterConfigNoop: true,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("Mattermost account restart failed");

    expect(rpc.channelsStart).toHaveBeenCalledOnce();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("starts an initially absent account and verifies that it connects", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "new account binding",
      ["ceckert-proj-gardyn"],
      { "ceckert-proj-gardyn": 0 },
    );
    const snapshots = [
      { channelAccounts: { mattermost: [] } },
      {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-proj-gardyn",
            running: true,
            connected: true,
            lastStartAt: 1,
          },
        ] },
      },
    ];
    const rpc = channelOperationRpc(
      ["ceckert-proj-gardyn"],
      vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("waits until every marked account is connected with a newer start time", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account bindings changed",
      ["ceckert-coach", "ceckert-proj-gardyn"],
      { "ceckert-coach": 100, "ceckert-proj-gardyn": 200 },
    );
    const snapshots = [
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", lastStartAt: 100 },
          { accountId: "ceckert-proj-gardyn", lastStartAt: 200 },
        ] },
      },
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", running: true, connected: true, lastStartAt: 101 },
          { accountId: "ceckert-proj-gardyn", running: true, connected: true, lastStartAt: 200 },
        ] },
      },
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", running: true, connected: true, lastStartAt: 101 },
          { accountId: "ceckert-proj-gardyn", running: true, connected: true, lastStartAt: 201 },
        ] },
      },
    ];
    const rpc = channelOperationRpc(
      ["ceckert-coach", "ceckert-proj-gardyn"],
      vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(rpc.channelsStatus).toHaveBeenCalledTimes(3);
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("preserves the marker when scoped activation never becomes healthy", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    let statusCall = 0;
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => {
        statusCall += 1;
        return {
          channelAccounts: { mattermost: [
            {
              accountId: "ceckert-coach",
              running: statusCall === 1,
              connected: statusCall === 1,
              lastStartAt: statusCall === 1 ? 100 : 101,
            },
          ] },
        };
      }),
    );
    let now = 0;

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        now: () => now,
        sleep: async () => {
          now += 10;
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Mattermost routing activation was not observed");

    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("allows a scoped activation to settle after the config patch deadline", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    let now = 0;
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-coach",
            running: true,
            connected: true,
            lastStartAt: now > 60_000 ? 101 : 100,
          },
        ] },
      })),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      now: () => now,
      sleep: async () => {
        now += 10_000;
      },
    });

    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("preserves the marker when config hot reload never advances the account", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", lastStartAt: 100 },
        ] },
      })),
    );
    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        now: (() => {
          let now = 0;
          return () => now += 10;
        })(),
        sleep: async () => undefined,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Mattermost routing activation was not observed");

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("preserves the marker when a connected account reports an infinite start time", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-coach",
            running: true,
            connected: true,
            lastStartAt: Number.POSITIVE_INFINITY,
          },
        ] },
      })),
    );

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        now: (() => {
          let now = 0;
          return () => now += 10;
        })(),
        sleep: async () => undefined,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("Mattermost routing activation was not observed");
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("activates a new marker that arrives before the first marker clears", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "first account binding",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    let statusCall = 0;
    const rpc = channelOperationRpc(
      ["ceckert-coach", "ceckert-proj-gardyn"],
      vi.fn(async () => {
        statusCall += 1;
        if (statusCall === 1) {
          return {
            channelAccounts: { mattermost: [
              { accountId: "ceckert-coach", lastStartAt: 100 },
            ] },
          };
        }
        if (statusCall === 2) {
          markMattermostRoutingActivationPending(
            openclawDir,
            "second account binding",
            ["ceckert-proj-gardyn"],
            { "ceckert-proj-gardyn": 0 },
          );
          return {
            channelAccounts: { mattermost: [
              {
                accountId: "ceckert-coach",
                running: true,
                connected: true,
                lastStartAt: 101,
              },
            ] },
          };
        }
        if (statusCall === 3) {
          return {
            channelAccounts: { mattermost: [
              { accountId: "ceckert-coach", lastStartAt: 101 },
              { accountId: "ceckert-proj-gardyn", lastStartAt: 200 },
            ] },
          };
        }
        return {
          channelAccounts: { mattermost: [
            { accountId: "ceckert-coach", lastStartAt: 101 },
            {
              accountId: "ceckert-proj-gardyn",
              running: true,
              connected: true,
              lastStartAt: 201,
            },
          ] },
        };
      }),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("drops retired account ids after persisted config confirms they are absent", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "retired project account",
      ["ceckert-proj-retired"],
      { "ceckert-proj-retired": 0 },
    );
    markMattermostRoutingActivationPending(
      openclawDir,
      "new project account",
      ["ceckert-proj-new"],
      { "ceckert-proj-new": 100 },
    );
    const snapshots = [
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-proj-new", lastStartAt: 100 },
        ] },
      },
      {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-proj-new",
            running: true,
            connected: true,
            lastStartAt: 101,
          },
        ] },
      },
    ];
    const rpc = channelOperationRpc(
      ["ceckert-proj-new"],
      vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
    );
    let now = Date.now();

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      timeoutMs: 20,
      accountAbsenceGraceMs: 0,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("recovers a marker stranded in a confirmed claim by a process crash", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "new account binding",
      ["ceckert-coach"],
      { "ceckert-coach": 100 },
    );
    const marker = (await fs.readdir(openclawDir)).find((entry) =>
      entry.startsWith(".mattermost-routing-restart-required.json") &&
      !entry.endsWith(".tmp")
    )!;
    await fs.rename(
      path.join(openclawDir, marker),
      path.join(openclawDir, ".mattermost-routing-restart-required.json.crash.confirmed"),
    );
    const snapshots = [
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", lastStartAt: 100 },
        ] },
      },
      {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-coach",
            running: true,
            connected: true,
            lastStartAt: 101,
          },
        ] },
      },
    ];
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
    );

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });
});
