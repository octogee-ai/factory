#!/usr/bin/env tsx

import {
  applicationDefault,
  cert,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type GatewayStatus,
  GATEWAYS_COLLECTION,
} from "../../shared/types/fleet-controller.js";
import {
  GLM_OPERATIONS_COLLECTION,
  isValidGatewayId,
  type GatewayDesiredStatus,
  type GatewayProfile,
} from "../../shared/types/glm.js";
import { projectGatewayDesiredRootForGateway } from "../../shared/types/gateway-releases.js";
import {
  readGatewayAuthorization,
  readGatewayRuntimeHeartbeat,
} from "@octogee/core/gateway-live-release";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import {
  assertNormalFleetMutationSnapshotOpen,
  GLM_MAINTENANCE_DOC_PATH,
  runNormalFleetMutation,
  type NormalFleetMutationDb,
  type NormalFleetMutationInput,
} from "@octogee/core/normal-fleet-mutation";
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
import { readReleaseStatus, type ReleaseStatusSnapshot } from "../lib/release-status.js";
import {
  createAdminFleetClient,
  exchangeAdminFleetCustomToken,
  type AdminFleetClient,
  type AdminFleetRequest,
} from "../lib/admin-fleet-client.js";

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
    verb: "release status",
    summary: "Show Cowboy's one-shot release convergence view.",
    args: "",
    description:
      "Reads Firestore desired roots, selected immutable release payloads, and Cowboy runtime observations once. Reports desired/live/runtime release state and heartbeat status/version; it never waits for convergence or changes fleet state.",
    examples: ["fleet --env=test release status"],
    writes: false,
  },
  {
    verb: "release cut",
    summary: "Cut a CENTRAL TEST gateway release from an exact digest manifest.",
    args: "<version> --sha=<sha> [--gateway-scope=shared|all] [--idempotency-key=<key>] [--apply]",
    description:
      "Requires an explicit full main SHA, then sends one Admin API request. The server reads the exact CENTRAL digest manifest, cuts the selected shared or all-gateway desired releases, journals each mutation, and enqueues Cowboy. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test release cut v0.4.0 --sha=0123456789abcdef0123456789abcdef01234567 --apply",
      "fleet --env=test release cut v0.4.0 --sha=0123456789abcdef0123456789abcdef01234567 --gateway-scope=all --apply",
    ],
    writes: true,
  },
  {
    verb: "release promote",
    summary: "Promote an explicitly selected CENTRAL main manifest to PROD.",
    args: "<version> --sha=<sha> [--idempotency-key=<key>] [--apply]",
    description:
      "Sends one Admin API request. The server requires the same full main SHA selected for TEST, resolves its exact CENTRAL digest manifest, and promotes those bytes through the PROD desired-state release path. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=prod release promote v0.4.0 --sha=0123456789abcdef0123456789abcdef01234567",
      "fleet --env=prod release promote v0.4.0 --sha=0123456789abcdef0123456789abcdef01234567 --apply",
    ],
    writes: true,
  },
  {
    verb: "gw ls",
    summary: "List gateways (alias for ls gateways).",
    args: "",
    description:
      "Alias for `ls gateways`, retaining the established Firestore and Kubernetes diagnostic read.",
    examples: ["fleet --env=prod gw ls"],
    writes: false,
  },
  {
    verb: "gw inspect",
    summary: "Inspect one gateway (alias for inspect gateway).",
    args: "<gw-id>",
    description:
      "Alias for `inspect gateway <gw-id>`, including durable state, heartbeat, and pod diagnostics.",
    examples: ["fleet --env=prod gw inspect shared-a"],
    writes: false,
  },
  {
    verb: "gw add",
    summary: "Add a gateway through the Admin API.",
    args: "--gateway-id=<id> --image-tag=<tag> [--image-repository=<repo>] [--gateway-class=<class>] [--apply]",
    description:
      "Uses POST /api/admin/gateways so maintenance and the operations journal match the Admin UI. imageRepository defaults to the selected environment's canonical /octogee-gateway image. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test gw add --gateway-id=canary --image-tag=abc1234",
      "fleet --env=test gw add --gateway-id=canary --image-tag=abc1234 --apply",
    ],
    writes: true,
  },
  {
    verb: "gw roll",
    summary: "Request a gateway image rollout through the Admin API.",
    args: "<gw-id> --image-tag=<tag> [--image-repository=<repo>] [--apply]",
    description:
      "Uses POST /api/admin/gateways/:id/rollout so maintenance and the operations journal match the Admin UI. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test gw roll canary --image-tag=abc1234",
      "fleet --env=test gw roll canary --image-tag=abc1234 --apply",
    ],
    writes: true,
  },
  {
    verb: "gw park",
    summary: "Pause a gateway through the Admin API.",
    args: "<gw-id> [--apply]",
    description:
      "Uses PATCH /api/admin/gateways/:id with desiredStatus=paused. Dry-run by default; pass --apply to send the request.",
    examples: ["fleet --env=test gw park canary", "fleet --env=test gw park canary --apply"],
    writes: true,
  },
  {
    verb: "gw retire",
    summary: "Retire an empty gateway through the Admin API.",
    args: "<gw-id> [--apply]",
    description:
      "Uses DELETE /api/admin/gateways/:id. The Admin API enforces retirement preconditions, maintenance, and journaling. Dry-run by default; pass --apply to send the request.",
    examples: ["fleet --env=test gw retire canary", "fleet --env=test gw retire canary --apply"],
    writes: true,
  },
  {
    verb: "gw restart",
    summary: "Restart a gateway through the Admin API, or force-delete its exact pod.",
    args: "<gw-id> [--force] [--idempotency-key=<key>] [--apply]",
    description:
      "Normally uses POST /api/admin/gateways/:id/restart so maintenance and the operations journal match the Admin UI. With --force --apply, it journals a break-glass operation, hands the gateway to the operator lane, selects exactly one fresh gateway pod, verifies its UID again, and deletes only that pod without waiting. Dry-run by default.",
    examples: [
      "fleet --env=test gw restart canary",
      "fleet --env=test gw restart canary --apply",
      "fleet --env=test gw restart canary --force --apply",
    ],
    writes: true,
  },
  {
    verb: "gw override",
    summary: "Hand a gateway to the operator management lane.",
    args: "<gw-id> [--apply]",
    description:
      "Uses PATCH /api/admin/gateways/:id with managedBy=operator. Dry-run by default; pass --apply to send the request.",
    examples: ["fleet --env=test gw override canary", "fleet --env=test gw override canary --apply"],
    writes: true,
  },
  {
    verb: "gw release-to-cowboy",
    summary: "Return a gateway to Cowboy management.",
    args: "<gw-id> [--apply]",
    description:
      "Uses PATCH /api/admin/gateways/:id with managedBy=cowboy. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test gw release-to-cowboy canary",
      "fleet --env=test gw release-to-cowboy canary --apply",
    ],
    writes: true,
  },
  {
    verb: "builder evict",
    summary: "Move a Builder to a gateway or park them through the Admin API.",
    args: "<slug> (--to=<gw-id> | --park) [--idempotency-key=<key>] [--apply]",
    description:
      "Resolves the Builder slug to its UID, then asks the Admin API to set operator-owned placement desired state. A cross-gateway move uses the API's migration path; parking removes placement. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test builder evict alice --to=canary",
      "fleet --env=test builder evict alice --park --apply",
    ],
    writes: true,
  },
  {
    verb: "builder place",
    summary: "Return a Builder to Cowboy placement.",
    args: "<slug> [--idempotency-key=<key>] [--apply]",
    description:
      "Resolves the Builder slug to its UID, then asks the Admin API to release the Builder from the operator management lane. Cowboy chooses the next placement; the CLI returns after the desired-state response and never waits for convergence. Dry-run by default; pass --apply to send the request.",
    examples: [
      "fleet --env=test builder place alice",
      "fleet --env=test builder place alice --apply",
    ],
    writes: true,
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

export function fleetServiceAccountCredential(
  value: unknown,
  projectId: string,
): ServiceAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const credential = value as Record<string, unknown>;
  if (
    credential.type !== "service_account" ||
    typeof credential.client_email !== "string" ||
    typeof credential.private_key !== "string"
  ) {
    return null;
  }
  return {
    projectId,
    clientEmail: credential.client_email,
    privateKey: credential.private_key,
  };
}

