

import { initializeApp, cert } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import {
  GLM_OPERATIONS_COLLECTION,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import { readGatewayAuthorization } from "@octogee/core/gateway-live-release";
import {
  resolveOnboardingPlacementEligibility,
} from "../../shared/types/orchestrator-placement.js";
import {
  commitPlacementAtomic,
  hasFreshReadyKubernetesObservation,
  isGatewayRuntimeDoc,
  type PlacementFirestore,
} from "../../shared/types/gateway-releases.js";
import {
  parseSharedGatewayPoolConfig,
  selectSharedGateway,
  type SharedGatewayPoolCandidate,
  type SharedGatewayPoolConfig,
} from "../../shared/types/shared-gateway-pool.js";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "../../shared/types/fleet-controller.js";

const ORCHESTRATOR_CONFIG_DOC = "config/orchestrator";



async function readOrchestratorConfig(db: Firestore): Promise<SharedGatewayPoolConfig | null> {
  const snap = await db.doc(ORCHESTRATOR_CONFIG_DOC).get();
  if (!snap.exists) return null;
  return parseSharedGatewayPoolConfig(snap.data());
}

type AssignResult =
  | { kind: "assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile; previous: string | null }
  | { kind: "already-assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile }
  | { kind: "not-ready"; uid: string; slug: string; reason: string };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "operator" ? "operator" : "standard";
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
  assignmentDocs: readonly { data(): Record<string, unknown> }[],
  mountedCustomers: readonly string[],
): boolean {
  const mounted = new Set(mountedCustomers);
  return assignmentDocs.every((assignment) => {
    const slug = assignment.data().slug;
    return typeof slug === "string" && mounted.has(slug);
  });
}

type SelectedAssignmentGateway = {
  gatewayId: string;
  gatewayProfile: GatewayProfile;
};

async function selectAssignmentGateway(
  db: Firestore,
  config: SharedGatewayPoolConfig,
  uid: string,
  currentGatewayId: string | null,
  pinnedGatewayId: string | null,
): Promise<SelectedAssignmentGateway | null> {
  const [assignmentSnapshot, operationSnapshot] = await Promise.all([
    db.collectionGroup("assignments").get(),
    db.collection(GLM_OPERATIONS_COLLECTION)
      .where("status", "in", ["pending", "running"])
      .get(),
  ]);
  const assignmentsByGateway = new Map<string, typeof assignmentSnapshot.docs>();
  for (const assignment of assignmentSnapshot.docs) {
    const gatewayId = assignment.ref.parent.parent?.id;
    if (!gatewayId) continue;
    const existing = assignmentsByGateway.get(gatewayId) ?? [];
    existing.push(assignment);
    assignmentsByGateway.set(gatewayId, existing);
  }
  const incomingMigrationsByGateway = new Map<string, number>();
  for (const operation of operationSnapshot.docs) {
    const data = operation.data();
    if (data.kind !== "migrate-customer") continue;
    const input = data.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) continue;
    const targetGatewayId = (input as Record<string, unknown>).toGatewayId;
    if (typeof targetGatewayId !== "string") continue;
    incomingMigrationsByGateway.set(
      targetGatewayId,
      (incomingMigrationsByGateway.get(targetGatewayId) ?? 0) + 1,
    );
  }

  const candidates: SharedGatewayPoolCandidate[] = [];
  const profiles = new Map<string, GatewayProfile>();
  const now = Date.now();
  for (const gatewayId of config.sharedGatewayIds) {
    const [authorization, runtimeSnapshot] = await Promise.all([
      readGatewayAuthorization(db, gatewayId),
      db.doc(`glmGateways/${gatewayId}`).get(),
    ]);
    if (!authorization) continue;
    const runtime = runtimeSnapshot.exists ? runtimeSnapshot.data() : undefined;
    const heartbeatAt = isGatewayRuntimeDoc(runtime)
      ? millis(runtime.heartbeat.lastHeartbeatAt)
      : null;
    const assignments = assignmentsByGateway.get(gatewayId) ?? [];
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
      managedBy: authorization.gateway.managedBy,
      ready: runtimeReady,
      serving: isGatewayRuntimeDoc(runtime) && runtime.lifecycle === "serving",
      heartbeatFresh,
      liveReleaseReady: isGatewayRuntimeDoc(runtime) &&
        authorization.gateway.liveRelease !== null &&
        authorization.gateway.liveRelease === authorization.gateway.desiredRelease &&
        runtime.release === authorization.gateway.liveRelease,
      rosterComplete: isGatewayRuntimeDoc(runtime) &&
        mountedRosterComplete(assignments, runtime.heartbeat.mountedCustomers),
      converging: incomingMigrationCount > 0,
      incomingMigrationCount,
      assignmentCount: assignments.length,
    });
    profiles.set(gatewayId, normalizeGatewayProfile(authorization.config.profile));
  }
  const selection = selectSharedGateway({
    uid,
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
  db: Firestore,
  gatewayId: string,
): Promise<GatewayProfile | null> {
  const authorization = await readGatewayAuthorization(db, gatewayId);
  if (!authorization || authorization.gateway.desiredStatus === "retired") return null;
  return normalizeGatewayProfile(authorization.config.profile);
}

export function isBulkAssignmentCandidate(data: Record<string, unknown>): boolean {
  const eligibility = resolveOnboardingPlacementEligibility(data);
  if (!eligibility.eligible) return false;
  const provisioning = data.provisioning as Record<string, unknown>;
  const openclaw = provisioning.openclaw as Record<string, unknown> | undefined;
  return typeof openclaw?.gatewayId !== "string";
}

// Cohort-era stamps are dead — assignment strips any left on the doc.
function modelMetadataPatch(
  openclaw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of [
    "onboardingCohortId",
    "initialModelProvider",
    "initialModel",
    "initialModelReasoningEffort",
  ]) {
    if (openclaw && Object.prototype.hasOwnProperty.call(openclaw, field)) {
      patch[`provisioning.openclaw.${field}`] = FieldValue.delete();
    }
  }
  return patch;
}

