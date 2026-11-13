import { resolveDefaultPlacementEligibility } from "@octogee/shared/types/orchestrator-placement";
import { projectGatewayDesiredRootForGateway, type AssignmentSource } from "@octogee/shared/types/gateway-releases";
import { isolatedRuntimeMutationFenced } from "./gateway-retirement-claim.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateRepositories, PlatformStateStore, Stored } from "./platform-state/store.js";

export type OperatorPlacementRefusalReason =
  | "user-not-found"
  | "user-not-admitted"
  | "user-provisioning-not-started"
  | "user-slug-missing"
  | "account-not-interactive"
  | "restore-in-progress"
  | "source-transfer-in-progress"
  | "migration-in-progress"
  | "assigned-elsewhere"
  | "gateway-not-found"
  | "gateway-retired"
  | "gateway-root-invalid"
  | "gateway-not-shared"
  | "gateway-not-running";

export interface OperatorPlacementRefusal {
  kind: "refused";
  reason: OperatorPlacementRefusalReason;
  message: string;
}

export interface OperatorPlacementPlan {
  kind: "plan";
  uid: string;
  slug: string;
  gatewayId: string;
  currentGatewayId: string | null;
  assignmentPresent: boolean;
  mirrorCurrent: boolean;
}

export type OperatorPlacementOutcome =
  | { kind: "placed"; plan: OperatorPlacementPlan }
  | { kind: "repaired"; plan: OperatorPlacementPlan }
  | { kind: "unchanged"; plan: OperatorPlacementPlan }
  | OperatorPlacementRefusal;

export const SHARED_GATEWAY_MIRROR = { gatewayProfile: "standard", controlUiEnabled: false } as const;

const ELIGIBILITY_REFUSALS = {
  "not-admitted": ["user-not-admitted", "user is not admitted"],
  "account-not-interactive": ["account-not-interactive", "account is not interactive"],
  "provisioning-not-started": ["user-provisioning-not-started", "user provisioning has not started"],
  "builder-slug-missing": ["user-slug-missing", "user has no slug"],
} as const satisfies Record<Exclude<EligibilityRefusal, "operator-managed">, readonly [OperatorPlacementRefusalReason, string]>;

type EligibilityRefusal = Extract<ReturnType<typeof resolveDefaultPlacementEligibility>, { eligible: false }>["reason"];

function refused(reason: OperatorPlacementRefusalReason, message: string): OperatorPlacementRefusal {
  return { kind: "refused", reason, message };
}

function userRefusal(user: Stored<PlatformUserRecord>): OperatorPlacementRefusal | string {
  if (isolatedRuntimeMutationFenced(user)) {
    return user.fences.restoreFence !== undefined
      ? refused("restore-in-progress", "restore in progress for this user")
      : refused("source-transfer-in-progress", "source transfer in progress for this user");
  }
  if (user.fences.migration !== undefined) {
    return refused(
      "migration-in-progress",
      `migration ${user.fences.migration.operationId ?? "(no operation id)"} is in progress for this user`,
    );
  }
  const eligibility = resolveDefaultPlacementEligibility({
    admitted: user.admitted,
    accountLifecycle: user.accountLifecycle ?? undefined,
    provisioning: { status: user.provisioning.status, openclaw: { slug: user.slug ?? undefined } },
  });
  if (!eligibility.eligible) {
    if (eligibility.reason === "operator-managed") throw new Error("operator placement read an operator hold it does not pass");
    const [reason, message] = ELIGIBILITY_REFUSALS[eligibility.reason];
    return refused(reason, message);
  }
  return eligibility.slug;
}

async function sharedTargetRefusal(
  reader: PlatformStateRepositories,
  gatewayId: string,
): Promise<OperatorPlacementRefusal | null> {
  const stored = await reader.gateways.roots.get(gatewayId);
  if (stored === null) return refused("gateway-not-found", `gateway ${gatewayId} does not exist`);
  if (stored.desiredStatus === "retired") return refused("gateway-retired", `gateway ${gatewayId} is retired`);
  const { revision: _revision, ...record } = stored;
  const root = projectGatewayDesiredRootForGateway(record, gatewayId);
  if (root === null) return refused("gateway-root-invalid", `gateway ${gatewayId} has an invalid root`);
  if (root.gatewayClass !== "shared") return refused("gateway-not-shared", `gateway ${gatewayId} is isolated; only shared gateways take an assignment`);
  if (root.desiredStatus !== "running") {
    return refused("gateway-not-running", `gateway ${gatewayId} is ${root.desiredStatus}, not running`);
  }
  return null;
}

export async function planOperatorPlacement(
  reader: PlatformStateRepositories,
  input: { uid: string; gatewayId: string },
): Promise<OperatorPlacementPlan | OperatorPlacementRefusal> {
  const { uid, gatewayId } = input;
  const user = await reader.users.records.get(uid);
  if (user === null) return refused("user-not-found", `user ${uid} does not exist`);
  const targetRefusal = await sharedTargetRefusal(reader, gatewayId);
  if (targetRefusal !== null) return targetRefusal;
  const slug = userRefusal(user);
  if (typeof slug !== "string") return slug;
  const currentGatewayId = user.gateway?.gatewayId ?? null;
  const assignedGatewayIds = (await reader.gateways.assignments.listForUid(uid)).map((assignment) => assignment.gatewayId);
  const elsewhere = assignedGatewayIds.filter((assigned) => assigned !== gatewayId).sort();
  if (elsewhere.length > 0) {
    return refused("assigned-elsewhere", `user is assigned to ${elsewhere.join(", ")}; move them with migrate-customer`);
  }
  return {
    kind: "plan",
    uid,
    slug,
    gatewayId,
    currentGatewayId,
    assignmentPresent: assignedGatewayIds.includes(gatewayId),
    mirrorCurrent: currentGatewayId === gatewayId &&
      user.gateway?.gatewayProfile === SHARED_GATEWAY_MIRROR.gatewayProfile &&
      (user.gateway?.controlUiEnabled ?? false) === SHARED_GATEWAY_MIRROR.controlUiEnabled,
  };
}

export async function commitOperatorPlacement(
  store: PlatformStateStore,
  input: { uid: string; gatewayId: string; source: AssignmentSource; now: number },
): Promise<OperatorPlacementOutcome> {
  return store.transaction({ label: "operator-placement.assign" }, async (transaction): Promise<OperatorPlacementOutcome> => {
    const plan = await planOperatorPlacement(transaction, input);
    if (plan.kind === "refused") return plan;
    if (plan.assignmentPresent && plan.mirrorCurrent) return { kind: "unchanged", plan };
    await transaction.users.records.setGatewayMirror(plan.uid, {
      gatewayId: plan.gatewayId,
      ...SHARED_GATEWAY_MIRROR,
    });
    if (plan.assignmentPresent) return { kind: "repaired", plan };
    await transaction.gateways.assignments.put({
      uid: plan.uid,
      slug: plan.slug,
      gatewayId: plan.gatewayId,
      source: plan.currentGatewayId === plan.gatewayId ? "repair" : input.source,
      state: "serving",
      epoch: 0,
      createdAt: input.now,
      updatedAt: input.now,
      updatedByOperationId: null,
    });
    return { kind: "placed", plan };
  });
}
