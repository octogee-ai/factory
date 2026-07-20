import { createHash } from "node:crypto";
import {
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveOperatorGatewayAccess,
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  type HelmInstanceValue,
} from "@octogee/shared/types/glm";
import {
  isW9GatewayEdgeImage,
  isW9TestPublisherLiveExperiment,
  type GatewayDoc,
  type GatewayRuntimeDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { isW9CandidateImageTag } from "@octogee/shared/types/image-tag";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { W9TestPublisherLiveExperiment } from "@octogee/shared/types/gateway-releases";
import { resolveGatewayImageRepository } from "./gateway-profiles.js";

// The simple-roll convergence arm (GATEWAY-SIMPLE-ROLL-SPEC): every gateway has
// ONE stable-name Helm release; a roll is a desiredRelease write that surfaces
// here as image drift and applies in place (the chart's surge strategy replaces
// the pod). No revisions or durable roll state machine; readiness opens only
// after the surge customer handoff converges.

export type DurableGateway = GatewayDoc & GatewayMutableConfig;

export function requiresSurgeCustomerMigration(gateway: DurableGateway): boolean {
  return gateway.desiredStatus === "running" &&
    gateway.liveRelease !== null &&
    gateway.liveRelease !== gateway.desiredRelease;
}

export function isOwnerlessOperatorPrewarm(gateway: DurableGateway): boolean {
  return resolveGatewayClass(classKnobs(gateway)) === "operator" &&
    gateway.gatewayId.startsWith("trial-op-") &&
    !gateway.ownerUid &&
    !gateway.builderSlug &&
    gateway.allocation?.kind === "trial" &&
    gateway.allocation.state === "warming";
}

export function orderGatewaysForConvergence(
  gateways: readonly DurableGateway[],
): DurableGateway[] {
  return [...gateways].sort((left, right) => {
    const leftRank = resolveGatewayClass(classKnobs(left)) === "operator" ? 0 : 1;
    const rightRank = resolveGatewayClass(classKnobs(right)) === "operator" ? 0 : 1;
    return leftRank - rightRank || left.gatewayId.localeCompare(right.gatewayId);
  });
}

function classKnobs(gateway: DurableGateway): {
  gatewayClass?: "builder" | "operator" | "shared";
  profile?: "operator" | "standard";
  imageProfile?: "operator" | "standard";
} {
  return {
    gatewayClass: gateway.gatewayClass ?? undefined,
    profile: gateway.profile ?? undefined,
    imageProfile: gateway.imageProfile ?? undefined,
  };
}

function imageRepositoryFor(gateway: DurableGateway, artifact: ReleasePayload): string {
  return resolveGatewayImageRepository({
    ...classKnobs(gateway),
    imageRepository: artifact.imageRepository,
  });
}

export interface ObservedHelmInstance {
  imageRepository: string | null;
  imageTag: string | null;
  replicas: number | null;
  ownerUid?: string;
  builderSlug?: string;
  deploymentIntentFingerprint?: string | null;
}

export interface GatewayConvergencePlanInput {
  gateway: DurableGateway;
  artifact: ReleasePayload | null;
  helm: ObservedHelmInstance | null;
  desiredDeploymentIntentFingerprint?: string;
  deploymentReady: boolean;
}

export type GatewayConvergenceAction =
  | { kind: "uninstall" }
  | { kind: "hold-missing-release"; error: string }
  | { kind: "upsert"; replicas: number }
  | { kind: "mark-live" }
  | { kind: "steady" };

function desiredReplicas(gateway: DurableGateway): number {
  return gateway.desiredStatus === "paused" ? 0 : 1;
}

export function planGatewayConvergence(
  input: GatewayConvergencePlanInput,
): GatewayConvergenceAction {
  const { gateway, artifact, helm } = input;
  if (gateway.desiredStatus === "retired") {
    return helm ? { kind: "uninstall" } : { kind: "steady" };
  }
  if (!artifact) {
    return {
      kind: "hold-missing-release",
      error:
        `gateway ${gateway.gatewayId} desired release ${gateway.desiredRelease} has no ` +
        `readable payload at gateways/${gateway.gatewayId}/releases/${gateway.desiredRelease}`,
    };
  }
  const replicas = desiredReplicas(gateway);
  if (gatewayDeploymentDrifted(input, artifact, replicas)) {
    return { kind: "upsert", replicas };
  }
  if (
    gateway.liveRelease !== gateway.desiredRelease &&
    (gateway.desiredStatus === "paused" || input.deploymentReady)
  ) {
    return { kind: "mark-live" };
  }
  return { kind: "steady" };
}

function gatewayDeploymentDrifted(
  input: GatewayConvergencePlanInput,
  artifact: ReleasePayload,
  replicas: number,
): boolean {
  const { gateway, helm } = input;
  return (
    !helm ||
    helm.imageTag !== artifact.imageTag ||
    helm.imageRepository !== imageRepositoryFor(gateway, artifact) ||
    helm.replicas !== replicas ||
    helm.ownerUid !== (gateway.ownerUid ?? undefined) ||
    helm.builderSlug !== (gateway.builderSlug ?? undefined) ||
    (input.desiredDeploymentIntentFingerprint !== undefined &&
      helm.deploymentIntentFingerprint !== input.desiredDeploymentIntentFingerprint)
  );
}

export interface GatewayUpsertOpts {
  namespace: string;
  gatewayId: string;
  ownerUid?: string;
  builderSlug?: string;
  imageRepository: string;
  imageTag: string;
  gatewayEdgeImageRepository?: string;
  gatewayEdgeImageTag?: string;
  conversationExperimentMode?: "publisher-live";
  testExperiment?: W9TestPublisherLiveExperiment;
  serviceAccountName?: string;
  serviceAccount?: HelmInstanceValue["serviceAccount"];
  gatewayContainerSecurityContext?: Record<string, unknown>;
  operatorAccess?: HelmInstanceValue["operatorAccess"];
  computeClassOverride?: string;
  chartPath: string;
  valuesFile?: string;
  chartFingerprint?: string;
  profile?: HelmInstanceValue["profile"];
  gatewayClass?: HelmInstanceValue["gatewayClass"];
  imageProfile?: HelmInstanceValue["imageProfile"];
  sizingTier?: HelmInstanceValue["sizingTier"];
  replicas?: number;
  gcpProject?: string;
  rollStrategy: "surge";
  waitForReady: false;
  deploymentIntentFingerprint: string;
}

type GatewayIntentInput =
  | GatewayUpsertOpts
  | (Omit<GatewayUpsertOpts, "deploymentIntentFingerprint"> & {
      deploymentIntentFingerprint?: undefined;
    });

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export function gatewayDeploymentIntentFingerprint(opts: GatewayIntentInput): string {
  const intent = Object.fromEntries(
    Object.entries(opts).filter(([key]) =>
      key !== "deploymentIntentFingerprint" && key !== "waitForReady"),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(intent)))
    .digest("hex");
}

