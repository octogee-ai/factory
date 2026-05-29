#!/usr/bin/env tsx

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  cutoverUserGatewayAndMarkMounted,
  type FleetStateFirestore,
} from "../lib/fleet-state.js";

const COLOR_ENABLED =
  process.stdout.isTTY === true &&
  (process.env.NO_COLOR === undefined || process.env.NO_COLOR === "");
const ESC = "\x1b[";
const c = {
  reset: COLOR_ENABLED ? `${ESC}0m` : "",
  bold: COLOR_ENABLED ? `${ESC}1m` : "",
  dim: COLOR_ENABLED ? `${ESC}2m` : "",
  red: COLOR_ENABLED ? `${ESC}31m` : "",
  green: COLOR_ENABLED ? `${ESC}32m` : "",
  yellow: COLOR_ENABLED ? `${ESC}33m` : "",
  cyan: COLOR_ENABLED ? `${ESC}36m` : "",
};
const bold = (s: string) => `${c.bold}${s}${c.reset}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const red = (s: string) => `${c.red}${s}${c.reset}`;
const green = (s: string) => `${c.green}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;

const CHECK = COLOR_ENABLED ? "✓" : "[ok]";
const CROSS = COLOR_ENABLED ? "✗" : "[x]";
const ARROW = COLOR_ENABLED ? "→" : "->";

const VERSION = readVersion();