function applicationDefaultServiceAccountCredential(
  credentialPath: string | undefined,
  projectId: string,
): ServiceAccount | null {
  if (!credentialPath) return null;
  try {
    return fleetServiceAccountCredential(
      JSON.parse(fs.readFileSync(credentialPath, "utf-8")),
      projectId,
    );
  } catch {
    return null;
  }
}

export function resolveFleetDeploymentTarget(environment: "test" | "prod"): {
  projectId: string;
  namespace: string;
  kubeContext: string;
} {
  const target = deploymentEnvironmentSettings(environment);
  if (target.targetId !== `${environment}-central` || target.region !== "us-central1") {
    throw new Error(`fleet only supports the active CENTRAL target for ${environment}`);
  }
  return {
    projectId: target.firebaseProjectId,
    namespace: target.namespace,
    kubeContext: target.kubeContext,
  };
}

export function resolveFleetVerb(args: ParsedFleetArgs): VerbHelp | null {
  const [verb, sub] = args.positional;
  return verbsByName.get(`${verb ?? ""} ${sub ?? ""}`.trim()) ?? verbsByName.get(verb ?? "") ?? null;
}

export function resolveFleetCredentialMode(
  args: ParsedFleetArgs,
  env: { GOOGLE_APPLICATION_CREDENTIALS?: string } = process.env,
): FleetCredentialMode {
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) return "application-default";
  const verb = resolveFleetVerb(args);
  if (verb?.writes !== true || args.flags.apply !== true) return "service-account-key";
  return args.positional[0] === "gw" || args.positional[0] === "builder" || args.positional[0] === "release"
    ? "service-account-key"
    : "application-default";
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

const VALUE_FLAGS = new Set([
  "env",
  "to",
  "gateway",
  "gateway-id",
  "image-repository",
  "image-tag",
  "profile",
  "gateway-class",
  "image-profile",
  "sizing-tier",
  "owner-uid",
  "builder-slug",
  "idempotency-key",
  "sha",
]);

export function parseFleetArgs(argv: readonly string[]): ParsedFleetArgs {
  const out: ParsedFleetArgs = { env: "", positional: [], flags: {} };
  const seenFlags = new Set<string>();
  const setFlag = (name: string, value: string | true) => {
    if (seenFlags.has(name)) throw new Error(`duplicate --${name} flag`);
    seenFlags.add(name);
    if (name === "env") {
      out.env = typeof value === "string" ? value as "test" | "prod" : "";
      return;
    }
    out.flags[name] = value;
  };
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
      setFlag(k, v);
      continue;
    }
    const k = a.slice(2);

if (VALUE_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      const v = argv[++i];
      setFlag(k, v);
      continue;
    }
    setFlag(k, true);
  }
  return out;
}

