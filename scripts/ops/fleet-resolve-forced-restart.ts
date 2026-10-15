import { isDeepStrictEqual } from "node:util";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { updateRuntimeRestart, type RuntimeRestartFence } from "@octogee/core/gateway-runtime-restart";
import { createRestartDriverDeps } from "@octogee/core/gateway-restart-probe";
import { runNormalFleetMutation, type NormalFleetMutationDb, type NormalFleetMutationInput } from "@octogee/core/normal-fleet-mutation";
import { isOperationAuditRecord } from "../../shared/types/glm.js";
import { customerRuntimeMutationFenced, isReleasePayload, projectGatewayDesiredRootForGateway, releasePayloadHash } from "../../shared/types/gateway-releases.js";
import type { FleetKubectlRunner } from "./fleet.js";

interface Authority {
  root: DocumentData;
  fence: RuntimeRestartFence;
  restart: DocumentData;
  force: DocumentData;
  release: DocumentData;
  images: Record<string, string>;
}

const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

interface KubernetesResource {
  metadata?: {
    uid?: string; name?: string; generation?: number; deletionTimestamp?: string; creationTimestamp?: string;
    labels?: Record<string, string>; ownerReferences?: Array<{ uid: string; controller?: boolean }>;
  };
  spec?: { replicas?: number; containers?: Array<{ name: string; image: string }>; template?: { spec?: KubernetesResource["spec"] } };
  status?: { phase?: string; readyReplicas?: number; observedGeneration?: number; conditions?: Array<{ type: string; status: string }>;
    containerStatuses?: Array<{ name: string; ready?: boolean; state?: { running?: unknown }; imageID?: string }> };
}

async function readAuthority(db: Firestore, tx: Transaction, gatewayId: string, forceAuditId: string): Promise<Authority> {
  const root = (await tx.get(db.doc(`gateways/${gatewayId}`))).data() ?? {};
  const desired = projectGatewayDesiredRootForGateway(root, gatewayId);
  if (!desired || desired.gatewayClass !== "builder" || desired.desiredStatus !== "running" || root.retirementClaim != null ||
    (root.runtime !== undefined && root.runtime !== "cluster") || !Number.isSafeInteger(root.liveRelease) || root.liveRelease < 1 || root.liveRelease !== root.desiredRelease) {
    throw new Error("restart resolution requires a converged running Builder gateway");
  }
  const fence = root.runtimeRestartFence as RuntimeRestartFence | undefined;
  if (!fence || fence.kind !== "process" || fence.phase !== "dispatched" || fence.gatewayId !== gatewayId ||
    !validId(fence.attemptId) || !validId(fence.auditId) || !Number.isSafeInteger(fence.startedAt) || fence.startedAt < 1 ||
    !validId(fence.target?.podUid) || typeof fence.target?.podName !== "string" || !fence.target.podName.startsWith(`octogee-gateway-${gatewayId}-`)) {
    throw new Error("restart resolution requires the exact dispatched process fence");
  }
  const [restartDoc, forceDoc, releaseDoc] = await Promise.all([
    tx.get(db.doc(`glmOperations/${fence.auditId}`)), tx.get(db.doc(`glmOperations/${forceAuditId}`)),
    tx.get(db.doc(`gateways/${gatewayId}/releases/${root.liveRelease}`)),
  ]);
  const restart = restartDoc.data() ?? {}, force = forceDoc.data() ?? {}, release = releaseDoc.data() ?? {};
  if (!isOperationAuditRecord(restart) || restart.status !== "failed" || restart.target.gatewayId !== gatewayId ||
    restart.mutation.kind !== "process" || restart.mutation.attemptId !== fence.attemptId ||
    !isOperationAuditRecord(force) || force.status !== "completed" || force.outcome !== "completed" || force.forced !== true || force.actor !== "operator" ||
    force.mutation.kind !== "restart-gateway" || force.mutation.mode !== "force-pod-delete" || force.mutation.gatewayId !== gatewayId ||
    force.target.gatewayId !== gatewayId || force.target.podName !== fence.target.podName || force.target.podUid !== fence.target.podUid ||
    force.actionStartedAt! < restart.completedAt! || force.actionStartedAt! < fence.startedAt || force.completedAt! < force.actionStartedAt!) {
    throw new Error("completed force audit does not supersede the held restart");
  }
  const payload = release.payload;
  if (release.gatewayId !== gatewayId || release.release !== root.liveRelease || !isReleasePayload(payload) ||
    release.payloadHash !== releasePayloadHash(payload) || !payload.profileImages?.builder || !payload.gatewayEdgeImage) {
    throw new Error("restart resolution release images are unavailable");
  }
  await assertNoCustody(db, tx, gatewayId, root.ownerUid);
  return { root, fence, restart, force, release, images: {
    gateway: `${payload.profileImages.builder.imageRepository}:${payload.profileImages.builder.imageTag}`,
    "gateway-edge": `${payload.gatewayEdgeImage.imageRepository}:${payload.gatewayEdgeImage.imageTag}`,
  } };
}

