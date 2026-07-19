import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  isGatewayClass,
  isGatewayProfile,
  isValidGatewayId,
  operatorGatewayServiceAccountName,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayModelBrokerLimits,
  type GatewayPreemptionSpec,
  type GatewayProfile,
  type GatewayServiceAccountSpec,
  type OperatorGatewayAccessSpec,
} from "./glm.js";
import { isSizingTier, type SizingTier } from "./sizing.js";
import {
  isTrialGatewayAllocation,
  type TrialGatewayAllocation,
} from "./trial-gateway.js";

export const GATEWAY_CONFIG_SCHEMA_VERSION = 1 as const;

const KUBERNETES_SERVICE_ACCOUNT_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const REVISION_GATEWAY_ID_RE = /-r[1-9]\d*$/u;
const GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
const LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gateway-";
const PLATFORM_SERVICE_ACCOUNT_NAMES = new Set([
  "default",
  "octogee-api",
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  "octogee-cron",
  "glm-controller",
  "llm-broker",
  "octogee-glm-controller",
]);

export interface GatewayMutableConfig {
  configSchemaVersion: typeof GATEWAY_CONFIG_SCHEMA_VERSION;
  profile: GatewayProfile | null;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  sizingTier: SizingTier | null;
  computeClass: string | null;
  gcpProject: string | null;
  gatewayContainerSecurityContext: Record<string, unknown> | null;
  serviceAccountName: string | null;
  serviceAccount: GatewayServiceAccountSpec | null;
  operatorAccess: OperatorGatewayAccessSpec | null;
  ownerUid: string | null;
  coOwnerUids: string[];
  builderSlug: string | null;
  openclawOverrides: Record<string, unknown> | null;
  modelBrokerLimits: GatewayModelBrokerLimits | null;
  preemption: GatewayPreemptionSpec | null;
  allocation?: TrialGatewayAllocation | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isNullableServiceAccountName(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      (value.length === 0 ||
        (value.length <= 63 && KUBERNETES_SERVICE_ACCOUNT_NAME.test(value))))
  );
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNullableSizingTier(value: unknown): value is SizingTier | null {
  return value === null || isSizingTier(value);
}

function isNullableOperatorAccess(value: unknown): value is OperatorGatewayAccessSpec | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const validPowerAccess = isOptionalBoolean(value.shellsEnabled) &&
    isOptionalBoolean(value.controlUiEnabled);
  const validNetworkAccess = isOptionalBoolean(value.platformMetadataEgress) &&
    (value.kubeApiServerEgressCidrs === undefined || isStringArray(value.kubeApiServerEgressCidrs));
  const validVerification = isOptionalString(value.reason) &&
    (value.verifiedAt === undefined ||
      (typeof value.verifiedAt === "number" && Number.isFinite(value.verifiedAt))) &&
    isOptionalString(value.verifiedBy);
  return validPowerAccess && validNetworkAccess && validVerification;
}

function isNullableServiceAccount(value: unknown): value is GatewayServiceAccountSpec | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const annotations = value.annotations;
  return (
    (value.create === undefined || typeof value.create === "boolean") &&
    (annotations === undefined ||
      (isRecord(annotations) &&
        Object.values(annotations).every((entry) => typeof entry === "string")))
  );
}

function isNullablePreemption(value: unknown): value is GatewayPreemptionSpec | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    value.warmTargetGatewayId === undefined ||
    (typeof value.warmTargetGatewayId === "string" && value.warmTargetGatewayId.length > 0)
  );
}

function isNullableModelBrokerLimits(value: unknown): value is GatewayModelBrokerLimits | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const spendWindowUsd = value.spendWindowUsd;
  const spendWeekUsd = value.spendWeekUsd;
  const requestsPerMinute = value.requestsPerMinute;
  const isNonNegative = (entry: unknown) =>
    entry === undefined ||
    entry === null ||
    (typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
  return (
    isNonNegative(spendWindowUsd) &&
    isNonNegative(spendWeekUsd) &&
    isNonNegative(requestsPerMinute)
  );
}

function isOptionalTrialGatewayAllocation(
  value: unknown,
): value is TrialGatewayAllocation | null | undefined {
  return value === undefined || value === null || isTrialGatewayAllocation(value);
}

function isLockedTrialOperator(value: Record<string, unknown>): boolean {
  const access = value.operatorAccess;
  return value.gatewayClass === "operator" &&
    value.profile === "operator" &&
    value.imageProfile === "operator" &&
    isRecord(access) &&
    access.shellsEnabled === false &&
    access.controlUiEnabled === false &&
    access.platformMetadataEgress !== true &&
    (access.kubeApiServerEgressCidrs === undefined ||
      (Array.isArray(access.kubeApiServerEgressCidrs) && access.kubeApiServerEgressCidrs.length === 0));
}

