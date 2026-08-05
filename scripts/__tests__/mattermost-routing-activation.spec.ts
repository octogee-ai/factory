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

function scheduledRestartAcknowledgement() {
  return {
    ok: true as const,
    status: "scheduled" as const,
    restart: {
      ok: true as const,
      pid: 123,
      signal: "SIGUSR1" as const,
      coalesced: false,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Mattermost routing activation", () => {
  it("waits for an initially absent account to expose a numeric baseline before restarting", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "new account binding",
      ["ceckert-proj-gardyn"],
    );
    let connectionGeneration = 1;
    const gatewayRestartRequest = vi.fn(async () => {
      connectionGeneration = 2;
      return scheduledRestartAcknowledgement();
    });
    let statusCall = 0;
    const channelsStatus = vi.fn(async () => {
      statusCall += 1;
      if (statusCall === 1) {
        expect(gatewayRestartRequest).not.toHaveBeenCalled();
        return { channelAccounts: { mattermost: [] } };
      }
      if (statusCall === 2) {
        expect(gatewayRestartRequest).not.toHaveBeenCalled();
        return {
          channelAccounts: { mattermost: [
            { accountId: "ceckert-proj-gardyn", lastStartAt: 100 },
          ] },
        };
      }
      return {
        channelAccounts: { mattermost: [
          {
            accountId: "ceckert-proj-gardyn",
            running: true,
            connected: true,
            lastStartAt: 101,
          },
        ] },
      };
    });
    const rpc = {
      configGet: configGetWithMattermostAccounts(["ceckert-proj-gardyn"]),
      channelsStatus,
      channelsStatusConnectionGeneration: () => connectionGeneration,
      gatewayRestartRequest,
    } as unknown as GatewayRpcClient;
    let now = Date.now();

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      timeoutMs: 100,
    });

    expect(gatewayRestartRequest).toHaveBeenCalledOnce();
    expect(channelsStatus).toHaveBeenCalledTimes(3);
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("does not clear the durable marker until a real OpenClaw restart generation is observed", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
    );
    markMattermostRoutingActivationPending(
      openclawDir,
      "second account binding changed",
      ["ceckert-proj-gardyn"],
    );
    const statusSnapshots = [
      {
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", running: true, connected: true, lastStartAt: 100 },
          { accountId: "ceckert-proj-gardyn", running: true, connected: true, lastStartAt: 200 },
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
    let connectionGeneration = 1;
    const rpc = {
      configGet: configGetWithMattermostAccounts([
        "ceckert-coach",
        "ceckert-proj-gardyn",
      ]),
      channelsStatus: vi.fn(async () => statusSnapshots.shift() ?? statusSnapshots.at(-1)),
      channelsStatusConnectionGeneration: () => connectionGeneration,
      gatewayRestartRequest: vi.fn(async () => {
        connectionGeneration = 2;
        return scheduledRestartAcknowledgement();
      }),
    } as unknown as GatewayRpcClient;

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(rpc.gatewayRestartRequest).toHaveBeenCalledWith({
      reason: "account binding changed",
      skipDeferral: true,
    });
    expect(rpc.channelsStatus).toHaveBeenCalledTimes(3);
    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("fails closed and preserves the marker when the restart is accepted but never happens", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
    );
    const rpc = {
      configGet: configGetWithMattermostAccounts(["ceckert-coach"]),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [
          { accountId: "ceckert-coach", running: true, connected: true, lastStartAt: 100 },
        ] },
      })),
      channelsStatusConnectionGeneration: () => 1,
      gatewayRestartRequest: vi.fn(async () => scheduledRestartAcknowledgement()),
    } as unknown as GatewayRpcClient;
    let now = 0;

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        now: () => now,
        sleep: async () => {
          now += 10;
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("restart generation was not observed");

    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });

  it("requires a second confirmed restart when another account is marked before the first clear", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "first account binding",
      ["ceckert-coach"],
    );
    let statusCall = 0;
    const channelsStatus = vi.fn(async () => {
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
          {
            accountId: "ceckert-coach",
            running: true,
            connected: true,
            lastStartAt: 102,
          },
          {
            accountId: "ceckert-proj-gardyn",
            running: true,
            connected: true,
            lastStartAt: 201,
          },
        ] },
      };
    });
    let connectionGeneration = 1;
    const gatewayRestartRequest = vi.fn(async () => {
      connectionGeneration += 1;
      return scheduledRestartAcknowledgement();
    });
    const rpc = {
      configGet: configGetWithMattermostAccounts([
        "ceckert-coach",
        "ceckert-proj-gardyn",
      ]),
      channelsStatus,
      channelsStatusConnectionGeneration: () => connectionGeneration,
      gatewayRestartRequest,
    } as unknown as GatewayRpcClient;

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(gatewayRestartRequest).toHaveBeenCalledTimes(2);
    expect(channelsStatus).toHaveBeenCalledTimes(4);
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
    let statusCall = 0;
    let connectionGeneration = 1;
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          channels: {
            mattermost: {
              accounts: { "ceckert-proj-new": {} },
            },
          },
        },
      })),
      channelsStatus: vi.fn(async () => {
        statusCall += 1;
        return {
          channelAccounts: { mattermost: [
            {
              accountId: "ceckert-proj-new",
              running: true,
              connected: true,
              lastStartAt: statusCall === 1 ? 100 : 101,
            },
          ] },
        };
      }),
      channelsStatusConnectionGeneration: () => connectionGeneration,
      gatewayRestartRequest: vi.fn(async () => {
        connectionGeneration = 2;
        return {
          ok: true,
          status: "scheduled",
          restart: {
            ok: true,
            pid: 123,
            signal: "SIGUSR1",
            coalesced: false,
          },
        };
      }),
    } as unknown as GatewayRpcClient;
    let now = Date.now();

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      timeoutMs: 20,
      accountAbsenceGraceMs: 0,
    });

    expect(rpc.gatewayRestartRequest).toHaveBeenCalledOnce();
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

    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
    let statusCall = 0;
    let connectionGeneration = 1;
    const rpc = {
      configGet: configGetWithMattermostAccounts(["ceckert-coach"]),
      channelsStatus: vi.fn(async () => {
        statusCall += 1;
        return {
          channelAccounts: { mattermost: [
            {
              accountId: "ceckert-coach",
              running: true,
              connected: true,
              lastStartAt: statusCall === 1 ? 100 : 101,
            },
          ] },
        };
      }),
      channelsStatusConnectionGeneration: () => connectionGeneration,
      gatewayRestartRequest: vi.fn(async () => {
        connectionGeneration = 2;
        return scheduledRestartAcknowledgement();
      }),
    } as unknown as GatewayRpcClient;

    await activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
      sleep: async () => undefined,
    });

    expect(mattermostRoutingActivationPending(openclawDir)).toBe(false);
  });

  it("does not treat an account-only reconnect as causal restart evidence", async () => {
    const openclawDir = await temporaryOpenClawDir();
    markMattermostRoutingActivationPending(
      openclawDir,
      "account binding changed",
      ["ceckert-coach"],
    );
    let statusCall = 0;
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
        },
      })),
      channelsStatus: vi.fn(async () => {
        statusCall += 1;
        return {
          channelAccounts: { mattermost: [
            {
              accountId: "ceckert-coach",
              running: true,
              connected: true,
              lastStartAt: statusCall === 1 ? 100 : 101,
            },
          ] },
        };
      }),
      channelsStatusConnectionGeneration: () => 1,
      gatewayRestartRequest: vi.fn(async () => ({
        ok: true,
        status: "scheduled",
        restart: {
          ok: true,
          pid: 123,
          signal: "SIGUSR1",
          coalesced: false,
        },
      })),
    } as unknown as GatewayRpcClient;
    let now = 0;

    await expect(
      activatePendingMattermostRouting(rpc, openclawDir, vi.fn(), {
        now: () => now,
        sleep: async () => {
          now += 10;
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("restart generation was not observed");

    expect(mattermostRoutingActivationPending(openclawDir)).toBe(true);
  });
});
