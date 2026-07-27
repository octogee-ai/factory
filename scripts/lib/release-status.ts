import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayRuntimeDoc,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import { isBareGatewayId } from "@octogee/shared/types/gateway-mutable-config";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { imageTagMatchesArtifact } from "./release-convergence.js";

export type ReleaseStatusObservation =
  | "converged"
  | "rolling"
  | "missing-release"
  | "missing-runtime"
  | "runtime-stale"
  | "not-serving"
  | "unhealthy"
  | "version-drift"
  | "paused"
  | "retired"
  | "invalid-root";

export interface ReleaseStatusRuntime {
  release: number;
  lifecycle: string;
  heartbeatStatus: string;
  heartbeatVersion: string | null;
}

export interface ReleaseStatusGatewayInput {
  gatewayId: string;
  desiredStatus: string;
  desiredRelease: number;
  liveRelease: number | null;
  desiredImageTag: string | null;
  runtime: ReleaseStatusRuntime | null;
}

export interface ReleaseStatusGateway {
  gatewayId: string;
  isDefault: boolean;
  desiredStatus: string | null;
  desiredRelease: number | null;
  liveRelease: number | null;
  desiredImageTag: string | null;
  runtimeRelease: number | null;
  runtimeLifecycle: string | null;
  heartbeatStatus: string | null;
  heartbeatVersion: string | null;
  observation: ReleaseStatusObservation;
}

export interface ReleaseStatusSnapshot {
  defaultGatewayId: string | null;
  defaultSelection: ReleaseStatusDefaultSelection;
  gateways: ReleaseStatusGateway[];
}

export type ReleaseStatusDefaultSelection =
  | "selected"
  | "unconfigured"
  | "invalid"
  | "dangling";

export function observeGatewayRelease(input: ReleaseStatusGatewayInput): ReleaseStatusObservation {
  if (input.desiredStatus === "retired") return "retired";
  if (input.desiredStatus === "paused") return "paused";
  if (!input.desiredImageTag) return "missing-release";
  if (!input.runtime) return "missing-runtime";
  if (input.desiredRelease !== input.liveRelease) return "rolling";
  if (input.runtime.release !== input.desiredRelease) return "runtime-stale";
  if (input.runtime.lifecycle !== "serving") return "not-serving";
  if (input.runtime.heartbeatStatus !== "ready") return "unhealthy";
  if (!imageTagMatchesArtifact(input.runtime.heartbeatVersion, input.desiredImageTag)) {
    return "version-drift";
  }
  return "converged";
}

function projectRuntime(value: unknown, gatewayId: string): ReleaseStatusRuntime | null {
  if (!isGatewayRuntimeDoc(value) || value.gatewayId !== gatewayId) return null;
  const heartbeat = value.heartbeat as unknown;
  if (!heartbeat || typeof heartbeat !== "object") return null;
  const observation = heartbeat as Record<string, unknown>;
  if (
    observation.status !== "unknown" &&
    observation.status !== "ready" &&
    observation.status !== "unreachable" &&
    observation.status !== "error"
  ) {
    return null;
  }
  if (observation.version !== null && typeof observation.version !== "string") return null;
  return {
    release: value.release,
    lifecycle: value.lifecycle,
    heartbeatStatus: observation.status,
    heartbeatVersion: observation.version,
  };
}

function projectImageTag(value: unknown): string | null {
  const payload = (value as { payload?: unknown } | undefined)?.payload;
  return isReleasePayload(payload) ? payload.imageTag : null;
}

function invalidRoot(gatewayId: string, defaultGatewayId: string | null): ReleaseStatusGateway {
  return {
    gatewayId,
    isDefault: gatewayId === defaultGatewayId,
    desiredStatus: null,
    desiredRelease: null,
    liveRelease: null,
    desiredImageTag: null,
    runtimeRelease: null,
    runtimeLifecycle: null,
    heartbeatStatus: null,
    heartbeatVersion: null,
    observation: "invalid-root",
  };
}

function observeDefaultSelection(
  defaultGatewayValue: unknown,
  validGatewayIds: ReadonlySet<string>,
): ReleaseStatusDefaultSelection {
  if (
    defaultGatewayValue === undefined ||
    defaultGatewayValue === null ||
    defaultGatewayValue === ""
  ) {
    return "unconfigured";
  }
  if (typeof defaultGatewayValue !== "string" || !isBareGatewayId(defaultGatewayValue)) {
    return "invalid";
  }
  return validGatewayIds.has(defaultGatewayValue) ? "selected" : "dangling";
}

export async function readReleaseStatus(
  db: Pick<Firestore, "collection" | "doc">,
): Promise<ReleaseStatusSnapshot> {
  const [defaultGatewayDocument, gatewayDocuments] = await Promise.all([
    db.doc("config/orchestrator").get(),
    db.collection(GATEWAYS_COLLECTION).get(),
  ]);
  const defaultGatewayValue = defaultGatewayDocument.data()?.defaultGatewayId;
  const defaultGatewayId = typeof defaultGatewayValue === "string" ? defaultGatewayValue : null;
  const validRoots = gatewayDocuments.docs.flatMap((document) => {
    const root = projectGatewayDesiredRootForGateway(document.data(), document.id);
    return root ? [{ gatewayId: document.id, root }] : [];
  });
  const validGatewayIds = new Set(validRoots.map(({ gatewayId }) => gatewayId));
  const defaultSelection = observeDefaultSelection(defaultGatewayValue, validGatewayIds);
  const selectedDefaultGatewayId = defaultSelection === "selected" ? defaultGatewayId : null;
  const observed = await Promise.all(validRoots.map(async ({ gatewayId, root }) => {
    const [releaseDocument, runtimeDocument] = await Promise.all([
      db.collection(GATEWAYS_COLLECTION)
        .doc(gatewayId)
        .collection(GATEWAY_RELEASES_SUBCOLLECTION)
        .doc(String(root.desiredRelease))
        .get(),
      db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get(),
    ]);
    const desiredImageTag = projectImageTag(releaseDocument.data());
    const runtime = projectRuntime(runtimeDocument.data(), gatewayId);
    return {
      gatewayId,
      isDefault: gatewayId === selectedDefaultGatewayId,
      desiredStatus: root.desiredStatus,
      desiredRelease: root.desiredRelease,
      liveRelease: root.liveRelease,
      desiredImageTag,
      runtimeRelease: runtime?.release ?? null,
      runtimeLifecycle: runtime?.lifecycle ?? null,
      heartbeatStatus: runtime?.heartbeatStatus ?? null,
      heartbeatVersion: runtime?.heartbeatVersion ?? null,
      observation: observeGatewayRelease({
        gatewayId,
        desiredStatus: root.desiredStatus,
        desiredRelease: root.desiredRelease,
        liveRelease: root.liveRelease,
        desiredImageTag,
        runtime,
      }),
    } satisfies ReleaseStatusGateway;
  }));
  const invalidRoots = gatewayDocuments.docs
    .filter((document) => !validGatewayIds.has(document.id))
    .map((document) => invalidRoot(document.id, selectedDefaultGatewayId));

  return {
    defaultGatewayId,
    defaultSelection,
    gateways: [...observed, ...invalidRoots].sort(
      (left, right) => left.gatewayId.localeCompare(right.gatewayId),
    ),
  };
}
