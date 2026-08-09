import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  activatePendingMattermostRouting,
  markMattermostRoutingActivationPending,
  mattermostRoutingActivationPending,
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
  it("restarts only marked Mattermost accounts without restarting the gateway", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-proj-gardyn"],
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

    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "ceckert-proj-gardyn",
    });
    expect(rpc.channelsStart).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "ceckert-proj-gardyn",
    });
    expect(rpc.channelsStop).toHaveBeenCalledOnce();
    expect(rpc.channelsStart).toHaveBeenCalledOnce();
    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(rpc.channelsStatusConnectionGeneration).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("starts an initially absent account and verifies that it connects", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "new account binding",
      ["ceckert-proj-gardyn"],
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

    expect(rpc.channelsStop).toHaveBeenCalledOnce();
    expect(rpc.channelsStart).toHaveBeenCalledOnce();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("waits until every marked account is connected with a newer start time", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account bindings changed",
      ["ceckert-coach", "ceckert-proj-gardyn"],
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

    expect(rpc.channelsStop).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStart).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStatus).toHaveBeenCalledTimes(3);
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("preserves the marker when scoped activation never becomes healthy", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
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

  it("preserves the marker when a scoped channel start fails", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
    );
    const rpc = channelOperationRpc(
      ["ceckert-coach"],
      vi.fn(async () => ({
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", lastStartAt: 100 },
        ] },
      })),
    );
    vi.mocked(rpc.channelsStart).mockRejectedValueOnce(new Error("start refused"));

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn()),
    ).rejects.toThrow("start refused");

    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("activates a new marker that arrives before the first marker clears", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "first account binding",
      ["ceckert-coach"],
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

    expect(rpc.channelsStop).toHaveBeenNthCalledWith(1, {
      channel: "mattermost",
      accountId: "ceckert-coach",
    });
    expect(rpc.channelsStop).toHaveBeenNthCalledWith(2, {
      channel: "mattermost",
      accountId: "ceckert-proj-gardyn",
    });
    expect(rpc.channelsStart).toHaveBeenCalledTimes(2);
    expect(rpc.gatewayRestartRequest).not.toHaveBeenCalled();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("drops retired account ids after persisted config confirms they are absent", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "retired project account",
      ["ceckert-proj-retired"],
    );
    markMattermostRoutingActivationPending(
      openclawDir,
      "new project account",
      ["ceckert-proj-new"],
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

    expect(rpc.channelsStop).toHaveBeenCalledOnce();
    expect(rpc.channelsStop).toHaveBeenCalledWith({
      channel: "mattermost",
      accountId: "ceckert-proj-new",
    });
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("recovers a marker stranded in a confirmed claim by a process crash", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "new account binding",
      ["ceckert-coach"],
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

    expect(rpc.channelsStop).toHaveBeenCalledOnce();
    expect(rpc.channelsStart).toHaveBeenCalledOnce();
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });
});
