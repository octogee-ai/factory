

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  GATEWAY_CLASSES,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_ID_REQUIREMENT,
  GATEWAY_PROFILES,
  OPERATOR_GATEWAY_RESERVATIONS_COLLECTION,
  defaultOperatorGatewayAccess,
  resolveUserGatewayShellState,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  isValidGatewayId,
  isGatewayClass,
  isGatewayProfile,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveGatewayPersistence,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayProfile,
  type OperatorGatewayReservationSpec,
  type OperatorGatewayReservationRequest,
} from "@octogee/shared/types/glm";
import {
  ONBOARDING_MODEL_CATALOG,
  canonicalOnboardingModelId,
  isOnboardingReasoningEffortAllowed,
  isOnboardingCohortEnabled,
  isOnboardingModelProvider,
  isOnboardingReasoningEffort,
  onboardingModelCatalogEntryFor,
  resolveOnboardingPlacementForUid,
  type OnboardingModelCatalogEntry,
  type OnboardingCohortConfig,
  type OnboardingOrchestratorConfig,
  type OnboardingPlacementDecision,
} from "@octogee/shared/types/onboarding-cohorts";
import {
  SIZING_TIERS,
  isSizingTier,
  resolveSizingTier,
  type SizingTier,
} from "@octogee/shared/types/sizing";
import {
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  type GatewayPricingMode,
} from "@octogee/shared/types/cost-estimator";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import {
  findPendingActivationOperation,
  requestBuilderActivationLease,
} from "./builder-activation-lease.js";
import { resolveUidForSlug } from "./assigned-roster.js";

export { resolveBuilderActivationPlan } from "./builder-activation-lease.js";

export interface FleetLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface GatewayPodDiagnostic {
  name: string;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  pods: GatewayPodDiagnostic[];
  error?: string;
}

export interface FleetRouterDeps {
  db: Firestore;
  logger: FleetLogger;
  workspaceSlugsForUser: (data: { username?: string | null }) => string[];
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  
  deleteAuthUserTolerantOfMissing: (uid: string) => Promise<void>;
  dedicatedGatewayIdleDefaultMs?: number;
  dedicatedGatewayIdleSweepMs?: number;
}

type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

function resolveSizingForResponse(
  glmDoc: Record<string, unknown> | undefined,
  reservation: ReturnType<typeof projectGatewayReservation>,
): {
  tier: SizingTier;
  resolvedFrom: "explicit" | "class-default" | "profile-default";
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  capacity: { targetActiveBuilders: number; typicalBuilders: number };
  monthlyCostUsd: {
    compute: number;
    onDemandCompute: number;
    savings: number;
    pricingMode: GatewayPricingMode;
    perBuilderAtTarget: number;
    perBuilderAtTypical: number;
  };
} {
  const sizingTier =
    typeof glmDoc?.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(glmDoc.sizingTier)
      ? (glmDoc.sizingTier as SizingTier)
      : undefined;
  const profile = isGatewayProfile(glmDoc?.profile) ? glmDoc.profile : undefined;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(glmDoc?.gatewayClass) ? glmDoc.gatewayClass : undefined,
    profile,
    imageProfile: isGatewayProfile(glmDoc?.imageProfile) ? glmDoc.imageProfile : undefined,
  });
  const resolved = resolveSizingTier({ sizingTier, gatewayClass, profile });
  // Paused pods are scaled to 0 replicas → no node consumption → no compute
  // bill. Reflect that in both the per-gateway surface and the fleet roll-up
  // so the operator sees real cost, not nameplate.
  const isPaused = glmDoc?.desiredStatus === "paused";
  const cost = isPaused
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perBuilderAtTarget: 0,
        perBuilderAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(resolved.tier, { pricingMode: reservation.type });
  return {
    tier: resolved.tier,
    resolvedFrom: resolved.resolvedFrom,
    resources: {
      requests: {
        cpu: resolved.preset.resources.requests.cpu,
        memory: resolved.preset.resources.requests.memory,
      },
      limits: {
        cpu: resolved.preset.resources.limits.cpu,
        memory: resolved.preset.resources.limits.memory,
      },
    },
    capacity: resolved.preset.capacity,
    monthlyCostUsd: {
      compute: cost.computeUsd,
      onDemandCompute: cost.onDemandComputeUsd,
      savings: cost.savingsUsd,
      pricingMode: cost.pricingMode,
      perBuilderAtTarget: cost.perBuilderAtTarget,
      perBuilderAtTypical: cost.perBuilderAtTypical,
    },
  };
}

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "operator" ? "operator" : "standard";
}

function normalizeGatewayClass(doc: GlmDoc | undefined): GatewayClass {
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function normalizeGatewayImageProfile(doc: GlmDoc | undefined): GatewayImageProfile {
  return resolveGatewayImageProfile({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function isTruthyQueryFlag(value: unknown): boolean {
  return value === "true" || value === "1";
}

// The K8s namespace this fleet runs in — scopes the Grafana deep-link to the env.
export function resolveFleetNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const ns = env.K8S_NAMESPACE;
  return typeof ns === "string" && ns.length > 0 ? ns : "octogee";
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }

const FLEET_RUNTIME_CONFIG_DOC_PATH = "config/orchestrator";
export const DEDICATED_GATEWAY_IDLE_DEFAULT_MS = 30 * 60 * 1000;
const DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT = 60_000;

export interface DedicatedGatewayIdleSettings {
  configuredMs: number | null;
  defaultMs: number;
  effectiveMs: number;
  sweepMs: number;
  disabled: boolean;
}

export interface FleetRuntimeSettings {
  dedicatedGatewayIdle: DedicatedGatewayIdleSettings;
}

type AdminOnboardingDriftState =
  | "healthy"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "missing-gateway"
  | "disabled-default"
  | "in-flight";

const WARNING_CODE_COHORT_DISABLED = "cohort-disabled";

type AdminOnboardingPlacementWarningCode =
  | "raw-gateway-override"
  | typeof WARNING_CODE_COHORT_DISABLED
  | "cohort-gateway-missing"
  | "cohort-gateway-retired"
  | "cohort-gateway-not-shared"
  | "cohort-model-uncataloged"
  | "cohort-reasoning-unsupported"
  | "default-cohort-disabled"
  | "default-cohort-missing"
  | "preview-cohort-missing"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "migration-in-flight";

interface AdminOnboardingPlacementWarning {
  code: AdminOnboardingPlacementWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  cohortId?: string;
  gatewayId?: string;
  uid?: string;
  slug?: string;
  operationId?: string;
}

interface AdminOnboardingLatestOperation {
  id: string;
  kind: string;
  status: string;
  gatewayId: string | null;
  inputUid: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
  input: Record<string, unknown>;
}

type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

interface AdminOnboardingCohortSummary extends OnboardingCohortConfig {
  id: string;
  role: "current" | "preview" | "available";
  enabled: boolean;
  assignmentCount: number;
  mountedCount: number;
  missingCount: number;
  orphanCount: number;
  overrideCount: number;
  gateway: {
    gatewayId: string;
    gatewayClass: GatewayClass;
    desiredStatus: AdminGatewayDesiredStatus | null;
    status: string | null;
    imageTag: string | null;
    openclawVersion: string | null;
  } | null;
  warnings: AdminOnboardingPlacementWarning[];
  lastOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingOverrideSummary {
  uid: string;
  cohortId: string;
  username: string;
  email: string;
  slug: string | null;
  currentGatewayId: string | null;
  rawGatewayOverride: string | null;
}

interface AdminOnboardingGatewaySummary {
  gatewayId: string;
  gatewayClass: GatewayClass;
  desiredStatus: AdminGatewayDesiredStatus | null;
  status: string | null;
  imageTag: string | null;
  openclawVersion: string | null;
  assignableToOnboardingCohort: boolean;
  hostedCohortIds: string[];
  hostedCohortLabels: string[];
  defaultTarget: boolean;
  currentTarget: boolean;
  previewTarget: boolean;
  assignedCount: number;
  mountedCount: number;
  driftCount: number;
  warnings: AdminOnboardingPlacementWarning[];
  lastOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingCustomerProjection {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  cohortId: string | null;
  cohortLabel: string | null;
  rawGatewayOverride: string | null;
  policyTargetGatewayId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  provisioningStatus: string | null;
  initialModelProvider: string | null;
  initialModel: string | null;
  initialModelReasoningEffort: string | null;
  driftState: AdminOnboardingDriftState;
  warnings: AdminOnboardingPlacementWarning[];
  latestOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingCohortResponse {
  policy: {
    defaultGatewayId: string | null;
    currentOnboardingCohortId: string | null;
    previewOnboardingCohortId: string | null;
    onboardingCohorts: Record<string, OnboardingCohortConfig>;
    cohortOverrides: Record<string, string>;
    rawGatewayOverrides: Record<string, string>;
  };
  config: {
    defaultGatewayId: string | null;
    currentOnboardingCohortId: string | null;
    previewOnboardingCohortId: string | null;
    onboardingCohorts: Record<string, OnboardingCohortConfig>;
    cohortOverrides: Record<string, string>;
  };
  cohorts: AdminOnboardingCohortSummary[];
  overrides: AdminOnboardingOverrideSummary[];
  gateways: AdminOnboardingGatewaySummary[];
  customers: AdminOnboardingCustomerProjection[];
  modelCatalog: readonly OnboardingModelCatalogEntry[];
  driftSummary: Record<AdminOnboardingDriftState, number>;
  assignmentCounts: {
    byCohort: Record<string, number>;
    uncohorted: number;
  };
  warnings: AdminOnboardingPlacementWarning[];
  generatedAt: string;
}

interface OnboardingCohortPatchOk {
  currentOnboardingCohortId: string;
  previewOnboardingCohortId: string | null;
  onboardingCohorts: Record<string, OnboardingCohortConfig>;
  cohortOverrides?: Record<string, string>;
}

function normalizedNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function idleDefaultMs(value: number | undefined): number {
  return normalizedNonNegativeInt(value) ?? DEDICATED_GATEWAY_IDLE_DEFAULT_MS;
}

export function projectDedicatedGatewayIdleSettings(
  docData: Record<string, unknown> | undefined,
  defaultMs: number | undefined,
  sweepMs: number | undefined,
): DedicatedGatewayIdleSettings {
  const resolvedDefaultMs = idleDefaultMs(defaultMs);
  const configuredMs = normalizedNonNegativeInt(docData?.dedicatedGatewayIdleMs);
  const effectiveMs = configuredMs ?? resolvedDefaultMs;
  return {
    configuredMs,
    defaultMs: resolvedDefaultMs,
    effectiveMs,
    sweepMs: normalizedNonNegativeInt(sweepMs) ?? DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT,
    disabled: effectiveMs === 0,
  };
}

export function parseDedicatedGatewayIdlePatch(
  body: Record<string, unknown>,
):
  | { ok: number | null }
  | { error: { status: number; body: { error: string; got?: unknown } } } {
  if (!Object.prototype.hasOwnProperty.call(body, "dedicatedGatewayIdleMs")) {
    return {
      error: {
        status: 400,
        body: { error: "dedicatedGatewayIdleMs is required" },
      },
    };
  }
  const value = body.dedicatedGatewayIdleMs;
  if (value === null) return { ok: null };
  if (normalizedNonNegativeInt(value) === null) {
    return {
      error: {
        status: 400,
        body: {
          error: "dedicatedGatewayIdleMs must be a non-negative integer number, or null to reset",
          got: value,
        },
      },
    };
  }
  return { ok: value as number };
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length > 0 && typeof raw === "string" && raw.length > 0) {
      out[key] = raw;
    }
  }
  return out;
}

function normalizeOnboardingCohortConfig(
  raw: Record<string, unknown>,
): OnboardingCohortConfig | null {
  if (
    !isNonEmptyString(raw.gatewayId) ||
    !isOnboardingModelProvider(raw.provider) ||
    !isNonEmptyString(raw.model) ||
    !isNonEmptyString(raw.label)
  ) {
    return null;
  }
  if (
    raw.reasoningEffort !== undefined &&
    !isOnboardingReasoningEffort(raw.reasoningEffort)
  ) {
    return null;
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return null;
  return {
    gatewayId: raw.gatewayId,
    provider: raw.provider,
    model: canonicalOnboardingModelId(raw.provider, raw.model) ?? raw.model,
    label: raw.label,
    ...(raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
  };
}

function normalizeOnboardingCohorts(value: unknown): Record<string, OnboardingCohortConfig> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, OnboardingCohortConfig> = {};
  for (const [cohortId, raw] of Object.entries(value)) {
    if (cohortId.length === 0 || !isPlainRecord(raw)) continue;
    const cohort = normalizeOnboardingCohortConfig(raw);
    if (cohort) out[cohortId] = cohort;
  }
  return out;
}

function normalizeOnboardingRuntimeConfig(
  data: Record<string, unknown> | undefined,
): OnboardingOrchestratorConfig {
  return {
    defaultGatewayId: asStringOrNull(data?.defaultGatewayId) ?? "",
    overrides: normalizeStringMap(data?.overrides),
    currentOnboardingCohortId:
      asStringOrNull(data?.currentOnboardingCohortId) ?? undefined,
    previewOnboardingCohortId:
      asStringOrNull(data?.previewOnboardingCohortId) ?? undefined,
    onboardingCohorts: normalizeOnboardingCohorts(data?.onboardingCohorts),
    cohortOverrides: normalizeStringMap(data?.cohortOverrides),
  };
}

async function readOnboardingRuntimeConfig(
  deps: FleetRouterDeps,
): Promise<OnboardingOrchestratorConfig> {
  const snap = await deps.db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
  return normalizeOnboardingRuntimeConfig(data);
}

function containsPlatformApiKeyMaterial(value: unknown): boolean {
  if (typeof value === "string") {
    return /^sk-(or|ant)[-_]/iu.test(value) || /^sk-or-v1-/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsPlatformApiKeyMaterial);
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (/api[_-]?key|platform[_-]?key|secret|token/iu.test(key)) return true;
    if (containsPlatformApiKeyMaterial(nested)) return true;
  }
  return false;
}

function validateCohortGateway(
  gatewayId: string,
  glmByGatewayId: Map<string, GlmDoc>,
): RolloutBodyError | null {
  const glmDoc = glmByGatewayId.get(gatewayId);
  if (!glmDoc) {
    return {
      status: 400,
      body: {
        error: "cohort gateway desired state not found",
        gatewayId,
      },
    };
  }
  if (projectDesiredStatus(glmDoc) === "retired") {
    return {
      status: 400,
      body: {
        error: "cohort gateway must not be retired",
        gatewayId,
      },
    };
  }
  const gatewayClass = normalizeGatewayClass(glmDoc);
  if (gatewayClass !== "shared") {
    return {
      status: 400,
      body: {
        error: "cohort gateway must be a shared gateway",
        gatewayId,
        gatewayClass,
      },
    };
  }
  return null;
}

// eslint-disable-next-line max-lines-per-function, complexity, sonarjs/cognitive-complexity -- Linear request validation keeps each field's operator-facing error local.
function parseOnboardingCohortPatch(
  body: Record<string, unknown>,
  glmByGatewayId: Map<string, GlmDoc>,
):
  | { ok: OnboardingCohortPatchOk }
  | { error: RolloutBodyError } {
  if (containsPlatformApiKeyMaterial(body)) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "platform API key material must not be stored in onboarding cohort config; materialize platform keys as Broker environment variables",
        },
      },
    };
  }
  if (!isNonEmptyString(body.currentOnboardingCohortId)) {
    return {
      error: {
        status: 400,
        body: { error: "currentOnboardingCohortId is required" },
      },
    };
  }
  if (!isPlainRecord(body.onboardingCohorts)) {
    return {
      error: {
        status: 400,
        body: { error: "onboardingCohorts is required" },
      },
    };
  }

  const onboardingCohorts: Record<string, OnboardingCohortConfig> = {};
  for (const [cohortId, raw] of Object.entries(body.onboardingCohorts)) {
    if (cohortId.length === 0) {
      return {
        error: {
          status: 400,
          body: { error: "cohort ids must be non-empty strings" },
        },
      };
    }
    if (!isPlainRecord(raw)) {
      return {
        error: {
          status: 400,
          body: { error: "cohort config must be an object", cohortId },
        },
      };
    }
    if (!isNonEmptyString(raw.gatewayId)) {
      return {
        error: {
          status: 400,
          body: { error: "cohort gatewayId is required", cohortId },
        },
      };
    }
    const gatewayError = validateCohortGateway(raw.gatewayId, glmByGatewayId);
    if (gatewayError) return { error: gatewayError };
    if (!isOnboardingModelProvider(raw.provider)) {
      return {
        error: {
          status: 400,
          body: {
            error: "cohort provider must be anthropic or openrouter",
            cohortId,
            got: raw.provider,
          },
        },
      };
    }
    if (!isNonEmptyString(raw.model)) {
      return {
        error: {
          status: 400,
          body: { error: "cohort model is required", cohortId },
        },
      };
    }
    const model = canonicalOnboardingModelId(raw.provider, raw.model);
    if (!model) {
      return {
        error: {
          status: 400,
          body: {
            error: "cohort model must come from the onboarding model catalog",
            cohortId,
            provider: raw.provider,
            got: raw.model,
          },
        },
      };
    }
    if (!isNonEmptyString(raw.label)) {
      return {
        error: {
          status: 400,
          body: { error: "cohort label is required", cohortId },
        },
      };
    }
    if (
      raw.reasoningEffort !== undefined &&
      !isOnboardingReasoningEffort(raw.reasoningEffort)
    ) {
      return {
        error: {
          status: 400,
          body: {
            error: "cohort reasoningEffort must be high or xhigh",
            cohortId,
            got: raw.reasoningEffort,
          },
        },
      };
    }
    if (
      raw.reasoningEffort !== undefined &&
      !isOnboardingReasoningEffortAllowed(raw.provider, model, raw.reasoningEffort)
    ) {
      return {
        error: {
          status: 400,
          body: {
            error: "cohort reasoningEffort is not available for selected model",
            cohortId,
            provider: raw.provider,
            model,
            got: raw.reasoningEffort,
          },
        },
      };
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return {
        error: {
          status: 400,
          body: { error: "cohort enabled must be a boolean", cohortId },
        },
      };
    }
    onboardingCohorts[cohortId] = {
      gatewayId: raw.gatewayId,
      provider: raw.provider,
      model,
      label: raw.label,
      ...(raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}),
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    };
  }

  const current = onboardingCohorts[body.currentOnboardingCohortId];
  if (!current) {
    return {
      error: {
        status: 400,
        body: {
          error: "currentOnboardingCohortId must reference an onboarding cohort",
          currentOnboardingCohortId: body.currentOnboardingCohortId,
        },
      },
    };
  }
  if (!isOnboardingCohortEnabled(current)) {
    return {
      error: {
        status: 400,
        body: {
          error: "currentOnboardingCohortId must reference an enabled cohort",
          currentOnboardingCohortId: body.currentOnboardingCohortId,
        },
      },
    };
  }

  const preview =
    body.previewOnboardingCohortId === null
      ? null
      : asStringOrNull(body.previewOnboardingCohortId);
  if (preview !== null) {
    const cohort = onboardingCohorts[preview];
    if (!cohort) {
      return {
        error: {
          status: 400,
          body: {
            error: "previewOnboardingCohortId must reference an onboarding cohort",
            previewOnboardingCohortId: preview,
          },
        },
      };
    }
    if (!isOnboardingCohortEnabled(cohort)) {
      return {
        error: {
          status: 400,
          body: {
            error: "previewOnboardingCohortId must reference an enabled cohort",
            previewOnboardingCohortId: preview,
          },
        },
      };
    }
  }

  const cohortOverrides =
    body.cohortOverrides === undefined
      ? undefined
      : normalizeStringMap(body.cohortOverrides);
  if (cohortOverrides) {
    for (const [uid, cohortId] of Object.entries(cohortOverrides)) {
      if (!onboardingCohorts[cohortId]) {
        return {
          error: {
            status: 400,
            body: {
              error: "cohortOverrides must reference configured cohorts",
              uid,
              cohortId,
            },
          },
        };
      }
    }
  }

  return {
    ok: {
      currentOnboardingCohortId: body.currentOnboardingCohortId,
      previewOnboardingCohortId: preview,
      onboardingCohorts,
      ...(cohortOverrides ? { cohortOverrides } : {}),
    },
  };
}

