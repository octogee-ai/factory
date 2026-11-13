import { describe, expect, it, vi } from "vitest";

import {
  parseRetireMacMattermostArgs,
  retireMacMattermostUser,
} from "../ops/retire-mac-mattermost.js";
import {
  planRetiredMacSecretKeys,
  runRetiredMacK8sCleanup,
} from "../ops/cleanup-retired-mac-k8s.js";

describe("historical Mac Mattermost retirement", () => {
  it("defaults to the two exact central bots and adds explicit per-gateway identities", () => {
    expect(parseRetireMacMattermostArgs(["--gateway=walter"], {})).toEqual({
      apply: false,
      usernames: ["mac-gw-prod", "mac-gw-test", "mac-walter"],
    });
  });

  it("previews token revocation and deactivation without mutating Mattermost", async () => {
    const mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "GET" && endpoint === "/users/username/mac-walter") {
        return { id: "mac-id", username: "mac-walter", is_bot: true, delete_at: 0 };
      }
      if (method === "GET" && endpoint === "/users/mac-id/tokens") {
        return [{ id: "pat-1" }, { id: "pat-2" }];
      }
      throw new Error(`unexpected ${method} ${endpoint}`);
    });

    await expect(retireMacMattermostUser({
      username: "mac-walter",
      apply: false,
      mmApiCall,
    })).resolves.toEqual({
      outcome: "planned",
      username: "mac-walter",
      tokenCount: 2,
      wasActive: true,
    });
    expect(mmApiCall).not.toHaveBeenCalledWith("POST", "/users/tokens/revoke", expect.anything());
    expect(mmApiCall).not.toHaveBeenCalledWith("PUT", "/users/mac-id/active", expect.anything());
  });

  it("revokes every PAT before deactivating the exact historical bot", async () => {
    const calls: string[] = [];
    const mmApiCall = vi.fn(async (method: string, endpoint: string, body?: unknown) => {
      calls.push(`${method} ${endpoint} ${JSON.stringify(body ?? null)}`);
      if (method === "GET" && endpoint === "/users/username/mac-gw-prod") {
        return { id: "mac-id", username: "mac-gw-prod", is_bot: true, delete_at: 0 };
      }
      if (method === "GET" && endpoint === "/users/mac-id/tokens") {
        return [{ id: "pat-1" }, { id: "pat-2" }];
      }
      if (method === "POST" && endpoint === "/users/tokens/revoke") return {};
      if (method === "PUT" && endpoint === "/users/mac-id/active") return {};
      throw new Error(`unexpected ${method} ${endpoint}`);
    });

    await expect(retireMacMattermostUser({
      username: "mac-gw-prod",
      apply: true,
      mmApiCall,
    })).resolves.toMatchObject({ outcome: "retired", tokenCount: 2 });
    expect(calls).toEqual([
      "GET /users/username/mac-gw-prod null",
      "GET /users/mac-id/tokens null",
      'POST /users/tokens/revoke {"token_id":"pat-1"}',
      'POST /users/tokens/revoke {"token_id":"pat-2"}',
      'PUT /users/mac-id/active {"active":false}',
    ]);
  });

  it("refuses to deactivate a non-bot account even when explicitly named", async () => {
    await expect(retireMacMattermostUser({
      username: "mac-walter",
      apply: true,
      mmApiCall: vi.fn(async () => ({
        id: "human-id",
        username: "mac-walter",
        is_bot: false,
      })),
    })).rejects.toThrow("not a bot");
  });
});

describe("retired Mac Kubernetes Secret cleanup", () => {
  it("plans only the exact historical bot keys and never returns values", () => {
    const plan = planRetiredMacSecretKeys({
      admin_token: "preserve-admin",
      bot_token: "retired-pat",
      bot_user_id: "retired-user-id",
      bot_token_backup: "preserve-backup",
    });

    expect(plan).toEqual(["bot_token", "bot_user_id"]);
    expect(JSON.stringify(plan)).not.toMatch(/retired-pat|retired-user-id/);
  });

  it("is dry-run-first and applies one namespace-scoped exact-key patch", () => {
    const calls: string[][] = [];
    const run = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "get") {
        return {
          status: 0,
          stdout: JSON.stringify({
            data: {
              admin_token: "preserve-admin",
              bot_token: "retired-pat",
              bot_user_id: "retired-user-id",
            },
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    expect(runRetiredMacK8sCleanup({ namespace: "octogee", apply: false, run })).toEqual({
      removedKeys: ["bot_token", "bot_user_id"],
      applied: false,
    });
    expect(calls).toHaveLength(1);

    expect(runRetiredMacK8sCleanup({ namespace: "octogee", apply: true, run })).toEqual({
      removedKeys: ["bot_token", "bot_user_id"],
      applied: true,
    });
    const patchArgs = calls.at(-1)?.join(" ") ?? "";
    expect(patchArgs).toContain("patch secret mattermost-gateway -n octogee");
    expect(patchArgs).toContain("/data/bot_token");
    expect(patchArgs).toContain("/data/bot_user_id");
    expect(patchArgs).not.toMatch(/retired-pat|retired-user-id|preserve-admin/);
  });
});
