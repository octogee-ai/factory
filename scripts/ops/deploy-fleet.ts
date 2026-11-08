#!/usr/bin/env tsx
import { execFile as execFileCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { centralGatewayReleasePayload, createCentralReleaseAuthority, type ReleaseDigestManifest } from "@octogee/core/artifact-registry";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { appendGatewayRelease, asDurableGatewayRoot, InvalidGatewayRootError, StaleGatewayReleaseError } from "@octogee/core/gateway-release-append";
import { GatewayRetirementConflictError } from "@octogee/core/gateway-retirement-claim";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import { createFirestorePlatformStateStore } from "@octogee/core/platform-state";
import { timestampMillis } from "@octogee/core/timestamps";
import { parseSharedPoolReplacements } from "@octogee/shared/types/shared-gateway-pool";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION, GATEWAY_RELEASES_SUBCOLLECTION, PLATFORM_RELEASE_RECORD_DOC_PATH,
  isGatewayRuntimeDoc, isReleasePayload, parsePlatformReleaseRecord, projectGatewayDesiredRootForGateway, releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { deployFleet, formatFleetSummary, matchesFleetPlatformRelease, FleetDeploymentDeferredError, type FleetGateway, type FleetSnapshot } from "../lib/fleet-deploy.js";
import { object, fleetPodObservations, fleetVmObservation } from "../lib/fleet-observation.js";

const execFile = promisify(execFileCallback);

export function parseFleetDeployArgs(argv: string[]): { sourceSha: string; timeoutMs: number } {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(sha|timeout-ms)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(`invalid TEST fleet argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  const sourceSha = values.get("sha") ?? "";
  const timeoutMs = Number(values.get("timeout-ms") ?? 2_700_000);
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--sha=<full-lowercase-sha> and a positive --timeout-ms are required");
  return { sourceSha, timeoutMs };
}

function payloadOf(value: unknown, gatewayId: string, release: number): ReleasePayload | null {
  const doc = object(value);
  return doc.gatewayId === gatewayId && doc.release === release && isReleasePayload(doc.payload) && doc.payloadHash === releasePayloadHash(doc.payload) ? doc.payload : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function runtimeOf(value: Record<string, unknown>, gatewayId: string): FleetGateway["runtime"] {
  const heartbeat = object(value.heartbeat);
  if (!isGatewayRuntimeDoc(value) || value.gatewayId !== gatewayId) return null;
  return {
    release: value.release, lifecycle: String(value.lifecycle ?? "unknown"), status: String(heartbeat.status ?? "unknown"),
    heartbeatAt: timestampMillis(heartbeat.lastHeartbeatAt) ?? null, mountedCustomers: strings(heartbeat.mountedCustomers), migratingIn: strings(heartbeat.migratingIn),
  };
}

function replacementsOf(value: unknown): FleetSnapshot["sharedReplacements"] {
  return parseSharedPoolReplacements(object(value).replacements);
}

async function readGateway(input: {
  db: Firestore; gatewayId: string; value: unknown; observedAt: number;
  pods: ReturnType<typeof fleetPodObservations>; operations: Array<{ id: string; data: Record<string, unknown> }>;
}): Promise<FleetGateway> {
  const root = projectGatewayDesiredRootForGateway(input.value, input.gatewayId);
  if (!root) throw new Error(`gateway ${input.gatewayId} has an invalid durable root`);
  const ref = input.db.collection(GATEWAYS_COLLECTION).doc(root.gatewayId);
  const [desired, latest, runtimeDoc, assignments] = await Promise.all([
    ref.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(root.desiredRelease)).get(),
    ref.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(root.latestRelease)).get(),
    input.db.collection(GLM_GATEWAYS_COLLECTION).doc(root.gatewayId).get(),
    ref.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).get(),
  ]);
  const runtime = object(runtimeDoc.data());
  return {
    gatewayId: root.gatewayId, gatewayClass: root.gatewayClass, imageProfile: root.imageProfile,
    desiredStatus: root.desiredStatus, latestRelease: root.latestRelease, desiredRelease: root.desiredRelease, liveRelease: root.liveRelease,
    desiredPayload: payloadOf(desired.data(), root.gatewayId, root.desiredRelease), latestPayload: payloadOf(latest.data(), root.gatewayId, root.latestRelease),
    runtime: runtimeOf(runtime, root.gatewayId),
    live: runtime.runtime === "gce-vm" ? fleetVmObservation(runtime) : input.pods.get(root.gatewayId) ?? { observedAt: input.observedAt, instances: [] },
    assignments: assignments.docs.map((assignment) => {
      const data = assignment.data();
      if (typeof data.slug !== "string" || typeof data.state !== "string") throw new Error(`assignment ${assignment.ref.path} is malformed`);
      return { slug: data.slug, state: data.state };
    }),
    operations: input.operations.flatMap(({ id, data }) => {
      const operation = object(data.input);
      return operation.gatewayId === root.gatewayId && typeof operation.targetRelease === "number"
        ? [{ id, release: operation.targetRelease, status: String(data.status), error: typeof data.error === "string" ? data.error : null }] : [];
    }),
  };
}

async function readSnapshot(db: Firestore, environment: "test" | "prod"): Promise<FleetSnapshot> {
  const settings = deploymentEnvironmentSettings(environment);
  const [roots, operations, scalerState, platform, pods, retired] = await Promise.all([
    db.collection(GATEWAYS_COLLECTION).get(),
    db.collection(GLM_OPERATIONS_COLLECTION).where("kind", "==", "rollout").get(),
    db.doc("glmControllerState/sharedPoolScaler").get(),
    db.doc(PLATFORM_RELEASE_RECORD_DOC_PATH).get(),
    execFile("kubectl", ["--context", settings.kubeContext, "--namespace", settings.namespace, "get", "pods", "--selector", "app=octogee-gateway", "-o", "json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }),
    db.collection(GLM_OPERATIONS_COLLECTION).where("kind", "==", "retire-gateway").get(),
  ]);
  const observedAt = Date.now();
  const observations = fleetPodObservations(JSON.parse(pods.stdout), observedAt);
  const rolloutOperations = operations.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const gateways = await Promise.all(roots.docs.map((doc) => readGateway({ db, gatewayId: doc.id, value: doc.data(), observedAt, pods: observations, operations: rolloutOperations })));
  const retirements = retired.docs.flatMap((doc) => {
    const data = doc.data();
    const gatewayId = object(data.input).gatewayId;
    const completedAt = timestampMillis(data.completedAt);
    if (data.status !== "succeeded" || typeof gatewayId !== "string" || completedAt == null) return [];
    return [{ gatewayId, operationId: doc.id, completedAt, live: { observedAt, instances: observations.get(gatewayId)?.instances ?? [] } }];
  });
  return { gateways, retirements, sharedReplacements: replacementsOf(scalerState.data()), platform: parsePlatformReleaseRecord(platform.data()) };
}

async function hasSucceededRetirement(db: Firestore, gatewayId: string): Promise<boolean> {
  const operations = await db.collection(GLM_OPERATIONS_COLLECTION).where("kind", "==", "retire-gateway").get();
  return operations.docs.some((doc) => {
    const data = doc.data();
    return data.status === "succeeded" && object(data.input).gatewayId === gatewayId;
  });
}

async function rethrowMutationError(db: Firestore, gatewayId: string, error: unknown): Promise<never> {
  if (error instanceof GatewayRetirementConflictError || error instanceof StaleGatewayReleaseError) throw new FleetDeploymentDeferredError(error.message);
  if (error instanceof InvalidGatewayRootError && await hasSucceededRetirement(db, gatewayId)) throw new FleetDeploymentDeferredError(`${gatewayId} completed retirement during deployment selection`);
  throw error;
}

export async function deployFleetBuilder(db: Firestore, gateway: Pick<FleetGateway, "gatewayId">, manifest: ReleaseDigestManifest, payload: ReleasePayload, environment: "test" | "prod"): Promise<{ release: number; operationId: string | null }> {
  const [snapshot, platform] = await Promise.all([
    db.collection(GATEWAYS_COLLECTION).doc(gateway.gatewayId).get(),
    db.doc(PLATFORM_RELEASE_RECORD_DOC_PATH).get(),
  ]);
  const current = asDurableGatewayRoot(snapshot.data(), gateway.gatewayId);
  if (current?.desiredStatus === "retired") throw new FleetDeploymentDeferredError(`${gateway.gatewayId} retired during deployment selection`);
  if (!snapshot.exists && !current) await rethrowMutationError(db, gateway.gatewayId, new InvalidGatewayRootError(gateway.gatewayId));
  if (!current || current.gatewayClass !== "builder") throw new Error(`${gateway.gatewayId} is no longer a non-retired Builder`);
  if (!matchesFleetPlatformRelease(parsePlatformReleaseRecord(platform.data()), payload, manifest.sourceSha)) throw new Error("platform release was superseded before Builder deployment");
  const actor = process.env.RELEASE_ACTOR ?? `operator:${environment}-fleet`;
  const store = createFirestorePlatformStateStore({ db });
  try { return await runNormalFleetMutation(store, {
    actor, forced: false, what: `deploy ${environment.toUpperCase()} build to Builder gateway`, why: process.env.RELEASE_REASON ?? `operator requested complete ${environment.toUpperCase()} fleet deployment`,
    target: { gatewayId: current.gatewayId, environment },
    preActionStatus: { desiredStatus: current.desiredStatus, desiredRelease: current.desiredRelease, latestRelease: current.latestRelease },
    mutation: { kind: "deploy-gateway-build", gatewayId: current.gatewayId, sourceSha: manifest.sourceSha, manifestDigest: manifest.manifestDigest },
    ...(environment === "test" ? { testProvenance: { environment: "test" as const, sourceCommit: manifest.sourceSha } } : {}),
    action: () => appendGatewayRelease(store, { gateway: current, artifact: payload, payload, createdBy: actor, now: Date.now(), sourceRelease: current.latestRelease, note: `complete ${environment.toUpperCase()} deployment of ${manifest.sourceSha}`, origin: "operator" }),
    classifyResult: (result) => ({ outcome: "completed", releaseRollout: { releaseId: `${current.gatewayId}/releases/${result.release}`, ...(result.operationId ? { rolloutOperationId: result.operationId } : {}) } }),
  }); } catch (error) {
    return rethrowMutationError(db, gateway.gatewayId, error);
  }
}

export async function runFleetDeploy(argv: string[]): Promise<void> {
  const options = parseFleetDeployArgs(argv);
  const environment = process.env.RELEASE_ENVIRONMENT;
  if (environment !== "test" && environment !== "prod") throw new Error("RELEASE_ENVIRONMENT must be test or prod");
  const settings = deploymentEnvironmentSettings(environment);
  const authority = createCentralReleaseAuthority({ project: settings.artifactRegistryProjectId, location: settings.artifactRegistryLocation, repository: settings.artifactRegistryName });
  const manifest = await authority.resolveManifest(options.sourceSha);
  if (manifest.sourceSha !== options.sourceSha) throw new Error("resolved immutable manifest differs from requested source SHA");
  const payload = centralGatewayReleasePayload(manifest);
  const app = initializeApp({ credential: applicationDefault(), projectId: settings.firebaseProjectId }, "deploy-fleet");
  try {
    const db = getFirestore(app);
    const report = await deployFleet({ ...options, environment, payload }, {
      now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      readSnapshot: () => readSnapshot(db, environment), deploy: (gateway) => deployFleetBuilder(db, gateway, manifest, payload, environment),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatFleetSummary(report));
    if (report.outcome !== "converged") throw new Error(`${environment.toUpperCase()} fleet ${report.outcome}: ${[...report.reasons, ...report.targets.flatMap((target) => target.reasons.map((reason) => `${target.gatewayId}: ${reason}`))].join("; ")}`);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFleetDeploy(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
