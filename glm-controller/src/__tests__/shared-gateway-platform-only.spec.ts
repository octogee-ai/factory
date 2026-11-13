import { describe, expect, it, vi } from "vitest";
import { reconcilePlacementPolicyOnce, SHARED_GATEWAY_REBALANCE_STABILITY_MS } from "../placement-policy-reconciler.js";
import { placedUsers, serving, sharedGateway } from "./fixtures/placement-journey.js";
import { activeTrial, platformHarness, snapshot } from "./fixtures/placement-policy.js";

const newUser = {
  uid: "uid-alice",
  data: { ...activeTrial, provisioning: { status: "complete", openclaw: { slug: "alice" } } },
};

describe("shared gateways with no product installed", () => {
  it("places no one by itself: unplaced users wait, counted, with one line per pass saying to place them with user assign", async () => {
    const bob = { uid: "uid-bob", data: { ...activeTrial, username: "bob", provisioning: { status: "complete", openclaw: { slug: "bob" } } } };
    const deps = platformHarness(snapshot({ users: [newUser, bob] }));
    const holdLines = () => vi.mocked(deps.log).mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes("user assign"));

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ assigned: 0, enqueued: 0, blocked: 2 });
    await reconcilePlacementPolicyOnce(deps);

    expect(deps.assignInitialPlacement).not.toHaveBeenCalled();
    expect(deps.enqueueMigration).not.toHaveBeenCalled();
    expect(holdLines()).toEqual(Array(2).fill(
      "[placement-policy] ⚠ platform only: 2 user(s) have no gateway: uid-alice, uid-bob; place them with user assign",
    ));
  });

  it("warns about unplaced users before the first shared gateway exists, with the count and uids", async () => {
    const deps = platformHarness(snapshot({ defaultGatewayId: "", sharedGatewayIds: [], gateways: [], users: [newUser] }));

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ assigned: 0, blocked: 1 });

    expect(vi.mocked(deps.log).mock.calls.map(([line]) => String(line)).filter((line) => line.includes("⚠"))).toEqual([
      "[placement-policy] ⚠ platform only: 1 user(s) have no gateway: uid-alice; place them with user assign",
    ]);
  });

  it("leaves a placed user where they are, even on a gateway outside the shared pool", async () => {
    const deps = platformHarness(snapshot({
      users: placedUsers(["alice"], "shared-gone"),
      gateways: [sharedGateway("shared-blue", { assignmentCount: 0 }), sharedGateway("shared-gone", { desiredStatus: "retired" })],
      assignments: serving(["alice"], "shared-gone"),
    }));

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ assigned: 0, enqueued: 0 });

    expect(deps.enqueueMigration).not.toHaveBeenCalled();
    expect(deps.assignInitialPlacement).not.toHaveBeenCalled();
  });

  it("leaves users on an unavailable shared gateway and says once per pass to move them with user migrate", async () => {
    const deps = platformHarness(snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      users: placedUsers(["alice", "bob"], "shared-a"),
      gateways: [
        sharedGateway("shared-a", { ready: false, kubernetesStatus: "missing", heartbeatFresh: false }),
        sharedGateway("shared-b", { assignmentCount: 0 }),
      ],
      assignments: serving(["alice", "bob"], "shared-a", 7),
    }));
    const holdLines = () => vi.mocked(deps.log).mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes("unavailable shared gateway"));

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ enqueued: 0, blocked: 2 });
    await reconcilePlacementPolicyOnce(deps);

    expect(deps.recoverUnavailableGateway).not.toHaveBeenCalled();
    expect(deps.supersedeRollingSharedGateway).not.toHaveBeenCalled();
    expect(deps.enqueueMigration).not.toHaveBeenCalled();
    expect(holdLines()).toEqual(Array(2).fill(
      "[placement-policy] ⚠ platform only: 2 user(s) wait on unavailable shared gateway shared-a " +
        "(known Kubernetes status missing): uid-alice, uid-bob; move them with user migrate",
    ));
  });

  it.each([
    ["Kubernetes reports it not ready while its heartbeat is fresh", { ready: false, kubernetesStatus: "not-ready" as const, heartbeatFresh: true }],
    ["it still has Kubernetes pods", { ready: false, kubernetesStatus: "not-ready" as const, heartbeatFresh: false }],
    ["it is in an active roll", { ready: false, kubernetesStatus: "missing" as const, heartbeatFresh: false, rollActive: true }],
    ["it is inside its recovery grace", { ready: false, kubernetesStatus: "missing" as const, heartbeatFresh: false, recoveryGraceUntil: 5_000 }],
  ])("says nothing and counts nothing for users of a shared gateway the product would not yet recover from: %s", async (_case, unavailable) => {
    const deps = platformHarness(snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      users: placedUsers(["alice"], "shared-a"),
      gateways: [sharedGateway("shared-a", unavailable), sharedGateway("shared-b", { assignmentCount: 0 })],
      assignments: serving(["alice"], "shared-a", 7),
    }));
    vi.mocked(deps.now).mockReturnValue(2_000);

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ enqueued: 0, blocked: 0 });

    expect(deps.enqueueMigration).not.toHaveBeenCalled();
    expect(vi.mocked(deps.log).mock.calls.flat().filter((line) => String(line).includes("unavailable shared gateway"))).toEqual([]);
  });

  it("keeps the users of a draining shared gateway and says once per pass to move them one at a time, then retire it", async () => {
    const deps = platformHarness(snapshot({
      defaultGatewayId: "shared-new",
      sharedGatewayIds: ["shared-new", "shared-old"],
      platformCurrentGatewayIds: ["shared-new"],
      users: placedUsers(["alice", "bob"], "shared-old"),
      gateways: [
        sharedGateway("shared-new", { assignmentCount: 0 }),
        sharedGateway("shared-old", { desiredStatus: "draining", assignmentCount: 2 }),
      ],
      assignments: serving(["alice", "bob"], "shared-old"),
    }));
    vi.mocked(deps.now).mockReturnValue(SHARED_GATEWAY_REBALANCE_STABILITY_MS + 1);
    const holdLines = () => vi.mocked(deps.log).mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes("draining shared gateway"));

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ enqueued: 0, blocked: 2 });
    await reconcilePlacementPolicyOnce(deps);

    expect(deps.enqueueMigration).not.toHaveBeenCalled();
    expect(holdLines()).toEqual(Array(2).fill(
      "[placement-policy] ⚠ platform only: draining shared gateway shared-old keeps 2 user(s); " +
        "move them one at a time with user migrate, then retire it",
    ));
  });

  it("does not rebalance an uneven pool", async () => {
    const deps = platformHarness(snapshot({
      defaultGatewayId: "shared-new",
      sharedGatewayIds: ["shared-new", "shared-full"],
      platformCurrentGatewayIds: ["shared-new", "shared-full"],
      users: placedUsers(["carol", "dan", "erin"], "shared-full"),
      gateways: [sharedGateway("shared-new", { assignmentCount: 0 }), sharedGateway("shared-full", { assignmentCount: 3 })],
      assignments: serving(["carol", "dan", "erin"], "shared-full"),
    }));
    vi.mocked(deps.now).mockReturnValue(SHARED_GATEWAY_REBALANCE_STABILITY_MS + 1);

    await expect(reconcilePlacementPolicyOnce(deps)).resolves.toMatchObject({ enqueued: 0, blocked: 0 });

    expect(deps.enqueueMigration).not.toHaveBeenCalled();
  });

});