function stringFlag(args: ParsedFleetArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredFlag(
  args: ParsedFleetArgs,
  name: string,
  command: string,
  valueName: string,
): string {
  const value = stringFlag(args, name);
  if (!value) throw new Error(`${command} requires --${name}=<${valueName}>`);
  return value;
}

function requiredGatewayId(args: ParsedFleetArgs, command: string): string {
  const gatewayId = args.positional[2];
  if (!gatewayId) throw new Error(`${command} requires <gw-id>`);
  if (!isValidGatewayId(gatewayId)) {
    throw new Error(`${command} received an invalid gateway id: ${gatewayId}`);
  }
  return gatewayId;
}

export interface FleetGatewayRestart {
  gatewayId: string;
  force: boolean;
  apply: boolean;
  idempotencyKey?: string;
}

export function resolveFleetGatewayRestart(args: ParsedFleetArgs): FleetGatewayRestart {
  if (
    args.positional.length !== 3 ||
    args.positional[0] !== "gw" ||
    args.positional[1] !== "restart"
  ) {
    throw new Error("gw restart requires exactly <gw-id> and no extra positional arguments");
  }
  const allowedFlags = new Set(["force", "apply", "idempotency-key"]);
  for (const name of Object.keys(args.flags)) {
    if (!allowedFlags.has(name)) {
      throw new Error(`gw restart does not accept --${name}`);
    }
  }
  if (args.flags.force !== undefined && args.flags.force !== true) {
    throw new Error("gw restart --force must be a bare flag");
  }
  if (args.flags.apply !== undefined && args.flags.apply !== true) {
    throw new Error("gw restart --apply must be a bare flag");
  }
  const idempotency = args.flags["idempotency-key"];
  if (
    idempotency !== undefined &&
    (typeof idempotency !== "string" || idempotency.length === 0)
  ) {
    throw new Error("gw restart --idempotency-key requires a non-empty value");
  }
  return {
    gatewayId: requiredGatewayId(args, "gw restart"),
    force: args.flags.force === true,
    apply: args.flags.apply === true,
    ...(typeof idempotency === "string" ? { idempotencyKey: idempotency } : {}),
  };
}

function canonicalGatewayRepository(args: ParsedFleetArgs, command: string): string {
  if (!args.env) throw new Error(`${command} requires --env=test|prod`);
  const canonical =
    `${deploymentEnvironmentSettings(args.env).artifactRegistryRepository}/octogee-gateway`;
  const requested = stringFlag(args, "image-repository");
  if (requested && requested !== canonical) {
    throw new Error(`${command} requires the selected environment repository: ${canonical}`);
  }
  return canonical;
}

export function resolveFleetGatewayMutation(args: ParsedFleetArgs): AdminFleetRequest {
  const action = args.positional[1];
  const idempotencyKey = stringFlag(args, "idempotency-key");
  const withIdempotency = (request: Omit<AdminFleetRequest, "idempotencyKey">): AdminFleetRequest => ({
    ...request,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  switch (action) {
    case "add": {
      const command = "gw add";
      const body: Record<string, unknown> = {
        gatewayId: requiredFlag(args, "gateway-id", command, "id"),
        imageRepository: canonicalGatewayRepository(args, command),
        imageTag: requiredFlag(args, "image-tag", command, "tag"),
      };
      const optionalFields: ReadonlyArray<readonly [string, string]> = [
        ["profile", "profile"],
        ["gateway-class", "gatewayClass"],
        ["image-profile", "imageProfile"],
        ["sizing-tier", "sizingTier"],
        ["owner-uid", "ownerUid"],
        ["builder-slug", "builderSlug"],
      ];
      for (const [flag, field] of optionalFields) {
        const value = stringFlag(args, flag);
        if (value) body[field] = value;
      }
      return withIdempotency({ method: "POST", path: "/api/admin/gateways", body });
    }
    case "roll": {
      const gatewayId = requiredGatewayId(args, "gw roll");
      const imageRepository = stringFlag(args, "image-repository");
      if (imageRepository) canonicalGatewayRepository(args, "gw roll");
      return withIdempotency({
        method: "POST",
        path: `/api/admin/gateways/${gatewayId}/rollout`,
        body: {
          imageTag: requiredFlag(args, "image-tag", "gw roll", "tag"),
          ...(imageRepository ? { imageRepository } : {}),
        },
      });
    }
    case "park": {
      const gatewayId = requiredGatewayId(args, "gw park");
      return withIdempotency({
        method: "PATCH",
        path: `/api/admin/gateways/${gatewayId}`,
        body: { desiredStatus: "paused" },
      });
    }
    case "retire": {
      const gatewayId = requiredGatewayId(args, "gw retire");
      return withIdempotency({ method: "DELETE", path: `/api/admin/gateways/${gatewayId}` });
    }
    case "restart": {
      const restart = resolveFleetGatewayRestart(args);
      if (restart.force) {
        throw new Error("gw restart --force bypasses the Admin API");
      }
      return withIdempotency({
        method: "POST",
        path: `/api/admin/gateways/${restart.gatewayId}/restart`,
      });
    }
    case "override": {
      const gatewayId = requiredGatewayId(args, "gw override");
      return withIdempotency({
        method: "PATCH",
        path: `/api/admin/gateways/${gatewayId}`,
        body: { managedBy: "operator" },
      });
    }
    case "release-to-cowboy": {
      const gatewayId = requiredGatewayId(args, "gw release-to-cowboy");
      return withIdempotency({
        method: "PATCH",
        path: `/api/admin/gateways/${gatewayId}`,
        body: { managedBy: "cowboy" },
      });
    }
    default:
      throw new Error(`Unknown gateway mutation: gw ${action ?? ""}`.trim());
  }
}

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const RELEASE_VERSION_PATTERN = new RegExp(
  `^v${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}` +
    `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?$`,
);
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;

function releaseIdempotencyRequest(
  request: Omit<AdminFleetRequest, "idempotencyKey">,
  args: ParsedFleetArgs,
  defaultIdempotencyKey: string,
): AdminFleetRequest {
  const idempotencyKey = stringFlag(args, "idempotency-key");
  if (args.flags["idempotency-key"] !== undefined && !idempotencyKey) {
    throw new Error("release mutation requires --idempotency-key=<key>");
  }
  return { ...request, idempotencyKey: idempotencyKey ?? defaultIdempotencyKey };
}

function requiredReleaseVersion(args: ParsedFleetArgs, command: string): string {
  const version = args.positional[2];
  if (!version || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`${command} requires a v-prefixed semantic version`);
  }
  if (args.positional.length !== 3) {
    throw new Error(`${command} accepts exactly one <version>`);
  }
  return version;
}

function validateReleaseFlags(args: ParsedFleetArgs, command: string, allowed: readonly string[]): void {
  const accepted = new Set(["apply", "idempotency-key", ...allowed]);
  const unsupported = Object.keys(args.flags).filter((flag) => !accepted.has(flag));
  if (unsupported.length > 0) {
    throw new Error(`${command} does not accept --${unsupported.join(", --")}`);
  }
  if (args.flags.apply !== undefined && args.flags.apply !== true) {
    throw new Error(`${command} accepts --apply without a value`);
  }
}

export function resolveFleetReleaseMutation(
  args: ParsedFleetArgs,
): AdminFleetRequest {
  const action = args.positional[1];
  if (action === "cut") {
    if (args.env !== "test") throw new Error("release cut requires --env=test");
    validateReleaseFlags(args, "release cut", ["sha", "gateway-scope"]);
    const version = requiredReleaseVersion(args, "release cut");
    const sourceSha = stringFlag(args, "sha");
    if (!sourceSha || !SOURCE_SHA_PATTERN.test(sourceSha)) {
      throw new Error("release cut requires a full lowercase --sha");
    }
    const gatewayScope = stringFlag(args, "gateway-scope");
    if (gatewayScope !== undefined && gatewayScope !== "shared" && gatewayScope !== "all") {
      throw new Error("release cut --gateway-scope must be shared or all");
    }
    return releaseIdempotencyRequest({
      method: "POST",
      path: "/api/admin/releases/cut",
      body: { version, sourceSha, ...(gatewayScope === "all" ? { gatewayScope } : {}) },
    }, args, `release-cut:${version}:${sourceSha}:${gatewayScope ?? "shared"}`);
  }
  if (action === "promote") {
    if (args.env !== "prod") throw new Error("release promote requires --env=prod");
    validateReleaseFlags(args, "release promote", ["sha"]);
    const version = requiredReleaseVersion(args, "release promote");
    const sourceSha = stringFlag(args, "sha");
    if (!sourceSha || !SOURCE_SHA_PATTERN.test(sourceSha)) {
      throw new Error("release promote requires a full lowercase --sha");
    }
    return releaseIdempotencyRequest({
      method: "POST",
      path: `/api/admin/releases/${encodeURIComponent(version)}/promote`,
      body: { sourceSha },
    }, args, `release-promote:${version}:${sourceSha}`);
  }
  throw new Error(`Unknown release mutation: release ${action ?? ""}`.trim());
}

export type FleetBuilderMutation =
  | {
      kind: "evict";
      slug: string;
      target: { kind: "gateway"; gatewayId: string } | { kind: "park" };
    }
  | { kind: "place"; slug: string };

function requiredBuilderSlug(args: ParsedFleetArgs, command: string): string {
  const slug = args.positional[2];
  if (!slug) throw new Error(`${command} requires <slug>`);
  if (args.positional.length !== 3) {
    throw new Error(`${command} accepts exactly one <slug>`);
  }
  return slug;
}

function validateBuilderFlags(
  args: ParsedFleetArgs,
  command: string,
  actionFlags: readonly string[],
): void {
  const allowed = new Set(["apply", "idempotency-key", ...actionFlags]);
  const unsupported = Object.keys(args.flags).filter((flag) => !allowed.has(flag));
  if (unsupported.length > 0) {
    throw new Error(`${command} does not accept --${unsupported.join(", --")}`);
  }
  if (args.flags.apply !== undefined && args.flags.apply !== true) {
    throw new Error(`${command} accepts --apply without a value`);
  }
  if (
    args.flags["idempotency-key"] !== undefined &&
    stringFlag(args, "idempotency-key") === undefined
  ) {
    throw new Error(`${command} requires --idempotency-key=<key>`);
  }
}

function hasBuilderParkFlag(args: ParsedFleetArgs): boolean {
  const park = args.flags.park;
  if (park !== undefined && park !== true) {
    throw new Error("builder evict accepts --park without a value");
  }
  return park === true;
}

function builderTargetGatewayId(args: ParsedFleetArgs): string | undefined {
  const to = stringFlag(args, "to");
  if (args.flags.to !== undefined && !to) {
    throw new Error("builder evict requires --to=<gw-id>");
  }
  if (to && !isValidGatewayId(to)) {
    throw new Error(`builder evict received an invalid gateway id: ${to}`);
  }
  return to;
}

export function resolveFleetBuilderMutation(args: ParsedFleetArgs): FleetBuilderMutation {
  const action = args.positional[1];
  switch (action) {
    case "evict": {
      const slug = requiredBuilderSlug(args, "builder evict");
      validateBuilderFlags(args, "builder evict", ["to", "park"]);
      const to = builderTargetGatewayId(args);
      const park = hasBuilderParkFlag(args);
      if (to && park) {
        throw new Error("builder evict accepts exactly one of --to=<gw-id> or --park");
      }
      if (!to && !park) {
        throw new Error("builder evict requires exactly one of --to=<gw-id> or --park");
      }
      return {
        kind: "evict",
        slug,
        target: to ? { kind: "gateway", gatewayId: to } : { kind: "park" },
      };
    }
    case "place": {
      const slug = requiredBuilderSlug(args, "builder place");
      if (args.flags.to !== undefined || args.flags.park !== undefined) {
        throw new Error("builder place does not accept --to or --park");
      }
      validateBuilderFlags(args, "builder place", []);
      return { kind: "place", slug };
    }
    default:
      throw new Error(`Unknown Builder mutation: builder ${action ?? ""}`.trim());
  }
}

export function resolveFleetBuilderMutationRequest(
  mutation: FleetBuilderMutation,
  uid: string,
  idempotencyKey?: string,
): AdminFleetRequest {
  const request: AdminFleetRequest = {
    method: "PATCH",
    path: `/api/admin/customers/${encodeURIComponent(uid)}/placement`,
    body: mutation.kind === "place"
      ? { managedBy: "cowboy" }
      : mutation.target.kind === "park"
        ? { managedBy: "operator", gatewayId: null }
        : { managedBy: "operator", gatewayId: mutation.target.gatewayId },
  };
  return idempotencyKey ? { ...request, idempotencyKey } : request;
}

export async function executeFleetAdminMutation(
  client: Pick<AdminFleetClient, "request">,
  request: AdminFleetRequest,
  apply: boolean,
): Promise<{ applied: boolean; response: unknown }> {
  if (!apply) return { applied: false, response: null };
  return { applied: true, response: await client.request(request) };
}

export async function executeFleetGatewayMutation(
  client: Pick<AdminFleetClient, "request">,
  request: AdminFleetRequest,
  apply: boolean,
): Promise<{ applied: boolean; response: unknown }> {
  return executeFleetAdminMutation(client, request, apply);
}

export async function executeFleetReleaseMutation(
  client: Pick<AdminFleetClient, "request">,
  request: AdminFleetRequest,
  apply: boolean,
): Promise<{ applied: boolean; response: unknown }> {
  return executeFleetGatewayMutation(client, request, apply);
}

export interface ForceRestartPod {
  name: string;
  uid: string;
}

interface ForceRestartPodDocument {
  metadata?: {
    name?: unknown;
    uid?: unknown;
    deletionTimestamp?: unknown;
  };
}

interface ForceRestartPodList {
  items?: ForceRestartPodDocument[];
}

export interface FleetKubectlResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type FleetKubectlRunner = (args: string[], input?: string) => FleetKubectlResult;

export type ForcedGatewayRestartMutationRunner = <T>(
  input: NormalFleetMutationInput<T>,
) => Promise<T>;

export interface ForcedGatewayRestartInput {
  db: Firestore;
  kubeContext: string;
  namespace: string;
  gatewayId: string;
  idempotencyKey?: string;
  now?: () => number;
  runKubectl?: FleetKubectlRunner;
  runMutation?: ForcedGatewayRestartMutationRunner;
}

function forceRestartKubectlFailure(
  action: string,
  result: FleetKubectlResult,
): Error {
  const detail = result.error?.message || result.stderr.trim() || result.stdout.trim();
  return new Error(`kubectl ${action} failed${detail ? `: ${detail}` : ""}`);
}

function parseForceRestartJson(raw: string): ForceRestartPodList {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as ForceRestartPodList;
  } catch {
    throw new Error("kubectl returned invalid pod JSON");
  }
}

export function parseForceRestartPodList(raw: string, gatewayId: string): ForceRestartPod {
  const parsed = parseForceRestartJson(raw);
  if (!Array.isArray(parsed.items) || parsed.items.length !== 1) {
    const count = Array.isArray(parsed.items) ? parsed.items.length : 0;
    throw new Error(`force restart expected exactly one pod for ${gatewayId}, found ${count}`);
  }
  const metadata = parsed.items[0]?.metadata;
  if (typeof metadata?.name !== "string" || metadata.name.length === 0) {
    throw new Error(`force restart pod for ${gatewayId} is missing metadata.name`);
  }
  if (typeof metadata.uid !== "string" || metadata.uid.length === 0) {
    throw new Error(`force restart pod for ${gatewayId} is missing metadata.uid`);
  }
  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    throw new Error(`force restart pod ${metadata.name} is already terminating`);
  }
  const expectedPrefix = `octogee-gateway-${gatewayId}-`;
  if (!metadata.name.startsWith(expectedPrefix)) {
    throw new Error(`force restart pod ${metadata.name} does not belong to ${gatewayId}`);
  }
  return { name: metadata.name, uid: metadata.uid };
}

