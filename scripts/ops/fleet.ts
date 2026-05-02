#!/usr/bin/env tsx
/**
 * fleet — solo-operator CLI for the gateway fleet.
 *
 * Wraps the existing fleet controller (functions/src/fleet-controller/*) +
 * Firestore + helm + kubectl into one verb surface. Reads/writes the same
 * Firestore docs the controller already watches: writing here is exactly
 * the trigger the controller is waiting for, so the heavy lifting (mount,
 * pick-next, restore-customer task) keeps happening in Cloud Functions.
 *
 * Phase 1 (this file): read-only `ls` verbs + simple Firestore-write verbs.
 * Phase 2: live customer migration (separate file, gateway RPCs).
 *
 * Usage:
 *   tsx scripts/ops/fleet.ts --env=prod ls gateways
 *   tsx scripts/ops/fleet.ts --env=prod ls customers
 *   tsx scripts/ops/fleet.ts --env=prod ls customers --gateway=gw-prod
 *
 * Bootstrap mirrors scripts/ops/assign-customer-gateway.ts — same SA key
 * convention (~/.openclaw/secrets/octogee[-test]-sa-key.json), same
 * `--env` precondition, same `cert(JSON.parse(...))` pattern. Don't drift.
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type GatewayState,
  type GatewayStatus,
  GATEWAYS_COLLECTION,
  RESTORE_JOBS_COLLECTION,
} from "../../shared/types/fleet-controller.js";
import {
  type MigrationState,
  fullPlan,
  rollbackPlan,
  describeStep,
} from "../lib/fleet-migration.js";

const USAGE = `Usage: tsx scripts/ops/fleet.ts --env=test|prod <verb> [args]

Read verbs:
  ls gateways                          List gateways with pod status + customer count.
  ls customers [--gateway=GW_ID]       List customers, optionally filtered by gateway.
  inspect customer <slug>              Full diagnostic for one customer (assignment +
                                       gateway state + recent restoreJobs).
  inspect gateway <id>                 Full diagnostic for one gateway (mounted +
                                       failed + in-flight + recent jobs).

Write verbs (require --apply to commit; default is dry-run):
  unstick-customer <slug>              Clear failedCustomers backoff + nudge user
                                       doc to fire the controller. Targeted recovery
                                       for the SSH-key-race bug class.
  add-customer <slug> --to=<gw-id>     Override placement: write
                                       users/{uid}.provisioning.openclaw.gatewayId.
                                       Existing controller picks up via trigger.
  migrate-customer <slug> --to=<gw-id> Show the migration plan for moving a
                                       customer from their current gateway
                                       to the target. Plan-only — gateway-side
                                       /quiesce + /export + /import RPCs land
                                       in a follow-up. See lib/fleet-migration.ts.

Examples:
  tsx scripts/ops/fleet.ts --env=prod inspect customer ceckert
  tsx scripts/ops/fleet.ts --env=prod inspect gateway gw-prod
  tsx scripts/ops/fleet.ts --env=prod unstick-customer ceckert         # dry-run
  tsx scripts/ops/fleet.ts --env=prod unstick-customer ceckert --apply # commit
  tsx scripts/ops/fleet.ts --env=prod add-customer ceckert --to=gw-prod-canary --apply`;

// ── Argv parsing ────────────────────────────────────────────────────────────
interface ParsedArgs {
  env: "test" | "prod" | "";
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { env: "", positional: [], flags: {} };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        if (k === "env") {
          out.env = v as "test" | "prod";
        } else {
          out.flags[k] = v;
        }
      } else {
        out.flags[a.slice(2)] = true;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.help === true || args.positional[0] === "help" || args.positional.length === 0) {
  console.log(USAGE);
  process.exit(args.positional.length === 0 ? 1 : 0);
}

if (!args.env) {
  console.error(`--env is required (test or prod)\n${USAGE}`);
  process.exit(1);
}
if (args.env !== "test" && args.env !== "prod") {
  console.error(`--env must be 'test' or 'prod' (got: '${args.env}')\n${USAGE}`);
  process.exit(1);
}

// ── Firestore bootstrap ─────────────────────────────────────────────────────
const envSuffix = args.env === "prod" ? "" : `-${args.env}`;
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
  projectId: args.env === "prod" ? "octogee" : `octogee-${args.env}`,
});
const db = getFirestore();

// K8s context + namespace mirror the bootstrap script convention. PROD =
// `octogee` namespace; TEST = `octogee-test`. Both live in the same
// cluster (see memory: kubectl TEST context, namespace naming).
const KUBE_CONTEXT = "gke_octogee_us-central1_octogee-gateway";
const KUBE_NS = args.env === "prod" ? "octogee" : "octogee-test";

// ── Local Firestore-narrowed view of canonical types ───────────────────────
// shared/types/fleet-controller.ts types Timestamps as `unknown` because
// the shared package doesn't depend on firebase-admin. The CLI does
// receive admin SDK Timestamps in practice, so we narrow the few fields
// we actually call `.toMillis()` on. Everything else is unchanged from
// canonical — silent drift between CLI and controller would re-introduce
// the bug class this CLI exists to surface.
type FirestoreTs = { toMillis(): number };

type GatewayDoc =
  & Omit<
    GatewayState,
    "lastHeartbeatAt" | "lastJobCompletedAt" | "failedCustomers"
  >
  & {
    lastHeartbeatAt: FirestoreTs;
    lastJobCompletedAt: FirestoreTs | null;
    failedCustomers?: Record<
      string,
      { failCount: number; lastFailedAt: FirestoreTs }
    >;
  };

interface UserDoc {
  username?: string;
  email?: string;
  approved?: boolean;
  provisioning?: {
    openclaw?: {
      slug?: string;
      status?: GatewayStatus | string;
      gatewayId?: string;
    };
  };
}

// ── kubectl helpers ─────────────────────────────────────────────────────────
interface PodInfo {
  name: string;
  phase: string;
  ready: string; // e.g. "2/2"
  ageS: number;
}

// One kubectl exec per CLI invocation. Phase 1: all gateway pods share
// the `app=octogee-gateway` label so we get the whole set in one call.
// Phase 2 (release-per-gateway) will add a `gatewayId` label, at which
// point this function takes a gatewayId and filters by it. Cached on
// first call so callers can ask repeatedly without re-execing.
//
// `spawnSync` with array args avoids shell parsing — every input is a
// const so injection isn't possible, but spawnSync makes that obvious to
// the linter (sonarjs/os-command) and to anyone reading.
let podsCache: PodInfo[] | null = null;
function allGatewayPods(): PodInfo[] {
  if (podsCache !== null) return podsCache;
  const result = spawnSync(
    "kubectl", // eslint-disable-line sonarjs/no-os-command-from-path -- operator CLI, PATH is the operator's shell
    [
      "--context", KUBE_CONTEXT,
      "-n", KUBE_NS,
      "get", "pods",
      "-l", "app=octogee-gateway",
      "-o", "json",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 || result.error) {
    // Don't crash on kubectl failure — caller renders "?" for pod state.
    podsCache = [];
    return podsCache;
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{
        metadata: { name: string; creationTimestamp: string; labels?: Record<string, string> };
        status: { phase: string; containerStatuses?: Array<{ ready: boolean }> };
      }>;
    };
    podsCache = parsed.items.map((p) => ({
      name: p.metadata.name,
      phase: p.status.phase,
      ready: (() => {
        const cs = p.status.containerStatuses ?? [];
        return `${cs.filter((c) => c.ready).length}/${cs.length}`;
      })(),
      ageS: Math.round((Date.now() - new Date(p.metadata.creationTimestamp).getTime()) / 1000),
    }));
  } catch {
    podsCache = [];
  }
  return podsCache;
}

// ── Format helpers ──────────────────────────────────────────────────────────
function ts(t: { toMillis(): number } | number | undefined): string {
  if (t === undefined) return "-";
  const ms = typeof t === "number" ? t : t.toMillis();
  const ageS = Math.round((Date.now() - ms) / 1000);
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.round(ageS / 60)}m ago`;
  return `${Math.round(ageS / 3600)}h ago`;
}

function ageHuman(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function table(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "(none)";
  const cols = Object.keys(rows[0]);
  const widths: Record<string, number> = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length));
  }
  const header = cols.map((c) => c.toUpperCase().padEnd(widths[c])).join("  ");
  const sep = cols.map((c) => "─".repeat(widths[c])).join("  ");
  const body = rows.map((r) => cols.map((c) => String(r[c] ?? "").padEnd(widths[c])).join("  "));
  return [header, sep, ...body].join("\n");
}

// ── User lookup ─────────────────────────────────────────────────────────────
// Used by every verb that targets a customer. The provisioner's canonical
// slug field is `provisioning.openclaw.slug`; older docs only have
// `username`. Try both, in that order.
async function findUserBySlug(slug: string): Promise<
  { uid: string; data: UserDoc } | null
> {
  let snap = await db
    .collection("users")
    .where("provisioning.openclaw.slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) {
    snap = await db.collection("users").where("username", "==", slug).limit(1).get();
  }
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { uid: doc.id, data: doc.data() as UserDoc };
}

interface RestoreJobDoc {
  state?: string;
  gatewayId?: string;
  slug?: string;
  createdAt?: { toMillis(): number };
  error?: { message?: string } | string | null;
}

// Recent restore jobs for a slug. Sorted newest-first client-side so we
// don't need a composite Firestore index for one-shot diagnostics.
async function recentRestoreJobs(
  slug: string,
  limit: number,
): Promise<Array<{ id: string } & RestoreJobDoc>> {
  const snap = await db.collection(RESTORE_JOBS_COLLECTION).where("slug", "==", slug).get();
  const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as RestoreJobDoc) }));
  all.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return all.slice(0, limit);
}

// ── Verbs ───────────────────────────────────────────────────────────────────

async function lsGateways(): Promise<void> {
  const snap = await db.collection(GATEWAYS_COLLECTION).get();
  const rows = snap.docs.map((d) => {
    const gw = d.data() as GatewayDoc;
    // Phase 1: one gateway deployment, no per-gateway label distinction,
    // so allGatewayPods() returns the single shared set. Phase 2 will
    // filter by `pod.metadata.labels.gatewayId === d.id` when the chart
    // adds the label.
    const pods = allGatewayPods();
    const podSummary = pods.length === 0
      ? "?"
      : pods.length === 1
        ? `${pods[0].ready} ${pods[0].phase} (${ageHuman(pods[0].ageS)})`
        : `${pods.length} pods (${pods.filter((p) => p.phase === "Running").length} running)`;
    const failedCount = Object.keys(gw.failedCustomers ?? {}).length;
    return {
      gatewayId: d.id,
      status: gw.status ?? "?",
      version: (gw.version ?? "-").slice(0, 12),
      mounted: (gw.mountedCustomers ?? []).length,
      failed: failedCount === 0 ? "-" : failedCount,
      inFlight: gw.inFlightJobId === null || gw.inFlightJobId === undefined ? "-" : gw.inFlightJobId.slice(0, 8),
      heartbeat: ts(gw.lastHeartbeatAt),
      pods: podSummary,
    };
  });
  console.log(table(rows));
}

async function lsCustomers(): Promise<void> {
  const filter = typeof args.flags.gateway === "string" ? args.flags.gateway : null;

  // Read all gateways once for the cross-check.
  const gwSnap = await db.collection(GATEWAYS_COLLECTION).get();
  const gwMounted: Record<string, Set<string>> = {};
  for (const d of gwSnap.docs) {
    const gw = d.data() as GatewayDoc;
    gwMounted[d.id] = new Set(gw.mountedCustomers ?? []);
  }

  // Filter user query to assigned customers (provisioning.openclaw.gatewayId
  // set). Approved=true gate matches assign-customer-gateway.ts so we don't
  // surface unfinished signups as "stuck."
  let q: FirebaseFirestore.Query = db.collection("users").where("approved", "==", true);
  if (filter) {
    q = q.where("provisioning.openclaw.gatewayId", "==", filter);
  }
  const usersSnap = await q.get();

  const rows = usersSnap.docs
    .map((d) => {
      const u = d.data() as UserDoc;
      const slug = u.provisioning?.openclaw?.slug ?? u.username ?? "?";
      const gw = u.provisioning?.openclaw?.gatewayId ?? "-";
      const status = u.provisioning?.openclaw?.status ?? "-";
      const onGateway = gw !== "-" && gwMounted[gw]?.has(slug);
      const drift =
        gw !== "-" && status === "complete"
          ? onGateway
            ? "ok"
            : "MISSING"
          : "-";
      return {
        slug,
        username: u.username ?? "-",
        gatewayId: gw,
        status,
        drift,
      };
    })
    .filter((r) => r.slug !== "?")
    .sort((a, b) => a.slug.localeCompare(b.slug));

  console.log(table(rows));

  // Inverse drift check: customers in mountedCustomers but not assigned
  // in Firestore. Computed per-gateway WITHOUT the approved=true filter
  // so unapproved-but-assigned customers (rare but legal) don't false-
  // positive as orphans. Per-gateway query is one round-trip per gateway
  // in scope, which is small at our fleet size.
  const orphans: Array<{ gatewayId: string; slug: string }> = [];
  for (const [gwId, mountedSet] of Object.entries(gwMounted)) {
    if (filter && gwId !== filter) continue;
    if (mountedSet.size === 0) continue;
    const assignedSnap = await db
      .collection("users")
      .where("provisioning.openclaw.gatewayId", "==", gwId)
      .get();
    const assignedSlugs = new Set(
      assignedSnap.docs
        .map((d) => (d.data() as UserDoc).provisioning?.openclaw?.slug ?? null)
        .filter((s): s is string => s !== null),
    );
    for (const slug of mountedSet) {
      if (!assignedSlugs.has(slug)) {
        orphans.push({ gatewayId: gwId, slug });
      }
    }
  }
  if (orphans.length > 0) {
    console.log("\nORPHANS (in gateway.mountedCustomers but not assigned to that gateway in Firestore):");
    console.log(table(orphans));
  }
}

async function inspectCustomer(slug: string): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(`No user found with slug or username '${slug}'.`);
    process.exit(1);
  }
  const oc = user.data.provisioning?.openclaw ?? {};
  console.log(`=== USER ${slug} (uid=${user.uid}) ===`);
  console.log(table([
    {
      field: "username",
      value: user.data.username ?? "-",
    },
    {
      field: "email",
      value: user.data.email ?? "-",
    },
    {
      field: "approved",
      value: user.data.approved === true ? "true" : "false",
    },
    {
      field: "openclaw.status",
      value: oc.status ?? "-",
    },
    {
      field: "openclaw.gatewayId",
      value: oc.gatewayId ?? "-",
    },
  ]));

  if (!oc.gatewayId) {
    console.log("\n(no gateway assigned — placement hasn't run; check config/orchestrator)");
    return;
  }

  const gwSnap = await db.collection(GATEWAYS_COLLECTION).doc(oc.gatewayId).get();
  if (!gwSnap.exists) {
    console.log(`\n!! gateways/${oc.gatewayId} does not exist — assigned to a gateway that isn't registered.`);
    return;
  }
  const gw = gwSnap.data() as GatewayDoc;
  const mounted = (gw.mountedCustomers ?? []).includes(slug);
  const failed = gw.failedCustomers?.[slug];
  console.log(`\n=== GATEWAY ${oc.gatewayId} ===`);
  console.log(table([
    { field: "status", value: gw.status ?? "-" },
    { field: "heartbeat", value: ts(gw.lastHeartbeatAt) },
    { field: "inFlightJobId", value: gw.inFlightJobId ?? "-" },
    { field: `mountedCustomers.includes('${slug}')`, value: mounted ? "true" : "false" },
    {
      field: `failedCustomers['${slug}']`,
      value: failed
        ? `failCount=${failed.failCount}, last=${ts(failed.lastFailedAt)}`
        : "-",
    },
  ]));

  // Drift verdict — combine the user state with the gateway state.
  console.log("\n=== DRIFT ===");
  if (oc.status === "complete" && !mounted && !failed) {
    console.log("✗ MISSING — assigned + complete but gateway hasn't mounted; trigger may be wedged. Try: unstick-customer");
  } else if (oc.status === "complete" && !mounted && failed) {
    console.log(`✗ STUCK IN BACKOFF — failCount=${failed.failCount}. Try: unstick-customer`);
  } else if (oc.status !== "complete") {
    console.log("· upstream provisioning incomplete; not a fleet-controller issue");
  } else {
    console.log("· healthy (mounted on the assigned gateway)");
  }

  const jobs = await recentRestoreJobs(slug, 5);
  console.log(`\n=== RECENT RESTORE JOBS (latest 5 of ${jobs.length}) ===`);
  if (jobs.length === 0) {
    console.log("(none)");
  } else {
    console.log(table(jobs.map((j) => ({
      id: j.id.slice(0, 12),
      state: j.state ?? "-",
      gatewayId: j.gatewayId ?? "-",
      created: ts(j.createdAt),
      error:
        typeof j.error === "string"
          ? j.error.slice(0, 80)
          : j.error?.message?.slice(0, 80) ?? "-",
    }))));
  }
}

async function inspectGateway(gatewayId: string): Promise<void> {
  const gwSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!gwSnap.exists) {
    console.error(`No gateway doc at gateways/${gatewayId}.`);
    process.exit(1);
  }
  const gw = gwSnap.data() as GatewayDoc;
  console.log(`=== GATEWAY ${gatewayId} ===`);
  console.log(table([
    { field: "status", value: gw.status ?? "-" },
    { field: "version", value: gw.version ?? "-" },
    { field: "openclawVersion", value: gw.openclawVersion ?? "-" },
    { field: "internalUrl", value: gw.internalUrl ?? "-" },
    { field: "heartbeat", value: ts(gw.lastHeartbeatAt) },
    { field: "inFlightJobId", value: gw.inFlightJobId ?? "-" },
    { field: "mountedCustomers", value: String((gw.mountedCustomers ?? []).length) },
  ]));

  const mounted = (gw.mountedCustomers ?? []).slice().sort();
  console.log(`\n=== MOUNTED (${mounted.length}) ===`);
  console.log(mounted.length === 0 ? "(none)" : mounted.join(", "));

  const failed = gw.failedCustomers ?? {};
  const failedKeys = Object.keys(failed).sort();
  console.log(`\n=== FAILED-CUSTOMERS BACKOFF (${failedKeys.length}) ===`);
  if (failedKeys.length === 0) {
    console.log("(none)");
  } else {
    console.log(table(failedKeys.map((k) => ({
      slug: k,
      failCount: failed[k].failCount,
      lastFailedAt: ts(failed[k].lastFailedAt),
    }))));
  }

  // Recent restore jobs across the gateway, not just one slug. We bound to
  // 10 to keep output skimmable.
  const allJobs = await db
    .collection("restoreJobs")
    .where("gatewayId", "==", gatewayId)
    .get();
  const jobs = allJobs.docs
    .map((d) => ({ id: d.id, ...(d.data() as RestoreJobDoc) }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
    .slice(0, 10);
  console.log(`\n=== RECENT RESTORE JOBS (latest 10 of ${allJobs.size}) ===`);
  console.log(table(jobs.map((j) => ({
    id: j.id.slice(0, 12),
    slug: j.slug ?? "-",
    state: j.state ?? "-",
    created: ts(j.createdAt),
    error:
      typeof j.error === "string"
        ? j.error.slice(0, 60)
        : j.error?.message?.slice(0, 60) ?? "-",
  }))));

  // Pod status (from kubectl) for completeness — same source as `ls gateways`.
  // Phase 1 has one shared set across all gateway docs; Phase 2 will filter
  // by `metadata.labels.gatewayId === gatewayId` when the chart adds the label.
  const pods = allGatewayPods();
  console.log(`\n=== PODS (${pods.length}) ===`);
  console.log(pods.length === 0 ? "(none / kubectl unavailable)" : table(pods.map((p) => ({
    name: p.name,
    phase: p.phase,
    ready: p.ready,
    age: ageHuman(p.ageS),
  }))));
}

async function unstickCustomer(slug: string, apply: boolean): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(`No user found with slug or username '${slug}'.`);
    process.exit(1);
  }
  const oc = user.data.provisioning?.openclaw ?? {};
  if (oc.status !== "complete") {
    console.error(
      `User '${slug}' has provisioning.openclaw.status='${oc.status ?? "-"}' (not 'complete'). The fleet controller will skip them — this is upstream provisioning, not a stuck-restore. Refusing to nudge.`,
    );
    process.exit(1);
  }
  if (!oc.gatewayId) {
    console.error(`User '${slug}' has no gatewayId. Run assign-customer-gateway first.`);
    process.exit(1);
  }

  const gwRef = db.collection(GATEWAYS_COLLECTION).doc(oc.gatewayId);
  const gwSnap = await gwRef.get();
  if (!gwSnap.exists) {
    console.error(`Gateway doc gateways/${oc.gatewayId} doesn't exist.`);
    process.exit(1);
  }
  const gw = gwSnap.data() as GatewayDoc;
  const failed = gw.failedCustomers?.[slug];
  const mounted = (gw.mountedCustomers ?? []).includes(slug);

  console.log(`=== unstick-customer ${slug} ===`);
  console.log(`uid:                ${user.uid}`);
  console.log(`gatewayId:          ${oc.gatewayId}`);
  console.log(`gateway status:     ${gw.status}`);
  console.log(`mountedCustomers:   ${mounted ? "includes slug (healthy — won't touch)" : "does NOT include slug (pending — will resolve via nudge)"}`);
  console.log(`failedCustomers:    ${failed ? `failCount=${failed.failCount} → will CLEAR` : "no entry — nothing to clear"}`);
  console.log(`nudge:              users/${user.uid} (forces onUserUpdatedForFleet)`);

  if (mounted && !failed) {
    console.log("\n· Customer appears healthy. unstick will only nudge the trigger; harmless but probably unnecessary.");
  }

  if (!apply) {
    console.log("\n--- DRY RUN (re-run with --apply to commit) ---");
    return;
  }

  // Clear backoff if present. Never touch mountedCustomers from this verb —
  // forcing an unmount is a different concern (a future `unmount-customer`
  // verb that would need a real /unmount RPC, not just a Firestore edit).
  if (failed) {
    await gwRef.update({ [`failedCustomers.${slug}`]: FieldValue.delete() });
    console.log(`\n✓ gateways/${oc.gatewayId}.failedCustomers.${slug} cleared`);
  }

  // Always nudge — fires `onUserUpdatedForFleet` so the controller re-runs
  // pick-next for this customer's gateway. Idempotent: a healthy customer
  // ends in noop-none-pending.
  await db.collection("users").doc(user.uid).set({
    provisioning: {
      openclaw: {
        status: oc.status,
        gatewayId: oc.gatewayId,
        _kickedAt: FieldValue.serverTimestamp(),
      },
    },
  }, { merge: true });
  console.log(`✓ users/${user.uid} nudged`);
  if (!mounted) {
    console.log(`\nWatch gateways/${oc.gatewayId}.mountedCustomers for '${slug}' to appear within ~30s.`);
  }
}

async function addCustomer(slug: string, gatewayId: string, apply: boolean): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(`No user found with slug or username '${slug}'.`);
    process.exit(1);
  }
  if (user.data.approved !== true) {
    console.error(`User '${slug}' is not approved=true. Refusing to assign.`);
    process.exit(1);
  }
  const gwSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!gwSnap.exists) {
    console.error(
      `Gateway doc gateways/${gatewayId} doesn't exist. Use \`fleet ls gateways\` to see registered gateways.`,
    );
    process.exit(1);
  }
  const gw = gwSnap.data() as GatewayDoc;
  if (gw.status === "unreachable") {
    console.error(
      `Gateway '${gatewayId}' is in 'unreachable' status. Refusing to assign — the customer would never get mounted.`,
    );
    process.exit(1);
  }
  const current = user.data.provisioning?.openclaw?.gatewayId ?? null;
  if (current === gatewayId) {
    console.log(`'${slug}' is already assigned to '${gatewayId}'. Nothing to do.`);
    return;
  }

  console.log(`=== add-customer ${slug} → ${gatewayId} ===`);
  console.log(`uid:                ${user.uid}`);
  console.log(`current gatewayId:  ${current ?? "(none)"}`);
  console.log(`new gatewayId:      ${gatewayId}`);
  console.log(`gateway status:     ${gw.status}`);
  if (current && current !== gatewayId) {
    console.log(`!! moving from '${current}' to '${gatewayId}'. Old gateway will keep ${slug} in mountedCustomers until next reboot or explicit unmount — that's drift until Phase 2 ships /unmount RPC.`);
  }

  if (!apply) {
    console.log("\n--- DRY RUN (re-run with --apply to commit) ---");
    return;
  }

  await db.collection("users").doc(user.uid).update({
    "provisioning.openclaw.gatewayId": gatewayId,
  });
  console.log(`\n✓ users/${user.uid}.provisioning.openclaw.gatewayId = ${gatewayId}`);
  console.log(`Controller's onUserUpdatedForFleet will fire and pick-next on ${gatewayId}.`);
}

async function migrateCustomerPlan(slug: string, toGatewayId: string): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(`No user found with slug or username '${slug}'.`);
    process.exit(1);
  }
  const oc = user.data.provisioning?.openclaw ?? {};
  const fromGatewayId = oc.gatewayId;
  if (!fromGatewayId) {
    console.error(
      `User '${slug}' is not currently assigned to any gateway. Use 'add-customer' to place them first.`,
    );
    process.exit(1);
  }
  if (fromGatewayId === toGatewayId) {
    console.log(`'${slug}' is already on '${toGatewayId}'. Nothing to migrate.`);
    return;
  }
  const targetSnap = await db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get();
  if (!targetSnap.exists) {
    console.error(`Target gateway 'gateways/${toGatewayId}' does not exist.`);
    process.exit(1);
  }
  const target = targetSnap.data() as GatewayDoc;
  if (target.status !== "ready") {
    console.error(
      `Target gateway '${toGatewayId}' is in status '${target.status}'. Refusing to plan a migration to a non-ready gateway.`,
    );
    process.exit(1);
  }

  const initial: MigrationState = {
    phase: "initial",
    slug,
    uid: user.uid,
    fromGatewayId,
    toGatewayId,
  };

  const forward = fullPlan(initial);

  console.log(`=== migrate-customer ${slug}: ${fromGatewayId} → ${toGatewayId} ===`);
  console.log(`uid: ${user.uid}`);
  console.log("");
  console.log("FORWARD PLAN");
  forward.forEach((step, i) => {
    console.log(`  ${i + 1}. ${describeStep(step)}`);
  });

  console.log("");
  console.log("ROLLBACK SAFETY NET (steps to recover if forward fails at each phase):");
  // Roll back from the worst-case post-cutover point — that's the most
  // dangerous boundary and the one operators most need to know about.
  const postCutover = rollbackPlan({ ...initial, phase: "cutover-done" });
  console.log("  if forward fails at or after 'cutover-firestore':");
  postCutover.forEach((step) => {
    console.log(`    - ${describeStep(step)}`);
  });
  console.log("  if forward fails before cutover, source still owns; un-quiesce + leave target leak for lazy cleanup.");

  console.log("");
  console.log("--- PLAN ONLY ---");
  console.log("Live execution requires the gateway-side /quiesce, /export,");
  console.log("/import, /unmount RPCs (Phase 2.2). State machine + tests are");
  console.log("in place at scripts/lib/fleet-migration.ts so the orchestrator");
  console.log("can be wired up in a small follow-up PR.");
}

// ── Router ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const verb = args.positional[0] ?? "";
  const sub = args.positional[1] ?? "";
  const apply = args.flags.apply === true;

  switch (`${verb} ${sub}`.trim()) {
    case "ls gateways":
      return lsGateways();
    case "ls customers":
      return lsCustomers();
    case "inspect customer":
      if (!args.positional[2]) {
        console.error(`'inspect customer' needs a slug.\nExample: tsx scripts/ops/fleet.ts --env=prod inspect customer ceckert`);
        process.exit(1);
      }
      return inspectCustomer(args.positional[2]);
    case "inspect gateway":
      if (!args.positional[2]) {
        console.error(`'inspect gateway' needs a gatewayId.\nExample: tsx scripts/ops/fleet.ts --env=prod inspect gateway gw-prod`);
        process.exit(1);
      }
      return inspectGateway(args.positional[2]);
  }

  switch (verb) {
    case "unstick-customer":
      if (!args.positional[1]) {
        console.error(`'unstick-customer' needs a slug.\nExample: tsx scripts/ops/fleet.ts --env=prod unstick-customer ceckert --apply`);
        process.exit(1);
      }
      return unstickCustomer(args.positional[1], apply);
    case "add-customer": {
      const to = args.flags.to as string | undefined;
      if (!args.positional[1] || !to) {
        console.error(`'add-customer' needs a slug and --to=<gatewayId>.\nExample: tsx scripts/ops/fleet.ts --env=prod add-customer ceckert --to=gw-prod-canary --apply`);
        process.exit(1);
      }
      return addCustomer(args.positional[1], to, apply);
    }
    case "migrate-customer": {
      const to = args.flags.to as string | undefined;
      if (!args.positional[1] || !to) {
        console.error(`'migrate-customer' needs a slug and --to=<gatewayId>.\nExample: tsx scripts/ops/fleet.ts --env=prod migrate-customer ceckert --to=gw-prod-v2`);
        process.exit(1);
      }
      return migrateCustomerPlan(args.positional[1], to);
    }
  }

  console.error(`Unknown verb: '${verb} ${sub}'.trim()\n${USAGE}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