function readVersion(): string {

try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const BANNER = `${bold("fleet")} ${dim("v" + VERSION)} ${dim("— Octogee gateway fleet operations")}`;

interface VerbHelp {
  verb: string;
  summary: string;
  args: string;
  description: string;
  examples: readonly string[];
  
  writes: boolean;
}

const VERBS: readonly VerbHelp[] = [
  {
    verb: "ls gateways",
    summary: "List gateways with pod status + customer count.",
    args: "",
    description:
      "Joins Firestore `gateways/*` with `kubectl get pods -l app=octogee-gateway`. Surfaces stuck pods + heartbeat age that are otherwise invisible without dropping into kubectl directly.",
    examples: ["fleet --env=prod ls gateways"],
    writes: false,
  },
  {
    verb: "ls customers",
    summary: "List customers; optionally filter by gateway. Reports drift in both directions.",
    args: "[--gateway=<gw-id>]",
    description:
      "MISSING = Firestore says assigned, gateway doesn't claim mounted.\nORPHANS = mounted on a gateway but not assigned in Firestore (separate table at the bottom).",
    examples: [
      "fleet --env=prod ls customers",
      "fleet --env=prod ls customers --gateway=gw-prod",
    ],
    writes: false,
  },
  {
    verb: "inspect customer",
    summary: "Full diagnostic for one customer.",
    args: "<slug>",
    description:
      "Shows user state, gateway state focused on this slug, drift verdict, recent restoreJobs (latest 5). The verb-shaped version of the ad-hoc fix-ceckert.ts triage script.",
    examples: ["fleet --env=prod inspect customer ceckert"],
    writes: false,
  },
  {
    verb: "inspect gateway",
    summary: "Full diagnostic for one gateway.",
    args: "<gw-id>",
    description:
      "Mounted set, failedCustomers backoff, recent restoreJobs across the gateway, pod status. Single-screen state dump.",
    examples: ["fleet --env=prod inspect gateway gw-prod"],
    writes: false,
  },
  {
    verb: "unstick-customer",
    summary: "Clear stuck-customer backoff + nudge the controller.",
    args: "<slug> [--apply]",
    description:
      "Clears `failedCustomers[slug]` if set and rewrites `users/{uid}.provisioning.openclaw` to fire the `onUserUpdatedForFleet` trigger.\n\nTargeted recovery for the SSH-key-race bug class. Will NOT remove from `mountedCustomers` (that's a forced unmount, separate concern). Refuses if user provisioning is incomplete or no gateway is assigned.\n\nDry-run by default. Pass `--apply` to commit.",
    examples: [
      "fleet --env=prod unstick-customer ceckert         # dry-run",
      "fleet --env=prod unstick-customer ceckert --apply # commit",
    ],
    writes: true,
  },
  {
    verb: "add-customer",
    summary: "Override placement: assign customer to a specific gateway.",
    args: "<slug> --to=<gw-id> [--apply]",
    description:
      "Writes `users/{uid}.provisioning.openclaw.gatewayId`. Refuses if the gateway doesn't exist or is `unreachable`. Same downstream path as `assign-customer-gateway.ts`, but lets ops force a specific gateway (canary placement, repair).\n\nDry-run by default. Pass `--apply` to commit.",
    examples: [
      "fleet --env=prod add-customer ceckert --to=gw-prod-canary",
      "fleet --env=prod add-customer ceckert --to=gw-prod-canary --apply",
    ],
    writes: true,
  },
  {
    verb: "migrate-customer",
    summary: "Move a customer between gateways via the four-step migration state machine.",
    args: "<slug> --to=<gw-id> [--apply]",
    description:
      "Plans (or executes with --apply) the four-step migration: quiesce source → transfer state → cutover Firestore → unmount source. The state machine in scripts/lib/fleet-migration.ts owns the safety boundaries; rollback is automatic on per-step failure (un-quiesce pre-cutover; reverse cutover + unmount target post-cutover).\n\nDry-run by default — pass --apply to execute. Requires FLEET_CONTROLLER_SECRET in env (see error message for the gcloud one-liner).",
    examples: [
      "fleet --env=test migrate-customer ceckert --to=gw-test-v2",
      "fleet --env=test migrate-customer ceckert --to=gw-test-v2 --apply",
    ],
    writes: true,
  },
];

const verbsByName = new Map<string, VerbHelp>(VERBS.map((v) => [v.verb, v]));

function renderTopHelp(): string {
  const readVerbs = VERBS.filter((v) => !v.writes);
  const writeVerbs = VERBS.filter((v) => v.writes);
  const fmtVerb = (v: VerbHelp) => {
    const name = v.verb.padEnd(20);
    const args = v.args ? ` ${dim(v.args)}` : "";
    return `  ${cyan(name)}${args}\n      ${v.summary}`;
  };
  return [
    BANNER,
    "",
    bold("USAGE"),
    "  fleet --env=test|prod <verb> [args]",
    "",
    bold("READ VERBS"),
    ...readVerbs.map(fmtVerb),
    "",
    bold("WRITE VERBS") + dim(" (dry-run by default; --apply commits)"),
    ...writeVerbs.map(fmtVerb),
    "",
    bold("OPTIONS"),
    `  ${cyan("--env=test|prod")}      ${dim("Required.")} Targets PROD or TEST Firestore + cluster.`,
    `  ${cyan("--apply")}              Commit changes (write verbs only). Without it, runs as dry-run.`,
    `  ${cyan("--help")}               Show this help.`,
    `  ${cyan("--version")}            Print version (${VERSION}).`,
    "",
    bold("LEARN MORE"),
    `  fleet help <verb>      Detailed help, args, and examples for one verb.`,
    "",
  ].join("\n");
}

function renderVerbHelp(verb: VerbHelp): string {
  const command = `fleet --env=<env> ${verb.verb}${verb.args ? " " + verb.args : ""}`;
  return [
    BANNER,
    "",
    bold(verb.verb.toUpperCase()) + dim(verb.writes ? " (write — requires --apply)" : " (read-only)"),
    "",
    bold("SUMMARY"),
    "  " + verb.summary,
    "",
    bold("USAGE"),
    "  " + cyan(command),
    "",
    bold("DESCRIPTION"),
    ...verb.description.split("\n").map((l) => "  " + l),
    "",
    bold("EXAMPLES"),
    ...verb.examples.map((e) => "  " + e),
    "",
  ].join("\n");
}

interface ParsedArgs {
  env: "test" | "prod" | "";
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["env", "to", "gateway"]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { env: "", positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      if (k === "env") out.env = v as "test" | "prod";
      else out.flags[k] = v;
      continue;
    }
    const k = a.slice(2);

if (VALUE_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      const v = argv[++i];
      if (k === "env") out.env = v as "test" | "prod";
      else out.flags[k] = v;
      continue;
    }
    out.flags[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.version === true) {
  console.log(VERSION);
  process.exit(0);
}

if (args.positional.length === 0 || args.flags.help === true) {
  console.log(renderTopHelp());
  process.exit(args.positional.length === 0 ? 1 : 0);
}

if (args.positional[0] === "help") {

const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    console.log(renderTopHelp());
    process.exit(0);
  }
  const verb = verbsByName.get(target);
  if (!verb) {
    console.error(red(`Unknown verb: '${target}'`));
    console.error(dim(`Run \`fleet --help\` for the verb list.`));
    process.exit(1);
  }
  console.log(renderVerbHelp(verb));
  process.exit(0);
}

if (!args.env) {
  console.error(red(`--env is required (test or prod).`));
  console.error(dim(`Example: fleet --env=prod ls gateways`));
  console.error(dim(`Run \`fleet --help\` for the verb list.`));
  process.exit(1);
}
if (args.env !== "test" && args.env !== "prod") {
  console.error(red(`--env must be 'test' or 'prod' (got: '${args.env}').`));
  process.exit(1);
}

const envSuffix = args.env === "prod" ? "" : `-${args.env}`;
const saPath = path.join(
  process.env.HOME ?? "",
  `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
);
if (!fs.existsSync(saPath)) {
  console.error(red(`${CROSS} SA key not found at ${saPath}`));
  console.error(dim(`  Expected file used to authenticate against the ${args.env.toUpperCase()} Firestore database.`));
  process.exit(1);
}
initializeApp({
  credential: cert(JSON.parse(fs.readFileSync(saPath, "utf-8"))),
  projectId: args.env === "prod" ? "octogee" : `octogee-${args.env}`,
});
const db = getFirestore();

const KUBE_CONTEXT = "gke_octogee_us-central1_octogee-gateway";
const KUBE_NS = args.env === "prod" ? "octogee" : "octogee-test";

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

interface PodInfo {
  name: string;
  phase: string;
  ready: string; 
  ageS: number;
}

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

async function recentRestoreJobs(
  slug: string,
  limit: number,
): Promise<Array<{ id: string } & RestoreJobDoc>> {
  const snap = await db.collection(RESTORE_JOBS_COLLECTION).where("slug", "==", slug).get();
  const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as RestoreJobDoc) }));
  all.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return all.slice(0, limit);
}

async function lsGateways(): Promise<void> {
  const snap = await db.collection(GATEWAYS_COLLECTION).get();
  const rows = snap.docs.map((d) => {
    const gw = d.data() as GatewayDoc;

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

const gwSnap = await db.collection(GATEWAYS_COLLECTION).get();
  const gwMounted: Record<string, Set<string>> = {};
  for (const d of gwSnap.docs) {
    const gw = d.data() as GatewayDoc;
    gwMounted[d.id] = new Set(gw.mountedCustomers ?? []);
  }

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
    console.log("\n" + yellow(bold("ORPHANS")) + dim("  in gateway.mountedCustomers but not assigned to that gateway in Firestore"));
    console.log(table(orphans));
  }
}

async function inspectCustomer(slug: string): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug or username '${slug}'.`));
    process.exit(1);
  }
  const oc = user.data.provisioning?.openclaw ?? {};
  console.log(bold(`USER ${slug}`) + dim(`  uid=${user.uid}`));
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
    console.log("\n" + yellow(`No gateway assigned — placement hasn't run; check config/orchestrator.`));
    return;
  }

  const gwSnap = await db.collection(GATEWAYS_COLLECTION).doc(oc.gatewayId).get();
  if (!gwSnap.exists) {
    console.log("\n" + red(`${CROSS} gateways/${oc.gatewayId} does not exist — assigned to a gateway that isn't registered.`));
    return;
  }
  const gw = gwSnap.data() as GatewayDoc;
  const mounted = (gw.mountedCustomers ?? []).includes(slug);
  const failed = gw.failedCustomers?.[slug];
  console.log("\n" + bold(`GATEWAY ${oc.gatewayId}`));
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

