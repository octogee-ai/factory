import "../product/lib/octogee-entitlements.js";
import { getFirestore } from "firebase-admin/firestore";
import { pathToFileURL } from "node:url";
import {
  firestoreUserAccountReader,
  type UserAccount,
  type UserAccountReader,
} from "@octogee/core/user-account";
import { readGatewayAuthorizationInStore, readGatewayRuntimeDoc } from "@octogee/core/gateway-live-release";
import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import {
  type PlatformUserRecord,
  type PlatformStateStore,
  type PlatformStateTransaction,
  type Stored,
} from "@octogee/core/platform-state";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import {
  readSharedGatewayAutoscalingConfigInStore,
  readSharedGatewayPoolConfigInStore,
} from "@octogee/core/shared-gateway-pool-read";
import { accountAllowsInteractiveAccess } from "../../shared/types/account-lifecycle.js";
import type { GatewayProfile } from "../../shared/types/glm.js";
import {
  resolveOnboardingPlacementEligibility,
  type OnboardingPlacementEligibility,
} from "../../shared/types/orchestrator-placement.js";
import {
  hasFreshReadyKubernetesObservation,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type AssignmentSource,
  type CommitPlacementResult,
  type PlacementRejectReason,
} from "../../shared/types/gateway-releases.js";
import {
  selectSharedGateway,
  type SharedGatewayPoolCandidate,
  type SharedGatewayPoolConfig,
} from "../../shared/types/shared-gateway-pool.js";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "../../shared/types/fleet-controller.js";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";

export interface AssignUserGatewayDeps {
  store: PlatformStateStore;
  accounts: UserAccountReader;
}