export function deploymentIntentFingerprintForComparison(input: {
  desired: GatewayUpsertOpts;
  observedChartFingerprint: string | undefined;
  observedDeploymentIntentFingerprint: string | undefined;
  autoRollOnChartDrift: boolean;
}): string | undefined {
  if (!input.autoRollOnChartDrift && !input.observedDeploymentIntentFingerprint) {
    return undefined;
  }
  if (input.autoRollOnChartDrift || !input.observedChartFingerprint) {
    return input.desired.deploymentIntentFingerprint;
  }
  return gatewayDeploymentIntentFingerprint({
    ...input.desired,
    chartFingerprint: input.observedChartFingerprint,
    deploymentIntentFingerprint: undefined,
  });
}

function w9TestExperimentForNamespace(input: {
  namespace: string;
  artifact: ReleasePayload;
}): Pick<
  GatewayUpsertOpts,
  | "conversationExperimentMode"
  | "testExperiment"
  | "gatewayEdgeImageRepository"
  | "gatewayEdgeImageTag"
> {
  const testExperiment = input.artifact.testExperiment;
  if (testExperiment === undefined) {
    if (isW9CandidateImageTag(input.artifact.imageTag)) {
      throw new Error("digest-bound W9 candidate image requires its W9 TEST experiment");
    }
    return {};
  }
  if (
    input.namespace !== "octogee-test" ||
    !isW9CandidateImageTag(input.artifact.imageTag) ||
    !isW9GatewayEdgeImage(input.artifact.gatewayEdgeImage, input.artifact.imageTag) ||
    !isW9TestPublisherLiveExperiment(testExperiment)
  ) {
    throw new Error("publisher-live W9 experiment is TEST-only and requires its digest-bound candidate");
  }
  return {
    conversationExperimentMode: "publisher-live",
    testExperiment,
    gatewayEdgeImageRepository: input.artifact.gatewayEdgeImage.imageRepository,
    gatewayEdgeImageTag: input.artifact.gatewayEdgeImage.imageTag,
  };
}

