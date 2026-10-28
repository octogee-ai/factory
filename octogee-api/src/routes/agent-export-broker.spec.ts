import { describe, expect, it } from "vitest";
import { authorizeAgentExport } from "./agent-export-broker.js";
import type { AgentImportBrokerDeps, OwnerContext } from "./agent-import-broker.js";
function fixture() {
  const owner: OwnerContext = { uid: "u1", slug: "alice", gatewayId: "shared-a", isAdmin: false, workspacePolicy: { preserveConvergedContextFiles: true } };
  const docs = new Map<string, any>([
    ["users/u1", { provisioning: { openclaw: { gatewayId: "shared-a", slug: "alice", status: "complete" } } }],
    ["workspaces/alice", { ownerUid: "u1" }], ["gateways/shared-a", { desiredStatus: "running" }],
    ["glmGateways/shared-a", { lifecycle: "serving" }], ["gateways/shared-a/assignments/u1", { state: "serving", epoch: 4, slug: "alice", gatewayId: "shared-a" }],
    ["workspaces/alice/projects/demo", { ownerUid: "u1", provisioningState: "active" }],
  ]);
  const deps = { db: { doc: (key: string) => ({ get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }) }) } } as unknown as AgentImportBrokerDeps;
  return { owner, docs, deps };
}
describe("authored export custody", () => {
  it("admits an owned serving Barn coach and project without requiring dedicated Native surfaces", async () => {
    const f = fixture();
    expect(await authorizeAgentExport(f.deps, f.owner, "octogee-alice-coach")).toMatchObject({ project: null, epoch: 4 });
    expect(await authorizeAgentExport(f.deps, f.owner, "octogee-alice-proj-demo-coach")).toMatchObject({ project: "demo" });
  });
  it.each(["quiescing", "missing", "retired", "restart", "transfer", "restore", "foreign", "archived", "owner", "pending-migration", "suspended", "deleting", "inactive-owner", "paused"])("refuses %s source custody", async scenario => {
    const f = fixture(); let agent = "octogee-alice-proj-demo-coach";
    if (scenario === "quiescing") f.docs.get("gateways/shared-a/assignments/u1").state = "quiescing";
    if (scenario === "missing") f.docs.delete("gateways/shared-a/assignments/u1");
    if (scenario === "retired") f.docs.get("gateways/shared-a").retirementClaim = false;
    if (scenario === "restart") f.docs.get("gateways/shared-a").runtimeRestartFence = {};
    if (scenario === "transfer") f.docs.get("users/u1").provisioning.openclaw.sourceTransferFence = {};
    if (scenario === "restore") f.docs.get("users/u1").provisioning.openclaw.restoreFence = {};
    if (scenario === "foreign") agent = "octogee-other-coach";
    if (scenario === "archived") f.docs.get("workspaces/alice/projects/demo").commercialLifecycle = { status: "archived" };
    if (scenario === "owner") f.docs.get("workspaces/alice/projects/demo").ownerUid = "u2";
    if (scenario === "pending-migration") f.docs.get("users/u1").provisioning.openclaw.migration = { operationId: "moving" };
    if (scenario === "suspended") f.docs.get("users/u1").accountLifecycle = { status: "suspended" };
    if (scenario === "deleting") f.docs.get("users/u1").accountLifecycle = { status: "deletion_scheduled" };
    if (scenario === "inactive-owner") f.docs.get("workspaces/alice").ownerActive = false;
    if (scenario === "paused") f.docs.get("gateways/shared-a").desiredStatus = "paused";
    await expect(authorizeAgentExport(f.deps, f.owner, agent)).rejects.toThrow();
  });
});
