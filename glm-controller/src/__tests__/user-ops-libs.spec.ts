import { describe, it, expect, vi } from "vitest";
import {
  deleteAvatarObjects,
  deleteUserStorageObjects,
  verifyUserStorageErasure,
} from "../lib/user-ops/avatars";

describe("deleteAvatarObjects", () => {
  it("deletes by the avatars/{uid}/ prefix — the gateway-edge upload writes avatars/{uid}/{type}.jpg", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteAvatarObjects({ deleteFiles }, "uid-alice");
    expect(deleteFiles).toHaveBeenCalledWith({ prefix: "avatars/uid-alice/" });
  });
});

describe("deleteUserStorageObjects", () => {
  it("deletes avatars, post covers, and the complete workspace/project blob tree", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteUserStorageObjects(
      { deleteFiles },
      "uid-alice",
      "alice",
      ["a".repeat(64)],
      ["import-1"],
    );
    expect(deleteFiles.mock.calls.map(([arg]) => arg)).toEqual([
      { prefix: "avatars/uid-alice/" },
      { prefix: "post-covers/uid-alice/" },
      { prefix: "agent-imports/uid-alice/" },
      { prefix: "customers/alice/" },
      { prefix: `chat-artifacts/${"a".repeat(64)}/` },
      { prefix: "agent-imports/import-1/" },
    ]);
  });

  it("skips only the slug prefix for a pre-provisioning account", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteUserStorageObjects({ deleteFiles }, "uid-lite", "", [], []);
    expect(deleteFiles.mock.calls.map(([arg]) => arg)).toEqual([
      { prefix: "avatars/uid-lite/" },
      { prefix: "post-covers/uid-lite/" },
      { prefix: "agent-imports/uid-lite/" },
    ]);
  });

  it("reports any object that remains under an identifying user prefix", async () => {
    const getFiles = vi.fn(async ({ prefix }: { prefix: string }) => [
      prefix === "post-covers/uid-alice/" ? [{ name: `${prefix}cover.jpg` }] : [],
    ]);
    await expect(
      verifyUserStorageErasure(
        { getFiles },
        "uid-alice",
        "alice",
        ["a".repeat(64)],
        ["import-1"],
      ),
    ).resolves.toEqual(["gcs/post-covers/uid-alice/cover.jpg"]);
    expect(getFiles).toHaveBeenCalledTimes(6);
  });
});