function readUserOnboardingCohortId(data: Record<string, unknown>): string | null {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.onboardingCohortId);
}

function readUserOpenclaw(data: Record<string, unknown>): Record<string, unknown> {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
}

function readProvisioningStatus(data: Record<string, unknown>): string | null {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(provisioning.status) ?? asStringOrNull(readUserOpenclaw(data).status);
}

function cohortRole(
  cohortId: string,
  config: OnboardingOrchestratorConfig,
): AdminOnboardingCohortSummary["role"] {
  if (cohortId === config.currentOnboardingCohortId) return "current";
  if (cohortId === config.previewOnboardingCohortId) return "preview";
  return "available";
}

function cohortWarnings(
  cohortId: string,
  cohort: OnboardingCohortConfig,
  glmByGatewayId: Map<string, GlmDoc>,
): AdminOnboardingPlacementWarning[] {
  const warnings: AdminOnboardingPlacementWarning[] = [];
  if (!isOnboardingCohortEnabled(cohort)) {
    warnings.push({
      code: WARNING_CODE_COHORT_DISABLED,
      severity: "warning",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} is disabled`,
    });
  }
  const glmDoc = glmByGatewayId.get(cohort.gatewayId);
  if (!glmDoc) {
    warnings.push({
      code: "cohort-gateway-missing",
      severity: "error",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} points at missing gateway ${cohort.gatewayId}`,
    });
    return warnings;
  }
  const desiredStatus = projectDesiredStatus(glmDoc);
  if (desiredStatus === "retired") {
    warnings.push({
      code: "cohort-gateway-retired",
      severity: "error",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} points at retired gateway ${cohort.gatewayId}`,
    });
  }
  const gatewayClass = normalizeGatewayClass(glmDoc);
  if (gatewayClass !== "shared") {
    warnings.push({
      code: "cohort-gateway-not-shared",
      severity: "error",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} points at ${gatewayClass} gateway ${cohort.gatewayId}`,
    });
  }
  if (!onboardingModelCatalogEntryFor(cohort.provider, cohort.model)) {
    warnings.push({
      code: "cohort-model-uncataloged",
      severity: "warning",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} uses uncataloged ${cohort.provider} model ${cohort.model}`,
    });
  } else if (
    cohort.reasoningEffort &&
    !isOnboardingReasoningEffortAllowed(cohort.provider, cohort.model, cohort.reasoningEffort)
  ) {
    warnings.push({
      code: "cohort-reasoning-unsupported",
      severity: "warning",
      cohortId,
      gatewayId: cohort.gatewayId,
      message: `${cohortId} uses ${cohort.reasoningEffort} reasoning on ${cohort.model}, but that model catalog row does not allow it`,
    });
  }
  return warnings;
}

function sortedCohortEntries(
  config: OnboardingOrchestratorConfig,
): Array<[string, OnboardingCohortConfig]> {
  const entries = Object.entries(config.onboardingCohorts ?? {});
  return entries.sort(([a], [b]) => {
    const rank = (id: string): number => {
      if (id === config.currentOnboardingCohortId) return 0;
      if (id === config.previewOnboardingCohortId) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function shapeOnboardingOperation(
  id: string,
  data: Record<string, unknown>,
): AdminOnboardingLatestOperation {
  return {
    id,
    kind: asStringOrNull(data.kind) ?? "unknown",
    status: asStringOrNull(data.status) ?? "unknown",
    gatewayId: asStringOrNull(data.gatewayId),
    inputUid: asStringOrNull(data.inputUid),
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    input: isPlainRecord(data.input) ? data.input : {},
  };
}

function latestOperation(
  operations: ReadonlyArray<AdminOnboardingLatestOperation>,
  predicate: (operation: AdminOnboardingLatestOperation) => boolean,
): AdminOnboardingLatestOperation | null {
  return operations
    .filter(predicate)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

function operationUid(operation: AdminOnboardingLatestOperation): string | null {
  return asStringOrNull(operation.input.uid) ?? asStringOrNull(operation.inputUid);
}

function operationTouchesGateway(
  operation: AdminOnboardingLatestOperation,
  gatewayId: string,
): boolean {
  return (
    operation.gatewayId === gatewayId ||
    operation.input.gatewayId === gatewayId ||
    operation.input.fromGatewayId === gatewayId ||
    operation.input.toGatewayId === gatewayId
  );
}

function isInFlightOperation(operation: AdminOnboardingLatestOperation | null): boolean {
  return operation?.status === "pending" || operation?.status === "running";
}

function mountedGatewayBySlug(
  gatewayDocs: ReadonlyArray<FirestoreDocLike>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const doc of gatewayDocs) {
    const data = doc.data();
    const gatewayId = asStringOrNull(data.gatewayId) ?? doc.id;
    for (const slug of readMountedSlugs(data)) {
      out.set(slug, gatewayId);
    }
  }
  return out;
}

function policyTarget(decision: OnboardingPlacementDecision): {
  cohortId: string | null;
  gatewayId: string | null;
  warning: AdminOnboardingPlacementWarning | null;
} {
  if (decision.kind === "cohort") {
    return { cohortId: decision.cohortId, gatewayId: decision.cohort.gatewayId, warning: null };
  }
  if (decision.kind === "legacy-gateway-override") {
    return { cohortId: null, gatewayId: decision.gatewayId, warning: null };
  }
  if (decision.kind === "legacy-default") {
    return { cohortId: null, gatewayId: decision.gatewayId, warning: null };
  }
  return {
    cohortId: decision.cohortId,
    gatewayId: null,
    warning: {
      code:
        decision.reason === WARNING_CODE_COHORT_DISABLED
          ? WARNING_CODE_COHORT_DISABLED
          : "default-cohort-missing",
      severity: "error",
      cohortId: decision.cohortId,
      message: `placement cohort ${decision.cohortId} is ${placementDecisionLabel(decision.reason)}`,
    },
  };
}

function placementDecisionLabel(reason: "cohort-not-found" | typeof WARNING_CODE_COHORT_DISABLED): string {
  return reason === WARNING_CODE_COHORT_DISABLED ? "disabled" : "missing";
}

function shouldIncludeOnboardingCustomer(input: {
  uid: string;
  data: Record<string, unknown>;
  config: OnboardingOrchestratorConfig;
}): boolean {
  return (
    input.data.approved === true ||
    readUserGatewayId(input.data) !== null ||
    readUserOnboardingCohortId(input.data) !== null ||
    Boolean(input.config.cohortOverrides?.[input.uid]) ||
    Boolean(input.config.overrides?.[input.uid])
  );
}

// eslint-disable-next-line complexity -- Warning projection intentionally enumerates each drift state with its distinct operator message.
function userPlacementWarnings(input: {
  uid: string;
  slug: string | null;
  cohortId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  driftState: AdminOnboardingDriftState;
  latestOperation: AdminOnboardingLatestOperation | null;
  policyWarning: AdminOnboardingPlacementWarning | null;
}): AdminOnboardingPlacementWarning[] {
  const warnings: AdminOnboardingPlacementWarning[] = [];
  if (input.policyWarning) warnings.push({ ...input.policyWarning, uid: input.uid, slug: input.slug ?? undefined });
  if (input.driftState === "pointer-drift") {
    warnings.push({
      code: "pointer-drift",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      cohortId: input.cohortId ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but policy targets ${input.policyTargetGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "assigned-not-mounted") {
    warnings.push({
      code: "assigned-not-mounted",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      cohortId: input.cohortId ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but is not mounted there`,
    });
  }
  if (input.driftState === "mounted-orphan") {
    warnings.push({
      code: "mounted-orphan",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      cohortId: input.cohortId ?? undefined,
      gatewayId: input.mountedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is mounted on ${input.mountedGatewayId ?? "none"} but assigned to ${input.assignedGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "in-flight" && input.latestOperation) {
    warnings.push({
      code: "migration-in-flight",
      severity: "info",
      uid: input.uid,
      slug: input.slug ?? undefined,
      operationId: input.latestOperation.id,
      message: `${input.latestOperation.kind} ${input.latestOperation.id} is ${input.latestOperation.status}`,
    });
  }
  return warnings;
}

// eslint-disable-next-line complexity -- Drift classification is a prioritized decision table.
function driftStateForCustomer(input: {
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  policyWarning: AdminOnboardingPlacementWarning | null;
  latestOperation: AdminOnboardingLatestOperation | null;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminOnboardingDriftState {
  if (isInFlightOperation(input.latestOperation)) return "in-flight";
  if (input.policyWarning?.code === WARNING_CODE_COHORT_DISABLED) return "disabled-default";
  if (
    input.policyTargetGatewayId &&
    (!input.glmByGatewayId.has(input.policyTargetGatewayId) ||
      projectDesiredStatus(input.glmByGatewayId.get(input.policyTargetGatewayId)) === "retired")
  ) {
    return "missing-gateway";
  }
  if (
    input.assignedGatewayId &&
    input.policyTargetGatewayId &&
    input.assignedGatewayId !== input.policyTargetGatewayId
  ) {
    return "pointer-drift";
  }
  if (
    input.mountedGatewayId &&
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "mounted-orphan";
  }
  if (input.mountedGatewayId && !input.assignedGatewayId) return "mounted-orphan";
  if (
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "assigned-not-mounted";
  }
  return "healthy";
}

function buildCustomerPlacementProjection(input: {
  uid: string;
  data: Record<string, unknown>;
  config: OnboardingOrchestratorConfig;
  mountedBySlug: Map<string, string>;
  operations: ReadonlyArray<AdminOnboardingLatestOperation>;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminOnboardingCustomerProjection {
  const openclaw = readUserOpenclaw(input.data);
  const slug = resolveCustomerSlug(input.data, (userData) =>
    asStringOrNull(userData.username) ? [asStringOrNull(userData.username)!] : [],
  );
  const assignedGatewayId = readUserGatewayId(input.data);
  const assignedCohortId = readUserOnboardingCohortId(input.data);
  const decision = resolveOnboardingPlacementForUid(input.uid, input.config);
  const target = policyTarget(decision);
  const mountedGatewayId = slug ? input.mountedBySlug.get(slug) ?? null : null;
  const latestOp = latestOperation(
    input.operations,
    (operation: AdminOnboardingLatestOperation) => operationUid(operation) === input.uid,
  );
  const driftState = driftStateForCustomer({
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId: target.gatewayId,
    policyWarning: target.warning,
    latestOperation: latestOp,
    glmByGatewayId: input.glmByGatewayId,
  });
  const cohort = assignedCohortId ? input.config.onboardingCohorts?.[assignedCohortId] : null;
  const warnings = userPlacementWarnings({
    uid: input.uid,
    slug,
    cohortId: assignedCohortId,
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId: target.gatewayId,
    driftState,
    latestOperation: latestOp,
    policyWarning: target.warning,
  });
  return {
    uid: input.uid,
    username: asStringOrNull(input.data.username) ?? "",
    email: asStringOrNull(input.data.email) ?? "",
    slug,
    cohortId: assignedCohortId,
    cohortLabel: cohort?.label ?? null,
    rawGatewayOverride: input.config.overrides?.[input.uid] ?? null,
    policyTargetGatewayId: target.gatewayId,
    assignedGatewayId,
    mountedGatewayId,
    provisioningStatus: readProvisioningStatus(input.data),
    initialModelProvider: asStringOrNull(openclaw.initialModelProvider),
    initialModel: asStringOrNull(openclaw.initialModel),
    initialModelReasoningEffort: asStringOrNull(openclaw.initialModelReasoningEffort),
    driftState,
    warnings,
    latestOperation: latestOp,
  };
}

function countBy<T extends string | null>(
  items: ReadonlyArray<AdminOnboardingCustomerProjection>,
  key: (item: AdminOnboardingCustomerProjection) => T,
): Record<Exclude<T, null>, number> {
  const out = {} as Record<Exclude<T, null>, number>;
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    out[value as Exclude<T, null>] = (out[value as Exclude<T, null>] ?? 0) + 1;
  }
  return out;
}

// eslint-disable-next-line max-lines-per-function, complexity -- Builds one Admin Ops projection from Firestore snapshots so callers get a consistent response shape.
function buildOnboardingCohortResponse(opts: {
  config: OnboardingOrchestratorConfig;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  userDocs: ReadonlyArray<FirestoreDocLike>;
  operationDocs: ReadonlyArray<FirestoreDocLike>;
}): AdminOnboardingCohortResponse {
  const glmByGatewayId = indexGlmDocs(opts.glmDocs);
  const heartbeatByGatewayId = indexFirestoreDocs(opts.gatewayDocs);
  const usersById = indexFirestoreDocs(opts.userDocs);
  const cohortOverrides = opts.config.cohortOverrides ?? {};
  const rawGatewayOverrides = opts.config.overrides ?? {};
  const operations = opts.operationDocs.map((doc) =>
    shapeOnboardingOperation(doc.id, doc.data()),
  );
  const mountedBySlug = mountedGatewayBySlug(opts.gatewayDocs);
  const customers = opts.userDocs
    .filter((doc) =>
      shouldIncludeOnboardingCustomer({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
      }),
    )
    .map((doc) =>
      buildCustomerPlacementProjection({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
        mountedBySlug,
        operations,
        glmByGatewayId,
      }),
    )
    .sort((a, b) =>
      (a.slug ?? a.username ?? a.email ?? a.uid).localeCompare(
        b.slug ?? b.username ?? b.email ?? b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const assignmentCountsByCohort = countBy(customers, (customer) => customer.cohortId);
  const mountedCountsByCohort = countBy(
    customers,
    (customer) =>
      customer.cohortId &&
      customer.mountedGatewayId === opts.config.onboardingCohorts?.[customer.cohortId]?.gatewayId
        ? customer.cohortId
        : null,
  );
  const overrideCountsByCohort: Record<string, number> = {};
  for (const cohortId of Object.values(cohortOverrides)) {
    overrideCountsByCohort[cohortId] =
      (overrideCountsByCohort[cohortId] ?? 0) + 1;
  }
  const mountedCountsByGateway = countBy(customers, (customer) => customer.mountedGatewayId);
  const assignedCountsByGateway = countBy(customers, (customer) => customer.assignedGatewayId);
  const driftCountsByGateway: Record<string, number> = {};
  for (const customer of customers) {
    if (customer.driftState === "healthy") continue;
    const touchedGatewayIds = new Set(
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    );
    for (const gatewayId of touchedGatewayIds) {
      driftCountsByGateway[gatewayId] = (driftCountsByGateway[gatewayId] ?? 0) + 1;
    }
  }
  const driftSummary: Record<AdminOnboardingDriftState, number> = {
    healthy: 0,
    "pointer-drift": 0,
    "assigned-not-mounted": 0,
    "mounted-orphan": 0,
    "missing-gateway": 0,
    "disabled-default": 0,
    "in-flight": 0,
  };
  for (const customer of customers) driftSummary[customer.driftState] += 1;

  const cohorts = sortedCohortEntries(opts.config).map(([cohortId, cohort]) => {
    const glmDoc = glmByGatewayId.get(cohort.gatewayId);
    const heartbeat = heartbeatByGatewayId.get(cohort.gatewayId)?.data();
    const desiredStatus = projectDesiredStatus(glmDoc);
    const assigned = assignmentCountsByCohort[cohortId] ?? 0;
    const mounted = mountedCountsByCohort[cohortId] ?? 0;
    return {
      id: cohortId,
      role: cohortRole(cohortId, opts.config),
      enabled: isOnboardingCohortEnabled(cohort),
      assignmentCount: assigned,
      mountedCount: mounted,
      missingCount: Math.max(0, assigned - mounted),
      orphanCount: customers.filter(
        (customer) =>
          customer.mountedGatewayId === cohort.gatewayId &&
          customer.cohortId !== cohortId,
      ).length,
      overrideCount: overrideCountsByCohort[cohortId] ?? 0,
      gateway: glmDoc
        ? {
            gatewayId: cohort.gatewayId,
            gatewayClass: normalizeGatewayClass(glmDoc),
            desiredStatus,
            status: asStringOrNull(heartbeat?.status),
            imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
            openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
          }
        : null,
      warnings: cohortWarnings(cohortId, cohort, glmByGatewayId),
      lastOperation: latestOperation(operations, (operation) =>
        operationTouchesGateway(operation, cohort.gatewayId),
      ),
      ...cohort,
    };
  });

  const gatewayIds = new Set([
    ...glmByGatewayId.keys(),
    ...heartbeatByGatewayId.keys(),
    ...Object.values(opts.config.onboardingCohorts ?? {}).map((cohort) => cohort.gatewayId),
    ...Object.values(rawGatewayOverrides),
    ...customers.flatMap((customer) =>
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    ),
  ]);
  // eslint-disable-next-line complexity -- Gateway row projection joins desired state, heartbeat, cohort, and customer drift signals.
  const gateways = [...gatewayIds].sort().map((gatewayId) => {
    const glmDoc = glmByGatewayId.get(gatewayId);
    const heartbeat = heartbeatByGatewayId.get(gatewayId)?.data();
    const desiredStatus = projectDesiredStatus(glmDoc);
    const gatewayClass = normalizeGatewayClass(glmDoc);
    const hostedCohorts = Object.entries(opts.config.onboardingCohorts ?? {})
      .filter(([, cohort]) => cohort.gatewayId === gatewayId)
      .map(([cohortId, cohort]) => ({ cohortId, label: cohort.label }));
    const warnings = [
      ...cohorts
        .filter((cohort) => cohort.gatewayId === gatewayId)
        .flatMap((cohort) => cohort.warnings),
      ...customers
        .filter((customer) =>
          [
            customer.policyTargetGatewayId,
            customer.assignedGatewayId,
            customer.mountedGatewayId,
          ].includes(gatewayId),
        )
        .flatMap((customer) => customer.warnings),
    ];
    const currentGatewayId = opts.config.currentOnboardingCohortId
      ? opts.config.onboardingCohorts?.[opts.config.currentOnboardingCohortId]?.gatewayId
      : null;
    const previewGatewayId = opts.config.previewOnboardingCohortId
      ? opts.config.onboardingCohorts?.[opts.config.previewOnboardingCohortId]?.gatewayId
      : null;
    return {
      gatewayId,
      gatewayClass,
      desiredStatus,
      status: asStringOrNull(heartbeat?.status),
      imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
      openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
      assignableToOnboardingCohort:
        Boolean(glmDoc) && gatewayClass === "shared" && desiredStatus !== "retired",
      hostedCohortIds: hostedCohorts.map((cohort) => cohort.cohortId),
      hostedCohortLabels: hostedCohorts.map((cohort) => cohort.label),
      defaultTarget: opts.config.defaultGatewayId === gatewayId || currentGatewayId === gatewayId,
      currentTarget: currentGatewayId === gatewayId,
      previewTarget: previewGatewayId === gatewayId,
      assignedCount: assignedCountsByGateway[gatewayId] ?? 0,
      mountedCount: mountedCountsByGateway[gatewayId] ?? 0,
      driftCount: driftCountsByGateway[gatewayId] ?? 0,
      warnings,
      lastOperation: latestOperation(operations, (operation) =>
        operationTouchesGateway(operation, gatewayId),
      ),
    };
  });

  const overrides = Object.entries(cohortOverrides)
    .map(([uid, cohortId]) => {
      const userData = usersById.get(uid)?.data() ?? {};
      return {
        uid,
        cohortId,
        username: asStringOrNull(userData.username) ?? "",
        email: asStringOrNull(userData.email) ?? "",
        slug: resolveCustomerSlug(userData, (data) =>
          asStringOrNull(data.username) ? [asStringOrNull(data.username)!] : [],
        ),
        currentGatewayId: readUserGatewayId(userData),
        rawGatewayOverride: rawGatewayOverrides[uid] ?? null,
      };
    })
    .sort((a, b) =>
      (a.username || a.email || a.uid).localeCompare(
        b.username || b.email || b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const warnings: AdminOnboardingPlacementWarning[] = [];
  for (const [uid, gatewayId] of Object.entries(rawGatewayOverrides)) {
    const userData = usersById.get(uid)?.data() ?? {};
    warnings.push({
      code: "raw-gateway-override",
      severity: "warning",
      uid,
      gatewayId,
      slug: resolveCustomerSlug(userData, (data) =>
        asStringOrNull(data.username) ? [asStringOrNull(data.username)!] : [],
      ) ?? undefined,
      message: `${uid} has a raw gateway override to ${gatewayId}; this bypasses cohort placement`,
    });
  }
  if (
    opts.config.currentOnboardingCohortId &&
    !opts.config.onboardingCohorts?.[opts.config.currentOnboardingCohortId]
  ) {
    warnings.push({
      code: "default-cohort-missing",
      severity: "error",
      cohortId: opts.config.currentOnboardingCohortId,
      message: `Current cohort ${opts.config.currentOnboardingCohortId} is missing`,
    });
  }
  if (
    opts.config.previewOnboardingCohortId &&
    !opts.config.onboardingCohorts?.[opts.config.previewOnboardingCohortId]
  ) {
    warnings.push({
      code: "preview-cohort-missing",
      severity: "warning",
      cohortId: opts.config.previewOnboardingCohortId,
      message: `Preview cohort ${opts.config.previewOnboardingCohortId} is missing`,
    });
  }
  for (const cohort of cohorts) {
    warnings.push(...cohort.warnings);
  }
  for (const customer of customers) warnings.push(...customer.warnings);

  return {
    policy: {
      defaultGatewayId: opts.config.defaultGatewayId || null,
      currentOnboardingCohortId: opts.config.currentOnboardingCohortId ?? null,
      previewOnboardingCohortId: opts.config.previewOnboardingCohortId ?? null,
      onboardingCohorts: opts.config.onboardingCohorts ?? {},
      cohortOverrides,
      rawGatewayOverrides,
    },
    config: {
      defaultGatewayId: opts.config.defaultGatewayId || null,
      currentOnboardingCohortId: opts.config.currentOnboardingCohortId ?? null,
      previewOnboardingCohortId: opts.config.previewOnboardingCohortId ?? null,
      onboardingCohorts: opts.config.onboardingCohorts ?? {},
      cohortOverrides,
    },
    cohorts,
    overrides,
    gateways,
    customers,
    modelCatalog: ONBOARDING_MODEL_CATALOG,
    driftSummary,
    assignmentCounts: {
      byCohort: assignmentCountsByCohort,
      uncohorted: customers.filter((customer) => customer.cohortId === null).length,
    },
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function readAdminOnboardingCohortResponse(
  deps: FleetRouterDeps,
): Promise<AdminOnboardingCohortResponse> {
  const [config, glmSnap, gatewaySnap, usersSnap, operationsSnap] = await Promise.all([
    readOnboardingRuntimeConfig(deps),
    deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
    deps.db.collection("gateways").get(),
    deps.db.collection("users").get(),
    deps.db
      .collection(GLM_OPERATIONS_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(200)
      .get(),
  ]);
  return buildOnboardingCohortResponse({
    config,
    glmDocs: glmSnap.docs,
    gatewayDocs: gatewaySnap.docs,
    userDocs: usersSnap.docs,
    operationDocs: operationsSnap.docs,
  });
}

async function readFleetRuntimeSettings(deps: FleetRouterDeps): Promise<FleetRuntimeSettings> {
  const snap = await deps.db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
  return {
    dedicatedGatewayIdle: projectDedicatedGatewayIdleSettings(
      data,
      deps.dedicatedGatewayIdleDefaultMs,
      deps.dedicatedGatewayIdleSweepMs,
    ),
  };
}

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function indexFirestoreDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, FirestoreDocLike> {
  const out = new Map<string, FirestoreDocLike>();
  for (const doc of docs) out.set(doc.id, doc);
  return out;
}

function projectLastError(raw: unknown):
  | { slug?: string; message?: string; at: string | null }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { slug?: string; message?: string; at?: unknown };
  return { slug: e.slug, message: e.message, at: toIso(e.at) };
}

function projectDesiredStatus(glmDoc: GlmDoc | undefined):
  | "running" | "paused" | "draining" | "retired" | null {
  const v = glmDoc?.desiredStatus;
  if (typeof v !== "string") return null;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function requestedGatewayStatus(
  desiredStatus: ReturnType<typeof projectDesiredStatus>,
): string {
  if (desiredStatus === "running") return "booting";
  if (desiredStatus === "paused") return "paused";
  if (desiredStatus === "draining") return "draining";
  return "unknown";
}

function openclawVersionFromImageTag(imageTag: unknown): string | null {
  if (typeof imageTag !== "string") return null;
  const match = imageTag.match(/^[0-9a-f]{7,40}-oc(.+)$/u);
  return match?.[1] ?? null;
}

function projectOpenclawVersion(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.openclawVersion === "string" && data.openclawVersion !== "unknown") {
    return data.openclawVersion;
  }
  return openclawVersionFromImageTag(glmDoc?.imageTag);
}

function projectImageTag(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.version === "string") return data.version;
  return typeof glmDoc?.imageTag === "string" ? glmDoc.imageTag : null;
}

function syntheticGatewayDoc(id: string): FirestoreDocLike {
  return { id, data: () => ({ gatewayId: id }) };
}

function shouldProjectDesiredOnlyGateway(glmDoc: GlmDoc | undefined): boolean {
  const desiredStatus = projectDesiredStatus(glmDoc);
  return desiredStatus !== null && desiredStatus !== "retired";
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

type ProjectedGatewayStorage = {
  mode: "emptyDir" | "pvc";
  pvcName: string | null;
  size: string | null;
  storageClassName: string | null;
  accessModes: string[];
};

function emptyDirGatewayStorage(): ProjectedGatewayStorage {
  return {
    mode: "emptyDir",
    pvcName: null,
    size: null,
    storageClassName: null,
    accessModes: [],
  };
}

function pvcNameForGateway(
  gatewayId: string,
  persistence: Record<string, unknown>,
): string {
  if (typeof persistence.existingClaim === "string" && persistence.existingClaim.length > 0) {
    return persistence.existingClaim;
  }
  return `octogee-gateway-${gatewayId}-data`;
}

function projectGatewayStorage(
  gatewayId: string,
  glmDoc: GlmDoc | undefined,
): ProjectedGatewayStorage {
  const persistence = isPlainRecord(glmDoc?.persistence) ? glmDoc.persistence : undefined;
  if (persistence?.enabled !== true) return emptyDirGatewayStorage();
  return {
    mode: "pvc",
    pvcName: pvcNameForGateway(gatewayId, persistence),
    size: typeof persistence.size === "string" ? persistence.size : null,
    storageClassName:
      typeof persistence.storageClassName === "string"
        ? persistence.storageClassName
        : null,
    accessModes: stringArray(persistence.accessModes),
  };
}

function gatewayComputeClassBase(): string {
  return resolveFleetNamespace() === "octogee-test"
    ? "octogee-gateway-test"
    : "octogee-gateway";
}

export function projectGatewayReservation(
  glmDoc: GlmDoc | undefined,
): {
  type: GatewayPricingMode;
  computeClass: string;
  priceMultiplier: number;
} {
  const explicitComputeClass =
    typeof glmDoc?.computeClass === "string" && glmDoc.computeClass.length > 0
      ? glmDoc.computeClass
      : null;
  const scheduling =
    glmDoc?.scheduling === "on-demand" || glmDoc?.scheduling === "spot"
      ? glmDoc.scheduling
      : "spot";
  const base = gatewayComputeClassBase();
  const computeClass = explicitComputeClass ?? (scheduling === "spot" ? `${base}-spot` : base);
  const type: GatewayPricingMode = computeClass.includes("spot") ? "spot" : "on-demand";
  return {
    type,
    computeClass,
    priceMultiplier: type === "spot" ? SPOT_PRICE_MULTIPLIER : 1,
  };
}

export function projectGatewaySummary(
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): {
  gatewayId: string; status: string;
  desiredStatus: AdminGatewayDesiredStatus | null;
  imageTag: string | null; openclawVersion: string | null;
  mountedCustomers: unknown[];
  lastHeartbeatAt: string | null; heartbeatAgeMs: number | null;
  startedAt: string | null; uptimeMs: number | null;
  lastError: ReturnType<typeof projectLastError>;
  sizing: ReturnType<typeof resolveSizingForResponse>;
  storage: ReturnType<typeof projectGatewayStorage>;
  reservation: ReturnType<typeof projectGatewayReservation>;
  profile: GatewayProfile;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
} {
  const data = doc.data();
  const gatewayId = typeof data.gatewayId === "string" ? data.gatewayId : doc.id;
  const desiredStatus = projectDesiredStatus(glmDoc);
  const reservation = projectGatewayReservation(glmDoc);
  return {
    gatewayId,
    status: typeof data.status === "string" ? data.status : requestedGatewayStatus(desiredStatus),
    desiredStatus,
    imageTag: projectImageTag(data, glmDoc),
    openclawVersion: projectOpenclawVersion(data, glmDoc),
    mountedCustomers: Array.isArray(data.mountedCustomers) ? data.mountedCustomers : [],
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    heartbeatAgeMs: ageMsOrNull(toMillis(data.lastHeartbeatAt), now),
    startedAt: toIso(data.startedAt),
    uptimeMs: ageMsOrNull(toMillis(data.startedAt), now),
    lastError: projectLastError(data.lastError),
    sizing: resolveSizingForResponse(glmDoc, reservation),
    storage: projectGatewayStorage(gatewayId, glmDoc),
    reservation,
    profile: normalizeGatewayProfile(glmDoc?.profile),
    gatewayClass: normalizeGatewayClass(glmDoc),
    imageProfile: normalizeGatewayImageProfile(glmDoc),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
): {
  gateways: { total: number; ready: number; unreachable: number };
  customersMounted: number;
  fleetCost: {
    monthlyUsd: number;
    onDemandMonthlyUsd: number;
    savingsUsd: number;
    byTier: Record<string, {
      count: number;
      subtotalUsd: number;
      onDemandSubtotalUsd: number;
      spotCount: number;
      onDemandCount: number;
    }>;
  };
} {
  let ready = 0, unreachable = 0, customersMounted = 0, fleetMonthlyUsd = 0, fleetOnDemandUsd = 0;
  const byTier: Record<string, {
    count: number;
    subtotalUsd: number;
    onDemandSubtotalUsd: number;
    spotCount: number;
    onDemandCount: number;
  }> = {};
  for (const g of gateways) {
    // Derived reachability (replaces the deleted Cloud-Function "unreachable" writer):
    // a gateway whose heartbeat has aged out is unreachable, whatever its last
    // self-reported status said. See FLEET-RECONCILE-SPEC.
    const stale = g.heartbeatAgeMs != null && g.heartbeatAgeMs > GATEWAY_UNREACHABLE_AFTER_MS;
    if (stale) unreachable++;
    else if (g.status === "ready") ready++;
    customersMounted += g.mountedCustomers.length;
    fleetMonthlyUsd += g.sizing.monthlyCostUsd.compute;
    fleetOnDemandUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    const entry = byTier[g.sizing.tier] ?? {
      count: 0,
      subtotalUsd: 0,
      onDemandSubtotalUsd: 0,
      spotCount: 0,
      onDemandCount: 0,
    };
    entry.count += 1;
    entry.subtotalUsd += g.sizing.monthlyCostUsd.compute;
    entry.onDemandSubtotalUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    if (g.reservation.type === "spot") entry.spotCount += 1;
    else entry.onDemandCount += 1;
    byTier[g.sizing.tier] = entry;
  }
  return {
    gateways: { total: gateways.length, ready, unreachable },
    customersMounted,
    fleetCost: {
      monthlyUsd: fleetMonthlyUsd,
      onDemandMonthlyUsd: fleetOnDemandUsd,
      savingsUsd: Math.max(0, fleetOnDemandUsd - fleetMonthlyUsd),
      byTier,
    },
  };
}

const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const OP_KIND_MIGRATE_CUSTOMER = "migrate-customer";
const GATEWAY_IMAGE_REPO_PREFIX =
  "us-central1-docker.pkg.dev/octogee/octogee/";
const BUILDS_SERVICE_ALLOWLIST = new Set([
  "octogee-gateway",
  "gateway-edge",
]);

const OP_KINDS = new Set([
  "add-gateway",
  OP_KIND_MIGRATE_CUSTOMER,
  "retire-gateway",
  "restart-gateway",
  "rollout",
  "deprovision-customer",
]);
const OP_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
]);

interface StripeRefs {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
}

interface DrawerMountedCustomer {
  uid: string;
  slug: string;
  username: string;
  email: string;
  lastActive: string | null;
}

interface DrawerOperation {
  id: string;
  kind: string;
  status: string;
  createdBy: string;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: unknown[];
  error?: string;
  rolledBack?: boolean;
}

interface NewOperationInput {
  kind:
    | "add-gateway"
    | typeof OP_KIND_MIGRATE_CUSTOMER
    | "retire-gateway"
    | "restart-gateway"
    | "rollout"
    | "deprovision-customer";
  createdBy: string;
  input: Record<string, unknown>;
}

interface AddGatewayBody {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile: string;
  gatewayClass: string;
  imageProfile: string;
  sizingTier: string;
  ownerUid: string;
  builderSlug: string;
}

interface AddGatewayCreate {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  sizingTier?: SizingTier;
  ownerUid?: string;
  builderSlug?: string;
}

interface FulfillOperatorReservationBody {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
}

interface FulfillableOperatorReservation {
  uid: string;
  builderSlug: string;
  requestedSizingTier: SizingTier;
  requestedAt: number;
}

interface ActivatableOperatorReservation {
  uid: string;
  builderSlug: string;
  gatewayId: string;
}

interface AdminOperatorGatewayReservationSummary {
  uid: string;
  builderSlug: string | null;
  requestedSizingTier: SizingTier | null;
  status: string;
  billingStatus: string;
  currentGatewayId: string | null;
  currentGatewayProfile: GatewayProfile | null;
  gatewayId: string | null;
  operationId: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  provisioningStartedAt: string | null;
  provisioningStartedBy: string | null;
  activationOperationId: string | null;
  activationStartedAt: string | null;
  activationStartedBy: string | null;
  fulfilledAt: string | null;
  fulfilledByOperationId: string | null;
  readyToFulfill: boolean;
  fulfillBlockedReason: string | null;
}

interface CustomerLookupDoc {
  id: string;
  data: () =>
    | { provisioning?: { openclaw?: { gatewayId?: string } } }
    | undefined;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function coerceNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toMillis(v: unknown): number | null {
  if (v == null) return null;
  const t = v as { toDate?: () => Date };
  if (typeof t?.toDate === "function") return t.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}

function toIso(v: unknown): string | null {
  const ms = toMillis(v);
  return ms == null ? null : new Date(ms).toISOString();
}

function ageMsOrNull(ms: number | null, now: number): number | null {
  return ms == null ? null : now - ms;
}

function isValidGatewayImageRepository(repo: string): boolean {
  return repo.startsWith(GATEWAY_IMAGE_REPO_PREFIX);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

interface RolloutBodyOk {
  imageTag: string;
  imageRepository: string | null;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
}

// A PATCH may move a gateway between running/paused/draining, but NOT to
// "retired": that must run full teardown via DELETE (which creates the
// retire-gateway op). A bare PATCH to "retired" only flips desired state, and
// the reconciler would then remove the pod while stranding the PVC, both
// auth-token secrets, the GSA, and the Firestore records.
export function validateDesiredStatusPatch(
  desiredStatus: string,
):
  | { error: { status: number; body: { error: string; got?: string } } }
  | { ok: "running" | "paused" | "draining" } {
  if (desiredStatus === "retired") {
    return {
      error: {
        status: 400,
        body: {
          error:
            "retire a gateway via DELETE /gateways/:id (full teardown), not PATCH desiredStatus=retired",
        },
      },
    };
  }
  if (
    desiredStatus !== "running" &&
    desiredStatus !== "paused" &&
    desiredStatus !== "draining"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "desiredStatus must be one of: running, paused, draining",
          got: desiredStatus,
        },
      },
    };
  }
  return { ok: desiredStatus };
}

// eslint-disable-next-line complexity -- Linear API validation keeps each field's error response local.
export function validateRolloutBody(
  body: Partial<{
    imageTag: string;
    imageRepository: string;
    profile: string;
    gatewayClass: string;
    imageProfile: string;
  }>,
): { error: RolloutBodyError } | { ok: RolloutBodyOk } {
  if (!body.imageTag || typeof body.imageTag !== "string") {
    return { error: { status: 400, body: { error: "missing imageTag" } } };
  }
  if (!IMAGE_TAG_PATTERN.test(body.imageTag)) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "imageTag must be a lowercase hex SHA (7–40 chars) or pinned bundle (e.g. abc1234-oc2026.5.2)",
          got: body.imageTag,
        },
      },
    };
  }
  if (
    body.imageRepository != null &&
    (typeof body.imageRepository !== "string" ||
      !isValidGatewayImageRepository(body.imageRepository))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "imageRepository must be the canonical Octogee Artifact Registry repo",
          expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
          got: body.imageRepository,
        },
      },
    };
  }
  if (
    body.profile != null &&
    (typeof body.profile !== "string" || !isGatewayProfile(body.profile))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
          got: body.profile,
        },
      },
    };
  }
  if (
    body.gatewayClass != null &&
    (typeof body.gatewayClass !== "string" || !isGatewayClass(body.gatewayClass))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `gatewayClass must be one of: ${GATEWAY_CLASSES.join(", ")}`,
          got: body.gatewayClass,
        },
      },
    };
  }
  if (
    body.imageProfile != null &&
    (typeof body.imageProfile !== "string" || !isGatewayProfile(body.imageProfile))
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
        },
      },
    };
  }
  return {
    ok: {
      imageTag: body.imageTag,
      imageRepository: body.imageRepository ?? null,
      ...(body.profile != null
        ? { profile: body.profile as GatewayProfile }
        : {}),
      ...(body.gatewayClass != null
        ? { gatewayClass: body.gatewayClass as GatewayClass }
        : {}),
      ...(body.imageProfile != null
        ? { imageProfile: body.imageProfile as GatewayImageProfile }
        : {}),
    },
  };
}

