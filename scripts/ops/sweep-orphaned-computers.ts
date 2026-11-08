import "../lib/octogee-entitlements.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { type PlatformStateStore } from "@octogee/core/platform-state";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";

import { BUILDER_COMPUTER_INSTANCE_PREFIX } from "../../shared/types/glm.js";

const FIRESTORE_PROJECT_BY_ENV = { test: "octogee-test", prod: "octogee" } as const;
const COMPUTE_PROJECT = "octogee";

export interface SweepOrphanedComputersArgs {
  environment: "test" | "prod";
  apply: boolean;
  firestoreProjectId: string;
  computeProjectId: string;
}

export function parseSweepOrphanedComputersArgs(argv: string[]): SweepOrphanedComputersArgs {
  const envArg = argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length);
  if (envArg !== "test" && envArg !== "prod") throw new Error("sweep-orphaned-computers needs --env=test|prod");
  const unknown = argv.filter((arg) => !arg.startsWith("--env=") && arg !== "--apply");
  if (unknown.length > 0) throw new Error(`sweep-orphaned-computers: unexpected arguments ${unknown.join(" ")}`);
  return { environment: envArg, apply: argv.includes("--apply"), firestoreProjectId: FIRESTORE_PROJECT_BY_ENV[envArg], computeProjectId: COMPUTE_PROJECT };
}

export interface TerminatedComputer {
  name: string;
  zone: string;
  instanceId: string;
  ownerUid: string | null;
  lastStopTimestamp: string | null;
}

export interface ComputerReferences {
  parkedInstanceIds: ReadonlySet<string>;
  gatewayInstanceIds: ReadonlySet<string>;
  existingOwnerUids: ReadonlySet<string>;
}

export type ComputerVerdict =
  | { action: "keep"; reason: "parked" | "gateway" | "owner-active" }
  | { action: "delete"; reason: "owner-gone" | "no-owner" };

export function classifyTerminatedComputer(computer: TerminatedComputer, refs: ComputerReferences): ComputerVerdict {
  if (refs.parkedInstanceIds.has(computer.instanceId)) return { action: "keep", reason: "parked" };
  if (refs.gatewayInstanceIds.has(computer.instanceId)) return { action: "keep", reason: "gateway" };
  if (!computer.ownerUid) return { action: "delete", reason: "no-owner" };
  if (refs.existingOwnerUids.has(computer.ownerUid)) return { action: "keep", reason: "owner-active" };
  return { action: "delete", reason: "owner-gone" };
}

interface GcloudInstance {
  name?: unknown;
  id?: unknown;
  zone?: unknown;
  status?: unknown;
  lastStopTimestamp?: unknown;
  metadata?: { items?: Array<{ key?: unknown; value?: unknown }> };
}

export function terminatedComputerFromGcloud(raw: GcloudInstance): TerminatedComputer {
  if (typeof raw.name !== "string" || typeof raw.id !== "string" || typeof raw.zone !== "string") {
    throw new Error(`Compute returned an instance without name/id/zone: ${JSON.stringify(raw)}`);
  }
  const owner = raw.metadata?.items?.find((item) => item.key === "octogee-owner-uid")?.value;
  return {
    name: raw.name,
    zone: raw.zone.slice(raw.zone.lastIndexOf("/") + 1),
    instanceId: raw.id,
    ownerUid: typeof owner === "string" && owner.length > 0 ? owner : null,
    lastStopTimestamp: typeof raw.lastStopTimestamp === "string" ? raw.lastStopTimestamp : null,
  };
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return result.stdout;
}

function listTerminatedComputers(args: SweepOrphanedComputersArgs): TerminatedComputer[] {
  const raw = JSON.parse(run("gcloud", [
    "compute", "instances", "list",
    `--project=${args.computeProjectId}`,
    `--filter=name~^${BUILDER_COMPUTER_INSTANCE_PREFIX}${args.environment}- AND status=TERMINATED`,
    "--format=json",
  ])) as GcloudInstance[];
  return raw.map(terminatedComputerFromGcloud);
}

export async function readComputerReferences(store: PlatformStateStore, computers: readonly TerminatedComputer[]): Promise<ComputerReferences> {
  const parkedInstanceIds = new Set<string>();
  const gatewayInstanceIds = new Set<string>();
  const existingOwnerUids = new Set<string>();
  for (const computer of computers) {
    if (await store.builders.records.findByComputerInstanceId(computer.instanceId) !== null) parkedInstanceIds.add(computer.instanceId);
    if (await store.fleetRegistry.findByVmInstanceId(computer.instanceId) !== null) gatewayInstanceIds.add(computer.instanceId);
    if (computer.ownerUid && await store.builders.records.get(computer.ownerUid) !== null) existingOwnerUids.add(computer.ownerUid);
  }
  return { parkedInstanceIds, gatewayInstanceIds, existingOwnerUids };
}

async function main(): Promise<void> {
  const args = parseSweepOrphanedComputersArgs(process.argv.slice(2));
  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: args.firestoreProjectId });
  const store = await operatorPlatformStateStore(getFirestore(), deploymentEnvironmentSettings(args.environment).targetId);
  const computers = listTerminatedComputers(args);
  console.log(`${computers.length} TERMINATED ${BUILDER_COMPUTER_INSTANCE_PREFIX}${args.environment}-* instance(s) in ${args.computeProjectId}`);
  const refs = await readComputerReferences(store, computers);
  let deleted = 0;
  for (const computer of computers) {
    const verdict = classifyTerminatedComputer(computer, refs);
    const stopped = computer.lastStopTimestamp ?? "unknown stop time";
    if (verdict.action === "keep") {
      console.log(`  keep   ${computer.name} (${computer.zone}, ${stopped}): ${verdict.reason}${computer.ownerUid ? ` owner=${computer.ownerUid}` : ""}`);
      continue;
    }
    console.log(`  ${args.apply ? "DELETE" : "delete"} ${computer.name} (${computer.zone}, ${stopped}): ${verdict.reason}${computer.ownerUid ? ` owner=${computer.ownerUid}` : ""}`);
    if (!args.apply) continue;
    run("gcloud", ["compute", "instances", "delete", computer.name, `--zone=${computer.zone}`, `--project=${args.computeProjectId}`, "--quiet"]);
    deleted += 1;
  }
  console.log(args.apply ? `deleted ${deleted} instance(s)` : "dry run; pass --apply to delete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
