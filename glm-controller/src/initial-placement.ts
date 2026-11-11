import {
  isolatedRuntimeMutationFenced,
} from "@octogee/core/gateway-retirement-claim";
import type {
  PlatformUserRecord,
  FleetRegistryRecord,
  GatewayAssignment,
  OperationRecord,
  PlacementAdmissionPolicy,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import { readSharedGatewayAutoscalingConfigInStore } from "@octogee/core/shared-gateway-pool-read";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import {
  hasFreshReadyKubernetesObservation,
  projectGatewayDesiredRootForGateway,
  type PlacementRejectReason,
} from "@octogee/shared/types/gateway-releases";
import { resolveUserGatewayControlState } from "@octogee/shared/types/glm";
import type { ContinuousPlacementOwnedGateway } from "@octogee/shared/types/orchestrator-placement";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";

export const openPlacementAdmission: PlacementAdmissionPolicy = {
  decide: async () => ({ kind: "admitted" }),
};

export interface AssignInitialPlacementInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  gateway: ContinuousPlacementOwnedGateway;
  siblingGatewayIds: readonly string[];
}

export type InitialPlacementResult =
  | { kind: "assigned"; release: number | null }
  | { kind: "already-placed" }
  | { kind: "rejected"; reason: PlacementRejectReason };

type ProjectedRoot = NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>>;

interface MigrationRoute {
  uid: string | null;
  fromGatewayId: string | null;
  toGatewayId: string | null;
}

function migrationRoute(operation: Stored<OperationRecord>): MigrationRoute | null {
  if (operation.kind !== MIGRATE_USER_KIND) return null;
  const input = operation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { uid, fromGatewayId, toGatewayId } = input as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return { uid: text(uid), fromGatewayId: text(fromGatewayId), toGatewayId: text(toGatewayId) };
}

interface GatewayLoad {
  assignmentCount: number;
  incomingMigrations: number;
  outgoingMigrations: number;
}

function gatewayLoad(
  gatewayId: string,
  assignments: readonly GatewayAssignment[],
  routes: readonly MigrationRoute[],
): GatewayLoad {
  const assigned = new Set(assignments.map((assignment) => assignment.uid));
  return {
    assignmentCount: assignments.length,
    incomingMigrations: routes.filter((route) =>
      route.toGatewayId === gatewayId && (route.uid === null || !assigned.has(route.uid))).length,
    outgoingMigrations: routes.filter((route) =>
      route.fromGatewayId === gatewayId && route.uid !== null && assigned.has(route.uid)).length,
  };
}

function heartbeatMillis(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value !== null && typeof (value as { toMillis?: unknown } | undefined)?.toMillis === "function") {
    return (value as { toMillis(): number }).toMillis();
  }
  return null;
}

export function initialTargetFenceFailures(input: {
  target: string;
  gateway: ProjectedRoot;
  runtime: FleetRegistryRecord;
  load: GatewayLoad;
  siblingLoads: readonly number[];
  buildersPerGateway: number | null;
  nowMs: number;
}): string[] {
  const { target, gateway, runtime, load, siblingLoads, buildersPerGateway, nowMs } = input;
  const heartbeatAt = heartbeatMillis(runtime.heartbeat.lastHeartbeatAt);
  const checks: Array<[string, boolean]> = [
    ["gateway-id-mismatch", gateway.gatewayId !== target],
    ["gateway-class-not-shared", gateway.gatewayClass !== "shared"],
    ["gateway-not-running", gateway.desiredStatus !== "running"],
    ["live-release-missing", gateway.liveRelease === null],
    ["release-not-converged", gateway.desiredRelease !== gateway.liveRelease],
    ["runtime-gateway-mismatch", runtime.gatewayId !== target],
    ["runtime-release-mismatch", runtime.release !== gateway.liveRelease],
    ["runtime-not-serving", runtime.lifecycle !== "serving"],
    ["heartbeat-not-ready", runtime.heartbeat.status !== "ready"],
    ["kubernetes-observation-stale", !hasFreshReadyKubernetesObservation(runtime, nowMs, GATEWAY_UNREACHABLE_AFTER_MS)],
    ["heartbeat-missing", heartbeatAt === null],
    ["heartbeat-stale", heartbeatAt !== null && nowMs - heartbeatAt > GATEWAY_UNREACHABLE_AFTER_MS],
    ["target-at-capacity", buildersPerGateway !== null && load.assignmentCount + load.incomingMigrations >= buildersPerGateway],
    ["target-not-least-loaded", siblingLoads.some((sibling) =>
      sibling < load.assignmentCount + load.incomingMigrations - load.outgoingMigrations)],
  ];
  return checks.filter(([, failed]) => failed).map(([name]) => name);
}

