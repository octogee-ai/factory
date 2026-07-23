#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { deploymentTargetSettings } from "@octogee/core/deployment-environment";
import { isBareGatewayId } from "@octogee/core/gateway-live-release";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  resolveGatewayClass,
} from "@octogee/shared/types/glm";
import {
  assessReleaseConvergence,
  type ReleaseConvergenceBaseline,
  type ReleaseConvergenceDeployment,
  type ReleaseConvergenceGateway,
  type ReleaseConvergencePod,
  type ReleaseConvergenceReplicaSet,
  type ReleaseConvergenceRolloutOperation,
  type ReleaseConvergenceSnapshot,
} from "../lib/release-convergence.js";

const execFile = promisify(execFileCallback);
const POLL_INTERVAL_MS = 15_000;

interface VerifyOptions {
  deploymentTarget: string;
  expectedImageTag: string;
  baseline: string;
  timeoutMs: number;
  releaseTag: string;
}

function parseArgs(argv: readonly string[]): VerifyOptions {
  const values = new Map(
    argv.map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator < 0) {
        throw new Error(`invalid argument ${argument}`);
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  );
  const deploymentTarget = values.get("deployment-target");
  const expectedImageTag = values.get("expected-image-tag");
  const baseline = values.get("baseline");
  const releaseTag = values.get("release-tag");
  const timeoutMs = Number(values.get("timeout-ms"));
  if (
    !deploymentTarget ||
    !expectedImageTag ||
    !baseline ||
    !releaseTag ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    values.size !== 5
  ) {
    throw new Error(
      "--deployment-target, --expected-image-tag, --baseline, --timeout-ms, and --release-tag are required",
    );
  }
  return {
    deploymentTarget,
    expectedImageTag,
    baseline,
    timeoutMs,
    releaseTag,
  };
}

function isBaseline(value: unknown): value is ReleaseConvergenceBaseline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isBareGatewayId(candidate.configuredDefaultGatewayId) &&
    Array.isArray(candidate.predecessorPodUids) &&
    candidate.predecessorPodUids.every((uid) => typeof uid === "string") &&
    typeof candidate.capturedAt === "number"
  );
}

interface KubernetesList<T> {
  items?: T[];
}

interface KubernetesDeployment {
  metadata?: { name?: unknown };
  spec?: { replicas?: unknown };
  status?: {
    updatedReplicas?: unknown;
    readyReplicas?: unknown;
    availableReplicas?: unknown;
  };
}

interface KubernetesPod {
  metadata?: { name?: unknown; uid?: unknown };
  spec?: { containers?: Array<{ name?: unknown; image?: unknown }> };
  status?: {
    phase?: unknown;
    conditions?: Array<{ type?: unknown; status?: unknown }>;
  };
}

