import { describe, expect, it, vi } from "vitest";
import { resolveActiveArtifactWorkspaceSlug } from "./chat-artifact-workspace.js";

function dbFor(input: { ownerUid?: string; lifecycle?: string; workspaceCount?: number }) {
  const getUser = vi.fn(async () => ({
    exists: true,
    data: () => ({ accountLifecycle: { status: input.lifecycle ?? "active" } }),
  }));
  return {
    collection: (name: string) => {
      if (name === "workspaces") {
        return {
          where: () => ({
            limit: () => ({
              get: async () => ({
                docs: Array.from({ length: input.workspaceCount ?? 1 }, (_, index) => ({
                  id: index === 0 ? "channel-workspace" : "duplicate-workspace",
                  data: () => ({ ownerUid: input.ownerUid ?? "owner-1" }),
                })),
              }),
            }),
          }),
        };
      }
      return { doc: () => ({ get: getUser }) };
    },
  };
}

describe("resolveActiveArtifactWorkspaceSlug", () => {
  it("binds a Mattermost team to its active owning workspace", async () => {
    await expect(resolveActiveArtifactWorkspaceSlug(
      dbFor({}) as never,
      "team-1",
    )).resolves.toEqual({
      workspaceSlug: "channel-workspace",
      workspaceOwnerUid: "owner-1",
    });
  });

  it.each(["deletion_scheduled", "erasing", "suspended"])(
    "rejects artifact creation when the workspace owner is %s",
    async (lifecycle) => {
      await expect(resolveActiveArtifactWorkspaceSlug(
        dbFor({ lifecycle }) as never,
        "team-1",
      )).resolves.toBeNull();
    },
  );

  it("fails when a Mattermost team is ambiguously mapped", async () => {
    await expect(resolveActiveArtifactWorkspaceSlug(
      dbFor({ workspaceCount: 2 }) as never,
      "team-1",
    )).rejects.toThrow(/multiple workspaces/i);
  });
});