function validateAddGatewayRequiredFields(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | {
  ok: Pick<
    AddGatewayCreate,
    "gatewayId" | "imageRepository" | "imageTag"
  >;
} {
  if (
    !isNonEmptyString(body.gatewayId) ||
    !isNonEmptyString(body.imageRepository) ||
    !isNonEmptyString(body.imageTag)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "missing required fields",
          required: ["gatewayId", "imageRepository", "imageTag"],
        },
      },
    };
  }
  if (!isValidGatewayId(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: {
          error: GATEWAY_ID_REQUIREMENT,
          got: body.gatewayId,
        },
      },
    };
  }
  return {
    ok: {
      gatewayId: body.gatewayId,
      imageRepository: body.imageRepository,
      imageTag: body.imageTag,
    },
  };
}

function validateAddGatewayProfile(
  body: Partial<AddGatewayBody>,
): {
  error: RolloutBodyError;
} | {
  ok: {
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
  };
} {
  if (body.profile !== undefined && !isGatewayProfile(body.profile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
          got: body.profile,
        },
      },
    };
  }
  if (body.gatewayClass !== undefined && !isGatewayClass(body.gatewayClass)) {
    return {
      error: {
        status: 400,
        body: {
          error: `gatewayClass must be one of: ${GATEWAY_CLASSES.join(", ")}`,
          got: body.gatewayClass,
        },
      },
    };
  }
  if (body.imageProfile !== undefined && !isGatewayProfile(body.imageProfile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
        },
      },
    };
  }
  return {
    ok: {
      ...(body.profile ? { profile: body.profile as GatewayProfile } : {}),
      ...(body.gatewayClass ? { gatewayClass: body.gatewayClass as GatewayClass } : {}),
      ...(body.imageProfile ? { imageProfile: body.imageProfile as GatewayImageProfile } : {}),
    },
  };
}

