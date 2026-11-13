import "../src/main.js";
import { pathToFileURL } from "node:url";
import { commitOperatorPlacement, planOperatorPlacement } from "@octogee/core/operator-placement";
import { type PlatformUserRecord, type PlatformStateStore } from "@octogee/core/platform-state";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { resolveDefaultPlacementEligibility } from "../../shared/types/orchestrator-placement.js";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";

export interface AssignUserGatewayDeps {
  store: PlatformStateStore;
}

type AssignResult =
  | { kind: "assigned"; uid: string; slug: string; gatewayId: string; previous: string | null }
  | { kind: "already-assigned"; uid: string; slug: string; gatewayId: string }
  | { kind: "refused"; uid: string; reason: string; message: string };

export function isBulkAssignmentCandidate(user: PlatformUserRecord): boolean {
  return user.gateway === null && resolveDefaultPlacementEligibility({
    admitted: user.admitted,
    accountLifecycle: user.accountLifecycle ?? undefined,
    provisioning: {
      status: user.provisioning.status,
      openclaw: { managedBy: user.openclaw.managedBy, slug: user.slug ?? undefined },
    },
  }).eligible;
}

export async function assignOne(
  deps: AssignUserGatewayDeps,
  uid: string,
  opts: { dryRun: boolean; gatewayId: string },
): Promise<AssignResult> {
  const input = { uid, gatewayId: opts.gatewayId };
  const outcome = opts.dryRun
    ? await planOperatorPlacement(deps.store, input)
    : await commitOperatorPlacement(deps.store, { ...input, source: "onboarding", now: Date.now() });
  if (outcome.kind === "refused") return { kind: "refused", uid, reason: outcome.reason, message: outcome.message };
  const plan = outcome.kind === "plan" ? outcome : outcome.plan;
  return plan.currentGatewayId === plan.gatewayId
    ? { kind: "already-assigned", uid, slug: plan.slug, gatewayId: plan.gatewayId }
    : { kind: "assigned", uid, slug: plan.slug, gatewayId: plan.gatewayId, previous: plan.currentGatewayId };
}

export const ASSIGN_USER_GATEWAY_USAGE =
  `Usage: tsx scripts/ops/assign-user-gateway.ts --env=test|prod (--uid=UID | --slug=SLUG | --all) --to=GATEWAY_ID [--dry-run]`;

export interface AssignUserGatewayArgs {
  all: boolean;
  dryRun: boolean;
  env: "test" | "prod";
  gatewayId: string;
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
    gatewayId: "",
  };
  for (const arg of argv) {
    if (arg.startsWith("--env=")) opts.env = arg.slice("--env=".length);
    else if (arg.startsWith("--uid=")) opts.uid = arg.slice("--uid=".length);
    else if (arg.startsWith("--slug=")) opts.slug = arg.slice("--slug=".length);
    else if (arg.startsWith("--to=")) opts.gatewayId = arg.slice("--to=".length);
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
  if (!opts.gatewayId) {
    return {
      kind: "error",
      message: `name the gateway with --to=GATEWAY_ID; the platform does not choose one\n${ASSIGN_USER_GATEWAY_USAGE}`,
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
      gatewayId: opts.gatewayId,
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
  const deps: AssignUserGatewayDeps = {
    store: await operatorPlatformStateStore(deploymentEnvironmentSettings(opts.env).targetId),
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
    for (const user of await deps.store.users.records.listAll()) {
      if (isBulkAssignmentCandidate(user)) uids.push(user.uid);
    }

    console.log(`Found ${uids.length} unassigned-complete user(s)`);
  }

  const mode = opts.dryRun ? " (DRY-RUN)" : "";
  for (const uid of uids) {
    const result = await assignOne(deps, uid, { dryRun: opts.dryRun, gatewayId: opts.gatewayId });
    switch (result.kind) {
      case "assigned":
        console.log(`✅${mode} ${result.slug} (${result.uid}): ${result.previous ?? "(unassigned)"} → ${result.gatewayId}`);
        break;
      case "already-assigned":
        console.log(`•  ${result.slug} (${result.uid}): already on ${result.gatewayId}`);
        break;
      case "refused":
        console.error(`⚠️  ${result.uid}: refused (${result.reason}): ${result.message}`);
        process.exitCode = 1;
        break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
