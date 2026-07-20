import { describe, it, expect, vi } from "vitest";
import {
  deleteAuthUserTolerantOfMissing,
  disableAuthUserAndRevokeSessions,
} from "./firebase-auth-helpers";

describe("deleteAuthUserTolerantOfMissing", () => {
  it("delegates to deleteUser and resolves on success", async () => {
    const deleteUser = vi.fn(async (_uid: string) => undefined);
    await deleteAuthUserTolerantOfMissing("uid-alice", { deleteUser });
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith("uid-alice");
  });

  it("swallows auth/user-not-found", async () => {
    const deleteUser = vi.fn(async () => {
      const err = new Error("user not found") as Error & { code?: string };
      err.code = "auth/user-not-found";
      throw err;
    });
    await expect(
      deleteAuthUserTolerantOfMissing("uid-ghost", { deleteUser }),
    ).resolves.toBeUndefined();
    expect(deleteUser).toHaveBeenCalledOnce();
  });

  it("rethrows any other error", async () => {
    const deleteUser = vi.fn(async () => {
      const err = new Error("permission denied") as Error & { code?: string };
      err.code = "auth/insufficient-permission";
      throw err;
    });
    await expect(
      deleteAuthUserTolerantOfMissing("uid-locked", { deleteUser }),
    ).rejects.toThrow("permission denied");
  });

  it("rethrows non-coded errors", async () => {
    const deleteUser = vi.fn(async () => {
      throw new Error("network error");
    });
    await expect(
      deleteAuthUserTolerantOfMissing("uid-flaky", { deleteUser }),
    ).rejects.toThrow("network error");
  });
});

describe("disableAuthUserAndRevokeSessions", () => {
  it("disables the user before revoking refresh sessions", async () => {
    const calls: string[] = [];
    await disableAuthUserAndRevokeSessions("uid-alice", {
      updateUser: async (uid, patch) => {
        calls.push(`disable:${uid}:${String(patch.disabled)}`);
        return {};
      },
      revokeRefreshTokens: async (uid) => {
        calls.push(`revoke:${uid}`);
      },
    });
    expect(calls).toEqual(["disable:uid-alice:true", "revoke:uid-alice"]);
  });

  it("is idempotent when Auth was already deleted", async () => {
    const error = Object.assign(new Error("missing"), { code: "auth/user-not-found" });
    const revokeRefreshTokens = vi.fn();
    await disableAuthUserAndRevokeSessions("uid-gone", {
      updateUser: vi.fn(async () => { throw error; }),
      revokeRefreshTokens,
    });
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("surfaces every non-missing Auth error", async () => {
    const error = Object.assign(new Error("quota"), { code: "auth/quota-exceeded" });
    await expect(disableAuthUserAndRevokeSessions("uid-alice", {
      updateUser: vi.fn(async () => { throw error; }),
      revokeRefreshTokens: vi.fn(),
    })).rejects.toBe(error);
  });
});