function validateAddGatewaySizing(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: { sizingTier?: SizingTier } } {
  if (
    body.sizingTier !== undefined &&
    !(SIZING_TIERS as readonly string[]).includes(body.sizingTier)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
          got: body.sizingTier,
        },
      },
    };
  }
  return {
    ok: body.sizingTier ? { sizingTier: body.sizingTier as SizingTier } : {},
  };
}

function validateAddGatewayOwnerFields(
  body: Partial<AddGatewayBody>,
  gatewayClass: GatewayClass,
): { error: RolloutBodyError } | {
  ok: { ownerUid?: string; builderSlug?: string };
} {
  if (body.ownerUid !== undefined && !isNonEmptyString(body.ownerUid)) {
    return {
      error: {
        status: 400,
        body: { error: "ownerUid must be a non-empty string" },
      },
    };
  }
  if (body.builderSlug !== undefined && !isNonEmptyString(body.builderSlug)) {
    return {
      error: {
        status: 400,
        body: { error: "builderSlug must be a non-empty string" },
      },
    };
  }
  if (
    (body.ownerUid !== undefined || body.builderSlug !== undefined) &&
    gatewayClass === "shared"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "dedicated gateway ownership requires gatewayClass=builder or gatewayClass=operator",
        },
      },
    };
  }
  if (gatewayClass === "builder" && body.ownerUid === undefined) {
    return {
      error: {
        status: 400,
        body: { error: "builder gateway requires ownerUid" },
      },
    };
  }
  if (body.builderSlug !== undefined && body.ownerUid === undefined) {
    return {
      error: {
        status: 400,
        body: { error: "builderSlug requires ownerUid" },
      },
    };
  }
  return {
    ok: {
      ...(body.ownerUid ? { ownerUid: body.ownerUid } : {}),
      ...(body.builderSlug ? { builderSlug: body.builderSlug } : {}),
    },
  };
}

