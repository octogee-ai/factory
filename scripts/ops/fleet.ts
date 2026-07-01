#!/usr/bin/env tsx

import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type GatewayState,
  type GatewayStatus,
  GATEWAYS_COLLECTION,
} from "../../shared/types/fleet-controller.js";
import {
  GLM_GATEWAYS_COLLECTION,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import {
  type MigrationState,
  fullPlan,
  rollbackPlan,
  describeStep,
} from "../lib/fleet-migration.js";
import {
  enqueueOperation,
  awaitOperation,
  type OperationsDb,
} from "../lib/glm-operations.js";

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
      "fleet --env=prod ls customers --gateway=default",
    ],
    writes: false,
  },
  {
    verb: "inspect customer",
    summary: "Full diagnostic for one customer.",
    args: "<slug>",
    description:
      "Shows user state, gateway state focused on this slug, drift verdict, and gateways/{id}.lastError when it names this slug. The verb-shaped version of the ad-hoc fix-ceckert.ts triage script.",
    examples: ["fleet --env=prod inspect customer ceckert"],
    writes: false,
  },
  {
    verb: "inspect gateway",
    summary: "Full diagnostic for one gateway.",
    args: "<gw-id>",
    description:
      "Mounted set, lastError, pod status. Single-screen state dump.",
    examples: ["fleet --env=prod inspect gateway default"],
    writes: false,
  },
  {
    verb: "add-customer",
    summary: "Override placement: assign customer to a specific gateway.",
    args: "<slug> --to=<gw-id> [--apply]",
    description:
      "Writes `users/{uid}.provisioning.openclaw.gatewayId` and the mirrored `gatewayProfile`. Refuses if the gateway doesn't exist or is `unreachable`. Same downstream path as `assign-customer-gateway.ts`, but lets ops force a specific gateway (canary placement, repair).\n\nDry-run by default. Pass `--apply` to commit.",
    examples: [
      "fleet --env=prod add-customer ceckert --to=canary",
      "fleet --env=prod add-customer ceckert --to=canary --apply",
    ],
    writes: true,
  },
  {
    verb: "migrate-customer",
    summary: "Move a customer between gateways via the four-step migration state machine.",
    args: "<slug> --to=<gw-id> [--apply]",
    description:
      "Plans (or executes with --apply) the four-step migration: quiesce source → transfer state → cutover Firestore → unmount source. The state machine in scripts/lib/fleet-migration.ts owns the safety boundaries; rollback is automatic on per-step failure (un-quiesce pre-cutover; reverse cutover + unmount target post-cutover).\n\nDry-run by default — pass --apply to execute. Migration runs server-side in glm-controller; the CLI just enqueues the operation and streams its reported steps.",
    examples: [
      "fleet --env=test migrate-customer ceckert --to=canary",
      "fleet --env=test migrate-customer ceckert --to=canary --apply",
    ],
    writes: true,
  },
];

const verbsByName = new Map<string, VerbHelp>(VERBS.map((v) => [v.verb, v]));

export type FleetCredentialMode = "service-account-key" | "application-default";

function parsedVerb(args: ParsedFleetArgs): VerbHelp | null {
  const [verb, sub] = args.positional;
  return verbsByName.get(`${verb ?? ""} ${sub ?? ""}`.trim()) ?? verbsByName.get(verb ?? "") ?? null;
}

export function resolveFleetCredentialMode(args: ParsedFleetArgs): FleetCredentialMode {
  const verb = parsedVerb(args);
  return verb?.writes === true && args.flags.apply === true
    ? "application-default"
    : "service-account-key";
}

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

export interface ParsedFleetArgs {
  env: "test" | "prod" | "";
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["env", "to", "gateway"]);