async function userRejection(
  transaction: PlatformStateTransaction,
  user: Stored<PlatformUserRecord> | null,
  request: AssignInitialPlacementInput,
): Promise<PlacementRejectReason | null> {
  if (user === null) return "builder-missing";
  if (user.openclaw.managedBy === "operator") return "builder-operator-managed";
  if (isolatedRuntimeMutationFenced(user)) {
    return user.fences.restoreFence !== undefined ? "restore-in-progress" : "source-transfer-in-progress";
  }
  if (!accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle })) return "account-not-interactive";
  const currentGatewayId = user.gateway?.gatewayId;
  if (
    currentGatewayId !== undefined && currentGatewayId !== request.gatewayId &&
    await transaction.gateways.assignments.get(currentGatewayId, request.uid) !== null
  ) {
    return "assigned-elsewhere";
  }
  return null;
}

async function sharedTargetRejection(input: {
  transaction: PlatformStateTransaction;
  request: AssignInitialPlacementInput;
  root: ProjectedRoot;
  runtime: FleetRegistryRecord;
  nowMs: number;
  log(message: string): void;
}): Promise<PlacementRejectReason | null> {
  const { transaction, request, root, runtime, nowMs, log } = input;
  const [config, assignments, operations, siblings] = await Promise.all([
    readSharedGatewayAutoscalingConfigInStore(transaction),
    transaction.gateways.assignments.list(request.gatewayId),
    transaction.journal.operations.listByStatus(["pending", "running"]),
    Promise.all(request.siblingGatewayIds.map((gatewayId) => transaction.gateways.assignments.list(gatewayId))),
  ]);
  const routes = operations.flatMap((operation) => migrationRoute(operation) ?? []);
  const failures = initialTargetFenceFailures({
    target: request.gatewayId,
    gateway: root,
    runtime,
    load: gatewayLoad(request.gatewayId, assignments, routes),
    siblingLoads: siblings.map((siblingAssignments, index) => {
      const load = gatewayLoad(request.siblingGatewayIds[index]!, siblingAssignments, routes);
      return load.assignmentCount + load.incomingMigrations - load.outgoingMigrations;
    }),
    buildersPerGateway: assignments.some((assignment) => assignment.uid === request.uid)
      ? null
      : config.buildersPerGateway,
    nowMs,
  });
  if (failures.length === 0) return null;
  log(`[placement-policy] uid=${request.uid} placement fence rejected ${request.gatewayId}: ${failures.join(", ")}`);
  return "gateway-target-not-accepting";
}

export async function commitInitialPlacement(
  store: PlatformStateStore,
  request: AssignInitialPlacementInput,
  options: { nowMs: number; log(message: string): void },
): Promise<InitialPlacementResult> {
  const controlState = resolveUserGatewayControlState(request.gateway, request.uid);
  return store.transaction<InitialPlacementResult>(
    { label: "placement-policy.initial-placement" },
    async (transaction) => {
      const user = await transaction.users.records.get(request.uid);
      const rejection = await userRejection(transaction, user, request);
      if (rejection !== null) return { kind: "rejected", reason: rejection };
      const existing = await transaction.gateways.assignments.get(request.gatewayId, request.uid);
      if (existing !== null && user?.gateway?.gatewayId === request.gatewayId) {
        return { kind: "already-placed" };
      }
      const stored = await transaction.gateways.roots.get(request.gatewayId);
      const root = stored === null ? null : projectGatewayDesiredRootForGateway(stored, request.gatewayId);
      if (root === null) return { kind: "rejected", reason: "gateway-root-invalid" };
      if (root.desiredStatus !== "running") return { kind: "rejected", reason: "gateway-not-running" };
      const runtime = await transaction.fleetRegistry.get(request.gatewayId);
      if (runtime === null || runtime.gatewayId !== request.gatewayId || runtime.lifecycle !== "serving") {
        return { kind: "rejected", reason: "gateway-not-serving" };
      }
      if (root.gatewayClass === "shared") {
        const targetRejection = await sharedTargetRejection({
          transaction,
          request,
          root,
          runtime,
          nowMs: options.nowMs,
          log: options.log,
        });
        if (targetRejection !== null) return { kind: "rejected", reason: targetRejection };
      }
      await transaction.users.records.setGatewayMirror(request.uid, {
        gatewayId: request.gatewayId,
        gatewayProfile: controlState.gatewayProfile,
        controlUiEnabled: controlState.controlUiEnabled,
      });
      if (existing !== null) return { kind: "already-placed" };
      await transaction.gateways.assignments.put({
        uid: request.uid,
        slug: request.builderSlug,
        gatewayId: request.gatewayId,
        source: "onboarding",
        state: "serving",
        epoch: 0,
        createdAt: options.nowMs,
        updatedAt: options.nowMs,
        updatedByOperationId: null,
      });
      return { kind: "assigned", release: root.liveRelease };
    },
  );
}