console.log("\n" + bold("DRIFT"));
  if (oc.status === "complete" && !mounted && !failed) {
    console.log(red(`${CROSS} MISSING`) + " — assigned + complete but gateway hasn't mounted; trigger may be wedged.");
    console.log(dim(`  Try: fleet --env=${args.env} unstick-customer ${slug} --apply`));
  } else if (oc.status === "complete" && !mounted && failed) {
    console.log(red(`${CROSS} STUCK IN BACKOFF`) + ` — failCount=${failed.failCount}.`);
    console.log(dim(`  Try: fleet --env=${args.env} unstick-customer ${slug} --apply`));
  } else if (oc.status !== "complete") {
    console.log(yellow("·") + " upstream provisioning incomplete; not a fleet-controller issue.");
  } else {
    console.log(green(`${CHECK} healthy`) + " — mounted on the assigned gateway.");
  }

  const jobs = await recentRestoreJobs(slug, 5);
  console.log("\n" + bold(`RECENT RESTORE JOBS`) + dim(`  latest 5 of ${jobs.length}`));
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
    console.error(red(`${CROSS} No gateway doc at gateways/${gatewayId}.`));
    process.exit(1);
  }
  const gw = gwSnap.data() as GatewayDoc;
  console.log(bold(`GATEWAY ${gatewayId}`));
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
  console.log("\n" + bold(`MOUNTED`) + dim(`  ${mounted.length}`));
  console.log(mounted.length === 0 ? dim("  (none)") : "  " + mounted.join(", "));

  const failed = gw.failedCustomers ?? {};
  const failedKeys = Object.keys(failed).sort();
  console.log("\n" + bold(`FAILED-CUSTOMERS BACKOFF`) + dim(`  ${failedKeys.length}`));
  if (failedKeys.length === 0) {
    console.log("(none)");
  } else {
    console.log(table(failedKeys.map((k) => ({
      slug: k,
      failCount: failed[k].failCount,
      lastFailedAt: ts(failed[k].lastFailedAt),
    }))));
  }

