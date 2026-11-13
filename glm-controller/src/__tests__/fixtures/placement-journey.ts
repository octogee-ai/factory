import { vi } from "vitest";

import {
  reconcilePlacementPolicyOnce,
  SHARED_GATEWAY_REBALANCE_STABILITY_MS,
  type PlacementPolicyReconcilerDeps,
  type PlacementPolicySnapshot,
} from "../../placement-policy-reconciler.js";
import { activeTrial, platformHarness, snapshot } from "./placement-policy.js";

type Gateway = PlacementPolicySnapshot["gateways"][number];

export function sharedGateway(gatewayId: string, patch: Partial<Gateway> = {}): Gateway {
  return {
    gatewayId,
    gatewayClass: "shared",
    ownerUid: null,
    desiredStatus: "running",
    ready: true,
    kubernetesStatus: "ready",
    runtimeStartedAt: 1,
    disposable: false,
    ...patch,
  };
}

export function placedUsers(slugs: readonly string[], gatewayId: string) {
  return slugs.map((slug) => ({
    uid: `uid-${slug}`,
    data: {
      ...activeTrial,
      username: slug,
      provisioning: { status: "complete", openclaw: { gatewayId, slug, status: "complete" } },
    },
  }));
}

export function serving(slugs: readonly string[], gatewayId: string, epoch = 0) {
  return slugs.map((slug) => ({
    uid: `uid-${slug}`,
    slug,
    gatewayId,
    state: "serving",
    epoch,
    createdAt: 0,
  }));
}

interface JourneyStep {
  name: string;
  now: number;
  state: ReturnType<typeof snapshot>;
}

function newcomer(slug: string) {
  return {
    uid: `uid-${slug}`,
    data: { ...activeTrial, username: slug, provisioning: { status: "complete", openclaw: { slug } } },
  };
}

const steps: JourneyStep[] = [
  {
    name: "places a new user on a shared gateway with room",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      platformCurrentGatewayIds: ["shared-a", "shared-b"],
      users: [{
        uid: "uid-newcomer",
        data: { ...activeTrial, username: "newcomer", provisioning: { status: "complete", openclaw: { slug: "newcomer" } } },
      }],
      gateways: [sharedGateway("shared-a", { assignmentCount: 1 }), sharedGateway("shared-b", { assignmentCount: 0 })],
      assignments: [],
    }),
  },
  {
    name: "places a new user off the platform build when no gateway on it has room",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      platformCurrentGatewayIds: ["shared-a"],
      users: [newcomer("newcomer"), ...placedUsers(["ann", "ben", "cat", "dan"], "shared-a")],
      gateways: [sharedGateway("shared-a", { assignmentCount: 4 }), sharedGateway("shared-b", { assignmentCount: 2 })],
      assignments: serving(["ann", "ben", "cat", "dan"], "shared-a"),
    }),
  },
  {
    name: "leaves a new user waiting while every shared gateway is full",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a"],
      platformCurrentGatewayIds: ["shared-a"],
      users: [newcomer("newcomer"), ...placedUsers(["ann", "ben", "cat", "dan"], "shared-a")],
      gateways: [sharedGateway("shared-a", { assignmentCount: 4 })],
      assignments: serving(["ann", "ben", "cat", "dan"], "shared-a"),
    }),
  },
  {
    name: "never places a new user on a draining gateway",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-old",
      sharedGatewayIds: ["shared-old", "shared-new"],
      platformCurrentGatewayIds: ["shared-old", "shared-new"],
      users: [newcomer("newcomer")],
      gateways: [
        sharedGateway("shared-old", { desiredStatus: "draining", assignmentCount: 0 }),
        sharedGateway("shared-new", { assignmentCount: 3 }),
      ],
      assignments: [],
    }),
  },
  {
    name: "supersedes the sole rolling peer before recovering off a missing gateway",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      users: placedUsers(["alice"], "shared-a"),
      gateways: [
        sharedGateway("shared-a", {
          kubernetesStatus: "missing", heartbeatFresh: false, liveRelease: 11, desiredRelease: 11, latestRelease: 11,
        }),
        sharedGateway("shared-b", {
          ready: false, serving: true, heartbeatFresh: true, liveReleaseReady: false, rosterComplete: true,
          liveRelease: 10, desiredRelease: 11, latestRelease: 11,
        }),
      ],
      assignments: serving(["alice"], "shared-a", 7),
    }),
  },
  {
    name: "recovers a user off a missing gateway",
    now: 2_000,
    state: snapshot({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-b"],
      users: placedUsers(["alice"], "shared-a"),
      gateways: [
        sharedGateway("shared-a", { ready: false, kubernetesStatus: "missing", heartbeatFresh: false }),
        sharedGateway("shared-b", { assignmentCount: 0 }),
      ],
      assignments: serving(["alice"], "shared-a", 7),
    }),
  },
  {
    name: "drains a draining gateway and holds the rebalance",
    now: SHARED_GATEWAY_REBALANCE_STABILITY_MS + 1,
    state: snapshot({
      defaultGatewayId: "shared-new",
      sharedGatewayIds: ["shared-new", "shared-old", "shared-full"],
      platformCurrentGatewayIds: ["shared-new", "shared-full"],
      users: [...placedUsers(["alice", "bob"], "shared-old"), ...placedUsers(["carol", "dan", "erin"], "shared-full")],
      gateways: [
        sharedGateway("shared-new", { assignmentCount: 0 }),
        sharedGateway("shared-old", { desiredStatus: "draining", assignmentCount: 2 }),
        sharedGateway("shared-full", { assignmentCount: 3 }),
      ],
      assignments: [...serving(["alice", "bob"], "shared-old"), ...serving(["carol", "dan", "erin"], "shared-full")],
    }),
  },
  {
    name: "rebalances once nothing drains",
    now: SHARED_GATEWAY_REBALANCE_STABILITY_MS + 1,
    state: snapshot({
      defaultGatewayId: "shared-new",
      sharedGatewayIds: ["shared-new", "shared-full"],
      platformCurrentGatewayIds: ["shared-new", "shared-full"],
      users: placedUsers(["carol", "dan", "erin"], "shared-full"),
      gateways: [
        sharedGateway("shared-new", { assignmentCount: 0 }),
        sharedGateway("shared-full", { assignmentCount: 3 }),
      ],
      assignments: serving(["carol", "dan", "erin"], "shared-full"),
    }),
  },
];

const RECORDED_CALLS = [
  "assignInitialPlacement",
  "recoverUnavailableGateway",
  "supersedeRollingSharedGateway",
  "enqueueMigration",
] as const;

export async function runPlacementJourney(
  install: (deps: PlacementPolicyReconcilerDeps, usersPerGateway: number) => PlacementPolicyReconcilerDeps,
): Promise<unknown[]> {
  const recorded: unknown[] = [];
  for (const step of steps) {
    const deps = platformHarness(structuredClone(step.state));
    vi.mocked(deps.now).mockReturnValue(step.now);
    const result = await reconcilePlacementPolicyOnce(install(deps, step.state.buildersPerGateway));
    recorded.push({
      step: step.name,
      result,
      calls: Object.fromEntries(RECORDED_CALLS.map((name) => [name, vi.mocked(deps[name]).mock.calls])),
    });
  }
  return recorded;
}
