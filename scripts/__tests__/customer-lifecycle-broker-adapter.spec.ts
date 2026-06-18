import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";

const mocks = vi.hoisted(() => ({
  addCustomerToGateway: vi.fn(),
}));

vi.mock("../lib/customer-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/customer-lifecycle.js")>();
  return {
    ...actual,
    addCustomerToGateway: mocks.addCustomerToGateway,
  };
});

function mkClient(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    uidForSlug: vi.fn(async () => "uid-tester10"),
    userSnapshot: vi.fn(async () => null),
    setProvisioningStatus: vi.fn(async () => undefined),
    setRepoUrl: vi.fn(async () => undefined),
    provisionMattermost: vi.fn(async () => ({})),
    setMattermostFields: vi.fn(async () => undefined),
    setGreetingResult: vi.fn(async () => undefined),
    setAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
    recordReconcileError: vi.fn(async () => undefined),
    clearReconcileError: vi.fn(async () => undefined),
    notifySignup: vi.fn(async () => undefined),
    macOpsToken: vi.fn(async () => ({
      gatewayId: "gw",
      username: "tester10",
      mmUserId: "mm-user",
      token: "token",
    })),
    createProjectFromAgent: vi.fn(async () => ({
      success: true,
      workspaceId: "workspace",
      slug: "project",
      channelId: "channel",
    })),
    applyMilestoneSignal: vi.fn(async () => undefined),
    recordUsageEvent: vi.fn(async () => undefined),
    blobDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      method: "GET",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    blobUploadUrl: vi.fn(async () => ({
      url: "https://example.com/upload",
      method: "PUT",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    ...overrides,
  };
}

describe("buildBrokeredLifecycleAdapter migration import activation", () => {
  beforeEach(() => {
    mocks.addCustomerToGateway.mockReset();
    mocks.addCustomerToGateway.mockResolvedValue({
      newCustomer: false,
      steps: ["config-patch", "verify-channel-ready"],
    });
  });

  it("activates imported standard-gateway state through the brokered mount flow", async () => {
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });
    const signal = new AbortController().signal;

    await adapter.activateImportedCustomer("tester10", { signal });

    expect(client.uidForSlug).toHaveBeenCalledWith("tester10");
    expect(mocks.addCustomerToGateway).toHaveBeenCalledWith(adapter, "uid-tester10", { signal });
  });

  it("fails clearly when the broker cannot resolve the imported slug", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ uidForSlug: vi.fn(async () => null) }),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.activateImportedCustomer("missing")).rejects.toThrow(
      /fleet broker could not resolve uid/,
    );
    expect(mocks.addCustomerToGateway).not.toHaveBeenCalled();
  });
});