function validateAddGatewayRepository(
  imageRepository: string,
): RolloutBodyError | null {
  if (!isValidGatewayImageRepository(imageRepository)) {
    return {
      status: 400,
      body: {
        error:
          "imageRepository must be the canonical Octogee Artifact Registry repo",
        expectedPrefix: GATEWAY_IMAGE_REPO_PREFIX,
        got: imageRepository,
      },
    };
  }
  return null;
}

function validateAddGatewayBody(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: AddGatewayCreate } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const profile = validateAddGatewayProfile(body);
  if ("error" in profile) return profile;
  const gatewayClass = resolveGatewayClass(profile.ok);
  const sizing = validateAddGatewaySizing(body);
  if ("error" in sizing) return sizing;
  const owner = validateAddGatewayOwnerFields(
    body,
    gatewayClass,
  );
  if ("error" in owner) return owner;
  const repoError = validateAddGatewayRepository(required.ok.imageRepository);
  if (repoError) return { error: repoError };
  return {
    ok: {
      ...required.ok,
      ...profile.ok,
      gatewayClass,
      imageProfile: resolveGatewayImageProfile(profile.ok),
      ...sizing.ok,
      ...owner.ok,
    },
  };
}

function validateFulfillOperatorReservationBody(
  body: Partial<FulfillOperatorReservationBody>,
): { error: RolloutBodyError } | { ok: FulfillOperatorReservationBody } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const repoError = validateAddGatewayRepository(required.ok.imageRepository);
  if (repoError) return { error: repoError };
  return { ok: required.ok };
}

function validateFulfillableOperatorReservation(
  uid: string,
  data: Record<string, unknown>,
): { error: RolloutBodyError } | { ok: FulfillableOperatorReservation } {
  if (data.uid !== uid) {
    return {
      error: {
        status: 409,
        body: { error: "reservation uid mismatch", uid, got: data.uid },
      },
    };
  }
  if (data.status !== "requested" || data.billingStatus !== "active") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation is not ready for fulfillment",
          status: data.status,
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (!isNonEmptyString(data.builderSlug)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing builderSlug" },
      },
    };
  }
  if (!isSizingTier(data.requestedSizingTier)) {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation has invalid requestedSizingTier",
          requestedSizingTier: data.requestedSizingTier,
        },
      },
    };
  }
  if (typeof data.requestedAt !== "number" || !Number.isFinite(data.requestedAt)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing requestedAt" },
      },
    };
  }
  return {
    ok: {
      uid,
      builderSlug: data.builderSlug,
      requestedSizingTier: data.requestedSizingTier,
      requestedAt: data.requestedAt,
    },
  };
}

function validateActivatableOperatorReservation(
  uid: string,
  data: Record<string, unknown>,
): { error: RolloutBodyError } | { ok: ActivatableOperatorReservation } {
  if (data.uid !== uid) {
    return {
      error: {
        status: 409,
        body: { error: "reservation uid mismatch", uid, got: data.uid },
      },
    };
  }
  if (data.status !== "provisioning") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation is not ready for activation",
          status: data.status,
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (data.billingStatus !== "active") {
    return {
      error: {
        status: 409,
        body: {
          error: "operator gateway reservation billing is not active",
          billingStatus: data.billingStatus,
        },
      },
    };
  }
  if (!isNonEmptyString(data.builderSlug)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing builderSlug" },
      },
    };
  }
  if (!isNonEmptyString(data.gatewayId)) {
    return {
      error: {
        status: 409,
        body: { error: "operator gateway reservation is missing gatewayId" },
      },
    };
  }
  return {
    ok: {
      uid,
      builderSlug: data.builderSlug,
      gatewayId: data.gatewayId,
    },
  };
}

function normalizeReservationGatewayProfile(v: unknown): GatewayProfile | null {
  return typeof v === "string" &&
    (GATEWAY_PROFILES as readonly string[]).includes(v)
    ? (v as GatewayProfile)
    : null;
}

function fulfillBlockedReason(
  uid: string,
  data: Record<string, unknown>,
): string | null {
  if (data.uid !== uid) return "reservation uid mismatch";
  if (data.status !== "requested") return `status is ${String(data.status)}`;
  if (data.billingStatus !== "active") {
    return `billing is ${String(data.billingStatus)}`;
  }
  if (!isNonEmptyString(data.builderSlug)) return "missing builderSlug";
  if (!isSizingTier(data.requestedSizingTier)) return "invalid requestedSizingTier";
  if (typeof data.requestedAt !== "number" || !Number.isFinite(data.requestedAt)) {
    return "missing requestedAt";
  }
  return null;
}

function projectOperatorGatewayReservation(
  doc: FirestoreDocLike,
): AdminOperatorGatewayReservationSummary {
  const data = doc.data();
  const uid = isNonEmptyString(data.uid) ? data.uid : doc.id;
  const blockedReason = fulfillBlockedReason(uid, data);
  return {
    uid,
    builderSlug: isNonEmptyString(data.builderSlug) ? data.builderSlug : null,
    requestedSizingTier: isSizingTier(data.requestedSizingTier)
      ? data.requestedSizingTier
      : null,
    status: isNonEmptyString(data.status) ? data.status : "unknown",
    billingStatus: isNonEmptyString(data.billingStatus)
      ? data.billingStatus
      : "unknown",
    currentGatewayId: asStringOrNull(data.currentGatewayId),
    currentGatewayProfile: normalizeReservationGatewayProfile(
      data.currentGatewayProfile,
    ),
    gatewayId: asStringOrNull(data.gatewayId),
    operationId: asStringOrNull(data.operationId),
    requestedAt: toIso(data.requestedAt),
    updatedAt: toIso(data.updatedAt),
    provisioningStartedAt: toIso(data.provisioningStartedAt),
    provisioningStartedBy: asStringOrNull(data.provisioningStartedBy),
    activationOperationId: asStringOrNull(data.activationOperationId),
    activationStartedAt: toIso(data.activationStartedAt),
    activationStartedBy: asStringOrNull(data.activationStartedBy),
    fulfilledAt: toIso(data.fulfilledAt),
    fulfilledByOperationId: asStringOrNull(data.fulfilledByOperationId),
    readyToFulfill: blockedReason === null,
    fulfillBlockedReason: blockedReason,
  };
}

function readUserGatewayId(data: Record<string, unknown> | undefined): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
}

function validateOperatorGatewayOwnership(opts: {
  uid: string;
  reservation: ActivatableOperatorReservation;
  gatewayData: Record<string, unknown>;
}): RolloutBodyError | null {
  if (resolveGatewayClass({
    gatewayClass: isGatewayClass(opts.gatewayData.gatewayClass)
      ? opts.gatewayData.gatewayClass
      : undefined,
    profile: isGatewayProfile(opts.gatewayData.profile)
      ? opts.gatewayData.profile
      : undefined,
    imageProfile: isGatewayProfile(opts.gatewayData.imageProfile)
      ? opts.gatewayData.imageProfile
      : undefined,
  }) !== "operator") {
    return {
      status: 409,
      body: {
        error: "reserved gateway is not operator class",
        gatewayId: opts.reservation.gatewayId,
        gatewayClass: opts.gatewayData.gatewayClass,
        profile: opts.gatewayData.profile,
      },
    };
  }
  if (opts.gatewayData.ownerUid !== opts.uid) {
    return {
      status: 409,
      body: {
        error: "reserved gateway owner does not match reservation uid",
        gatewayId: opts.reservation.gatewayId,
        ownerUid: opts.gatewayData.ownerUid,
      },
    };
  }
  if (opts.gatewayData.builderSlug !== opts.reservation.builderSlug) {
    return {
      status: 409,
      body: {
        error: "reserved gateway builderSlug does not match reservation",
        gatewayId: opts.reservation.gatewayId,
        builderSlug: opts.gatewayData.builderSlug,
      },
    };
  }
  return null;
}

function operatorReservationRank(
  reservation: AdminOperatorGatewayReservationSummary,
): number {
  if (reservation.readyToFulfill) return 0;
  if (reservation.status === "billing_pending" || reservation.billingStatus === "pending") {
    return 1;
  }
  if (reservation.status === "provisioning") return 2;
  if (reservation.status === "requested") return 3;
  if (reservation.status === "fulfilled") return 4;
  if (reservation.status === "cancelled") return 5;
  return 9;
}

function reservationSortMs(
  reservation: AdminOperatorGatewayReservationSummary,
): number {
  const parsed = Date.parse(
    reservation.updatedAt ?? reservation.requestedAt ?? "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareOperatorReservations(
  a: AdminOperatorGatewayReservationSummary,
  b: AdminOperatorGatewayReservationSummary,
): number {
  const rankDelta = operatorReservationRank(a) - operatorReservationRank(b);
  if (rankDelta !== 0) return rankDelta;
  return reservationSortMs(b) - reservationSortMs(a);
}

function resolveCustomerSlug(
  userData: Record<string, unknown>,
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"],
): string | null {
  const provisioning =
    (userData.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const openclawSlug = asStringOrNull(openclaw.slug);
  return (
    openclawSlug ??
    workspaceSlugsForUser(userData as { username?: string | null })[0] ??
    null
  );
}

function resolveStripeRefs(userData: Record<string, unknown>): StripeRefs {
  const subscription =
    (userData.subscription as Record<string, unknown> | undefined) ?? {};
  const billing =
    (userData.billing as Record<string, unknown> | undefined) ?? {};
  return {
    customerId:
      asStringOrNull(userData.stripeCustomerId) ??
      asStringOrNull(billing.stripeCustomerId),
    subscriptionId:
      asStringOrNull(subscription.id) ??
      asStringOrNull(billing.subscriptionId),
    subscriptionStatus:
      asStringOrNull(subscription.status) ??
      asStringOrNull(billing.subscriptionStatus),
  };
}

interface PendingPlacement {
  uid: string;
  username: string;
  email: string;
  currentGatewayId: string | null;
  reason: "never-assigned" | "gateway-gone";
  approvedAt: string | null;
}

interface UserPlacement {
  kind: "unassigned" | "orphan" | "assigned-not-mounted" | "mounted";
  gid: string | null;
  pending: PendingPlacement | null;
}

function classifyUserPlacement(
  uid: string,
  data: Record<string, unknown>,
  gateways: Map<string, { mountedCustomers: Set<string> }>,
): UserPlacement {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const slug = typeof openclaw.slug === "string" ? openclaw.slug : null;
  const gid =
    typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : null;
  const username = typeof data.username === "string" ? data.username : "";
  const email = typeof data.email === "string" ? data.email : "";
  const approvedAt = toIso(data.approvedAt);

  if (!gid) {
    return {
      kind: "unassigned",
      gid: null,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: null,
        reason: "never-assigned",
        approvedAt,
      },
    };
  }
  const gw = gateways.get(gid);
  if (!gw) {
    return {
      kind: "orphan",
      gid,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: gid,
        reason: "gateway-gone",
        approvedAt,
      },
    };
  }
  return {
    kind: slug && gw.mountedCustomers.has(slug) ? "mounted" : "assigned-not-mounted",
    gid,
    pending: null,
  };
}

function readMountedSlugs(
  hbData: Record<string, unknown> | undefined,
): Set<string> {
  if (!Array.isArray(hbData?.mountedCustomers)) return new Set();
  return new Set(
    (hbData.mountedCustomers as unknown[]).filter(
      (s): s is string => typeof s === "string",
    ),
  );
}

function buildMountedCustomer(
  uid: string,
  data: Record<string, unknown>,
  slug: string,
): DrawerMountedCustomer {
  return {
    uid,
    slug,
    username: typeof data.username === "string" ? data.username : "",
    email: typeof data.email === "string" ? data.email : "",
    lastActive: toIso(data.lastActive),
  };
}

function userSlug(data: Record<string, unknown>): string {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return typeof openclaw.slug === "string" ? openclaw.slug : "";
}

function shapeDrawerOperation(
  id: string,
  data: Record<string, unknown>,
): DrawerOperation {
  const kind =
    typeof data.kind === "string" && OP_KINDS.has(data.kind)
      ? data.kind
      : "unknown";
  const status =
    typeof data.status === "string" && OP_STATUSES.has(data.status)
      ? data.status
      : "unknown";
  const out: DrawerOperation = {
    id,
    kind,
    status,
    createdBy:
      typeof data.createdBy === "string" ? data.createdBy : "unknown",
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    input:
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {},
    steps: Array.isArray(data.steps) ? data.steps : [],
  };
  if (typeof data.error === "string") out.error = data.error;
  if (typeof data.rolledBack === "boolean") out.rolledBack = data.rolledBack;
  return out;
}

function serializeCustomerLookup(doc: CustomerLookupDoc): {
  uid: string;
  currentGatewayId: string | null;
} {
  const data = doc.data();
  const currentGatewayId =
    data?.provisioning?.openclaw?.gatewayId ?? null;
  return { uid: doc.id, currentGatewayId };
}

async function projectGatewaySummaryWithDiagnostics(
  deps: FleetRouterDeps,
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): Promise<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}> {
  const summary = projectGatewaySummary(doc, glmDoc, now);
  if (!deps.readGatewayPodDiagnostics) {
    return { ...summary, podDiagnostics: null };
  }
  try {
    return {
      ...summary,
      podDiagnostics: await deps.readGatewayPodDiagnostics(summary.gatewayId),
    };
  } catch (e) {
    deps.logger.warn("gateway pod diagnostics failed", {
      gatewayId: summary.gatewayId,
      error: (e as Error)?.message ?? String(e),
    });
    return {
      ...summary,
      podDiagnostics: {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        pods: [],
        error: (e as Error)?.message ?? "pod diagnostics failed",
      },
    };
  }
}

