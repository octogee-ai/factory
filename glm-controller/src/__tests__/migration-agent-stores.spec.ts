import { describe, expect, it, vi } from "vitest";
import { createMigrationAgentStorePreparer } from "../migration-agent-stores.js";
import { classifyCustomerMigrationV2Error } from "@octogee/core/customer-migration-v2";
import { classifyOperationFailure } from "../operation-retry.js";

function harness(gateway: { gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null } | null) {
  const order: string[] = [];
  const readGateway = vi.fn(async () => gateway);
  const readBuilder = vi.fn(async () => ({ uid: "uid-alice", slug: "alice" }));
  const ensureCredentials = vi.fn(async () => { order.push("credentials"); });
  const transferOwnership = vi.fn<(builder: { uid: string; slug: string }, target: "shared" | "builder", assertCurrent?: () => Promise<void>) => Promise<void>>(async () => { order.push("ownership"); });
  return { order, readGateway, readBuilder, ensureCredentials, transferOwnership,
    prepare: createMigrationAgentStorePreparer({ readGateway, readBuilder, ensureCredentials, transferOwnership }) };
}

describe("migration agent-store ownership", () => {
  it.each([
    ["55P03", "canceling statement due to lock timeout"],
    ["57014", "canceling statement due to statement timeout"],
  ])("treats PostgreSQL %s handoff timeout as retryable through both migration paths", async (code, message) => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(Object.assign(new Error(message), { code }));
    const error = await h.prepare("target", "alice").catch(error => error);
    expect(error.message).toMatch(/^agent-store handoff timeout:/);
    expect(classifyCustomerMigrationV2Error(error)).toBe("retry");
    expect(classifyOperationFailure(error.message)).toBe("transient");
  });
  it("does not turn PostgreSQL authorization failure into a retry", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
    const error = await h.prepare("target", "alice").catch(error => error);
    expect(classifyCustomerMigrationV2Error(error)).toBe("terminal");
    expect(classifyOperationFailure(error.message)).toBe("terminal");
  });
  it.each(["shared", "builder"] as const)("prepares %s ownership from the authoritative Builder identity", async gatewayClass => {
    const h = harness({ gatewayClass, ownerUid: gatewayClass === "builder" ? "uid-alice" : null, builderSlug: gatewayClass === "builder" ? "alice" : null });
    await h.prepare("target", "alice");
    expect(h.readGateway).toHaveBeenCalledWith("target");
    expect(h.readBuilder).toHaveBeenCalledWith("alice");
    expect(h.ensureCredentials).toHaveBeenCalledWith("target");
    expect(h.transferOwnership).toHaveBeenCalledWith({ uid: "uid-alice", slug: "alice" }, gatewayClass);
    expect(h.order).toEqual(["credentials", "ownership"]);
  });

  it.each([
    null,
    { gatewayClass: "builder" as const, ownerUid: "uid-bob", builderSlug: "alice" },
    { gatewayClass: "builder" as const, ownerUid: "uid-alice", builderSlug: "bob" },
    { gatewayClass: "shared" as const, ownerUid: "uid-alice", builderSlug: "alice" },
  ])("rejects a missing or mismatched desired owner (%j)", async gateway => {
    const h = harness(gateway);
    await expect(h.prepare("target", "alice")).rejects.toThrow();
    expect(h.ensureCredentials).not.toHaveBeenCalled();
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("refuses a missing Builder or a slug mismatch", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.readBuilder.mockResolvedValue({ uid: "", slug: "alice" });
    await expect(h.prepare("target", "alice")).rejects.toThrow("identity changed");
    h.readBuilder.mockResolvedValue({ uid: "uid-alice", slug: "bob" });
    await expect(h.prepare("target", "alice")).rejects.toThrow("identity changed");
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("stops before ownership changes if credential publication fails", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.ensureCredentials.mockRejectedValue(new Error("publication failed"));
    await expect(h.prepare("target", "alice")).rejects.toThrow("publication failed");
    expect(h.transferOwnership).not.toHaveBeenCalled();
  });

  it("surfaces ownership failures so import or rollback stays fenced", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.transferOwnership.mockRejectedValue(new Error("ownership failed"));
    await expect(h.prepare("target", "alice")).rejects.toThrow("ownership failed");
  });
});


describe("claimed agent-store recovery authority", () => {
  it("passes the exact recovery authority to the PostgreSQL transaction owner", async () => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    const assertCurrent = vi.fn(async () => undefined);
    await h.prepare("source", "alice", { expectedBuilderUid: "uid-alice", assertCurrent });
    expect(h.transferOwnership).toHaveBeenCalledExactlyOnceWith({ uid: "uid-alice", slug: "alice" }, "shared", assertCurrent);
  });

  it.each(["changed-uid", "claim-lost", "gateway-rebound", "slug-reassigned"] as const)("refuses stale ownership before transfer after credential await: %s", async scenario => {
    const h = harness({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    let credentialsDone = false;
    const assertCurrent = vi.fn(async () => { if (scenario === "claim-lost" && credentialsDone) throw new Error("recovery claim replaced"); });
    if (scenario === "changed-uid") h.readBuilder.mockResolvedValue({ uid: "uid-bob", slug: "alice" });
    h.ensureCredentials.mockImplementation(async () => {
      credentialsDone = true;
      if (scenario === "gateway-rebound") h.readGateway.mockResolvedValue({ gatewayClass: "builder", ownerUid: "uid-bob", builderSlug: "alice" });
      if (scenario === "slug-reassigned") h.readBuilder.mockResolvedValue({ uid: "uid-bob", slug: "alice" });
    });
    await expect(h.prepare("source", "alice", { expectedBuilderUid: "uid-alice", assertCurrent })).rejects.toThrow();
    expect(h.transferOwnership).not.toHaveBeenCalled();
    if (scenario === "changed-uid") expect(h.ensureCredentials).not.toHaveBeenCalled();
  });
});