export function parseFleetArgs(argv: readonly string[]): ParsedFleetArgs {
  const out: ParsedFleetArgs = { env: "", positional: [], flags: {} };
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

let args: ParsedFleetArgs = parseFleetArgs([]);
let db: ReturnType<typeof getFirestore>;

function initializeFleetCli(argv: string[]): void {
  args = parseFleetArgs(argv);

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

  const credentialMode = resolveFleetCredentialMode(args);
  const projectId = args.env === "prod" ? "octogee" : `octogee-${args.env}`;
  const envSuffix = args.env === "prod" ? "" : `-${args.env}`;
  const saPath = path.join(
    process.env.HOME ?? "",
    `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
  );
  if (credentialMode === "service-account-key" && !fs.existsSync(saPath)) {
    console.error(red(`${CROSS} SA key not found at ${saPath}`));
    console.error(dim(`  Expected file used to authenticate against the ${args.env.toUpperCase()} Firestore database.`));
    process.exit(1);
  }
  initializeApp({
    credential:
      credentialMode === "application-default"
        ? applicationDefault()
        : cert(JSON.parse(fs.readFileSync(saPath, "utf-8"))),
    projectId,
  });
  if (credentialMode === "application-default") {
    console.error(dim(`  fleet writes use Application Default Credentials for ${projectId}.`));
  }
  db = getFirestore();
  KUBE_NS = args.env === "prod" ? "octogee" : "octogee-test";
}

const KUBE_CONTEXT = "gke_octogee_us-central1_octogee-gateway";
let KUBE_NS = "octogee-test";

type FirestoreTs = { toMillis(): number };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "operator" ? "operator" : "standard";
}

async function readGatewayProfile(gatewayId: string): Promise<GatewayProfile> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  return normalizeGatewayProfile(snap.exists ? snap.data()?.profile : undefined);
}

type GatewayDoc =
  & Omit<GatewayState, "lastHeartbeatAt">
  & {
    lastHeartbeatAt: FirestoreTs;
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
      gatewayProfile?: unknown;
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
    return {
      gatewayId: d.id,
      status: gw.status ?? "?",
      version: (gw.version ?? "-").slice(0, 12),
      mounted: (gw.mountedCustomers ?? []).length,
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
  const lastErrorForSlug =
    gw.lastError && gw.lastError.slug === slug ? gw.lastError : null;
  console.log("\n" + bold(`GATEWAY ${oc.gatewayId}`));
  console.log(table([
    { field: "status", value: gw.status ?? "-" },
    { field: "heartbeat", value: ts(gw.lastHeartbeatAt) },
    { field: `mountedCustomers.includes('${slug}')`, value: mounted ? "true" : "false" },
    {
      field: `lastError (this slug)`,
      value: lastErrorForSlug
        ? `${lastErrorForSlug.message} (${ts(lastErrorForSlug.at as FirestoreTs)})`
        : "-",
    },
  ]));

console.log("\n" + bold("DRIFT"));
  if (oc.status === "complete" && !mounted) {
    console.log(red(`${CROSS} NOT MOUNTED`) + " — assigned + complete but absent from mountedCustomers.");
    console.log(dim(`  The gateway reconcile re-checks desired−observed every ~15s and self-heals — no kick needed.`));
    console.log(dim(`  If it persists, check the gateway pod's [reconcile] logs${lastErrorForSlug ? " + the lastError above" : ""}.`));
  } else if (oc.status !== "complete") {
    console.log(yellow("·") + " upstream provisioning incomplete; not a fleet issue.");
  } else {
    console.log(green(`${CHECK} healthy`) + " — mounted on the assigned gateway.");
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
    { field: "mountedCustomers", value: String((gw.mountedCustomers ?? []).length) },
  ]));

  const mounted = (gw.mountedCustomers ?? []).slice().sort();
  console.log("\n" + bold(`MOUNTED`) + dim(`  ${mounted.length}`));
  console.log(mounted.length === 0 ? dim("  (none)") : "  " + mounted.join(", "));

  console.log("\n" + bold(`LAST ERROR`) + dim(`  most recent reconcile ensure failure`));
  if (gw.lastError) {
    console.log(table([{
      slug: gw.lastError.slug ?? "-",
      message: (gw.lastError.message ?? "-").slice(0, 80),
      at: ts(gw.lastError.at as FirestoreTs),
    }]));
  } else {
    console.log("(none)");
  }