const allJobs = await db
    .collection("restoreJobs")
    .where("gatewayId", "==", gatewayId)
    .get();
  const jobs = allJobs.docs
    .map((d) => ({ id: d.id, ...(d.data() as RestoreJobDoc) }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
    .slice(0, 10);
  console.log("\n" + bold(`RECENT RESTORE JOBS`) + dim(`  latest 10 of ${allJobs.size}`));
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
    console.error(red(`${CROSS} No user found with slug or username '${slug}'.`));
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

  console.log(bold(`UNSTICK-CUSTOMER ${slug}`));
  console.log(`  uid               ${user.uid}`);
  console.log(`  gatewayId         ${oc.gatewayId}`);
  console.log(`  gateway status    ${gw.status}`);
  console.log(`  mountedCustomers  ${mounted ? dim("includes slug (healthy — won't touch)") : yellow("does NOT include slug (pending — will resolve via nudge)")}`);
  console.log(`  failedCustomers   ${failed ? yellow(`failCount=${failed.failCount} ${ARROW} will CLEAR`) : dim("no entry — nothing to clear")}`);
  console.log(`  nudge             ${dim(`users/${user.uid} (forces onUserUpdatedForFleet)`)}`);

  if (mounted && !failed) {
    console.log("\n" + dim(`Customer appears healthy. Unstick will only nudge the trigger; harmless but probably unnecessary.`));
  }

  if (!apply) {
    console.log("\n" + dim(`--- DRY RUN (re-run with --apply to commit) ---`));
    return;
  }

if (failed) {
    await gwRef.update({ [`failedCustomers.${slug}`]: FieldValue.delete() });
    console.log("\n" + green(`${CHECK} gateways/${oc.gatewayId}.failedCustomers.${slug} cleared`));
  }

await db.collection("users").doc(user.uid).set({
    provisioning: {
      openclaw: {
        status: oc.status,
        gatewayId: oc.gatewayId,
        _kickedAt: FieldValue.serverTimestamp(),
      },
    },
  }, { merge: true });
  console.log(green(`${CHECK} users/${user.uid} nudged`));
  if (!mounted) {
    console.log("\n" + dim(`Watch gateways/${oc.gatewayId}.mountedCustomers for '${slug}' to appear within ~30s.`));
  }
}

async function addCustomer(slug: string, gatewayId: string, apply: boolean): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug or username '${slug}'.`));
    process.exit(1);
  }
  if (user.data.approved !== true) {
    console.error(red(`${CROSS} User '${slug}' is not approved=true. Refusing to assign.`));
    process.exit(1);
  }
  const gwSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!gwSnap.exists) {
    console.error(red(`${CROSS} Gateway doc gateways/${gatewayId} doesn't exist.`));
    console.error(dim(`  Run \`fleet --env=${args.env} ls gateways\` to see registered gateways.`));
    process.exit(1);
  }
  const gw = gwSnap.data() as GatewayDoc;
  if (gw.status === "unreachable") {
    console.error(red(`${CROSS} Gateway '${gatewayId}' is in 'unreachable' status.`));
    console.error(dim(`  Refusing to assign — the customer would never get mounted.`));
    process.exit(1);
  }
  const current = user.data.provisioning?.openclaw?.gatewayId ?? null;
  if (current === gatewayId) {
    console.log(yellow(`'${slug}' is already assigned to '${gatewayId}'. Nothing to do.`));
    return;
  }

  console.log(bold(`ADD-CUSTOMER ${slug}`) + dim(`  ${ARROW} ${gatewayId}`));
  console.log(`  uid                 ${user.uid}`);
  console.log(`  current gatewayId   ${current ?? dim("(none)")}`);
  console.log(`  new gatewayId       ${cyan(gatewayId)}`);
  console.log(`  gateway status      ${gw.status}`);
  if (current && current !== gatewayId) {
    console.log("\n" + yellow(`!  moving from '${current}' to '${gatewayId}'. Old gateway will keep ${slug} in mountedCustomers until next reboot or explicit unmount — that's drift until Phase 2 ships /unmount RPC.`));
  }

  if (!apply) {
    console.log("\n" + dim(`--- DRY RUN (re-run with --apply to commit) ---`));
    return;
  }

  await db.collection("users").doc(user.uid).update({
    "provisioning.openclaw.gatewayId": gatewayId,
  });
  console.log("\n" + green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayId = ${gatewayId}`));
  console.log(dim(`  Controller's onUserUpdatedForFleet will fire and pick-next on ${gatewayId}.`));
}

