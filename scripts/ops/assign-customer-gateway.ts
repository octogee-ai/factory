/**
 * Manually assign customer(s) to a gateway via the orchestrator.
 *
 * Sole purpose: the ops entry-point for placement decisions, until the
 * provisioning pipeline wires up a direct call to `assignCustomerGateway`.
 * Keeps the "orchestrator is the correct location" invariant honest without
 * a Firestore trigger (which caused racy re-fires and a "bounce the doc"
 * ops flow we're deliberately avoiding).
 *
 * Usage:
 *   # Assign one customer by uid (reads config/orchestrator from Firestore):
 *   tsx scripts/ops/assign-customer-gateway.ts --env=test --uid=qv7tA8MmwKYc...
 *
 *   # Assign one customer by slug:
 *   tsx scripts/ops/assign-customer-gateway.ts --env=test --slug=chris-test8
 *
 *   # Assign ALL unassigned-complete customers in one shot:
 *   tsx scripts/ops/assign-customer-gateway.ts --env=test --all
 *
 *   # Dry-run (show what would happen, no writes):
 *   tsx scripts/ops/assign-customer-gateway.ts --env=test --all --dry-run
 *
 * The decision logic (config/orchestrator → overrides[uid] ?? defaultGatewayId)
 * is duplicated here from functions/src/orchestrator/assign.ts by design —
 * scripts/ is a separate npm workspace from functions/, and pulling the
 * helper through a shared package would add disproportionate complexity for
 * ~30 lines of code. Canonical source: functions/src/orchestrator/assign.ts.
 * Keep the two in sync.
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

// ── Config copy (mirror of functions/src/orchestrator/types.ts) ──────────
//
// The CLI duplicates the placement logic by design — scripts/ is a separate
// npm workspace from functions/, and pulling the helper through a shared
// package would add disproportionate complexity. The decision matrix is
// kept byte-equivalent to functions/src/orchestrator/assign.ts.
const ORCHESTRATOR_CONFIG_DOC = "config/orchestrator";
const GATEWAY_ID_PATTERN = /^[a-z0-9-]+$/;

interface OrchestratorConfig {
  defaultGatewayId: string;
  overrides?: Record<string, string>;
}

/** Returns null when the doc is missing or `defaultGatewayId` is invalid —
 *  caller surfaces that as "config-missing" so ops fixes the doc instead of
 *  the script silently routing customers at a hardcoded default. */
async function readOrchestratorConfig(db: Firestore): Promise<OrchestratorConfig | null> {
  const snap = await db.doc(ORCHESTRATOR_CONFIG_DOC).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<OrchestratorConfig> | undefined;
  if (typeof data?.defaultGatewayId !== "string" || !GATEWAY_ID_PATTERN.test(data.defaultGatewayId)) {
    return null;
  }
  const overrides =
    data.overrides && typeof data.overrides === "object"
      ? Object.fromEntries(
          Object.entries(data.overrides).filter(
            ([, v]) => typeof v === "string" && GATEWAY_ID_PATTERN.test(v),
          ),
        )
      : undefined;
  return { defaultGatewayId: data.defaultGatewayId, overrides };
}

type AssignResult =
  | { kind: "assigned"; uid: string; slug: string; gatewayId: string; previous: string | null }
  | { kind: "already-assigned"; uid: string; slug: string; gatewayId: string }
  | { kind: "not-ready"; uid: string; slug: string; reason: string };