function hasLegalOwnershipAndAllocation(value: Record<string, unknown>): boolean {
  const allocation = value.allocation;
  const ownerUid = value.ownerUid;
  const builderSlug = value.builderSlug;
  const isOwned = typeof ownerUid === "string" && ownerUid.length > 0 &&
    typeof builderSlug === "string" && builderSlug.length > 0;
  if (value.gatewayClass === "shared") {
    return ownerUid === null && builderSlug === null && (allocation === undefined || allocation === null);
  }
  if (isOwned) {
    if (allocation === undefined || allocation === null) return true;
    return isTrialGatewayAllocation(allocation) &&
      allocation.state !== "warming" && allocation.state !== "standby" &&
      allocation.claimedByUid === ownerUid;
  }
  const isUnownedTrial = ownerUid === null && builderSlug === null &&
    isTrialGatewayAllocation(allocation) &&
    (allocation.state === "warming" || allocation.state === "standby") &&
    isLockedTrialOperator(value);
  if (!isUnownedTrial) return false;
  const desiredStatus = value.desiredStatus;
  if (desiredStatus === undefined || desiredStatus === "retired") return true;
  return allocation.state === "warming"
    ? desiredStatus === "running" || desiredStatus === "paused"
    : desiredStatus === "paused";
}

export function isBareGatewayId(value: unknown): value is string {
  return isValidGatewayId(value) && !REVISION_GATEWAY_ID_RE.test(value);
}

// eslint-disable-next-line complexity
export function isGatewayMutableConfig(value: unknown): value is GatewayMutableConfig {
  if (!isRecord(value) || value.configSchemaVersion !== GATEWAY_CONFIG_SCHEMA_VERSION) return false;
  if (Object.prototype.hasOwnProperty.call(value, "byosub")) return false;
  return (
    (value.profile === null || isGatewayProfile(value.profile)) &&
    isGatewayClass(value.gatewayClass) &&
    isGatewayProfile(value.imageProfile) &&
    isNullableSizingTier(value.sizingTier) &&
    isNullableNonEmptyString(value.computeClass) &&
    isNullableString(value.gcpProject) &&
    isNullableRecord(value.gatewayContainerSecurityContext) &&
    isNullableServiceAccountName(value.serviceAccountName) &&
    isNullableServiceAccount(value.serviceAccount) &&
    isNullableOperatorAccess(value.operatorAccess) &&
    isNullableString(value.ownerUid) &&
    isStringArray(value.coOwnerUids) &&
    isNullableString(value.builderSlug) &&
    isNullableRecord(value.openclawOverrides) &&
    isNullableModelBrokerLimits(value.modelBrokerLimits) &&
    isNullablePreemption(value.preemption) &&
    isOptionalTrialGatewayAllocation(value.allocation) &&
    hasLegalOwnershipAndAllocation(value)
  );
}

export function isGatewayMutableConfigForGateway(
  value: unknown,
  gatewayId: string,
): value is GatewayMutableConfig {
  if (!isBareGatewayId(gatewayId) || !isGatewayMutableConfig(value)) return false;
  const serviceAccountName = value.serviceAccountName;
  if (serviceAccountName === null || serviceAccountName === "") return true;
  if (PLATFORM_SERVICE_ACCOUNT_NAMES.has(serviceAccountName)) return false;
  const generatedName = operatorGatewayServiceAccountName(gatewayId);
  const legacyName = `${LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
  if (serviceAccountName.startsWith(GATEWAY_SERVICE_ACCOUNT_PREFIX)) {
    return serviceAccountName === generatedName;
  }
  if (serviceAccountName.startsWith(LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX)) {
    return serviceAccountName === legacyName;
  }
  return true;
}

export function isGatewayMutableConfigForDesiredStatus(
  value: unknown,
  gatewayId: string,
  desiredStatus: "running" | "paused" | "retired",
): value is GatewayMutableConfig {
  if (!isGatewayMutableConfigForGateway(value, gatewayId)) return false;
  const allocation = value.allocation;
  if (!allocation || allocation.state === "claimed" ||
    allocation.state === "expiring" || allocation.state === "converted") return true;
  if (desiredStatus === "retired") return true;
  return allocation.state === "warming"
    ? desiredStatus === "running" || desiredStatus === "paused"
    : desiredStatus === "paused";
}

export function effectiveGatewayServiceAccountNameForGateway(
  config: GatewayMutableConfig,
  gatewayId: string,
): string {
  return config.serviceAccountName || operatorGatewayServiceAccountName(gatewayId);
}