function assertForceRestartPodUnchanged(
  raw: string,
  expected: ForceRestartPod,
): void {
  const metadata = (parseForceRestartJson(raw) as ForceRestartPodDocument).metadata;
  if (metadata?.name !== expected.name) {
    throw new Error(`force restart pod name changed from ${expected.name}`);
  }
  if (metadata.uid !== expected.uid) {
    throw new Error(`force restart pod UID changed for ${expected.name}`);
  }
  if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
    throw new Error(`force restart pod ${expected.name} is already terminating`);
  }
}

function localFleetKubectl(args: string[], input?: string): FleetKubectlResult {
  const result = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    "kubectl",
    args,
    {
      encoding: "utf-8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function runForceRestartKubectl(
  runKubectl: FleetKubectlRunner,
  action: string,
  args: string[],
  input?: string,
): string {
  const result = runKubectl(args, input);
  if (result.error || result.status !== 0) throw forceRestartKubectlFailure(action, result);
  return result.stdout;
}

async function markForcedGatewayRestartOperatorManaged(
  db: Firestore,
  gatewayId: string,
  now: number,
): Promise<void> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  await db.runTransaction(async (transaction) => {
    const [maintenance, gateway] = await Promise.all([
      transaction.get(db.doc(GLM_MAINTENANCE_DOC_PATH)),
      transaction.get(gatewayRef),
    ]);
    assertNormalFleetMutationSnapshotOpen(maintenance as never);
    const durableGateway = projectGatewayDesiredRootForGateway(
      gateway.exists ? gateway.data() : undefined,
      gatewayId,
    );
    if (!durableGateway) {
      throw new Error(`gateway ${gatewayId} has no valid durable root configuration`);
    }
    if (durableGateway.desiredStatus === "retired") {
      throw new Error(`cannot force restart a retired gateway: ${gatewayId}`);
    }
    transaction.update(gatewayRef, {
      managedBy: "operator",
      updatedAt: now,
      updatedBy: "operator",
    });
  });
}