interface KubernetesReplicaSet {
  metadata?: {
    name?: unknown;
    annotations?: Record<string, unknown>;
    ownerReferences?: Array<{ kind?: unknown; name?: unknown }>;
  };
  spec?: { replicas?: unknown };
  status?: { replicas?: unknown };
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function string(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function kubectlJson<T>(args: readonly string[]): Promise<T> {
  const { stdout } = await execFile("kubectl", [...args, "-o", "json"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function readKubernetesState(input: {
  kubeContext: string;
  namespace: string;
  gatewayId: string;
  deploymentName: string;
}): Promise<{
  deployment: ReleaseConvergenceDeployment;
  pods: ReleaseConvergencePod[];
  replicaSets: ReleaseConvergenceReplicaSet[];
}> {
  const base = ["--context", input.kubeContext];
  const [deploymentValue, podsValue, replicaSetsValue] = await Promise.all([
    kubectlJson<KubernetesDeployment>([
      ...base,
      "get",
      "deployment",
      input.deploymentName,
      "--namespace",
      input.namespace,
    ]),
    kubectlJson<KubernetesList<KubernetesPod>>([
      ...base,
      "get",
      "pods",
      "--namespace",
      input.namespace,
      "--selector",
      `app=octogee-gateway,gateway-instance=${input.gatewayId}`,
    ]),
    kubectlJson<KubernetesList<KubernetesReplicaSet>>([
      ...base,
      "get",
      "replicasets",
      "--namespace",
      input.namespace,
      "--selector",
      `app=octogee-gateway,gateway-instance=${input.gatewayId}`,
    ]),
  ]);

  const deployment: ReleaseConvergenceDeployment = {
    name: string(deploymentValue.metadata?.name),
    replicas: integer(deploymentValue.spec?.replicas),
    updatedReplicas: integer(deploymentValue.status?.updatedReplicas),
    readyReplicas: integer(deploymentValue.status?.readyReplicas),
    availableReplicas: integer(deploymentValue.status?.availableReplicas),
  };
  const pods = (podsValue.items ?? []).map((pod): ReleaseConvergencePod => ({
    uid: string(pod.metadata?.uid),
    name: string(pod.metadata?.name),
    phase: string(pod.status?.phase),
    ready: (pod.status?.conditions ?? []).some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ),
    images: Object.fromEntries(
      (pod.spec?.containers ?? []).flatMap((container) =>
        typeof container.name === "string" && typeof container.image === "string"
          ? [[container.name, container.image]]
          : [],
      ),
    ),
  }));
  const ownedReplicaSets = (replicaSetsValue.items ?? []).filter((replicaSet) =>
    (replicaSet.metadata?.ownerReferences ?? []).some(
      (owner) => owner.kind === "Deployment" && owner.name === input.deploymentName,
    ),
  );
  const currentRevision = Math.max(
    ...ownedReplicaSets.map((replicaSet) =>
      Number(replicaSet.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
    ),
    0,
  );
  const replicaSets = ownedReplicaSets.map((replicaSet): ReleaseConvergenceReplicaSet => ({
    name: string(replicaSet.metadata?.name),
    current:
      Number(replicaSet.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0) ===
      currentRevision,
    desiredReplicas: integer(replicaSet.spec?.replicas),
    replicas: integer(replicaSet.status?.replicas),
  }));
  return { deployment, pods, replicaSets };
}

async function readSnapshot(input: {
  db: Firestore;
  expectedImageTag: string;
  kubeContext: string;
  namespace: string;
}): Promise<{ snapshot: ReleaseConvergenceSnapshot }> {
  const [config, gatewayDocuments, operationDocuments] = await Promise.all([
    input.db.doc("config/orchestrator").get(),
    input.db.collection(GATEWAYS_COLLECTION).get(),
    input.db.collection(GLM_OPERATIONS_COLLECTION).get(),
  ]);
  const configuredDefaultGatewayId = config.data()?.defaultGatewayId;
  if (!isBareGatewayId(configuredDefaultGatewayId)) {
    throw new Error("config/orchestrator.defaultGatewayId is missing or invalid");
  }

  const roots = gatewayDocuments.docs.flatMap((document) => {
    const value = projectGatewayDesiredRootForGateway(document.data(), document.id);
    return value ? [value] : [];
  });
  const gateways = await Promise.all(roots.map(async (root): Promise<ReleaseConvergenceGateway> => {
    const release = await input.db
      .collection(GATEWAYS_COLLECTION)
      .doc(root.gatewayId)
      .collection(GATEWAY_RELEASES_SUBCOLLECTION)
      .doc(String(root.desiredRelease))
      .get();
    const data = release.data();
    const payload = data?.payload;
    const desiredImageTag = payload && typeof payload === "object" &&
      typeof (payload as Record<string, unknown>).imageTag === "string"
      ? (payload as Record<string, unknown>).imageTag as string
      : null;
    return {
      gatewayId: root.gatewayId,
      desiredStatus: root.desiredStatus,
      gatewayClass: resolveGatewayClass({
        gatewayClass: root.gatewayClass ?? undefined,
        profile: root.profile ?? undefined,
        imageProfile: root.imageProfile ?? undefined,
      }),
      desiredRelease: root.desiredRelease,
      liveRelease: root.liveRelease,
      desiredImageTag,
    };
  }));
  const rolloutOperations = operationDocuments.docs.flatMap((document) => {
    const value = document.data();
    const inputValue = value.input;
    if (value.kind !== "rollout" || !inputValue || typeof inputValue !== "object") return [];
    const operationInput = inputValue as Record<string, unknown>;
    if (
      typeof operationInput.gatewayId !== "string" ||
      typeof operationInput.imageTag !== "string" ||
      typeof value.status !== "string"
    ) return [];
    const operation: ReleaseConvergenceRolloutOperation = {
      id: document.id,
      gatewayId: operationInput.gatewayId,
      imageTag: operationInput.imageTag,
      status: value.status,
      error: typeof value.error === "string" ? value.error : null,
    };
    return [operation];
  });
  const [runtimeDocument, assignmentDocuments] = await Promise.all([
    input.db.collection(GLM_GATEWAYS_COLLECTION).doc(configuredDefaultGatewayId).get(),
    input.db.collection(GATEWAYS_COLLECTION).doc(configuredDefaultGatewayId)
      .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).get(),
  ]);
  const runtimeValue = runtimeDocument.data();
  const defaultRuntime = isGatewayRuntimeDoc(runtimeValue)
    ? {
      gatewayId: runtimeValue.gatewayId,
      release: runtimeValue.release,
      lifecycle: runtimeValue.lifecycle,
      heartbeatStatus: runtimeValue.heartbeat.status,
      heartbeatVersion: runtimeValue.heartbeat.version,
      mountedCustomers: runtimeValue.heartbeat.mountedCustomers,
    }
    : null;
  const defaultAssignments = assignmentDocuments.docs.map((document) => {
    const slug = document.data().slug;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(`${document.ref.path} is missing slug`);
    }
    return slug;
  });
  const defaultAssignmentsServing = assignmentDocuments.docs.every(
    (document) => document.data().state === "serving",
  );
  const deploymentName = defaultRuntime && isGatewayRuntimeDoc(runtimeValue)
    ? runtimeValue.helm.deploymentName
    : `octogee-gateway-${configuredDefaultGatewayId}`;
  const kubernetes = await readKubernetesState({
    kubeContext: input.kubeContext,
    namespace: input.namespace,
    gatewayId: configuredDefaultGatewayId,
    deploymentName,
  });
  return {
    snapshot: {
      expectedImageTag: input.expectedImageTag,
      configuredDefaultGatewayId,
      gateways,
      rolloutOperations,
      defaultRuntime,
      defaultAssignments,
      defaultAssignmentsServing,
      ...kubernetes,
    },
  };
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const settings = deploymentTargetSettings(options.deploymentTarget);
  const baselineValue = JSON.parse(await readFile(options.baseline, "utf8")) as unknown;
  if (!isBaseline(baselineValue)) throw new Error("release convergence baseline is invalid");
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: settings.firebaseProjectId,
  }, `release-convergence-${settings.targetId}`);
  const db = getFirestore(app);
  const deadline = Date.now() + options.timeoutMs;
  let failures = ["release convergence has not been observed"];

  while (Date.now() < deadline) {
    try {
      const observed = await readSnapshot({
        db,
        expectedImageTag: options.expectedImageTag,
        kubeContext: settings.kubeContext,
        namespace: settings.namespace,
      });
      const assessment = assessReleaseConvergence(observed.snapshot, baselineValue);
      if (assessment.converged) {
        process.stdout.write(
          `Release ${options.releaseTag} converged in ${settings.name}: ${options.expectedImageTag}\n`,
        );
        return;
      }
      failures = assessment.failures;
      process.stdout.write(
        `Waiting for release convergence (${Math.ceil((deadline - Date.now()) / 60_000)}m remain): ${failures.join("; ")}\n`,
      );
      if (observed.snapshot.rolloutOperations.some(
        (operation) => operation.imageTag === options.expectedImageTag &&
          (operation.status === "failed" || operation.status === "rolled-back"),
      )) break;
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)];
      process.stdout.write(`Waiting for release convergence: ${failures[0]}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Release convergence failed: ${failures.join("; ")}`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