export async function assignOne(
  db: Firestore,
  uid: string,
  opts: { dryRun: boolean },
): Promise<AssignResult> {
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  if (!snap.exists) {
    return { kind: "not-ready", uid, slug: "?", reason: "user-not-found" };
  }
  const data = snap.data() ?? {};
  const openclaw = data.provisioning?.openclaw as Record<string, unknown> | undefined;
  const eligibility = resolveOnboardingPlacementEligibility(data);
  if (!eligibility.eligible) {
    return { kind: "not-ready", uid, slug: "?", reason: `builder-not-eligible:${eligibility.reason}` };
  }
  const slug = eligibility.slug;

  const config = await readOrchestratorConfig(db);
  if (config === null) {
    return { kind: "not-ready", uid, slug, reason: "config-missing" };
  }
  const current: string | null = typeof openclaw?.gatewayId === "string" ? openclaw.gatewayId : null;
  let pinnedGatewayId: string | null = null;
  if (current !== null && config.sharedGatewayIds.includes(current)) {
    const existingAssignment = await db.doc(`gateways/${current}/assignments/${uid}`).get();
    if (existingAssignment.exists) pinnedGatewayId = current;
  }
  const selected = await selectAssignmentGateway(db, config, uid, current, pinnedGatewayId);
  if (selected === null) {
    return { kind: "not-ready", uid, slug, reason: "no-accepting-shared-gateway" };
  }
  const { gatewayId: target, gatewayProfile: targetProfile } = selected;
  if (current === target) {
    if (!opts.dryRun) {
      const committed = await commitPlacementAtomic(db as unknown as PlacementFirestore, {
        uid,
        slug,
        gatewayId: target,
        source: "repair",
        now: Date.now(),
        assignmentWrite: "create-if-missing",
        mirrorPatch: {
          "provisioning.openclaw.gatewayProfile": targetProfile,
          "provisioning.openclaw.shellsEnabled": false,
          ...modelMetadataPatch(openclaw),
        },
      });
      if (committed.kind === "rejected") {
        return { kind: "not-ready", uid, slug, reason: `placement-${committed.reason}` };
      }
    }
    return {
      kind: "already-assigned",
      uid,
      slug,
      gatewayId: current,
      gatewayProfile: targetProfile,
    };
  }
  if (!opts.dryRun) {
    // Mirror AND revision assignment doc commit together so an operator-placed
    // customer is never a gap user on a backfilled gateway mid-roll; a legacy
    // gateway keeps the mirror-only write byte-for-byte.
    const committed = await commitPlacementAtomic(db as unknown as PlacementFirestore, {
      uid,
      slug,
      gatewayId: target,
      source: "onboarding",
      now: Date.now(),
      mirrorPatch: {
        "provisioning.openclaw.gatewayId": target,
        "provisioning.openclaw.gatewayProfile": targetProfile,
        "provisioning.openclaw.shellsEnabled": false,
        ...modelMetadataPatch(openclaw),
      },
    });
    if (committed.kind === "rejected") {
      return { kind: "not-ready", uid, slug, reason: `placement-${committed.reason}` };
    }
  }
  return {
    kind: "assigned",
    uid,
    slug,
    gatewayId: target,
    gatewayProfile: targetProfile,
    previous: current,
  };
}