async function readMountedCustomers(db: Firestore, gatewayId: string): Promise<string[]> {
  const snap = await db.collection("gateways").doc(gatewayId).get();
  if (!snap.exists) return [];
  const data = snap.data() as { mountedCustomers?: unknown } | undefined;
  return Array.isArray(data?.mountedCustomers)
    ? (data!.mountedCustomers as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
}

function operationGatewayId(input: Record<string, unknown>): string | null {
  for (const field of ["gatewayId", "toGatewayId", "fromGatewayId"]) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  return null;
}

async function createOperation(
  db: Firestore,
  opts: NewOperationInput,
): Promise<string> {
  const gatewayId = operationGatewayId(opts.input);
  const inputUid =
    typeof opts.input.uid === "string" ? opts.input.uid : null;
  const ref = await db.collection(GLM_OPERATIONS_COLLECTION).add({
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  });
  return ref.id;
}

async function ensureGatewayCreateIsUnique(
  db: Firestore,
  body: Pick<AddGatewayCreate, "gatewayId">,
): Promise<{ error: RolloutBodyError } | { ok: true }> {
  const existing = await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(body.gatewayId)
    .get();
  if (existing.exists) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway already exists",
          gatewayId: body.gatewayId,
        },
      },
    };
  }

  return { ok: true };
}