async function migrateCustomerPlan(
  slug: string,
  toGatewayId: string,
  apply: boolean,
): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug or username '${slug}'.`));
    process.exit(1);
  }
  const oc = user.data.provisioning?.openclaw ?? {};
  const fromGatewayId = oc.gatewayId;
  if (!fromGatewayId) {
    console.error(red(`${CROSS} User '${slug}' is not currently assigned to any gateway.`));
    console.error(dim(`  Use \`fleet --env=${args.env} add-customer ${slug} --to=<gw-id> --apply\` to place them first.`));
    process.exit(1);
  }
  if (fromGatewayId === toGatewayId) {
    console.log(yellow(`'${slug}' is already on '${toGatewayId}'. Nothing to migrate.`));
    return;
  }
  const targetSnap = await db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get();
  if (!targetSnap.exists) {
    console.error(red(`${CROSS} Target gateway 'gateways/${toGatewayId}' does not exist.`));
    process.exit(1);
  }
  const target = targetSnap.data() as GatewayDoc;
  if (target.status !== "ready") {
    console.error(red(`${CROSS} Target gateway '${toGatewayId}' is in status '${target.status}'.`));
    console.error(dim(`  Refusing to migrate to a non-ready gateway.`));
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

  console.log(bold(`MIGRATE-CUSTOMER ${slug}`) + dim(`  ${fromGatewayId} ${ARROW} ${toGatewayId}`));
  console.log(`  uid  ${user.uid}`);

  console.log("\n" + bold(`FORWARD PLAN`));
  forward.forEach((step, i) => {
    console.log(`  ${cyan(`${i + 1}.`)} ${describeStep(step)}`);
  });

  console.log("\n" + bold(`ROLLBACK SAFETY NET`) + dim(`  recovery if forward fails at any phase`));
  console.log(dim(`  Pre-cutover (initial / source-quiesced / state-transferred):`));
  console.log(dim(`    Source still owns; un-quiesce + leave target leak for lazy cleanup.`));
  const postCutover = rollbackPlan({ ...initial, phase: "cutover-done" });
  console.log(yellow(`  Post-cutover (cutover-done):`));
  postCutover.forEach((step) => {
    console.log(`    ${ARROW} ${describeStep(step)}`);
  });

  if (!apply) {
    console.log("\n" + dim(`--- PLAN ONLY (re-run with --apply to execute) ---`));
    return;
  }

  await executeMigration(slug, user.uid, fromGatewayId, toGatewayId);
}

