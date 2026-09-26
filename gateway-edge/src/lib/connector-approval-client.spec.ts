import { describe, expect, it, vi } from "vitest";
import { connectorApprovalRpc, requestConnectorApproval } from "./connector-approval-client.js";

function harness() {
  const docs: Record<string, unknown> = {
    "workspaces/alice": { ownerUid: "owner" },
    "workspaces/alice/channels/coach-dm": { mattermost: { channelId: "c".repeat(26) } },
    "users/owner": { provisioning: { openclaw: { gatewayId: "b-alice" } } },
  };
  const db = { doc: (path: string) => ({ get: async () => ({ exists: Object.hasOwn(docs, path), data: () => docs[path] }) }) };
  const input = { ownerUid: "owner", gatewayId: "b-alice", agentId: "octogee-alice-coach", kind: "gmail-send",
    digest: "a".repeat(64), preview: { subject: "Private preview" }, actionUrl: "https://app.octogee.com/settings?productivityApproval=action&nonce=secret" };
  const rpc = vi.fn().mockResolvedValue({ id: "plugin:native-request", expiresAtMs: 100_000 });
  return { docs, db: db as never, input, rpc };
}
describe("connector approval native creation", () => {
  it("uses the private canonical Coach channel and preserves the exact preview link and action hash", async () => {
    const h = harness();
    await expect(requestConnectorApproval(h.db, h.rpc, h.input)).resolves.toEqual({ nativeApprovalId: "plugin:native-request", expiresAtMs: 100_000 });
    expect(h.rpc).toHaveBeenCalledWith(expect.objectContaining({ operation: "create", coachChannelId: "c".repeat(26),
      detail: expect.stringContaining(h.input.digest), actionUrl: h.input.actionUrl }));
    expect(h.rpc.mock.calls[0][0].detail).toContain("Private preview");
  });
  it.each(["missing-coach", "foreign-owner"])("does not deliver private approval details with %s", async change => {
    const h = harness();
    if (change === "missing-coach") delete h.docs["workspaces/alice/channels/coach-dm"];
    else h.docs["workspaces/alice"] = { ownerUid: "someone-else" };
    await expect(requestConnectorApproval(h.db, h.rpc, h.input)).rejects.toThrow("Canonical Coach DM");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("makes the native display limit explicit instead of silently truncating a long message", async () => {
    const h = harness(); h.input.preview.subject = "x".repeat(20_000);
    await requestConnectorApproval(h.db, h.rpc, h.input);
    const command = h.rpc.mock.calls[0][0];
    expect(command.detail).toContain("exceeds the native display limit");
    expect(command.detail).toContain(h.input.actionUrl);
    expect(command.detail.length).toBeLessThan(16_384);
  });
  it("does not follow a customer's new placement to resolve an old gateway approval", async () => {
    const h = harness();
    await expect(connectorApprovalRpc(h.db, {})({ operation: "get", ownerUid: "owner", gatewayId: "old-gateway", agentId: h.input.agentId, nativeId: "plugin:old" })).rejects.toThrow("assignment changed");
  });
});