async function recordForcedGatewayRestartPod(
  db: Firestore,
  claim: { auditId: string; claimId: string },
  gatewayId: string,
  pod: ForceRestartPod,
): Promise<void> {
  const auditRef = db.collection(GLM_OPERATIONS_COLLECTION).doc(claim.auditId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(auditRef);
    const data = snapshot.data() as Record<string, unknown> | undefined;
    if (
      !snapshot.exists ||
      data?.status !== "in-progress" ||
      data.actionClaimId !== claim.claimId ||
      data.target === null ||
      typeof data.target !== "object" ||
      Array.isArray(data.target)
    ) {
      throw new Error(`force restart audit ${claim.auditId} is not owned by this action`);
    }
    transaction.update(auditRef, {
      target: {
        ...(data.target as Record<string, unknown>),
        gatewayId,
        podName: pod.name,
        podUid: pod.uid,
      },
    });
  });
}

async function assertForcedGatewayRestartDeleteFence(
  db: Firestore,
  claim: { auditId: string; claimId: string },
  gatewayId: string,
  pod: ForceRestartPod,
): Promise<void> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  const auditRef = db.collection(GLM_OPERATIONS_COLLECTION).doc(claim.auditId);
  await db.runTransaction(async (transaction) => {
    const [maintenance, gateway, audit] = await Promise.all([
      transaction.get(db.doc(GLM_MAINTENANCE_DOC_PATH)),
      transaction.get(gatewayRef),
      transaction.get(auditRef),
    ]);
    assertNormalFleetMutationSnapshotOpen(maintenance as never);
    const durableGateway = projectGatewayDesiredRootForGateway(
      gateway.exists ? gateway.data() : undefined,
      gatewayId,
    );
    if (!durableGateway) {
      throw new Error(`gateway ${gatewayId} has no valid durable root configuration`);
    }
    if (durableGateway.desiredStatus === "retired") {
      throw new Error(`cannot force restart a retired gateway: ${gatewayId}`);
    }
    if (durableGateway.managedBy !== "operator") {
      throw new Error(`gateway ${gatewayId} is no longer operator-managed`);
    }
    const data = audit.data() as Record<string, unknown> | undefined;
    const target = data?.target;
    const targetRecord = target !== null && typeof target === "object" && !Array.isArray(target)
      ? target as Record<string, unknown>
      : null;
    const targetKeys = targetRecord ? Object.keys(targetRecord).sort() : [];
    if (
      !audit.exists ||
      data?.status !== "in-progress" ||
      data.actionClaimId !== claim.claimId ||
      targetRecord === null ||
      targetKeys.join(",") !== "gatewayId,podName,podUid" ||
      targetRecord.gatewayId !== gatewayId ||
      targetRecord.podName !== pod.name ||
      targetRecord.podUid !== pod.uid
    ) {
      throw new Error(`force restart audit ${claim.auditId} is not owned by this action`);
    }
  });
}

