import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readWorkspace: vi.fn(),
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readWorkspace: (...args: unknown[]) => h.readWorkspace(...args),
}));

const { resolveWorkspaceUid } = await import("../lib/workspace-resolution.js");

describe("resolveWorkspaceUid", () => {
  beforeEach(() => {
    h.readWorkspace.mockReset();
  });

  it("returns the workspace owner uid when the workspace exists", async () => {
    h.readWorkspace.mockResolvedValue({ ownerUid: "uid-1" });

    await expect(resolveWorkspaceUid("acme")).resolves.toBe("uid-1");
    expect(h.readWorkspace).toHaveBeenCalledWith("acme");
  });

  it("returns null when the workspace is absent", async () => {
    h.readWorkspace.mockResolvedValue(null);

    await expect(resolveWorkspaceUid("missing")).resolves.toBeNull();
  });
});