async function executeMigration(
  slug: string,
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
): Promise<void> {
  const secret = process.env.FLEET_CONTROLLER_SECRET;
  if (!secret) {
    const secretProject = args.env === "prod" ? "octogee" : "octogee-test";
    console.error("\n" + red(`${CROSS} FLEET_CONTROLLER_SECRET is not set in your environment.`));
    console.error(dim(`  Load it with:`));
    console.error(
      dim(
        `    export FLEET_CONTROLLER_SECRET=$(gcloud secrets versions access latest --secret=FLEET_CONTROLLER_SECRET --project=${secretProject})`,
      ),
    );
    process.exit(1);
  }

  const fleetHost = args.env === "prod" ? "https://fleet.octogee.com" : "https://fleet-test.octogee.com";
  const migrationId = `mig-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const { createMigrationClient } = await import("../lib/fleet-migration-client.js");
  const { runMigration } = await import("../lib/fleet-migration-runner.js");

  const client = createMigrationClient({
    secret,
    resolveGatewayUrl: () => fleetHost,
    log: (msg) => console.log(dim(`  ${msg}`)),
  });

  console.log("\n" + bold(`EXECUTING`) + dim(`  migrationId=${migrationId}`));

  const result = await runMigration(
    { migrationId, uid, slug, fromGatewayId, toGatewayId },
    {
      client,
      cutoverFirestore: async (cutoverUid, target, cutoverSlug) => {
        await cutoverUserGatewayAndMarkMounted(
          {
            db: db as unknown as FleetStateFirestore,
            serverTimestamp: () => FieldValue.serverTimestamp(),
            log: (msg) => console.log(dim(`  ${msg}`)),
          },
          { uid: cutoverUid, slug: cutoverSlug, toGatewayId: target },
        );
      },
      log: (msg) => console.log(dim(`  ${msg}`)),
    },
  );

  if (result.success) {
    console.log("\n" + green(`${CHECK} migration complete: ${slug} ${fromGatewayId} ${ARROW} ${toGatewayId}`));
    return;
  }
  console.error(
    "\n" +
      red(
        `${CROSS} migration failed at phase=${result.errorAt?.phase}: ${result.errorAt?.error}`,
      ),
  );
  console.error(
    dim(
      result.rolledBack
        ? `  Rollback was attempted. Source should still own the customer; verify with \`fleet --env=${args.env} inspect customer ${slug}\`.`
        : `  No rollback attempted (or post-unmount). Operator must intervene.`,
    ),
  );
  process.exit(1);
}

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
        return missingArg("inspect customer");
      }
      return inspectCustomer(args.positional[2]);
    case "inspect gateway":
      if (!args.positional[2]) {
        return missingArg("inspect gateway");
      }
      return inspectGateway(args.positional[2]);
  }

  switch (verb) {
    case "unstick-customer":
      if (!args.positional[1]) {
        return missingArg("unstick-customer");
      }
      return unstickCustomer(args.positional[1], apply);
    case "add-customer": {

const to = typeof args.flags.to === "string" ? args.flags.to : undefined;
      if (!args.positional[1] || !to) {
        return missingArg("add-customer");
      }
      return addCustomer(args.positional[1], to, apply);
    }
    case "migrate-customer": {

const to = typeof args.flags.to === "string" ? args.flags.to : undefined;
      if (!args.positional[1] || !to) {
        return missingArg("migrate-customer");
      }
      return migrateCustomerPlan(args.positional[1], to, apply);
    }
  }

  const triedVerb = `${verb}${sub ? " " + sub : ""}`;
  console.error(red(`${CROSS} Unknown verb: '${triedVerb}'`));
  console.error(dim(`  Run \`fleet --help\` for the verb list,`));
  console.error(dim(`  or \`fleet help <verb>\` for per-verb usage.`));
  process.exit(1);
}

function missingArg(verbName: string): never {
  const verb = verbsByName.get(verbName);
  if (!verb) {
    console.error(red(`${CROSS} Internal: unknown verb '${verbName}' in router.`));
    process.exit(1);
  }
  console.error(red(`${CROSS} '${verb.verb}' is missing required arguments.`));
  console.error(dim(`  Usage: fleet --env=<env> ${verb.verb}${verb.args ? " " + verb.args : ""}`));
  console.error(dim(`  Example: ${verb.examples[0]}`));
  console.error(dim(`  Full help: fleet help ${verb.verb}`));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