function forceRestartKubectlArgs(input: {
  kubeContext: string;
  namespace: string;
  gatewayId: string;
}): string[] {
  return [
    "--context", input.kubeContext,
    "-n", input.namespace,
  ];
}

export async function runForcedGatewayRestart(
  input: ForcedGatewayRestartInput,
): Promise<{ auditId: string; podName: string; podUid: string }> {
  const now = input.now ?? Date.now;
  const runKubectl = input.runKubectl ?? localFleetKubectl;
  const runMutation: ForcedGatewayRestartMutationRunner = input.runMutation ??
    ((mutation) => runNormalFleetMutation(
      input.db as unknown as NormalFleetMutationDb,
      mutation,
    ));
  return runMutation({
    actor: "operator",
    forced: true,
    what: "force restart gateway pod",
    why: "operator requested break-glass pod restart",
    target: { gatewayId: input.gatewayId },
    preActionStatus: {},
    mutation: {
      kind: "restart-gateway",
      gatewayId: input.gatewayId,
      mode: "force-pod-delete",
    },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    action: async (claim) => {
      await markForcedGatewayRestartOperatorManaged(input.db, input.gatewayId, now());
      const base = forceRestartKubectlArgs(input);
      const pod = parseForceRestartPodList(
        runForceRestartKubectl(runKubectl, "list pods", [
          ...base,
          "get", "pods",
          "-l", `app=octogee-gateway,gateway-instance=${input.gatewayId}`,
          "-o", "json",
        ]),
        input.gatewayId,
      );
      await recordForcedGatewayRestartPod(input.db, claim, input.gatewayId, pod);
      assertForceRestartPodUnchanged(
        runForceRestartKubectl(runKubectl, "get pod", [
          ...base,
          "get", "pod", pod.name,
          "-o", "json",
        ]),
        pod,
      );
      await assertForcedGatewayRestartDeleteFence(
        input.db,
        claim,
        input.gatewayId,
        pod,
      );
      runForceRestartKubectl(
        runKubectl,
        "delete pod",
        [
          ...base,
          "delete",
          `--raw=/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${
            encodeURIComponent(pod.name)
          }`,
          "-f", "-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: pod.uid },
        }),
      );
      return { auditId: claim.auditId, podName: pod.name, podUid: pod.uid };
    },
  });
}

let args: ParsedFleetArgs = parseFleetArgs([]);
let db: ReturnType<typeof getFirestore>;
let resolvedOperatorUid: Promise<string> | null = null;

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

  if (args.positional[0] === "gw" && args.positional[1] === "restart") {
    resolveFleetGatewayRestart(args);
  }

  const credentialMode = resolveFleetCredentialMode(args);
  const target = resolveFleetDeploymentTarget(args.env);
  const projectId = target.projectId;
  const envSuffix = args.env === "prod" ? "" : `-${args.env}`;
  const saPath = path.join(
    process.env.HOME ?? "",
    `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
  );
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || saPath;
  if (credentialMode === "service-account-key" && !fs.existsSync(credentialPath)) {
    console.error(red(`${CROSS} SA key not found at ${saPath}`));
    console.error(dim(`  Set GOOGLE_APPLICATION_CREDENTIALS or provide the local key used to authenticate against the ${args.env.toUpperCase()} Firestore database.`));
    process.exit(1);
  }
  const applicationDefaultServiceAccount = credentialMode === "application-default"
    ? applicationDefaultServiceAccountCredential(
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      projectId,
    )
    : null;
  initializeApp({
    credential: applicationDefaultServiceAccount
      ? cert(applicationDefaultServiceAccount)
      : credentialMode === "application-default"
        ? applicationDefault()
        : cert(JSON.parse(fs.readFileSync(credentialPath, "utf-8"))),
    projectId,
  });
  if (credentialMode === "application-default") {
    console.error(dim(
      applicationDefaultServiceAccount
        ? `  fleet writes use the service-account key supplied through GOOGLE_APPLICATION_CREDENTIALS for ${projectId}.`
        : `  fleet writes use Application Default Credentials for ${projectId}.`,
    ));
  }
  db = getFirestore();
  KUBE_CONTEXT = target.kubeContext;
  KUBE_NS = target.namespace;
}

function fleetAdminEnvironment(name: "OPERATOR_UID" | "FIREBASE_WEB_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for fleet Admin API mutations`);
  return value;
}

export function resolveFleetOperatorUidFromUserConfigs(
  configs: readonly { uid: string; role: unknown; disabled: boolean }[],
): string {
  const operatorUids = configs
    .filter((config) => config.role === "admin" && !config.disabled)
    .map((config) => config.uid);
  if (operatorUids.length !== 1) {
    throw new Error(
      `OPERATOR_UID or OPERATOR_EMAIL is required when Firebase Auth does not identify exactly one enabled Firestore admin (found ${operatorUids.length})`,
    );
  }
  return operatorUids[0]!;
}

export function resolveExplicitFleetOperatorUid(input: {
  uid: string;
  role: unknown;
  disabled: boolean;
}): string {
  if (input.disabled) throw new Error("configured Fleet admin is disabled");
  if (input.role !== "admin") throw new Error("configured Fleet admin does not have the admin role");
  return input.uid;
}

async function fleetOperatorUid(): Promise<string> {
  const explicit = process.env.OPERATOR_UID;
  if (explicit) return explicit;
  const explicitEmail = process.env.OPERATOR_EMAIL;
  if (explicitEmail) {
    const authUser = await getAuth().getUserByEmail(explicitEmail);
    const config = await db.doc(`users/${authUser.uid}/system/config`).get();
    return resolveExplicitFleetOperatorUid({
      uid: authUser.uid,
      role: config.get("role"),
      disabled: authUser.disabled,
    });
  }
  if (!resolvedOperatorUid) {
    resolvedOperatorUid = (async () => {
      const users = await db.collection("users").get();
      const configs = await Promise.all(
        users.docs.map((user) => user.ref.collection("system").doc("config").get()),
      );
      const authUsers = await Promise.all(users.docs.map((user) => getAuth().getUser(user.id)));
      return resolveFleetOperatorUidFromUserConfigs(configs.map((config, index) => ({
        uid: users.docs[index]!.id,
        role: config.get("role"),
        disabled: authUsers[index]!.disabled,
      })));
    })();
  }
  return resolvedOperatorUid;
}

