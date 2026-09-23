import { describe, expect, it, vi } from "vitest";
import { applyGoogleGrantApproval } from "./google-grant-approval.js";

function harness() {
  const stamp = { seconds: 1, nanoseconds: 0 };
  const permission = {
    operation: "/google/drive/read",
    resourceIds: ["file-a"],
    channelIds: ["general"],
  };
  const preview = {
    memberUid: "member",
    memberName: "Teammate",
    workspaceId: "space",
    accountLabel: "Google owner",
    operationLabel: "Read Drive files",
    channelName: "general",
    connectionEpoch: "1:0",
    membershipEpoch: "1:0",
    grantEpoch: "1:0",
    permissions: [permission],
  };
  const documents: Record<string, Record<string, unknown>> = {
    "workspaces/space": { ownerUid: "owner", ownerActive: true },
    "workspaces/space/members/member": {
      canonicalSource: "mattermost-general",
      canonicalState: "active",
      mattermostChannelId: "general",
      mattermostUserId: "sender",
    },
    "users/owner/integrations/google": {
      status: "connected",
      connectedAt: stamp,
    },
    "users/owner/googleGrants/member": {
      state: "active",
      connectionEpoch: "1:0",
      membershipEpoch: "1:0",
      permissions: [{ ...permission, resourceIds: ["prior-file"] }],
    },
  };
  let grantStamp = stamp;
  const tx = {
    get: async (ref: { path: string }) => ({
      exists: !!documents[ref.path],
      createTime: stamp,
      updateTime: grantStamp,
      data: () => documents[ref.path],
    }),
    set: vi.fn(),
  };
  return {
    preview,
    documents,
    tx,
    db: { doc: (path: string) => ({ path }) },
    revoke: () => {
      grantStamp = { seconds: 2, nanoseconds: 0 };
      documents["users/owner/googleGrants/member"].state = "revoked";
    },
  };
}
describe("Google grant approval lifecycle", () => {
  it("adds the exact requested permission while preserving other approved resources", async () => {
    const h = harness();
    expect(
      await applyGoogleGrantApproval(
        h.db as never,
        h.tx as never,
        "owner",
        h.preview,
      ),
    ).toBe(true);
    expect(h.tx.set.mock.calls[0][1].permissions).toEqual([
      { ...h.preview.permissions[0], resourceIds: ["prior-file"] },
      h.preview.permissions[0],
    ]);
  });
  it("cannot regrant access using a request issued before revocation", async () => {
    const h = harness();
    h.revoke();
    expect(
      await applyGoogleGrantApproval(
        h.db as never,
        h.tx as never,
        "owner",
        h.preview,
      ),
    ).toBe(false);
    expect(h.tx.set).not.toHaveBeenCalled();
  });
  it.each(["removed-member", "new-connection", "different-owner"])(
    "rejects a changed authority boundary: %s",
    async (change) => {
      const h = harness();
      if (change === "removed-member")
        h.documents["workspaces/space/members/member"].canonicalState =
          "revoking";
      if (change === "new-connection")
        h.documents["users/owner/integrations/google"].connectedAt = {
          seconds: 2,
          nanoseconds: 0,
        };
      if (change === "different-owner")
        h.documents["workspaces/space"].ownerUid = "someone-else";
      expect(
        await applyGoogleGrantApproval(
          h.db as never,
          h.tx as never,
          "owner",
          h.preview,
        ),
      ).toBe(false);
      expect(h.tx.set).not.toHaveBeenCalled();
    },
  );
});