async function assignOne(
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
  const openclaw = data.provisioning?.openclaw;
  const slug: string = openclaw?.slug ?? "?";
  // Precondition: user is approved. Deliberately NOT gating on
  // `status === "complete"` — assignment happens before provisioning
  // runs so the gateway knows which pod to target. Mirror of the
  // canonical helper in functions/src/orchestrator/assign.ts.
  if (data.approved !== true) {
    return { kind: "not-ready", uid, slug, reason: "not-approved" };
  }
  const config = await readOrchestratorConfig(db);
  if (config === null) {
    return { kind: "not-ready", uid, slug, reason: "config-missing" };
  }
  const target = config.overrides?.[uid] ?? config.defaultGatewayId;
  const current: string | null = typeof openclaw?.gatewayId === "string" ? openclaw.gatewayId : null;
  if (current === target) {
    return { kind: "already-assigned", uid, slug, gatewayId: current };
  }
  if (!opts.dryRun) {
    await userRef.update({ "provisioning.openclaw.gatewayId": target });
  }
  return { kind: "assigned", uid, slug, gatewayId: target, previous: current };
}

// ── Argv parsing ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
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
  else if (arg === "--help" || arg === "-h") {
    // eslint-disable-next-line no-console
    console.log(
      `Usage: tsx scripts/ops/assign-customer-gateway.ts --env=test|prod (--uid=UID | --slug=SLUG | --all) [--dry-run]`,
    );
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`Unknown arg: ${arg}`);
    process.exit(1);
  }
}
const USAGE =
  `Usage: tsx scripts/ops/assign-customer-gateway.ts --env=test|prod (--uid=UID | --slug=SLUG | --all) [--dry-run]`;

// --env is required — no default. PROD and TEST write to different Firestore
// databases; a default would silently target the wrong env on a typo.
if (!opts.env) {
  // eslint-disable-next-line no-console
  console.error(`--env is required (test or prod)\n${USAGE}`);
  process.exit(1);
}
if (opts.env !== "test" && opts.env !== "prod") {
  // eslint-disable-next-line no-console
  console.error(`--env must be 'test' or 'prod' (got: '${opts.env}')\n${USAGE}`);
  process.exit(1);
}
if (!opts.uid && !opts.slug && !opts.all) {
  // eslint-disable-next-line no-console
  console.error(`one of --uid=UID, --slug=SLUG, or --all is required\n${USAGE}`);
  process.exit(1);
}

const envSuffix = opts.env === "prod" ? "" : `-${opts.env}`;
const saPath = path.join(
  process.env.HOME ?? "",
  `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
);
if (!fs.existsSync(saPath)) {
  // eslint-disable-next-line no-console
  console.error(`SA key not found at ${saPath}`);
  process.exit(1);
}
initializeApp({
  credential: cert(JSON.parse(fs.readFileSync(saPath, "utf-8"))),
  projectId: opts.env === "prod" ? "octogee" : `octogee-${opts.env}`,
});
const db = getFirestore();

async function main(): Promise<void> {
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
      // eslint-disable-next-line no-console
      console.error(`No user with slug=${opts.slug}`);
      process.exit(1);
    }
    uids.push(q.docs[0].id);
  } else if (opts.all) {
    // `approved=true` is the precondition for assignment (see assignOne).
    // Widening from the prior `status=complete` filter so --all also
    // catches new signups that are approved but still provisioning.
    const q = await db
      .collection("users")
      .where("approved", "==", true)
      .get();
    for (const d of q.docs) {
      if (!d.data().provisioning?.openclaw?.gatewayId) {
        uids.push(d.id);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Found ${uids.length} unassigned-complete user(s)`);
  }

  const mode = opts.dryRun ? " (DRY-RUN)" : "";
  for (const uid of uids) {
    const result = await assignOne(db, uid, { dryRun: opts.dryRun });
    switch (result.kind) {
      case "assigned":
        // eslint-disable-next-line no-console
        console.log(
          `✅${mode} ${result.slug} (${result.uid}): ${result.previous ?? "(unassigned)"} → ${result.gatewayId}`,
        );
        break;
      case "already-assigned":
        // eslint-disable-next-line no-console
        console.log(`•  ${result.slug} (${result.uid}): already on ${result.gatewayId}`);
        break;
      case "not-ready":
        // eslint-disable-next-line no-console
        console.log(`⚠️  ${result.slug} (${result.uid}): not-ready — ${result.reason}`);
        break;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