const pods = allGatewayPods();
  console.log(`\n=== PODS (${pods.length}) ===`);
  console.log(pods.length === 0 ? "(none / kubectl unavailable)" : table(pods.map((p) => ({
    name: p.name,
    phase: p.phase,
    ready: p.ready,
    age: ageHuman(p.ageS),
  }))));
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
  const gatewayProfile = await readGatewayProfile(gatewayId);
  if (gw.status === "unreachable") {
    console.error(red(`${CROSS} Gateway '${gatewayId}' is in 'unreachable' status.`));
    console.error(dim(`  Refusing to assign — the customer would never get mounted.`));
    process.exit(1);
  }
  const current = user.data.provisioning?.openclaw?.gatewayId ?? null;
  const currentProfile = normalizeGatewayProfile(user.data.provisioning?.openclaw?.gatewayProfile);
  if (current === gatewayId) {
    if (currentProfile !== gatewayProfile) {
      console.log(yellow(`'${slug}' is already assigned to '${gatewayId}', but gatewayProfile is ${currentProfile}; repairing to ${gatewayProfile}.`));
      if (apply) {
        await db.collection("users").doc(user.uid).update({
          "provisioning.openclaw.gatewayProfile": gatewayProfile,
          "provisioning.openclaw.shellsEnabled": false,
        });
        console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayProfile = ${gatewayProfile}`));
        console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.shellsEnabled = false`));
      } else {
        console.log(dim(`--- DRY RUN (re-run with --apply to repair gatewayProfile) ---`));
      }
      return;
    }
    console.log(yellow(`'${slug}' is already assigned to '${gatewayId}'. Nothing to do.`));
    return;
  }

  console.log(bold(`ADD-CUSTOMER ${slug}`) + dim(`  ${ARROW} ${gatewayId}`));
  console.log(`  uid                 ${user.uid}`);
  console.log(`  current gatewayId   ${current ?? dim("(none)")}`);
  console.log(`  new gatewayId       ${cyan(gatewayId)}`);
  console.log(`  gateway profile     ${gatewayProfile}`);
  console.log(`  gateway status      ${gw.status}`);
  if (current && current !== gatewayId) {
    console.log("\n" + yellow(`!  moving from '${current}' to '${gatewayId}'. The old gateway's reconcile drains ${slug} (observed−desired → evict) within ~15s; use migrate-customer for a zero-downtime cutover instead.`));
  }

  if (!apply) {
    console.log("\n" + dim(`--- DRY RUN (re-run with --apply to commit) ---`));
    return;
  }

  await db.collection("users").doc(user.uid).update({
    "provisioning.openclaw.gatewayId": gatewayId,
    "provisioning.openclaw.gatewayProfile": gatewayProfile,
    "provisioning.openclaw.shellsEnabled": false,
  });
  console.log("\n" + green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayId = ${gatewayId}`));
  console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayProfile = ${gatewayProfile}`));
  console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.shellsEnabled = false`));
  console.log(dim(`  The ${gatewayId} reconcile loop mounts ${slug} within ~15s (desired−observed → ensure); watch gateways/${gatewayId}.mountedCustomers.`));
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

const MIGRATION_OP_TIMEOUT_MS = 30 * 60_000;

async function executeMigration(
  slug: string,
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
): Promise<void> {
  const opsDb = db as unknown as OperationsDb;
  const opId = await enqueueOperation(opsDb, {
    kind: "migrate-customer",
    input: { uid, toGatewayId },
    createdBy: `fleet-cli:${process.env.USER ?? "operator"}`,
  });

  console.log(
    "\n" +
      bold(`EXECUTING`) +
      dim(`  operationId=${opId}  (glm-controller runs the migration in-cluster)`),
  );

  const rendered = new Set<string>();
  const finalOp = await awaitOperation(opsDb, opId, {
    pollMs: 2_000,
    timeoutMs: MIGRATION_OP_TIMEOUT_MS,
    onUpdate: (op) => {
      for (const step of op.steps ?? []) {
        const key = `${step.name}:${step.status}`;
        if (rendered.has(key)) continue;
        rendered.add(key);
        const icon =
          step.status === "done"
            ? green(CHECK)
            : step.status === "failed"
              ? red(CROSS)
              : dim("·");
        console.log(
          `  ${icon} ${step.name}${step.error ? dim(` — ${step.error}`) : ""}`,
        );
      }
    },
  });

  if (finalOp.status === "succeeded") {
    console.log(
      "\n" +
        green(`${CHECK} migration complete: ${slug} ${fromGatewayId} ${ARROW} ${toGatewayId}`),
    );
    return;
  }
  console.error(
    "\n" + red(`${CROSS} migration ${finalOp.status}: ${finalOp.error ?? "unknown error"}`),
  );
  console.error(
    dim(
      finalOp.rolledBack
        ? `  Rollback was attempted. Source should still own the customer; verify with \`fleet --env=${args.env} inspect customer ${slug}\`.`
        : `  No rollback attempted (or post-unmount). Operator must intervene.`,
    ),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  initializeFleetCli(process.argv.slice(2));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