function fleetAdminClient(): AdminFleetClient {
  if (!args.env) throw new Error("fleet environment must be selected before creating an Admin API client");
  const webApiKey = fleetAdminEnvironment("FIREBASE_WEB_API_KEY");
  return createAdminFleetClient({
    apiOrigin: deploymentEnvironmentSettings(args.env).apiOrigin,
    getIdToken: async () => exchangeAdminFleetCustomToken({
      operatorUid: await fleetOperatorUid(),
      webApiKey,
      createCustomToken: (uid) => getAuth().createCustomToken(uid),
    }),
  });
}

let KUBE_CONTEXT = resolveFleetDeploymentTarget("test").kubeContext;
let KUBE_NS = resolveFleetDeploymentTarget("test").namespace;

type FirestoreTs = { toMillis(): number };

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "builder" ? "builder" : "standard";
}

export interface GatewayHeartbeatView {
  status?: string;
  version?: string;
  openclawVersion?: string;
  internalUrl?: string;
  mountedCustomers?: string[];
  lastHeartbeatAt?: FirestoreTs;
  lastError?: { message?: string; slug?: string; at?: unknown } | null;
}

function heartbeatView(heartbeat: Record<string, unknown> | undefined): GatewayHeartbeatView {
  return heartbeat ? (heartbeat as GatewayHeartbeatView) : {};
}

export interface FleetGatewayRuntime {
  gatewayId: string;
  desiredStatus: GatewayDesiredStatus;
  profile: GatewayProfile;
  heartbeat: GatewayHeartbeatView;
}

export interface FleetGatewayRuntimeEntry {
  gatewayId: string;
  runtime: FleetGatewayRuntime | null;
}

export async function readFleetGatewayRuntime(
  reader: Pick<Firestore, "doc">,
  gatewayId: string,
): Promise<FleetGatewayRuntime | null> {
  const authorization = await readGatewayAuthorization(reader, gatewayId);
  if (!authorization) return null;
  const heartbeat = await readGatewayRuntimeHeartbeat(reader, authorization.gateway);
  return {
    gatewayId,
    desiredStatus: authorization.gateway.desiredStatus,
    profile: normalizeGatewayProfile(authorization.config.profile),
    heartbeat: heartbeatView(heartbeat ?? undefined),
  };
}

export async function listFleetGatewayRuntimes(
  reader: Pick<Firestore, "collection" | "doc">,
): Promise<FleetGatewayRuntimeEntry[]> {
  const roots = await reader.collection(GATEWAYS_COLLECTION).get();
  return Promise.all(roots.docs.map(async (root) => ({
    gatewayId: root.id,
    runtime: await readFleetGatewayRuntime(reader, root.id),
  })));
}

interface UserDoc {
  username?: string;
  email?: string;
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
  const gateways = await listFleetGatewayRuntimes(db);
  const pods = allGatewayPods();
  const podSummary = pods.length === 0
    ? "?"
    : pods.length === 1
      ? `${pods[0].ready} ${pods[0].phase} (${ageHuman(pods[0].ageS)})`
      : `${pods.length} pods (${pods.filter((p) => p.phase === "Running").length} running)`;
  const rows = gateways.map(({ gatewayId, runtime }) => {
    const hb = runtime?.heartbeat ?? {};
    return {
      gatewayId,
      status: runtime ? hb.status ?? "?" : "invalid-root",
      version: (hb.version ?? "-").slice(0, 12),
      mounted: (hb.mountedCustomers ?? []).length,
      heartbeat: ts(hb.lastHeartbeatAt),
      pods: podSummary,
    };
  });
  console.log(table(rows));
}