type AssignResult =
  | { kind: "assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile; previous: string | null }
  | { kind: "already-assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile }
  | { kind: "not-ready"; uid: string; slug: string; reason: string };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "builder" ? "builder" : "standard";
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    const result = value.toMillis();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  return null;
}

function mountedRosterComplete(
  assignments: readonly { slug: string }[],
  mountedCustomers: readonly string[],
): boolean {
  const mounted = new Set(mountedCustomers);
  return assignments.every((assignment) => mounted.has(assignment.slug));
}

type SelectedAssignmentGateway = {
  gatewayId: string;
  gatewayProfile: GatewayProfile;
};

function incomingMigrationTarget(operation: { kind: string; input: unknown }): string | null {
  if (operation.kind !== "migrate-customer") return null;
  const input = operation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const targetGatewayId = (input as Record<string, unknown>).toGatewayId;
  return typeof targetGatewayId === "string" ? targetGatewayId : null;
}

async function selectAssignmentGateway(
  store: PlatformStateStore,
  config: SharedGatewayPoolConfig,
  uid: string,
  currentGatewayId: string | null,
  pinnedGatewayId: string | null,
): Promise<SelectedAssignmentGateway | null> {
  const operations = await store.journal.operations.listByStatus(["pending", "running"]);
  const incomingMigrationsByGateway = new Map<string, number>();
  for (const operation of operations) {
    const targetGatewayId = incomingMigrationTarget(operation);
    if (targetGatewayId === null) continue;
    incomingMigrationsByGateway.set(
      targetGatewayId,
      (incomingMigrationsByGateway.get(targetGatewayId) ?? 0) + 1,
    );
  }

  const candidates: SharedGatewayPoolCandidate[] = [];
  const profiles = new Map<string, GatewayProfile>();
  const now = Date.now();
  for (const gatewayId of config.sharedGatewayIds) {
    const [authorization, runtime, assignments] = await Promise.all([
      readGatewayAuthorizationInStore(store, gatewayId),
      readGatewayRuntimeDoc(store, { gatewayId }),
      store.gateways.assignments.list(gatewayId),
    ]);
    if (!authorization) continue;
    const heartbeatAt = isGatewayRuntimeDoc(runtime)
      ? millis(runtime.heartbeat.lastHeartbeatAt)
      : null;
    const incomingMigrationCount = incomingMigrationsByGateway.get(gatewayId) ?? 0;
    const runtimeReady = isGatewayRuntimeDoc(runtime) &&
      runtime.gatewayId === gatewayId &&
      hasFreshReadyKubernetesObservation(runtime, now, GATEWAY_UNREACHABLE_AFTER_MS);
    const heartbeatFresh = heartbeatAt !== null &&
      heartbeatAt <= now &&
      now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
    candidates.push({
      gatewayId,
      gatewayClass: authorization.config.gatewayClass,
      desiredStatus: authorization.gateway.desiredStatus,
      ready: runtimeReady,
      serving: isGatewayRuntimeDoc(runtime) && runtime.lifecycle === "serving",
      heartbeatFresh,
      liveReleaseReady: isGatewayRuntimeDoc(runtime) &&
        authorization.gateway.liveRelease !== null &&
        authorization.gateway.liveRelease === authorization.gateway.desiredRelease &&
        runtime.release === authorization.gateway.liveRelease,
      rosterComplete: isGatewayRuntimeDoc(runtime) &&
        mountedRosterComplete(assignments, runtime.heartbeat.mountedCustomers),
      incomingMigrationCount,
      assignmentCount: assignments.length,
    });
    profiles.set(gatewayId, normalizeGatewayProfile(authorization.config.profile));
  }
  const autoscaling = await readSharedGatewayAutoscalingConfigInStore(store);
  const selection = selectSharedGateway({
    buildersPerGateway: autoscaling.buildersPerGateway,
    uid,
    purpose: "initial-placement",
    config,
    candidates: pinnedGatewayId === null
      ? candidates
      : candidates.filter((candidate) => candidate.gatewayId === pinnedGatewayId),
    currentGatewayId,
  });
  if (selection.kind === "blocked") return null;
  const gatewayProfile = profiles.get(selection.gatewayId);
  return gatewayProfile === undefined
    ? null
    : { gatewayId: selection.gatewayId, gatewayProfile };
}

export async function readGatewayProfile(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<GatewayProfile | null> {
  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  if (!authorization || authorization.gateway.desiredStatus === "retired") return null;
  return normalizeGatewayProfile(authorization.config.profile);
}

export function placementEligibility(
  user: PlatformUserRecord,
  account: UserAccount | null,
): OnboardingPlacementEligibility {
  return resolveOnboardingPlacementEligibility({
    onboardingStep: account?.onboardingStep ?? undefined,
    accountLifecycle: user.accountLifecycle ?? undefined,
    provisioning: {
      status: user.provisioning.status,
      openclaw: { managedBy: user.openclaw.managedBy, slug: user.slug ?? undefined },
    },
  });
}

export function isBulkAssignmentCandidate(user: PlatformUserRecord, account: UserAccount | null): boolean {
  return placementEligibility(user, account).eligible && user.gateway === null;
}

async function placementUserRejection(
  transaction: PlatformStateTransaction,
  user: Stored<PlatformUserRecord> | null,
  uid: string,
  gatewayId: string,
): Promise<PlacementRejectReason | null> {
  if (user !== null && isolatedRuntimeMutationFenced(user)) {
    return user.fences.restoreFence !== undefined ? "restore-in-progress" : "source-transfer-in-progress";
  }
  if (!accountAllowsInteractiveAccess({ accountLifecycle: user?.accountLifecycle ?? undefined })) {
    return "account-not-interactive";
  }
  const currentGatewayId = user?.gateway?.gatewayId;
  if (
    currentGatewayId !== undefined && currentGatewayId !== gatewayId &&
    await transaction.gateways.assignments.get(currentGatewayId, uid) !== null
  ) {
    return "assigned-elsewhere";
  }
  return null;
}

async function sharedCapacityRejection(
  transaction: PlatformStateTransaction,
  gatewayId: string,
  uid: string,
): Promise<PlacementRejectReason | null> {
  const [config, assignments, operations] = await Promise.all([
    readSharedGatewayAutoscalingConfigInStore(transaction),
    transaction.gateways.assignments.list(gatewayId),
    transaction.journal.operations.listByStatus(["pending", "running"]),
  ]);
  if (assignments.some((assignment) => assignment.uid === uid)) return null;
  const incoming = operations.some((operation) => incomingMigrationTarget(operation) === gatewayId);
  return !incoming && assignments.length < config.buildersPerGateway ? null : "gateway-target-not-accepting";
}

interface OperatorPlacement {
  uid: string;
  slug: string;
  gatewayId: string;
  gatewayProfile: GatewayProfile;
  source: AssignmentSource;
  assignmentWrite: "upsert" | "create-if-missing";
  now: number;
}

export async function commitOperatorPlacement(
  store: PlatformStateStore,
  placement: OperatorPlacement,
): Promise<CommitPlacementResult> {
  const { uid, gatewayId } = placement;
  return store.transaction({ label: "assign-customer-gateway.place" }, async (transaction): Promise<CommitPlacementResult> => {
    const user = await transaction.users.records.get(uid);
    const userRejection = await placementUserRejection(transaction, user, uid, gatewayId);
    if (userRejection !== null) return { kind: "rejected", reason: userRejection };
    const stored = await transaction.gateways.roots.get(gatewayId);
    if (stored === null) return { kind: "rejected", reason: "gateway-root-invalid" };
    const { revision: _revision, ...rootRecord } = stored;
    const root = projectGatewayDesiredRootForGateway(rootRecord, gatewayId);
    if (root === null) return { kind: "rejected", reason: "gateway-root-invalid" };
    if (root.desiredStatus !== "running") return { kind: "rejected", reason: "gateway-not-running" };
    const runtime = await transaction.fleetRegistry.get(gatewayId);
    if (runtime?.lifecycle !== "serving") return { kind: "rejected", reason: "gateway-not-serving" };
    const capacityRejection = root.gatewayClass === "shared"
      ? await sharedCapacityRejection(transaction, gatewayId, uid)
      : null;
    if (capacityRejection !== null) return { kind: "rejected", reason: capacityRejection };
    const existing = placement.assignmentWrite === "create-if-missing"
      ? await transaction.gateways.assignments.get(gatewayId, uid)
      : null;
    await transaction.users.records.setGatewayMirror(uid, {
      gatewayId,
      gatewayProfile: placement.gatewayProfile,
      controlUiEnabled: false,
    });
    if (existing !== null) return { kind: "assignment-preserved" };
    await transaction.gateways.assignments.put({
      uid,
      slug: placement.slug,
      gatewayId,
      source: placement.source,
      state: "serving",
      epoch: 0,
      createdAt: placement.now,
      updatedAt: placement.now,
      updatedByOperationId: null,
    });
    return { kind: "assigned", release: root.liveRelease };
  });
}

export async function assignOne(
  deps: AssignUserGatewayDeps,
  uid: string,
  opts: { dryRun: boolean },
): Promise<AssignResult> {
  const [user, account] = await Promise.all([
    deps.store.users.records.get(uid),
    deps.accounts.get(uid),
  ]);
  if (user === null) {
    return { kind: "not-ready", uid, slug: "?", reason: "user-not-found" };
  }
  const eligibility = placementEligibility(user, account);
  if (!eligibility.eligible) {
    return { kind: "not-ready", uid, slug: "?", reason: `builder-not-eligible:${eligibility.reason}` };
  }
  const slug = eligibility.slug;

  const config = await readSharedGatewayPoolConfigInStore(deps.store);
  if (config === null) {
    return { kind: "not-ready", uid, slug, reason: "shared-pool-empty" };
  }
  const current = user.gateway?.gatewayId ?? null;
  let pinnedGatewayId: string | null = null;
  if (current !== null && config.sharedGatewayIds.includes(current)) {
    if (await deps.store.gateways.assignments.get(current, uid) !== null) pinnedGatewayId = current;
  }
  const selected = await selectAssignmentGateway(deps.store, config, uid, current, pinnedGatewayId);
  if (selected === null) {
    return { kind: "not-ready", uid, slug, reason: "no-accepting-shared-gateway" };
  }
  const { gatewayId: target, gatewayProfile: targetProfile } = selected;
  const repair = current === target;
  if (!opts.dryRun) {
    const committed = await commitOperatorPlacement(deps.store, {
      uid,
      slug,
      gatewayId: target,
      gatewayProfile: targetProfile,
      source: repair ? "repair" : "onboarding",
      assignmentWrite: repair ? "create-if-missing" : "upsert",
      now: Date.now(),
    });
    if (committed.kind === "rejected") {
      return { kind: "not-ready", uid, slug, reason: `placement-${committed.reason}` };
    }
  }
  return repair
    ? { kind: "already-assigned", uid, slug, gatewayId: target, gatewayProfile: targetProfile }
    : { kind: "assigned", uid, slug, gatewayId: target, gatewayProfile: targetProfile, previous: current };
}

export const ASSIGN_USER_GATEWAY_USAGE =
  `Usage: tsx scripts/ops/assign-user-gateway.ts --env=test|prod (--uid=UID | --slug=SLUG | --all) [--dry-run]`;

export interface AssignUserGatewayArgs {
  all: boolean;
  dryRun: boolean;
  env: "test" | "prod";
  slug: string;
  uid: string;
}

export type ParseAssignUserGatewayArgsResult =
  | { kind: "ok"; args: AssignUserGatewayArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseAssignUserGatewayArgs(
  argv: string[],
): ParseAssignUserGatewayArgsResult {
  const opts = {
    env: "",
    uid: "",
    slug: "",
    all: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--env=")) opts.env = arg.slice("--env=".length);
    else if (arg.startsWith("--uid=")) opts.uid = arg.slice("--uid=".length);
    else if (arg.startsWith("--slug=")) opts.slug = arg.slice("--slug=".length);
    else if (arg === "--all") opts.all = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") return { kind: "help" };
    else return { kind: "error", message: `Unknown arg: ${arg}` };
  }
  if (!opts.env) {
    return { kind: "error", message: `--env is required (test or prod)\n${ASSIGN_USER_GATEWAY_USAGE}` };
  }
  if (opts.env !== "test" && opts.env !== "prod") {
    return {
      kind: "error",
      message: `--env must be 'test' or 'prod' (got: '${opts.env}')\n${ASSIGN_USER_GATEWAY_USAGE}`,
    };
  }
  if (!opts.uid && !opts.slug && !opts.all) {
    return {
      kind: "error",
      message: `one of --uid=UID, --slug=SLUG, or --all is required\n${ASSIGN_USER_GATEWAY_USAGE}`,
    };
  }
  return {
    kind: "ok",
    args: {
      env: opts.env,
      uid: opts.uid,
      slug: opts.slug,
      all: opts.all,
      dryRun: opts.dryRun,
    },
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseAssignUserGatewayArgs(argv);
  if (parsed.kind === "help") {
    console.log(ASSIGN_USER_GATEWAY_USAGE);
    process.exit(0);
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    process.exit(1);
  }
  const opts = parsed.args;
  initializeOperatorFirebaseAdmin(opts.env === "prod" ? "octogee" : `octogee-${opts.env}`);
  const db = getFirestore();
  const deps: AssignUserGatewayDeps = {
    store: await operatorPlatformStateStore(deploymentEnvironmentSettings(opts.env).targetId),
    accounts: firestoreUserAccountReader(db),
  };
  const uids: string[] = [];
  if (opts.uid) {
    uids.push(opts.uid);
  } else if (opts.slug) {
    const user = await deps.store.users.records.findBySlug(opts.slug);
    if (user === null) {
      console.error(`No user with slug=${opts.slug}`);
      process.exit(1);
    }
    uids.push(user.uid);
  } else if (opts.all) {
    const [users, accounts] = await Promise.all([
      deps.store.users.records.listAll(),
      deps.accounts.list(),
    ]);
    for (const user of users) {
      if (isBulkAssignmentCandidate(user, accounts.get(user.uid) ?? null)) {
        uids.push(user.uid);
      }
    }

    console.log(`Found ${uids.length} unassigned-complete user(s)`);
  }

  const mode = opts.dryRun ? " (DRY-RUN)" : "";
  for (const uid of uids) {
    const result = await assignOne(deps, uid, { dryRun: opts.dryRun });
    switch (result.kind) {
      case "assigned":
        console.log(
          `✅${mode} ${result.slug} (${result.uid}): ${result.previous ?? "(unassigned)"} → ${result.gatewayId} (${result.gatewayProfile})`,
        );
        break;
      case "already-assigned":
        console.log(`•  ${result.slug} (${result.uid}): already on ${result.gatewayId} (${result.gatewayProfile})`);
        break;
      case "not-ready":
        console.log(`⚠️  ${result.slug} (${result.uid}): not-ready — ${result.reason}`);
        break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
