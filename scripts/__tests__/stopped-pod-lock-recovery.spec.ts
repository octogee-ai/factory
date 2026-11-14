import { describe, expect, it } from "vitest";
import type { OpenClawCommandOptions, OpenClawCommandResult } from "../lib/openclaw-cli.js";
import { gatewayLockHolderHost, recoverStoppedPodGatewayLocks } from "../lib/stopped-pod-lock-recovery.js";

const GATEWAY = "jane-s-1a2b3c4d";
const THIS_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-new01`;
const PREVIOUS_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-old01`;
const CLUSTER_ISOLATED = { GATEWAY_ID: GATEWAY, GATEWAY_CLASS: "builder", GATEWAY_RUNTIME_KIND: "cluster", OPENCLAW_STATE_DIR: "/home/node/.openclaw" };
const FINGERPRINT = "4db1f3d389c93f8f8a9b5f536ee948ea73c90ccbff923ff2c914662d937e2b4f";

function fileHolder(host: string): string {
  return `/home/node/.openclaw/tmp/openclaw-1000/state.c3867134fe5820b9.lock: holder 810 at ${host}/pid-ns 16, last renewed 474 s ago. `
    + "Stop the holder before retrying; if it has already stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner.";
}

function leaseHolder(host: string): string {
  return `PostgreSQL Gateway owner lease: holder 810 at ${host}/pid-ns 16, last renewed 532 s ago. `
    + "Stop the holder before retrying; if it has already stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged owner.";
}

function inspection(holders: string[]): string {
  return [
    "[state/sqlite] SQLite read-only snapshot for /home/node/.openclaw/state/openclaw.sqlite: 8.0 KiB, budget 301 seconds",
    JSON.stringify({ present: holders.length > 0, holders, confirmation: FINGERPRINT, command: `openclaw gateway recover-lock --confirm ${FINGERPRINT}` }, null, 2),
  ].join("\n");
}

function harness(input: { holders: string[]; stopped?: string[]; confirmOutput?: OpenClawCommandResult; env?: NodeJS.ProcessEnv }) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const asked: string[][] = [];
  const logs: string[] = [];
  const run = async (args: string[], options: OpenClawCommandOptions): Promise<OpenClawCommandResult> => {
    calls.push({ args, env: options.env });
    if (args.includes("--confirm")) return input.confirmOutput ?? { code: 0, stdout: JSON.stringify({ recovered: true, removed: input.holders.length }) };
    return { code: 0, stdout: inspection(input.holders) };
  };
  const recover = () => recoverStoppedPodGatewayLocks({
    env: input.env ?? CLUSTER_ISOLATED,
    hostname: THIS_POD,
    run,
    stoppedPods: async (hosts) => {
      asked.push(hosts);
      return hosts.filter((host) => (input.stopped ?? []).includes(host));
    },
    log: (message) => logs.push(message),
  });
  return { recover, calls, asked, logs };
}

describe("gatewayLockHolderHost", () => {
  it("names the holder host in each record OpenClaw's recover-lock inspection describes", () => {
    expect(gatewayLockHolderHost(fileHolder(PREVIOUS_POD))).toBe(PREVIOUS_POD);
    expect(gatewayLockHolderHost(leaseHolder(PREVIOUS_POD))).toBe(PREVIOUS_POD);
    expect(gatewayLockHolderHost("PostgreSQL Gateway owner lease: holder 810 at unknown host, last renewed at an unknown time. Stop it.")).toBeNull();
  });
});

describe("recoverStoppedPodGatewayLocks", () => {
  it("recovers the inspected records when every holder is another pod of this gateway that no longer exists", async () => {
    const { recover, calls, asked, logs } = harness({ holders: [fileHolder(PREVIOUS_POD), leaseHolder(PREVIOUS_POD)], stopped: [PREVIOUS_POD] });

    await expect(recover()).resolves.toBe("recovered");

    expect(asked).toEqual([[PREVIOUS_POD]]);
    expect(calls.map((call) => call.args)).toEqual([
      ["gateway", "recover-lock", "--json"],
      ["gateway", "recover-lock", "--confirm", FINGERPRINT, "--json"],
    ]);
    expect(calls.every((call) => call.env.OPENCLAW_STATE_DIR === "/home/node/.openclaw")).toBe(true);
    expect(logs.join("\n")).toContain(`recovered 2 Gateway lock record(s) held by stopped pod ${PREVIOUS_POD}`);
  });

  it("leaves the records while a holder pod still exists", async () => {
    const { recover, calls, logs } = harness({ holders: [leaseHolder(PREVIOUS_POD)], stopped: [] });

    await expect(recover()).resolves.toBe("held");

    expect(calls.map((call) => call.args)).toEqual([["gateway", "recover-lock", "--json"]]);
    expect(logs.join("\n")).toContain(`holder pod ${PREVIOUS_POD} still exists`);
  });

  it("leaves records this pod holds to OpenClaw, without asking whether this pod stopped", async () => {
    const { recover, calls, asked } = harness({ holders: [fileHolder(THIS_POD), leaseHolder(PREVIOUS_POD)], stopped: [PREVIOUS_POD] });

    await expect(recover()).resolves.toBe("held");

    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a holder that is not a pod of this gateway", async () => {
    const other = "octogee-gateway-john-s-9f8e7d6c-7f9c5d8b6-old01";
    const { recover, calls, asked } = harness({ holders: [leaseHolder(other)], stopped: [other] });

    await expect(recover()).rejects.toThrow(`Gateway lock holder ${other} is not a pod of gateway ${GATEWAY}`);

    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a holder record that names no host", async () => {
    const { recover, calls } = harness({ holders: ["PostgreSQL Gateway owner lease: holder 810 at unknown host, last renewed at an unknown time. Stop it."] });

    await expect(recover()).rejects.toThrow("Gateway lock holder record names no pod");

    expect(calls).toHaveLength(1);
  });

  it("does nothing when no lock or owner lease is present", async () => {
    const { recover, calls, asked } = harness({ holders: [] });

    await expect(recover()).resolves.toBe("absent");

    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("fails when OpenClaw does not confirm the recovery", async () => {
    const { recover } = harness({
      holders: [leaseHolder(PREVIOUS_POD)],
      stopped: [PREVIOUS_POD],
      confirmOutput: { code: 1, stdout: "", stderr: "Gateway lock recovery failed: the lock record changed since inspection" },
    });

    await expect(recover()).rejects.toThrow("Gateway lock recovery failed (exit 1): Gateway lock recovery failed: the lock record changed since inspection");
  });

  it.each([
    ["a shared gateway", { GATEWAY_ID: "shared-a", GATEWAY_CLASS: "shared" }],
    ["a VM gateway", { ...CLUSTER_ISOLATED, GATEWAY_RUNTIME_KIND: "gce-vm" }],
  ])("leaves %s alone", async (_name, env) => {
    const { recover, calls } = harness({ holders: [leaseHolder(PREVIOUS_POD)], stopped: [PREVIOUS_POD], env });

    await expect(recover()).resolves.toBe("absent");

    expect(calls).toEqual([]);
  });
});