async function assertNoCustody(db: Firestore, tx: Transaction, gatewayId: string, ownerUid: string): Promise<void> {
  const [sources, targets, users, operations, tasks] = await Promise.all([
    tx.get(db.collection("users").where("provisioning.openclaw.sourceTransferFence.sourceGatewayId", "==", gatewayId)),
    tx.get(db.collection("users").where("provisioning.openclaw.sourceTransferFence.targetGatewayId", "==", gatewayId)),
    tx.get(db.collection("users").where("provisioning.openclaw.gatewayId", "==", gatewayId)),
    tx.get(db.collection("glmOperations").where("status", "in", ["pending", "running"])),
    tx.get(db.collection("glmMigrationTransferTasks").where("status", "in", ["pending", "running"])),
  ]);
  const touches = (input: DocumentData) => [input.gatewayId, input.fromGatewayId, input.toGatewayId, input.sourceGatewayId, input.targetGatewayId].includes(gatewayId);
  if (!sources.empty || !targets.empty || users.docs.some(doc => customerRuntimeMutationFenced(doc.data())) ||
    operations.docs.some(doc => touches(doc.data().input ?? {}) || touches(doc.data().customerMigrationV2 ?? {}) || doc.data().input?.uid === ownerUid) || tasks.docs.some(doc => touches(doc.data()))) {
    throw new Error("restart resolution is blocked by active gateway custody");
  }
}

