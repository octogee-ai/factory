import { describe, expect, it, vi } from "vitest";

import {
  cleanupRetiredMacFirestore,
  findRetiredMacProtocolPaths,
  parseRetiredMacFirestoreCleanupArgs,
  planRetiredMacDocument,
} from "../ops/cleanup-retired-mac-firestore.js";
import {
  parseRetireMacMattermostArgs,
  retireMacMattermostUser,
} from "../ops/retire-mac-mattermost.js";
import {
  planRetiredMacSecretKeys,
  runRetiredMacK8sCleanup,
} from "../ops/cleanup-retired-mac-k8s.js";
import {
  isReleasePayload,
  releasePayloadHash,
} from "../../shared/types/gateway-releases.js";

describe("retired Mac Firestore cleanup", () => {
  it("finds only exact retired protocol fields at root and inside release artifacts", () => {
    expect(findRetiredMacProtocolPaths({
      macOpsTokenProtocol: 2,
      payload: {
        imageTag: "abc1234",
        macOpsTokenProtocol: 1,
        artifact: { macOpsTokenProtocol: 2 },
      },
      macOpsTokenProtocolNote: "preserve",
      customer: { protocol: 2 },
    })).toEqual([
      ["macOpsTokenProtocol"],
      ["payload", "artifact", "macOpsTokenProtocol"],
      ["payload", "macOpsTokenProtocol"],
    ]);
  });

  it("is dry-run-first and requires --apply for deletion", () => {
    expect(parseRetiredMacFirestoreCleanupArgs([], {})).toEqual({
      apply: false,
      projectId: "octogee-test",
    });
    expect(parseRetiredMacFirestoreCleanupArgs([
      "--apply",
      "--project=octogee",
    ], {})).toEqual({
      apply: true,
      projectId: "octogee",
    });
  });

  it("recomputes the immutable release hash and produces a currently valid payload", () => {
    const plan = planRetiredMacDocument({
      gatewayId: "bender",
      release: 7,
      createdAt: 1,
      createdBy: "operator",
      sourceRelease: null,
      note: null,
      payloadHash: "old-hash",
      payload: {
        macOpsTokenProtocol: 2,
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
        imageTag: "abc1234",
      },
    }, "release");

    expect(plan?.paths).toEqual([["payload", "macOpsTokenProtocol"]]);
    const payload = plan?.data.payload;
    expect(isReleasePayload(payload)).toBe(true);
    expect(plan?.data.payloadHash).toBe(releasePayloadHash(payload as never));
  });

  it("scans gateway roots and release payloads, then deletes only with --apply", async () => {
    const rootUpdate = vi.fn(async () => {});
    const releaseUpdate = vi.fn(async () => {});
    const releaseData = { payload: { macOpsTokenProtocol: 2, imageRepository: "repo", imageTag: "abc1234" } };
    const release = {
      data: () => releaseData,
      ref: {
        path: "gateways/bender/releases/7",
        collection: vi.fn(),
        get: async () => ({ exists: true, data: () => releaseData }),
      },
    };
    const rootData = { artifact: { macOpsTokenProtocol: 1 }, gatewayId: "bender" };
    const root = {
      data: () => rootData,
      ref: {
        path: "gateways/bender",
        collection: vi.fn(() => ({ get: async () => ({ docs: [release] }) })),
        get: async () => ({ exists: true, data: () => rootData }),
      },
    };
    const writes: string[] = [];
    const db = {
      collection: vi.fn(() => ({ get: async () => ({ docs: [root] }) })),
      runTransaction: async (body: (transaction: unknown) => Promise<unknown>) => body({
        get: async (ref: { get(): Promise<unknown> }) => ref.get(),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          writes.push(ref.path);
          if (ref.path.includes("/releases/")) releaseUpdate(data);
          else rootUpdate(data);
        },
      }),
    };

    await expect(cleanupRetiredMacFirestore(db as never, {
      apply: false,
      projectId: "octogee-test",
    }, vi.fn())).resolves.toEqual({ documents: 2, fields: 2 });
    expect(rootUpdate).not.toHaveBeenCalled();
    expect(releaseUpdate).not.toHaveBeenCalled();

    await expect(cleanupRetiredMacFirestore(db as never, {
      apply: true,
      projectId: "octogee-test",
    }, vi.fn())).resolves.toEqual({ documents: 2, fields: 2 });
    expect(rootUpdate).toHaveBeenCalledTimes(1);
    expect(releaseUpdate).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["gateways/bender", "gateways/bender/releases/7"]);
  });
});

describe("historical Mac Mattermost retirement", () => {
  it("defaults to the two exact central bots and adds explicit per-gateway identities", () => {
    expect(parseRetireMacMattermostArgs(["--gateway=bender"], {})).toEqual({
      apply: false,
      usernames: ["mac-bender", "mac-gw-prod", "mac-gw-test"],
    });
  });

  it("previews token revocation and deactivation without mutating Mattermost", async () => {
    const mmApiCall = vi.fn(async (method: string, endpoint: string) => {
      if (method === "GET" && endpoint === "/users/username/mac-bender") {
        return { id: "mac-id", username: "mac-bender", is_bot: true, delete_at: 0 };
      }
      if (method === "GET" && endpoint === "/users/mac-id/tokens") {
        return [{ id: "pat-1" }, { id: "pat-2" }];
      }
      throw new Error(`unexpected ${method} ${endpoint}`);
    });

    await expect(retireMacMattermostUser({
      username: "mac-bender",
      apply: false,
      mmApiCall,
    })).resolves.toEqual({
      outcome: "planned",
      username: "mac-bender",
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
      username: "mac-bender",
      apply: true,
      mmApiCall: vi.fn(async () => ({
        id: "human-id",
        username: "mac-bender",
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