// Tenant identity (KSA, secrets, GATEWAY_ID) and every resource name key off
// the bare gatewayId — the chart's revisionId value defaults to it.
export function gatewayUpsertOptsFromRelease(input: {
  namespace: string;
  gateway: DurableGateway;
  artifact: ReleasePayload;
  replicas: number;
  chartPath: string;
  valuesFile?: string;
  chartFingerprint?: string;
}): GatewayUpsertOpts {
  const { gateway, artifact } = input;
  const gatewayClass = resolveGatewayClass(classKnobs(gateway));
  const intent: Omit<GatewayUpsertOpts, "deploymentIntentFingerprint"> = {
    namespace: input.namespace,
    gatewayId: gateway.gatewayId,
    ownerUid: gateway.ownerUid ?? undefined,
    builderSlug: gateway.builderSlug ?? undefined,
    imageRepository: imageRepositoryFor(gateway, artifact),
    imageTag: artifact.imageTag,
    ...w9TestExperimentForNamespace({ namespace: input.namespace, artifact }),
    serviceAccountName: gatewayServiceAccountName(gateway),
    serviceAccount: gateway.serviceAccount ?? undefined,
    gatewayContainerSecurityContext: gateway.gatewayContainerSecurityContext ?? undefined,
    operatorAccess: gatewayOperatorAccess(gateway, gatewayClass),
    computeClassOverride: gateway.computeClass ?? undefined,
    chartPath: input.chartPath,
    valuesFile: input.valuesFile,
    chartFingerprint: input.chartFingerprint,
    profile: gateway.profile ?? undefined,
    gatewayClass,
    imageProfile: resolveGatewayImageProfile(classKnobs(gateway)),
    sizingTier: gateway.sizingTier ?? undefined,
    replicas: input.replicas,
    gcpProject: gateway.gcpProject ?? undefined,
    rollStrategy: "surge",
    waitForReady: false,
  };
  return {
    ...intent,
    deploymentIntentFingerprint: gatewayDeploymentIntentFingerprint(intent),
  };
}

function gatewayServiceAccountName(gateway: DurableGateway): string {
  const configured = gateway.serviceAccountName;
  return configured && configured !== GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME
    ? configured
    : operatorGatewayServiceAccountName(gateway.gatewayId);
}

function gatewayOperatorAccess(
  gateway: DurableGateway,
  gatewayClass: "shared" | "builder" | "operator",
): HelmInstanceValue["operatorAccess"] | undefined {
  if (gatewayClass === "shared") return gateway.operatorAccess ?? undefined;
  return resolveOperatorGatewayAccess(gateway.ownerUid, gateway.operatorAccess ?? undefined);
}

// The runtime doc the converge arm maintains at glmGateways/{gatewayId}.
export function provisioningRuntimeDoc(input: {
  gateway: DurableGateway;
  artifact: ReleasePayload;
  existing: GatewayRuntimeDoc | null;
  now: number;
}): GatewayRuntimeDoc {
  const { gateway, artifact, existing } = input;
  return {
    docKind: "runtime",
    gatewayId: gateway.gatewayId,
    release: gateway.desiredRelease,
    lifecycle: existing?.lifecycle ?? "provisioning",
    createdAt: existing?.createdAt ?? input.now,
    createdByOperationId: existing?.createdByOperationId ?? null,
    helm: {
      releaseName: `octogee-gw-${gateway.gatewayId}`,
      deploymentName: `octogee-gateway-${gateway.gatewayId}`,
      gatewayServiceName: `octogee-gateway-${gateway.gatewayId}`,
      gatewayEdgeServiceName: `gateway-edge-${gateway.gatewayId}`,
      serviceAccountName: operatorGatewayServiceAccountName(gateway.gatewayId),
      imageRepository: imageRepositoryFor(gateway, artifact),
      imageTag: artifact.imageTag,
      replicas: gateway.desiredStatus === "paused" ? 0 : 1,
      availableReplicas: existing?.helm.availableReplicas ?? null,
      lastAppliedAt: input.now,
    },
    heartbeat: existing?.heartbeat ?? {
      status: "unknown",
      lastHeartbeatAt: null,
      version: null,
      openclawVersion: null,
      internalUrl: null,
      startedAt: null,
      mountedCustomers: [],
      migratingIn: [],
    },
    lastError: existing?.lastError ?? { message: null, at: null },
  };
}
