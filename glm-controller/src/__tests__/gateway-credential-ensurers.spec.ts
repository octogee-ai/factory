import { describe, expect, it, vi } from "vitest";
import type { KubectlSubprocess } from "../auth-secret-ensurer.js";
import { createGatewayCredentialEnsurers } from "../gateway-credential-ensurers.js";

function harness() {
  const auth = { ensureAuthSecret: vi.fn(async () => {}) };
  const readGateway = vi.fn(async (): Promise<{ gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null } | null> => null);
  const provisionAgentStore = vi.fn(async () => "postgresql://gateway:synthetic@private/agents_test");
  const runKubectl = vi.fn<KubectlSubprocess>(async () => ({ code: 0, stdout: Buffer.from("synthetic-token").toString("base64"), stderr: "" }));
  return { auth, readGateway, provisionAgentStore, runKubectl, stages: createGatewayCredentialEnsurers({ auth, readGateway, provisionAgentStore, runKubectl }) };
}
const request = { namespace: "test", gatewayId: "fresh-builder" };

describe("Gateway credential provisioning stages", () => {
  it("allocates the token before the desired root exists and provisions SQL credentials before runtime start", async () => {
    const h = harness();
    await h.stages.ensureGatewayAuthSecret(request);
    expect(h.auth.ensureAuthSecret).toHaveBeenCalledWith(request);
    expect(h.readGateway).not.toHaveBeenCalled();
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    h.readGateway.mockResolvedValue({ gatewayClass: "builder", ownerUid: "uid-alice", builderSlug: "alice" });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledExactlyOnceWith({ gatewayId: request.gatewayId, gatewayClass: "builder", token: "synthetic-token", builder: { uid: "uid-alice", slug: "alice" } });
    expect(h.runKubectl.mock.calls.at(-1)?.[0]).toEqual(["patch", "secret", "gateway-auth-token-fresh-builder", "-n", "test", "--type=merge", "--patch-file=/dev/stdin"]);
  });

  it("refuses runtime credentials without a durable root", async () => {
    const h = harness();
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl).not.toHaveBeenCalled();
  });

  it("refuses incomplete desired ownership", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "builder", ownerUid: "uid-alice", builderSlug: null });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
  });

  it.each(["shared", "builder"] as const)("keeps an unowned %s runtime unclaimed", async gatewayClass => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass, ownerUid: null, builderSlug: null });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledWith({ gatewayId: request.gatewayId, gatewayClass, token: "synthetic-token" });
  });

  it("fails runtime preparation when scoped credentials cannot be published", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.runKubectl.mockResolvedValueOnce({ code: 0, stdout: Buffer.from("synthetic-token").toString("base64"), stderr: "" }).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "denied" });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("publication failed");
  });
});
