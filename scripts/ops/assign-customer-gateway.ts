

import { initializeApp, cert } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import {
  isValidGatewayId,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import { readGatewayAuthorization } from "@octogee/core/gateway-live-release";
import {
  resolveOnboardingPlacementEligibility,
  type OnboardingOrchestratorConfig,
} from "../../shared/types/orchestrator-placement.js";
import {
  commitPlacementAtomic,
  type PlacementFirestore,
} from "../../shared/types/gateway-releases.js";

const ORCHESTRATOR_CONFIG_DOC = "config/orchestrator";



async function readOrchestratorConfig(db: Firestore): Promise<OnboardingOrchestratorConfig | null> {
  const snap = await db.doc(ORCHESTRATOR_CONFIG_DOC).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<OnboardingOrchestratorConfig> | undefined;
  if (!isValidGatewayId(data?.defaultGatewayId)) {
    return null;
  }
  return { defaultGatewayId: data.defaultGatewayId };
}

type AssignResult =
  | { kind: "assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile; previous: string | null }
  | { kind: "already-assigned"; uid: string; slug: string; gatewayId: string; gatewayProfile: GatewayProfile }
  | { kind: "not-ready"; uid: string; slug: string; reason: string };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "operator" ? "operator" : "standard";
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
  const target = config.defaultGatewayId;
  const targetProfile = await readGatewayProfile(db, target);
  if (targetProfile === null) {
    return { kind: "not-ready", uid, slug, reason: "gateway-config-missing" };
  }
  const current: string | null = typeof openclaw?.gatewayId === "string" ? openclaw.gatewayId : null;
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