export async function nativeHealth(deps: Awaited<ReturnType<typeof createRestartDriverDeps>>) {
  const connection = await deps.connect();
  try {
    if (!validBoot(connection.bootId) || !await deps.ready()) throw new Error("replacement native runtime is not ready");
    await connection.request("health", {});
    if (!connection.alive()) throw new Error("replacement native runtime disconnected");
    return { bootId: connection.bootId, health: true };
  } finally { connection.close(); }
}
function validBoot(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

export function nativeProbeSource(packagePath = "/octogee/scripts/package.json"): string {
  return `const __name=(target)=>target;const validBoot=${validBoot.toString()};const timer=setTimeout(()=>{process.stderr.write('replacement native health deadline\\n');process.exit(1)},45000);(${createRestartDriverDeps.toString()})(${JSON.stringify(packagePath)}).then(deps=>(${nativeHealth.toString()})(deps)).then(value=>{clearTimeout(timer);process.stdout.write(JSON.stringify(value))}).catch(error=>{clearTimeout(timer);process.stderr.write(String(error.message)+'\\n');process.exit(1)});`;
}

interface Input {
  db: Firestore;
  gatewayId: string;
  forceAuditId: string;
  kubeContext: string;
  namespace: string;
  runKubectl: FleetKubectlRunner;
  apply: boolean;
  idempotencyKey?: string;
  runMutation?: <T>(input: NormalFleetMutationInput<T>) => Promise<T>;
}

function transport(input: Input) {
  return (args: string[], stdin?: string): string => {
    const result = input.runKubectl(["--context", input.kubeContext, "-n", input.namespace, ...args], stdin, stdin ? 60_000 : 20_000);
    if (result.error || result.status !== 0) throw new Error(`restart resolution Kubernetes proof failed: ${result.error?.message ?? result.stderr.slice(0, 300)}`);
    return result.stdout.trim();
  };
}

function observeReplacement(input: Input, authority: Authority) {
  const run = transport(input), target = authority.fence.target!;
  const old = run(["get", "pod", String(target.podName), "--ignore-not-found", "-o", "json"]);
  if (old && (JSON.parse(old) as KubernetesResource).metadata?.uid === target.podUid) throw new Error("original restart pod still exists");
  const pods = JSON.parse(run(["get", "pods", "-l", `app=octogee-gateway,gateway-instance=${input.gatewayId}`, "-o", "json"])) as { items?: KubernetesResource[] };
  if (!Array.isArray(pods.items) || pods.items.length !== 1) throw new Error("restart resolution requires one replacement pod");
  const pod = pods.items[0], metadata = pod.metadata ?? {}, status = pod.status ?? {};
  const deployment = JSON.parse(run(["get", "deployment", `octogee-gateway-${input.gatewayId}`, "-o", "json"])) as KubernetesResource;
  const replicaSets = JSON.parse(run(["get", "replicasets", "-l", `gateway-instance=${input.gatewayId}`, "-o", "json"])) as { items?: KubernetesResource[] };
  const owned = new Set((Array.isArray(replicaSets.items) ? replicaSets.items : [])
    .filter(rs => validId(rs.metadata?.uid) && rs.metadata?.ownerReferences?.some(ref => ref.uid === deployment.metadata?.uid && ref.controller === true))
    .map(rs => rs.metadata!.uid!));
  if (!validId(metadata.uid) || metadata.uid === target.podUid || typeof metadata.name !== "string" || !metadata.name.startsWith(`octogee-gateway-${input.gatewayId}-`) ||
    metadata.deletionTimestamp || metadata.labels?.["gateway-instance"] !== input.gatewayId ||
    !metadata.ownerReferences?.some(ref => owned.has(ref.uid) && ref.controller === true) || status.phase !== "Running" ||
    !status.conditions?.some(row => row.type === "Ready" && row.status === "True") ||
    !Number.isFinite(Date.parse(metadata.creationTimestamp ?? "")) || Date.parse(metadata.creationTimestamp ?? "") < authority.force.actionStartedAt || deployment.metadata?.deletionTimestamp ||
    !validId(deployment.metadata?.uid) || deployment.spec?.replicas !== 1 || deployment.status?.readyReplicas !== 1 ||
    typeof deployment.metadata.generation !== "number" || !Number.isSafeInteger(deployment.metadata.generation) || deployment.metadata.generation < 1 ||
    typeof deployment.status.observedGeneration !== "number" || !Number.isSafeInteger(deployment.status.observedGeneration) ||
    deployment.status.observedGeneration < deployment.metadata.generation) throw new Error("replacement pod ownership or readiness is unverified");
  for (const [name, image] of Object.entries(authority.images)) {
    const spec = pod.spec?.containers?.find(row => row.name === name);
    const template = deployment.spec?.template?.spec?.containers?.find(row => row.name === name);
    const live = status.containerStatuses?.find(row => row.name === name);
    if (spec?.image !== image || template?.image !== image || live?.ready !== true || !live.state?.running ||
      typeof live?.imageID !== "string" || !live.imageID.endsWith(`@${image.split("@")[1]}`)) throw new Error("replacement pod release images do not match");
  }
  return { podName: metadata.name as string, podUid: metadata.uid as string, deploymentUid: deployment.metadata.uid as string, images: authority.images };
}

export async function resolveForcedGatewayRestart(input: Input) {
  if (!validId(input.gatewayId) || !validId(input.forceAuditId)) throw new Error("restart resolution requires exact gateway and force audit IDs");
  const authority = await input.db.runTransaction(tx => readAuthority(input.db, tx, input.gatewayId, input.forceAuditId));
  const replacement = observeReplacement(input, authority);
  const proof = JSON.parse(transport(input)(["exec", replacement.podName, "-c", "gateway", "-i", "--", "node", "--input-type=commonjs"], nativeProbeSource()));
  if (!validBoot(proof.bootId) || proof.health !== true) throw new Error("replacement native health is unverified");
  if (!input.apply) return { applied: false, forceAuditId: input.forceAuditId, heldFence: authority.fence, replacement, native: proof };
  const runMutation = input.runMutation ?? (<T>(mutation: NormalFleetMutationInput<T>) => runNormalFleetMutation(input.db as unknown as NormalFleetMutationDb, mutation));
  return runMutation({
    actor: "operator", forced: true, what: "resolve forced gateway restart", why: "verified pod replacement supersedes an unresolved process restart",
    target: { gatewayId: input.gatewayId, restartAttemptId: authority.fence.attemptId, forceAuditId: input.forceAuditId },
    preActionStatus: { heldFence: authority.fence, replacement, native: proof, release: authority.root.liveRelease },
    mutation: { kind: "resolve-forced-restart", forceAuditId: input.forceAuditId, restartAttemptId: authority.fence.attemptId, replacementPodUid: replacement.podUid },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    action: async claim => {
      await updateRuntimeRestart(input.db, authority.fence, null, async (tx, root) => {
        const current = await readAuthority(input.db, tx, input.gatewayId, input.forceAuditId);
        if (!isDeepStrictEqual(root, authority.root) || !isDeepStrictEqual(current, authority) ||
          !isDeepStrictEqual(observeReplacement(input, current), replacement)) throw new Error("restart resolution authority changed");
      });
      return { auditId: claim.auditId, forceAuditId: input.forceAuditId, restartAttemptId: authority.fence.attemptId, replacementPodUid: replacement.podUid };
    },
  });
}