export const ASSIGN_CUSTOMER_GATEWAY_USAGE =
  `Usage: tsx scripts/ops/assign-customer-gateway.ts --env=test|prod (--uid=UID | --slug=SLUG | --all) [--dry-run]`;

export interface AssignCustomerGatewayArgs {
  all: boolean;
  dryRun: boolean;
  env: "test" | "prod";
  slug: string;
  uid: string;
}

export type ParseAssignCustomerGatewayArgsResult =
  | { kind: "ok"; args: AssignCustomerGatewayArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseAssignCustomerGatewayArgs(
  argv: string[],
): ParseAssignCustomerGatewayArgsResult {
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
    return { kind: "error", message: `--env is required (test or prod)\n${ASSIGN_CUSTOMER_GATEWAY_USAGE}` };
  }
  if (opts.env !== "test" && opts.env !== "prod") {
    return {
      kind: "error",
      message: `--env must be 'test' or 'prod' (got: '${opts.env}')\n${ASSIGN_CUSTOMER_GATEWAY_USAGE}`,
    };
  }
  if (!opts.uid && !opts.slug && !opts.all) {
    return {
      kind: "error",
      message: `one of --uid=UID, --slug=SLUG, or --all is required\n${ASSIGN_CUSTOMER_GATEWAY_USAGE}`,
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
  const parsed = parseAssignCustomerGatewayArgs(argv);
  if (parsed.kind === "help") {
    console.log(ASSIGN_CUSTOMER_GATEWAY_USAGE);
    process.exit(0);
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    process.exit(1);
  }
  const opts = parsed.args;
  const envSuffix = opts.env === "prod" ? "" : `-${opts.env}`;
  const saPath = path.join(
    process.env.HOME ?? "",
    `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
  );
  if (!fs.existsSync(saPath)) {
    console.error(`SA key not found at ${saPath}`);
    process.exit(1);
  }
  initializeApp({
    credential: cert(JSON.parse(fs.readFileSync(saPath, "utf-8"))),
    projectId: opts.env === "prod" ? "octogee" : `octogee-${opts.env}`,
  });
  const db = getFirestore();
  const uids: string[] = [];
  if (opts.uid) {
    uids.push(opts.uid);
  } else if (opts.slug) {
    const q = await db
      .collection("users")
      .where("provisioning.openclaw.slug", "==", opts.slug)
      .limit(1)
      .get();
    if (q.empty) {
      console.error(`No user with slug=${opts.slug}`);
      process.exit(1);
    }
    uids.push(q.docs[0].id);
  } else if (opts.all) {
    const q = await db.collection("users").get();
    for (const d of q.docs) {
      if (isBulkAssignmentCandidate(d.data())) {
        uids.push(d.id);
      }
    }

    console.log(`Found ${uids.length} unassigned-complete user(s)`);
  }

  const mode = opts.dryRun ? " (DRY-RUN)" : "";
  for (const uid of uids) {
    const result = await assignOne(db, uid, { dryRun: opts.dryRun });
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