async function lsCustomers(): Promise<void> {
  const filter = typeof args.flags.gateway === "string" ? args.flags.gateway : null;
  const gateways = await listFleetGatewayRuntimes(db);
  const gwMounted: Record<string, Set<string>> = {};
  for (const { gatewayId, runtime } of gateways) {
    if (runtime) {
      gwMounted[gatewayId] = new Set(runtime.heartbeat.mountedCustomers ?? []);
    }
  }

  let q: FirebaseFirestore.Query = db.collection("users");
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

  const runtime = await readFleetGatewayRuntime(db, oc.gatewayId);
  if (!runtime) {
    console.log("\n" + red(`${CROSS} gateways/${oc.gatewayId} has no valid durable root configuration.`));
    return;
  }
  const gw = runtime.heartbeat;
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
  const runtime = await readFleetGatewayRuntime(db, gatewayId);
  if (!runtime) {
    console.error(red(`${CROSS} Gateway '${gatewayId}' has no valid durable root configuration.`));
    process.exit(1);
  }
  const gw = runtime.heartbeat;
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

async function runFleetGatewayMutation(apply: boolean): Promise<void> {
  const request = resolveFleetGatewayMutation(args);
  console.log(bold(`GW ${args.positional[1]?.toUpperCase() ?? ""}`));
  console.log(dim(`  ${request.method} ${request.path}`));
  if (!apply) {
    console.log(dim("--- DRY RUN (re-run with --apply to send the Admin API request) ---"));
    return;
  }
  const result = await executeFleetGatewayMutation(fleetAdminClient(), request, true);
  console.log(green(`${CHECK} Admin API request accepted`));
  console.log(JSON.stringify(result.response, null, 2));
}

async function runFleetBuilderMutation(apply: boolean): Promise<void> {
  const mutation = resolveFleetBuilderMutation(args);
  const user = await findUserBySlug(mutation.slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug or username '${mutation.slug}'.`));
    process.exit(1);
  }
  const request = resolveFleetBuilderMutationRequest(
    mutation,
    user.uid,
    stringFlag(args, "idempotency-key"),
  );
  console.log(bold(`BUILDER ${mutation.kind.toUpperCase()} ${mutation.slug}`));
  console.log(dim(`  uid: ${user.uid}`));
  console.log(dim(`  ${request.method} ${request.path}`));
  if (!apply) {
    console.log(dim("--- DRY RUN (re-run with --apply to send the Admin API request) ---"));
    return;
  }
  const result = await executeFleetAdminMutation(fleetAdminClient(), request, true);
  console.log(green(`${CHECK} Admin API desired state accepted`));
  console.log(JSON.stringify(result.response, null, 2));
}

async function runFleetReleaseMutation(apply: boolean): Promise<void> {
  const request = resolveFleetReleaseMutation(args);
  console.log(bold(`RELEASE ${args.positional[1]?.toUpperCase() ?? ""} ${args.positional[2] ?? ""}`));
  console.log(dim(`  environment: ${args.env}`));
  console.log(dim(`  version: ${args.positional[2] ?? ""}`));
  console.log(dim(`  source SHA: ${stringFlag(args, "sha") ?? ""}`));
  console.log(dim(`  ${request.method} ${request.path}`));
  if (!apply) {
    console.log(dim("--- DRY RUN (re-run with --apply to send the Admin API request) ---"));
    return;
  }
  const result = await executeFleetReleaseMutation(fleetAdminClient(), request, true);
  console.log(green(`${CHECK} Admin API release request accepted`));
  console.log(JSON.stringify(result.response, null, 2));
}

async function runFleetGatewayRestart(): Promise<void> {
  const restart = resolveFleetGatewayRestart(args);
  if (!restart.force) return runFleetGatewayMutation(restart.apply);
  console.log(bold(`GW FORCE RESTART ${restart.gatewayId.toUpperCase()}`));
  console.log(dim(`  delete exactly one pod selected by gateway-instance=${restart.gatewayId}`));
  if (!restart.apply) {
    console.log(dim("--- DRY RUN (re-run with --force --apply to journal and delete the exact pod) ---"));
    return;
  }
  const result = await runForcedGatewayRestart({
    db,
    kubeContext: KUBE_CONTEXT,
    namespace: KUBE_NS,
    gatewayId: restart.gatewayId,
    ...(restart.idempotencyKey
      ? { idempotencyKey: restart.idempotencyKey }
      : {}),
  });
  console.log(green(`${CHECK} Force restart requested`));
  console.log(JSON.stringify(result, null, 2));
}

export function releaseStatusRows(status: ReleaseStatusSnapshot): Array<Record<string, string | number>> {
  return status.gateways.map((gateway) => ({
    gatewayId: gateway.gatewayId,
    default: gateway.isDefault ? "*" : "",
    desired: gateway.desiredRelease ?? "-",
    live: gateway.liveRelease ?? "-",
    runtime: gateway.runtimeRelease ?? "-",
    lifecycle: gateway.runtimeLifecycle ?? "-",
    heartbeat: gateway.heartbeatStatus ?? "-",
    heartbeatAt: gateway.lastHeartbeatAt === null
      ? "-"
      : new Date(gateway.lastHeartbeatAt).toISOString(),
    tag: gateway.desiredImageTag ?? "-",
    version: gateway.heartbeatVersion ?? "-",
    status: gateway.observation,
  }));
}

async function releaseStatus(): Promise<void> {
  const status = await readReleaseStatus(db);
  const defaultLabel = status.defaultGatewayId || (
    status.defaultSelection === "invalid" ? "(invalid)" : "(unconfigured)"
  );
  console.log(
    bold("RELEASE STATUS") + dim(
      `  default=${defaultLabel} (${status.defaultSelection})`,
    ),
  );
  console.log(table(releaseStatusRows(status)));
}

async function addCustomer(slug: string, gatewayId: string, apply: boolean): Promise<void> {
  const user = await findUserBySlug(slug);
  if (!user) {
    console.error(red(`${CROSS} No user found with slug or username '${slug}'.`));
    process.exit(1);
  }
  const runtime = await readFleetGatewayRuntime(db, gatewayId);
  if (!runtime) {
    console.error(red(`${CROSS} Gateway '${gatewayId}' has no valid durable root configuration.`));
    process.exit(1);
  }
  const gw = runtime.heartbeat;
  const gatewayProfile = runtime.profile;
  if (runtime.desiredStatus !== "running") {
    console.error(red(`${CROSS} Gateway '${gatewayId}' is ${runtime.desiredStatus}, not running.`));
    console.error(dim(`  Refusing to assign — the customer would not be mounted.`));
    process.exit(1);
  }
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
          "provisioning.openclaw.controlUiEnabled": false,
        });
        console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayProfile = ${gatewayProfile}`));
        console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.controlUiEnabled = false`));
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
    "provisioning.openclaw.controlUiEnabled": false,
  });
  console.log("\n" + green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayId = ${gatewayId}`));
  console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.gatewayProfile = ${gatewayProfile}`));
  console.log(green(`${CHECK} users/${user.uid}.provisioning.openclaw.controlUiEnabled = false`));
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
  const targetRuntime = await readFleetGatewayRuntime(db, toGatewayId);
  if (!targetRuntime) {
    console.error(red(`${CROSS} Target gateway '${toGatewayId}' has no valid durable root configuration.`));
    process.exit(1);
  }
  const target = targetRuntime.heartbeat;
  if (targetRuntime.desiredStatus !== "running" || target.status !== "ready") {
    const status = targetRuntime.desiredStatus === "running"
      ? target.status ?? "unknown"
      : targetRuntime.desiredStatus;
    console.error(red(`${CROSS} Target gateway '${toGatewayId}' is in status '${status}'.`));
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

export function buildFleetMigrateOperationInput(
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
): { uid: string; fromGatewayId: string; toGatewayId: string } {
  return { uid, fromGatewayId, toGatewayId };
}

async function executeMigration(
  slug: string,
  uid: string,
  fromGatewayId: string,
  toGatewayId: string,
): Promise<void> {
  const opsDb = db as unknown as OperationsDb;
  const opId = await enqueueOperation(opsDb, {
    kind: "migrate-customer",
    input: buildFleetMigrateOperationInput(uid, fromGatewayId, toGatewayId),
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
    case "gw ls":
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
    case "gw inspect":
      if (!args.positional[2]) {
        return missingArg("gw inspect");
      }
      return inspectGateway(args.positional[2]);
    case "release status":
      return releaseStatus();
    case "gw restart":
      return runFleetGatewayRestart();
  }

  switch (verb) {
    case "release":
      return runFleetReleaseMutation(apply);
    case "gw":
      return runFleetGatewayMutation(apply);
    case "builder":
      return runFleetBuilderMutation(apply);
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
