import { describe, it, expect, vi } from "vitest";
import { deleteAuthUserTolerantOfMissing } from "./firebase-auth-helpers";

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