async function resolveDedicatedGatewayOwner(opts: {
  db: Firestore;
  body: AddGatewayCreate;
  createdBy: string;
  now: number;
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): Promise<
  | { error: RolloutBodyError }
  | {
      ok: {
        ownerUid?: string;
        builderSlug?: string;
        operatorReservation?: OperatorGatewayReservationSpec;
      };
    }
> {
  const { body } = opts;
  const gatewayClass = resolveGatewayClass(body);
  if (
    (gatewayClass !== "builder" && gatewayClass !== "operator") ||
    body.ownerUid === undefined
  ) {
    return { ok: {} };
  }

  const ownerSnap = await opts.db.collection("users").doc(body.ownerUid).get();
  if (!ownerSnap.exists) {
    return {
      error: {
        status: 404,
        body: {
          error: "owner user not found",
          ownerUid: body.ownerUid,
        },
      },
    };
  }

  const userData = (ownerSnap.data() ?? {}) as Record<string, unknown>;
  const builderSlug =
    body.builderSlug ?? resolveCustomerSlug(userData, opts.workspaceSlugsForUser);
  if (!builderSlug) {
    return {
      error: {
        status: 400,
        body: {
          error:
            "builderSlug is required when owner user has no resolvable workspace slug",
          ownerUid: body.ownerUid,
        },
      },
    };
  }

  return {
    ok: {
      ownerUid: body.ownerUid,
      builderSlug,
      ...(gatewayClass === "operator"
        ? {
            operatorReservation: {
              status: "reserved" as const,
              reservedAt: opts.now,
              reservedBy: opts.createdBy,
              billingStatus: "manual" as const,
            },
          }
        : {}),
    },
  };
}

function operatorGatewayDesiredStateFromReservation(opts: {
  body: FulfillOperatorReservationBody;
  reservation: FulfillableOperatorReservation;
  createdBy: string;
  now: number;
}): Record<string, unknown> {
  const profile: GatewayProfile = "operator";
  const gatewayClass: GatewayClass = "operator";
  const imageProfile: GatewayImageProfile = "operator";
  const persistence = resolveGatewayPersistence(profile, undefined);
  return {
    gatewayId: opts.body.gatewayId,
    imageRepository: opts.body.imageRepository,
    imageTag: opts.body.imageTag,
    desiredStatus: "running",
    createdBy: opts.createdBy,
    createdAt: opts.now,
    profile,
    gatewayClass,
    imageProfile,
    ...(persistence ? { persistence } : {}),
    operatorAccess: defaultOperatorGatewayAccess(opts.reservation.uid),
    serviceAccountName: operatorGatewayServiceAccountName(opts.body.gatewayId),
    serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
    ownerUid: opts.reservation.uid,
    builderSlug: opts.reservation.builderSlug,
    sizingTier: opts.reservation.requestedSizingTier,
    operatorReservation: {
      status: "provisioning",
      reservedAt: opts.reservation.requestedAt,
      reservedBy: opts.reservation.uid,
      billingStatus: "active",
      billingVerifiedAt: opts.now,
    } satisfies OperatorGatewayReservationSpec,
  };
}

function addGatewayOperationRecord(opts: {
  createdBy: string;
  now: number;
  input: Record<string, unknown>;
}): Record<string, unknown> {
  const gatewayId =
    typeof opts.input.gatewayId === "string" ? opts.input.gatewayId : null;
  const inputUid = typeof opts.input.uid === "string" ? opts.input.uid : null;
  return {
    kind: "add-gateway",
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: opts.now,
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  };
}

export interface BuilderCandidate {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  assigned: boolean;
}

interface BuilderCandidateDoc {
  id: string;
  data: () => Record<string, unknown>;
}

// A builder is "assigned" — and therefore excluded from the operator-gateway picker —
// when any of three signals say a pet gateway already belongs to them:
//   1. they are the ownerUid (or a coOwnerUid) on a glmGateways desired-state doc,
//   2. an operatorGatewayReservations doc (id === uid) has a non-released status, or
//   3. their own user doc carries an operatorGatewayReservation with a non-released status.
// `released` is the only reservation status that frees the builder back up.
export function buildBuilderCandidates(opts: {
  approvedUsers: BuilderCandidateDoc[];
  glmGateways: BuilderCandidateDoc[];
  reservations: BuilderCandidateDoc[];
  workspaceSlugsForUser: FleetRouterDeps["workspaceSlugsForUser"];
}): BuilderCandidate[] {
  const assigned = new Set<string>();

  for (const doc of opts.glmGateways) {
    const data = doc.data();
    const ownerUid = asStringOrNull(data.ownerUid);
    if (ownerUid) assigned.add(ownerUid);
    if (Array.isArray(data.coOwnerUids)) {
      for (const co of data.coOwnerUids) {
        if (typeof co === "string" && co.length > 0) assigned.add(co);
      }
    }
  }

  for (const doc of opts.reservations) {
    const status = asStringOrNull(doc.data().status);
    if (status !== "released") assigned.add(doc.id);
  }

  const candidates = opts.approvedUsers.map((doc) => {
    const data = doc.data();
    const ownReservation =
      data.operatorGatewayReservation &&
      typeof data.operatorGatewayReservation === "object"
        ? (data.operatorGatewayReservation as { status?: unknown })
        : null;
    const ownStatus = asStringOrNull(ownReservation?.status);
    const isAssigned =
      assigned.has(doc.id) || (ownReservation !== null && ownStatus !== "released");
    return {
      uid: doc.id,
      username: asStringOrNull(data.username) ?? "",
      email: asStringOrNull(data.email) ?? "",
      slug: resolveCustomerSlug(data, opts.workspaceSlugsForUser),
      assigned: isAssigned,
    };
  });

  candidates.sort((a, b) =>
    (a.username || a.email).localeCompare(b.username || b.email, undefined, {
      sensitivity: "base",
    }),
  );
  return candidates;
}

// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { db, logger } = deps;

router.post(
    "/customer/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        const userData = userSnap.data() ?? {};

        const stripe = resolveStripeRefs(userData);
        if (stripe.customerId || stripe.subscriptionId) {
          logger.warn(
            `[admin-delete] ⚠️  STRIPE NOT CANCELLED — manual cancellation required. ` +
              `uid=${uid} email=${userData.email ?? "?"} stripeCustomerId=${stripe.customerId ?? "?"} ` +
              `subscriptionId=${stripe.subscriptionId ?? "?"} status=${stripe.subscriptionStatus ?? "?"}`,
          );
        }

        const slug = resolveCustomerSlug(userData, deps.workspaceSlugsForUser);

        if (!slug) {
          await deps.deleteAuthUserTolerantOfMissing(uid);
          await userRef.delete();
          logger.info(`[admin-delete] inline lite-delete uid=${uid}`);
          res.json({ status: "deleted-inline", uid });
          return;
        }

        const inFlight = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("kind", "==", "deprovision-customer")
          .where("inputUid", "==", uid)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflict = inFlight.docs[0] ?? null;
        if (conflict) {
          res.status(409).json({
            error: "Cleanup already in progress",
            operationId: conflict.id,
          });
          return;
        }

        const actor = req as ActorRequest;
        const operationId = await createOperation(db, {
          kind: "deprovision-customer",
          createdBy: actor.uid ?? "unknown",
          input: { uid, slug },
        });
        logger.info(
          `[admin-delete] queued deprovision-customer op=${operationId} uid=${uid} slug=${slug}`,
        );
        res.status(202).json({ status: "queued", operationId, slug });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, glmSnap, settings] = await Promise.all([
          db.collection("gateways").get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          readFleetRuntimeSettings(deps),
        ]);
        const glmByGatewayId = indexGlmDocs(glmSnap.docs);
        const heartbeatByGatewayId = indexFirestoreDocs(gwSnap.docs);
        const gatewayIds = new Set([
          ...heartbeatByGatewayId.keys(),
          ...glmByGatewayId.keys(),
        ]);
        const now = Date.now();
        const gateways = await Promise.all(
          [...gatewayIds].flatMap((gatewayId) => {
            const doc = heartbeatByGatewayId.get(gatewayId);
            const glmDoc = glmByGatewayId.get(gatewayId);
            if (!doc && !shouldProjectDesiredOnlyGateway(glmDoc)) return [];
            return [
              projectGatewaySummaryWithDiagnostics(
                deps,
                doc ?? syntheticGatewayDoc(gatewayId),
                glmDoc,
                now,
              ),
            ];
          }),
        );
        res.json({
          gateways,
          stats: rollupFleetStats(gateways),
          settings,
          namespace: resolveFleetNamespace(),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.patch(
    "/fleet-settings",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseDedicatedGatewayIdlePatch(req.body as Record<string, unknown>);
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            dedicatedGatewayIdleMs: parsed.ok,
            dedicatedGatewayIdleUpdatedAt: Date.now(),
            dedicatedGatewayIdleUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json({ settings: await readFleetRuntimeSettings(deps) });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/onboarding-cohorts",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await readAdminOnboardingCohortResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.patch(
    "/onboarding-cohorts",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const glmSnap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
        const parsed = parseOnboardingCohortPatch(
          req.body as Record<string, unknown>,
          indexGlmDocs(glmSnap.docs),
        );
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const actor = req as ActorRequest;
        const update: Record<string, unknown> = {
          currentOnboardingCohortId: parsed.ok.currentOnboardingCohortId,
          previewOnboardingCohortId: parsed.ok.previewOnboardingCohortId,
          onboardingCohorts: parsed.ok.onboardingCohorts,
          onboardingCohortsUpdatedAt: Date.now(),
          onboardingCohortsUpdatedBy: actor.uid ?? "unknown",
        };
        if (parsed.ok.cohortOverrides) {
          update.cohortOverrides = parsed.ok.cohortOverrides;
        }
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(update, { merge: true });
        res.json(await readAdminOnboardingCohortResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.put(
    "/onboarding-cohorts/:cohortId/overrides/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cohortId = req.params.cohortId as string;
        const slug = req.params.slug as string;
        const config = await readOnboardingRuntimeConfig(deps);
        const cohort = config.onboardingCohorts?.[cohortId];
        if (!cohort) {
          res.status(404).json({ error: "onboarding cohort not found", cohortId });
          return;
        }
        if (!isOnboardingCohortEnabled(cohort)) {
          res.status(409).json({ error: "onboarding cohort is disabled", cohortId });
          return;
        }
        const uid = await resolveUidForSlug(db, slug);
        if (!uid) {
          res.status(404).json({ error: "builder slug not found", slug });
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            cohortOverrides: {
              ...(config.cohortOverrides ?? {}),
              [uid]: cohortId,
            },
            onboardingCohortsUpdatedAt: Date.now(),
            onboardingCohortsUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingCohortResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.put(
    "/onboarding-cohorts/:cohortId/overrides/:uid",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const cohortId = req.params.cohortId as string;
        const uid = req.params.uid as string;
        const [config, userSnap] = await Promise.all([
          readOnboardingRuntimeConfig(deps),
          db.collection("users").doc(uid).get(),
        ]);
        const cohort = config.onboardingCohorts?.[cohortId];
        if (!cohort) {
          res.status(404).json({ error: "onboarding cohort not found", cohortId });
          return;
        }
        if (!isOnboardingCohortEnabled(cohort)) {
          res.status(409).json({ error: "onboarding cohort is disabled", cohortId });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "user not found", uid });
          return;
        }
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            cohortOverrides: {
              ...(config.cohortOverrides ?? {}),
              [uid]: cohortId,
            },
            onboardingCohortsUpdatedAt: Date.now(),
            onboardingCohortsUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingCohortResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

router.delete(
    "/onboarding-cohorts/:cohortId/overrides/:uid",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const config = await readOnboardingRuntimeConfig(deps);
        const nextOverrides = { ...(config.cohortOverrides ?? {}) };
        delete nextOverrides[uid];
        const actor = req as ActorRequest;
        await db.doc(FLEET_RUNTIME_CONFIG_DOC_PATH).set(
          {
            cohortOverrides: nextOverrides,
            onboardingCohortsUpdatedAt: Date.now(),
            onboardingCohortsUpdatedBy: actor.uid ?? "unknown",
          },
          { merge: true },
        );
        res.json(await readAdminOnboardingCohortResponse(deps));
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateway-migrations/bulk",
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Linear admin repair route validates input, adopts existing ops, or enqueues one result per uid.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          uids: unknown;
          toGatewayId: unknown;
          targetGatewayId: unknown;
          sourceGatewayId: unknown;
        }>;
        const uids = Array.isArray(body.uids)
          ? body.uids.filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
          : [];
        const toGatewayId = asStringOrNull(body.toGatewayId) ?? asStringOrNull(body.targetGatewayId);
        const sourceGatewayId = asStringOrNull(body.sourceGatewayId);
        if (!toGatewayId) {
          res.status(400).json({ error: "toGatewayId is required" });
          return;
        }
        if (uids.length === 0) {
          res.status(400).json({ error: "uids must contain at least one uid" });
          return;
        }

        const targetSnap = await db.collection("gateways").doc(toGatewayId).get();
        if (!targetSnap.exists) {
          res.status(404).json({ error: "target gateway not registered", gatewayId: toGatewayId });
          return;
        }
        const targetStatus = asStringOrNull(targetSnap.data()?.status);
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: toGatewayId,
            status: targetStatus ?? "unknown",
          });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const enqueued: Array<{ uid: string; operationId: string }> = [];
        const adopted: Array<{ uid: string; operationId: string }> = [];
        const rejected: Array<{ uid: string; reason: string; currentGatewayId?: string | null }> = [];

        for (const uid of [...new Set(uids)]) {
          const userSnap = await db.collection("users").doc(uid).get();
          if (!userSnap.exists) {
            rejected.push({ uid, reason: "user-not-found" });
            continue;
          }
          const userData = userSnap.data() as Record<string, unknown> | undefined;
          const currentGatewayId = readUserGatewayId(userData);
          const builderSlug = userData
            ? resolveCustomerSlug(userData, deps.workspaceSlugsForUser)
            : null;
          if (currentGatewayId === toGatewayId) {
            rejected.push({ uid, reason: "already-on-target", currentGatewayId });
            continue;
          }
          if (sourceGatewayId && currentGatewayId !== sourceGatewayId) {
            rejected.push({ uid, reason: "source-gateway-mismatch", currentGatewayId });
            continue;
          }
          const existing = pendingOps.docs.find((doc) => {
            const data = doc.data() as Record<string, unknown>;
            const input = isPlainRecord(data.input) ? data.input : {};
            return (
              data.kind === OP_KIND_MIGRATE_CUSTOMER &&
              (data.inputUid === uid || input.uid === uid) &&
              input.toGatewayId === toGatewayId
            );
          });
          if (existing) {
            adopted.push({ uid, operationId: existing.id });
            continue;
          }
          const operationId = await createOperation(db, {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            createdBy,
            input: {
              uid,
              ...(builderSlug ? { builderSlug } : {}),
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId,
              source: "admin-bulk-repair",
            },
          });
          enqueued.push({ uid, operationId });
        }

        res.status(202).json({
          targetGatewayId: toGatewayId,
          sourceGatewayId: sourceGatewayId ?? null,
          enqueued,
          adopted,
          rejected,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/customer-distribution",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [gwSnap, usersSnap] = await Promise.all([
          db.collection("gateways").get(),
          db.collection("users").where("approved", "==", true).get(),
        ]);

        const gateways = new Map<
          string,
          {
            status: string;
            mountedCustomers: Set<string>;
            mountedCount: number;
          }
        >();
        for (const doc of gwSnap.docs) {
          const data = doc.data() as
            | { status?: string; mountedCustomers?: unknown }
            | undefined;
          const mounted = Array.isArray(data?.mountedCustomers)
            ? (data!.mountedCustomers as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : [];
          gateways.set(doc.id, {
            status: typeof data?.status === "string" ? data.status : "unknown",
            mountedCustomers: new Set(mounted),
            mountedCount: mounted.length,
          });
        }

        const assignedByGateway = new Map<string, number>();
        const mountedByGateway = new Map<string, number>();
        const pendingPlacements: PendingPlacement[] = [];
        let totalApproved = 0;
        let assigned = 0;
        let unassigned = 0;
        let mounted = 0;

        for (const doc of usersSnap.docs) {
          totalApproved++;
          const placement = classifyUserPlacement(
            doc.id,
            doc.data() as Record<string, unknown>,
            gateways,
          );
          if (placement.pending) pendingPlacements.push(placement.pending);
          if (placement.kind === "unassigned") {
            unassigned++;
          } else if (placement.kind !== "orphan" && placement.gid) {
            assigned++;
            assignedByGateway.set(
              placement.gid,
              (assignedByGateway.get(placement.gid) ?? 0) + 1,
            );
            if (placement.kind === "mounted") {
              mounted++;
              mountedByGateway.set(
                placement.gid,
                (mountedByGateway.get(placement.gid) ?? 0) + 1,
              );
            }
          }
        }

        const perGateway = Array.from(gateways.entries()).map(
          ([gatewayId, gw]) => ({
            gatewayId,
            status: gw.status,
            assignedCount: assignedByGateway.get(gatewayId) ?? 0,
            mountedCount: mountedByGateway.get(gatewayId) ?? 0,
          }),
        );

        res.json({
          stats: {
            totalApproved,
            assigned,
            unassigned,
            mounted,
            assignedNotMounted: assigned - mounted,
          },
          perGateway,
          pendingPlacements,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways/:id/details",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const [glmSnap, hbSnap, usersSnap, opsSnap] = await Promise.all([
          db.collection(GLM_GATEWAYS_COLLECTION).doc(id).get(),
          db.collection("gateways").doc(id).get(),
          db.collection("users").where("approved", "==", true).get(),
          db
            .collection(GLM_OPERATIONS_COLLECTION)
            .where("gatewayId", "==", id)
            .limit(50)
            .get(),
        ]);
        if (!glmSnap.exists && !hbSnap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const hbData = hbSnap.exists
          ? (hbSnap.data() as Record<string, unknown>)
          : undefined;
        const mountedSlugs = readMountedSlugs(hbData);

        const mountedCustomers: DrawerMountedCustomer[] = [];
        for (const doc of usersSnap.docs) {
          const data = doc.data() as Record<string, unknown>;
          const slug = userSlug(data);
          if (!slug || !mountedSlugs.has(slug)) continue;
          mountedCustomers.push(buildMountedCustomer(doc.id, data, slug));
        }
        mountedCustomers.sort((a, b) => a.slug.localeCompare(b.slug));

        const recentOperations = opsSnap.docs
          .map((d) =>
            shapeDrawerOperation(d.id, d.data() as Record<string, unknown>),
          )
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 20);

        res.json({
          mountedCustomers,
          recentOperations,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/builder-candidates",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [usersSnap, glmSnap, reservationsSnap] = await Promise.all([
          db.collection("users").where("approved", "==", true).get(),
          db.collection(GLM_GATEWAYS_COLLECTION).get(),
          db.collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION).get(),
        ]);
        const candidates = buildBuilderCandidates({
          approvedUsers: usersSnap.docs,
          glmGateways: glmSnap.docs,
          reservations: reservationsSnap.docs,
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
        });
        res.json({ candidates, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operator-gateway-reservations",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const snap = await db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .get();
        const reservations = snap.docs
          .map(projectOperatorGatewayReservation)
          .sort(compareOperatorReservations);
        res.json({
          reservations,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/operator-gateway-reservations/:uid/activate",
    // eslint-disable-next-line complexity -- activation is a single transactional admin boundary with several explicit guard responses; splitting would hide the order of safety checks.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const reservationRef = db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          db.collection("users").doc(uid).get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "owner user not found", uid });
          return;
        }

        const reservationData = reservationSnap.data() as Record<string, unknown>;
        const userData = userSnap.data() as Record<string, unknown> | undefined;
        const currentGatewayId = readUserGatewayId(userData);
        if (
          reservationData.status === "fulfilled" &&
          currentGatewayId === reservationData.gatewayId
        ) {
          res.status(200).json({
            uid,
            gatewayId: reservationData.gatewayId,
            status: "fulfilled",
            alreadyActive: true,
          });
          return;
        }

        const reservation = validateActivatableOperatorReservation(
          uid,
          reservationData,
        );
        if ("error" in reservation) {
          res.status(reservation.error.status).json(reservation.error.body);
          return;
        }

        const [targetDesiredSnap, targetHeartbeatSnap, pendingOpsSnap] =
          await Promise.all([
            db
              .collection(GLM_GATEWAYS_COLLECTION)
              .doc(reservation.ok.gatewayId)
              .get(),
            db.collection("gateways").doc(reservation.ok.gatewayId).get(),
            db
              .collection(GLM_OPERATIONS_COLLECTION)
              .where("status", "in", ["pending", "running"])
              .get(),
          ]);
        if (!targetDesiredSnap.exists) {
          res.status(404).json({
            error: "reserved gateway desired state not found",
            gatewayId: reservation.ok.gatewayId,
          });
          return;
        }
        const ownershipError = validateOperatorGatewayOwnership({
          uid,
          reservation: reservation.ok,
          gatewayData: targetDesiredSnap.data() as Record<string, unknown>,
        });
        if (ownershipError) {
          res.status(ownershipError.status).json(ownershipError.body);
          return;
        }
        if (!targetHeartbeatSnap.exists) {
          res.status(409).json({
            error: "reserved gateway has not reported ready yet",
            gatewayId: reservation.ok.gatewayId,
            status: "missing",
          });
          return;
        }
        const targetStatus = (
          targetHeartbeatSnap.data() as Record<string, unknown> | undefined
        )?.status;
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "reserved gateway not ready",
            gatewayId: reservation.ok.gatewayId,
            status: targetStatus ?? "unknown",
          });
          return;
        }

        if (currentGatewayId === reservation.ok.gatewayId) {
          const fulfilledUpdate = {
            status: "fulfilled" as const,
            fulfilledAt: now,
            fulfilledByOperationId:
              asStringOrNull(reservationData.activationOperationId) ??
              asStringOrNull(reservationData.operationId) ??
              "already-active",
            updatedAt: now,
          };
          const batch = db.batch();
          batch.update(reservationRef, fulfilledUpdate);
          batch.update(db.collection("users").doc(uid), {
            "operatorGatewayReservation.status": "fulfilled",
            "operatorGatewayReservation.fulfilledAt": fulfilledUpdate.fulfilledAt,
            "operatorGatewayReservation.fulfilledByOperationId":
              fulfilledUpdate.fulfilledByOperationId,
            "operatorGatewayReservation.updatedAt": now,
          });
          await batch.commit();
          res.status(200).json({
            uid,
            gatewayId: reservation.ok.gatewayId,
            status: "fulfilled",
            alreadyActive: true,
          });
          return;
        }

        const existingActivation = findPendingActivationOperation(
          pendingOpsSnap.docs,
          uid,
          reservation.ok.gatewayId,
          "operator-gateway-reservation",
        );
        if (existingActivation) {
          res.status(409).json({
            error: "operator gateway activation is already running",
            uid,
            gatewayId: reservation.ok.gatewayId,
            operationId: existingActivation.id,
            kind: existingActivation.kind,
          });
          return;
        }

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const operationInput = {
          uid,
          ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
          toGatewayId: reservation.ok.gatewayId,
          source: "operator-gateway-reservation",
          operatorReservationUid: uid,
          builderSlug: reservation.ok.builderSlug,
        };
        const reservationUpdate: Partial<OperatorGatewayReservationRequest> = {
          activationOperationId: operationId,
          activationStartedAt: now,
          activationStartedBy: createdBy,
          updatedAt: now,
        };

        const batch = db.batch();
        batch.set(opRef, {
          kind: OP_KIND_MIGRATE_CUSTOMER,
          status: "pending",
          createdBy,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          input: operationInput,
          steps: [],
          gatewayId: reservation.ok.gatewayId,
          inputUid: uid,
        });
        batch.update(reservationRef, reservationUpdate);
        batch.update(db.collection("users").doc(uid), {
          "operatorGatewayReservation.activationOperationId": operationId,
          "operatorGatewayReservation.activationStartedAt": now,
          "operatorGatewayReservation.activationStartedBy": createdBy,
          "operatorGatewayReservation.updatedAt": now,
        });
        await batch.commit();

        res.status(202).json({
          uid,
          gatewayId: reservation.ok.gatewayId,
          operationId,
          status: "activating",
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/assign",
    // eslint-disable-next-line complexity -- linear request validation and one repair fast-path; each branch returns its own operator-facing response.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ gatewayId: string }>;
        if (!body.gatewayId || typeof body.gatewayId !== "string") {
          res.status(400).json({ error: "missing gatewayId in body" });
          return;
        }
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
          res.status(404).json({ error: "user not found", uid });
          return;
        }
        const userData = userSnap.data() as
          | {
              approved?: boolean;
              provisioning?: { openclaw?: { gatewayId?: string; gatewayProfile?: unknown } };
            }
          | undefined;
        if (!userData?.approved) {
          res.status(409).json({ error: "user is not approved", uid });
          return;
        }
        const heartbeatSnap = await db
          .collection("gateways")
          .doc(body.gatewayId)
          .get();
        if (!heartbeatSnap.exists) {
          res.status(404).json({
            error: ERR_GATEWAY_NOT_FOUND,
            gatewayId: body.gatewayId,
          });
          return;
        }
        const hb = heartbeatSnap.data() as { status?: string } | undefined;
        if (hb?.status !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.gatewayId,
            status: hb?.status ?? "unknown",
          });
          return;
        }
        const currentGid = userData.provisioning?.openclaw?.gatewayId;
        const glmSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(body.gatewayId).get();
        const shellState = resolveUserGatewayShellState(
          glmSnap.exists ? glmSnap.data() : undefined,
          uid,
        );
        const gatewayProfile = shellState.gatewayProfile;
        if (currentGid === body.gatewayId) {
          if (normalizeGatewayProfile(userData.provisioning?.openclaw?.gatewayProfile) !== gatewayProfile) {
            await db
              .collection("users")
              .doc(uid)
              .update({
                "provisioning.openclaw.gatewayProfile": gatewayProfile,
                "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
              });
            res.status(200).json({ uid, gatewayId: body.gatewayId, gatewayProfile, repaired: true });
            return;
          }
          res.status(409).json({
            error: "user already assigned to that gateway — no-op",
            uid,
            gatewayId: body.gatewayId,
            gatewayProfile,
          });
          return;
        }
        await db
          .collection("users")
          .doc(uid)
          .update({
            "provisioning.openclaw.gatewayId": body.gatewayId,
            "provisioning.openclaw.gatewayProfile": gatewayProfile,
            "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
          });
        res.status(202).json({ uid, gatewayId: body.gatewayId, gatewayProfile });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = req.body as Partial<{
          gatewayClass: string;
          reason: string;
        }>;
        let requestedGatewayClass: "builder" | "operator" | null = "builder";
        if (body.gatewayClass === "operator") {
          requestedGatewayClass = "operator";
        } else if (
          body.gatewayClass !== undefined &&
          body.gatewayClass !== "builder"
        ) {
          requestedGatewayClass = null;
        }
        if (requestedGatewayClass === null) {
          res.status(400).json({
            error: "gatewayClass must be builder or operator",
            got: body.gatewayClass,
          });
          return;
        }

        const result = await requestBuilderActivationLease({
          db,
          uid,
          requestedGatewayClass,
          createdBy,
          reason: typeof body.reason === "string" && body.reason.length > 0
            ? body.reason
            : "builder-activity",
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
          now,
        });
        res.status(result.statusCode).json(result.body);
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/operator-gateway-reservations/:uid/fulfill",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const parsed = validateFulfillOperatorReservationBody(
          req.body as Partial<FulfillOperatorReservationBody>,
        );
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const body = parsed.ok;

        const reservationRef = db
          .collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION)
          .doc(uid);
        const [reservationSnap, userSnap] = await Promise.all([
          reservationRef.get(),
          db.collection("users").doc(uid).get(),
        ]);
        if (!reservationSnap.exists) {
          res.status(404).json({
            error: "operator gateway reservation not found",
            uid,
          });
          return;
        }
        if (!userSnap.exists) {
          res.status(404).json({ error: "owner user not found", uid });
          return;
        }

        const reservation = validateFulfillableOperatorReservation(
          uid,
          reservationSnap.data() as Record<string, unknown>,
        );
        if ("error" in reservation) {
          res.status(reservation.error.status).json(reservation.error.body);
          return;
        }

        const uniqueness = await ensureGatewayCreateIsUnique(db, body);
        if ("error" in uniqueness) {
          res.status(uniqueness.error.status).json(uniqueness.error.body);
          return;
        }

        const gatewayServiceAccount = process.env.GATEWAY_SERVICE_ACCOUNT;
        if (!gatewayServiceAccount) {
          res.status(500).json({
            error:
              "GATEWAY_SERVICE_ACCOUNT not configured — admin cannot provision gateway auth-token secret",
          });
          return;
        }
        try {
          await deps.provisionGatewayAuthSecret({
            gatewayId: body.gatewayId,
            gatewayServiceAccount,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({
            error: "failed to provision gateway auth-token secret",
            gatewayId: body.gatewayId,
            detail: message,
          });
          return;
        }

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const operationInput = {
          uid,
          gatewayId: body.gatewayId,
          imageTag: body.imageTag,
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          sizingTier: reservation.ok.requestedSizingTier,
          builderSlug: reservation.ok.builderSlug,
          source: "operator-gateway-reservation",
        };
        const reservationUpdate: Partial<OperatorGatewayReservationRequest> = {
          status: "provisioning",
          gatewayId: body.gatewayId,
          operationId,
          provisioningStartedAt: now,
          provisioningStartedBy: createdBy,
          updatedAt: now,
        };

        const batch = db.batch();
        batch.set(
          db.collection(GLM_GATEWAYS_COLLECTION).doc(body.gatewayId),
          operatorGatewayDesiredStateFromReservation({
            body,
            reservation: reservation.ok,
            createdBy,
            now,
          }),
        );
        batch.set(
          opRef,
          addGatewayOperationRecord({
            createdBy,
            now,
            input: operationInput,
          }),
        );
        batch.update(reservationRef, reservationUpdate);
        batch.update(db.collection("users").doc(uid), {
          "operatorGatewayReservation.status": "provisioning",
          "operatorGatewayReservation.gatewayId": body.gatewayId,
          "operatorGatewayReservation.operationId": operationId,
          "operatorGatewayReservation.provisioningStartedAt": now,
          "operatorGatewayReservation.provisioningStartedBy": createdBy,
          "operatorGatewayReservation.updatedAt": now,
        });
        await batch.commit();

        res.status(202).json({
          uid,
          gatewayId: body.gatewayId,
          operationId,
          status: "provisioning",
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/gateways",
    // eslint-disable-next-line complexity -- linear preflight: validate body, check uniqueness, provision GSA secret, write desired state. Each guard returns its own error response; flattening is clearer than threading.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const parsed = validateAddGatewayBody(req.body as Partial<AddGatewayBody>);
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const body = parsed.ok;

        const uniqueness = await ensureGatewayCreateIsUnique(db, body);
        if ("error" in uniqueness) {
          res.status(uniqueness.error.status).json(uniqueness.error.body);
          return;
        }

        const owner = await resolveDedicatedGatewayOwner({
          db,
          body,
          createdBy,
          now,
          workspaceSlugsForUser: deps.workspaceSlugsForUser,
        });
        if ("error" in owner) {
          res.status(owner.error.status).json(owner.error.body);
          return;
        }

        const gatewayServiceAccount = process.env.GATEWAY_SERVICE_ACCOUNT;
        if (!gatewayServiceAccount) {
          res.status(500).json({
            error:
              "GATEWAY_SERVICE_ACCOUNT not configured — admin cannot provision gateway auth-token secret",
          });
          return;
        }
        try {
          await deps.provisionGatewayAuthSecret({
            gatewayId: body.gatewayId,
            gatewayServiceAccount,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({
            error: "failed to provision gateway auth-token secret",
            gatewayId: body.gatewayId,
            detail: message,
          });
          return;
        }
        const gatewayClass = resolveGatewayClass(body);
        const imageProfile = resolveGatewayImageProfile(body);
        const persistence = resolveGatewayPersistence(imageProfile, undefined);
        const operatorDefaults =
          gatewayClass === "operator"
            ? {
                operatorAccess: defaultOperatorGatewayAccess(owner.ok.ownerUid),
                serviceAccountName: operatorGatewayServiceAccountName(body.gatewayId),
                serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
              }
            : {};
        await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(body.gatewayId)
          .set({
            gatewayId: body.gatewayId,
            imageRepository: body.imageRepository,
            imageTag: body.imageTag,
            desiredStatus: "running",
            createdBy,
            createdAt: now,
            ...(body.profile ? { profile: body.profile } : {}),
            gatewayClass,
            ...(imageProfile !== "standard" ? { imageProfile } : {}),
            ...(persistence ? { persistence } : {}),
            ...operatorDefaults,
            ...owner.ok,
            ...(body.sizingTier ? { sizingTier: body.sizingTier } : {}),
          });
        const operationId = await createOperation(db, {
          kind: "add-gateway",
          createdBy,
          input: {
            gatewayId: body.gatewayId,
            imageTag: body.imageTag,
            ...(body.profile ? { profile: body.profile } : {}),
            gatewayClass,
            ...(imageProfile !== "standard" ? { imageProfile } : {}),
            ...(body.sizingTier ? { sizingTier: body.sizingTier } : {}),
            ...(owner.ok.ownerUid ? { ownerUid: owner.ok.ownerUid } : {}),
            ...(owner.ok.builderSlug ? { builderSlug: owner.ok.builderSlug } : {}),
          },
        });
        res
          .status(202)
          .json({ gatewayId: body.gatewayId, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.patch(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const body = req.body as Partial<{
          imageTag: string;
          desiredStatus: AdminGatewayDesiredStatus;
          sizingTier: string;
        }>;
        const update: Record<string, unknown> = {};
        if (typeof body.imageTag === "string" && body.imageTag.length > 0) {
          update.imageTag = body.imageTag;
        }
        if (body.desiredStatus !== undefined) {
          const v = validateDesiredStatusPatch(body.desiredStatus);
          if ("error" in v) {
            res.status(v.error.status).json(v.error.body);
            return;
          }
          update.desiredStatus = v.ok;
        }
        if (body.sizingTier !== undefined) {
          if (!(SIZING_TIERS as readonly string[]).includes(body.sizingTier)) {
            res.status(400).json({
              error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
              got: body.sizingTier,
            });
            return;
          }
          update.sizingTier = body.sizingTier;
        }
        if (Object.keys(update).length === 0) {
          res.status(400).json({ error: "no updatable fields provided" });
          return;
        }
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        // A direct imageTag write on a MOUNTED gateway is refused by the
        // reconciler (it would drop live sessions), but it still poisons desired
        // state so a later rollout no-ops. Route image changes through the
        // blue/green rollout op instead. Empty gateways may still be set directly.
        if (update.imageTag !== undefined) {
          const mounted = await readMountedCustomers(db, id);
          if (mounted.length > 0) {
            res.status(409).json({
              error:
                "cannot set imageTag directly on a gateway with mounted customers — roll it via POST /api/admin/gateways/:id/rollout (blue/green)",
              gatewayId: id,
              mountedCustomers: mounted,
            });
            return;
          }
        }
        await ref.update(update);
        res
          .status(202)
          .json({ gatewayId: id, updated: Object.keys(update) });
      } catch (e) {
        next(e);
      }
    },
  );

  router.delete(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const retainData = isTruthyQueryFlag(req.query.retainData);
        const retainServiceAccount = isTruthyQueryFlag(req.query.retainServiceAccount);
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const heartbeatSnap = await db.collection("gateways").doc(id).get();
        if (heartbeatSnap.exists) {
          const hbData = heartbeatSnap.data() as
            | { mountedCustomers?: unknown }
            | undefined;
          const mounted = Array.isArray(hbData?.mountedCustomers)
            ? (hbData!.mountedCustomers as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : [];
          if (mounted.length > 0) {
            res.status(409).json({
              error:
                "gateway still has mounted customers; migrate them off before retiring",
              gatewayId: id,
              mountedCustomers: mounted,
            });
            return;
          }
        }

        const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
        const operationId = opRef.id;
        const batch = db.batch();
        batch.update(ref, { desiredStatus: "retired" });
        batch.set(opRef, {
          kind: "retire-gateway",
          status: "pending",
          createdBy,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          input: {
            gatewayId: id,
            ...(retainData ? { retainData: true } : {}),
            ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
          },
          steps: [],
          gatewayId: id,
        });
        await batch.commit();
        res.status(202).json({ gatewayId: id, operationId, retainData, retainServiceAccount });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/restart",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflicting = pendingOps.docs.find((d) => {
          const opData = d.data() as
            | { input?: { gatewayId?: string } }
            | undefined;
          return opData?.input?.gatewayId === id;
        });
        if (conflicting) {
          res.status(409).json({
            error:
              "another operation is already pending or running for this gateway",
            gatewayId: id,
            operationId: conflicting.id,
            kind:
              (conflicting.data() as { kind?: string } | undefined)?.kind ??
              null,
          });
          return;
        }

        const actor = req as ActorRequest;
        const operationId = await createOperation(db, {
          kind: "restart-gateway",
          createdBy: actor.uid ?? "unknown",
          input: { gatewayId: id },
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/rollout",
    // eslint-disable-next-line complexity -- linear preflight: body validate → exists → no-op → conflicting-op → write. Each guard's response shape is distinct.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const validation = validateRolloutBody(
          req.body as Partial<{
            imageTag: string;
            imageRepository: string;
            profile: string;
            gatewayClass: string;
            imageProfile: string;
          }>,
        );
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const { imageTag, imageRepository, profile, gatewayClass, imageProfile } = validation.ok;

        const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const data = snap.data() as
          | {
              imageTag?: string;
              imageRepository?: string;
              profile?: string;
              gatewayClass?: string;
              imageProfile?: string;
            }
          | undefined;
        const targetRepo = imageRepository ?? data?.imageRepository ?? "";
        const currentProfile = isGatewayProfile(data?.profile) ? data.profile : "standard";
        const currentGatewayClass = normalizeGatewayClass(data);
        const currentImageProfile = normalizeGatewayImageProfile(data);
        const targetProfile = profile ?? currentProfile;
        const targetGatewayClass = gatewayClass ?? currentGatewayClass;
        const targetImageProfile = imageProfile ?? profile ?? currentImageProfile;
        if (
          data?.imageTag === imageTag &&
          data.imageRepository === targetRepo &&
          targetProfile === currentProfile &&
          targetGatewayClass === currentGatewayClass &&
          targetImageProfile === currentImageProfile
        ) {
          res.status(409).json({
            error: "gateway already on requested image — no-op rollout",
            gatewayId: id,
            imageTag,
            imageRepository: targetRepo,
            profile: targetProfile,
            gatewayClass: targetGatewayClass,
            imageProfile: targetImageProfile,
          });
          return;
        }

        const pendingOps = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", ["pending", "running"])
          .get();
        const conflicting = pendingOps.docs.find((d) => {
          const opData = d.data() as
            | { input?: { gatewayId?: string } }
            | undefined;
          return opData?.input?.gatewayId === id;
        });
        if (conflicting) {
          res.status(409).json({
            error:
              "another operation is already pending or running for this gateway",
            gatewayId: id,
            operationId: conflicting.id,
            kind:
              (conflicting.data() as { kind?: string } | undefined)?.kind ??
              null,
          });
          return;
        }

        const actor = req as ActorRequest;
        const input: {
          gatewayId: string;
          imageTag: string;
          imageRepository?: string;
          profile?: GatewayProfile;
          gatewayClass?: GatewayClass;
          imageProfile?: GatewayImageProfile;
        } = { gatewayId: id, imageTag };
        if (imageRepository) input.imageRepository = imageRepository;
        if (profile) input.profile = profile;
        if (gatewayClass) input.gatewayClass = gatewayClass;
        if (imageProfile) input.imageProfile = imageProfile;
        const operationId = await createOperation(db, {
          kind: "rollout",
          createdBy: actor.uid ?? "unknown",
          input,
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/customers/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug as string;
        const slugSnap = await db
          .collection("users")
          .where("provisioning.openclaw.slug", "==", slug)
          .limit(1)
          .get();
        if (slugSnap.size > 0) {
          res.json(serializeCustomerLookup(slugSnap.docs[0]));
          return;
        }
        const usernameSnap = await db
          .collection("users")
          .where("username", "==", slug)
          .limit(1)
          .get();
        if (usernameSnap.size > 0) {
          res.json(serializeCustomerLookup(usernameSnap.docs[0]));
          return;
        }
        res.status(404).json({ error: "customer not found", slug });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/customers/:uid/migrate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ to: string }>;
        if (typeof body.to !== "string" || body.to.length === 0) {
          res
            .status(400)
            .json({ error: "missing target gateway", required: ["to"] });
          return;
        }
        const targetSnap = await db
          .collection("gateways")
          .doc(body.to)
          .get();
        if (!targetSnap.exists) {
          res.status(404).json({
            error: "target gateway not registered",
            gatewayId: body.to,
          });
          return;
        }
        const targetStatus = (
          targetSnap.data() as Record<string, unknown> | undefined
        )?.status;
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: "target gateway not ready",
            gatewayId: body.to,
            status: targetStatus ?? "unknown",
          });
          return;
        }
        const userSnap = await db.collection("users").doc(uid).get();
        const userData = userSnap.data() as Record<string, unknown> | undefined;
        const currentGatewayId = readUserGatewayId(userData);
        const builderSlug = userData
          ? resolveCustomerSlug(userData, deps.workspaceSlugsForUser)
          : null;
        if (currentGatewayId === body.to) {
          res.status(409).json({
            error: "customer is already mounted on the target gateway",
            uid,
            gatewayId: body.to,
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await createOperation(db, {
          kind: OP_KIND_MIGRATE_CUSTOMER,
          createdBy,
          input: {
            uid,
            ...(builderSlug ? { builderSlug } : {}),
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId: body.to,
          },
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/rollouts",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          fromGatewayId: string;
          imageTag: string;
        }>;
        if (
          typeof body.fromGatewayId !== "string" ||
          body.fromGatewayId.length === 0 ||
          typeof body.imageTag !== "string" ||
          body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: ["fromGatewayId", "imageTag"],
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await createOperation(db, {
          kind: "rollout",
          createdBy,
          input: {
            fromGatewayId: body.fromGatewayId,
            imageTag: body.imageTag,
          },
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );


router.get(
    "/builds",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = (req.query.service as string) || "octogee-gateway";
        if (!BUILDS_SERVICE_ALLOWLIST.has(service)) {
          res.status(400).json({
            error:
              "service must be one of the canonical Octogee gateway-pod images",
            allowed: [...BUILDS_SERVICE_ALLOWLIST],
            got: service,
          });
          return;
        }
        const parsedLimit = parseInt(
          (req.query.limit as string) ?? "30",
          10,
        );
        const limit = Math.min(
          100,
          Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30),
        );
        try {
          const builds = await deps.listGatewayBuilds({ service, limit });
          res.json({
            service,
            builds,
            generatedAt: new Date().toISOString(),
          });
        } catch (e) {
          logger.warn("artifact-registry list failed", {
            service,
            error: (e as Error)?.message,
          });
          res.status(502).json({
            error: (e as Error)?.message ?? "artifact-registry list failed",
            service,
          });
        }
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operations",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(
          100,
          Math.max(1, parseInt((req.query.limit as string) ?? "25", 10)),
        );
        const snap = await db
          .collection(GLM_OPERATIONS_COLLECTION)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get();
        const operations = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        res.json({ operations, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
