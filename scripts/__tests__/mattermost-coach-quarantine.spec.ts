import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";

const mocks = vi.hoisted(() => ({
  applyConfigPatch: vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 })),
  updateMattermostAccountSecrets: vi.fn(async () => undefined),
}));

vi.mock("../lib/apply-config-patch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/apply-config-patch.js")>()),
  applyConfigPatch: mocks.applyConfigPatch,
}));
vi.mock("../lib/mattermost-account-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mattermost-account-secrets.js")>()),
  updateMattermostAccountSecrets: mocks.updateMattermostAccountSecrets,
}));

import { quarantineMalformedCoachMattermostAccount } from "../lib/mattermost-coach-quarantine.js";

describe("malformed customer Mattermost account quarantine", () => {
  beforeEach(() => {
    mocks.applyConfigPatch.mockClear();
    mocks.updateMattermostAccountSecrets.mockClear();
  });

  it("deletes the customer's workspace and project accounts before removing their credentials", async () => {
    mocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const current = {
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": { groupPolicy: "open", groupAllowFrom: ["guest"] },
              "alice-proj-orbit": { groupPolicy: "allowlist", groupAllowFrom: ["member"] },
              "bob-coach": { groupPolicy: "open", groupAllowFrom: ["bob"] },
              "bob-proj-map": { groupPolicy: "open", groupAllowFrom: ["bob"] },
            },
          },
        },
      };
      expect(args.buildPatch(current)).toEqual({
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": null,
              "alice-proj-orbit": null,
            },
          },
        },
      });
      expect(args.buildReplacePaths?.(current)).toEqual([
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
        "channels.mattermost.accounts.alice-proj-orbit.groupAllowFrom",
      ]);
      return { mode: "rpc", attempts: 1 };
    });

    await quarantineMalformedCoachMattermostAccount(
      "alice",
      {} as GatewayRpcClient,
      { current: undefined, hash: "" },
      vi.fn(),
    );

    expect(mocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
    expect(mocks.applyConfigPatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateMattermostAccountSecrets.mock.invocationCallOrder[0]!,
    );
  });

  it("does not report quarantine complete or touch the secret if account deletion fails", async () => {
    const log = vi.fn();
    mocks.applyConfigPatch.mockRejectedValueOnce(new Error("config.patch refused"));

    await expect(
      quarantineMalformedCoachMattermostAccount(
        "alice",
        {} as GatewayRpcClient,
        { current: undefined, hash: "" },
        log,
      ),
    ).rejects.toThrow("config.patch refused");

    expect(mocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("removed malformed"));
  });
});
