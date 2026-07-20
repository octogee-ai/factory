import { GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME, isGatewayClass, isGatewayProfile, isValidGatewayId, operatorGatewayServiceAccountName, } from "./glm.js";
import { isSizingTier } from "./sizing.js";
import { isTrialGatewayAllocation, } from "./trial-gateway.js";
export const GATEWAY_CONFIG_SCHEMA_VERSION = 1;
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
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNullableString(value) {
    return value === null || typeof value === "string";
}
function isNullableNonEmptyString(value) {
    return value === null || (typeof value === "string" && value.length > 0);
}
function isNullableServiceAccountName(value) {
    return (value === null ||
        (typeof value === "string" &&
            (value.length === 0 ||
                (value.length <= 63 && KUBERNETES_SERVICE_ACCOUNT_NAME.test(value)))));
}
function isNullableRecord(value) {
    return value === null || isRecord(value);
}
function isStringArray(value) {
    return (Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && entry.length > 0));
}
function isOptionalBoolean(value) {
    return value === undefined || typeof value === "boolean";
}
function isOptionalString(value) {
    return value === undefined || typeof value === "string";
}
function isNullableSizingTier(value) {
    return value === null || isSizingTier(value);
}
function isNullableOperatorAccess(value) {
    if (value === null)
        return true;
    if (!isRecord(value))
        return false;
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
function isNullableServiceAccount(value) {
    if (value === null)
        return true;
    if (!isRecord(value))
        return false;
    const annotations = value.annotations;
    return ((value.create === undefined || typeof value.create === "boolean") &&
        (annotations === undefined ||
            (isRecord(annotations) &&
                Object.values(annotations).every((entry) => typeof entry === "string"))));
}
function isNullablePreemption(value) {
    if (value === null)
        return true;
    if (!isRecord(value))
        return false;
    return (value.warmTargetGatewayId === undefined ||
        (typeof value.warmTargetGatewayId === "string" && value.warmTargetGatewayId.length > 0));
}
function isNullableModelBrokerLimits(value) {
    if (value === null)
        return true;
    if (!isRecord(value))
        return false;
    const spendWindowUsd = value.spendWindowUsd;
    const spendWeekUsd = value.spendWeekUsd;
    const requestsPerMinute = value.requestsPerMinute;
    const isNonNegative = (entry) => entry === undefined ||
        entry === null ||
        (typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
    return (isNonNegative(spendWindowUsd) &&
        isNonNegative(spendWeekUsd) &&
        isNonNegative(requestsPerMinute));
}
function isOptionalTrialGatewayAllocation(value) {
    return value === undefined || value === null || isTrialGatewayAllocation(value);
}
function hasOnlyFields(value, fields) {
    const allowed = new Set(fields);
    return Object.keys(value).every((field) => allowed.has(field));
}
function isCanonicalLockedOperatorAccess(value) {
    return isRecord(value) &&
        hasOnlyFields(value, ["shellsEnabled", "controlUiEnabled", "reason"]) &&
        value.shellsEnabled === false &&
        value.controlUiEnabled === false &&
        value.reason === "runtime-trust-boundary-not-provisioned";
}
function isCanonicalLockedServiceAccount(value) {
    return isRecord(value) && hasOnlyFields(value, ["create"]) && value.create === true;
}
function hasLockedTrialOperatorIdentity(value) {
    return value.gatewayClass === "operator" &&
        value.profile === "operator" &&
        value.imageProfile === "operator" &&
        value.sizingTier !== null &&
        value.computeClass === null &&
        value.gcpProject === null;
}
function hasLockedTrialOperatorRuntime(value) {
    return value.gatewayContainerSecurityContext === null &&
        typeof value.serviceAccountName === "string" &&
        value.serviceAccountName.startsWith(GATEWAY_SERVICE_ACCOUNT_PREFIX) &&
        isCanonicalLockedServiceAccount(value.serviceAccount) &&
        isCanonicalLockedOperatorAccess(value.operatorAccess) &&
        Array.isArray(value.coOwnerUids) && value.coOwnerUids.length === 0 &&
        value.openclawOverrides === null &&
        value.modelBrokerLimits === null &&
        value.preemption === null;
}
function isLockedTrialOperator(value) {
    return hasLockedTrialOperatorIdentity(value) && hasLockedTrialOperatorRuntime(value);
}
function isOwnedGateway(value) {
    return typeof value.ownerUid === "string" && value.ownerUid.length > 0 &&
        typeof value.builderSlug === "string" && value.builderSlug.length > 0;
}
function hasLegalOwnedAllocation(value) {
    const allocation = value.allocation;
    if (allocation === undefined || allocation === null)
        return true;
    return isTrialGatewayAllocation(allocation) &&
        allocation.state !== "warming" && allocation.state !== "standby" &&
        allocation.claimedByUid === value.ownerUid;
}
function hasLegalUnownedTrialAllocation(value) {
    const allocation = value.allocation;
    const isUnownedTrial = value.ownerUid === null && value.builderSlug === null &&
        isTrialGatewayAllocation(allocation) &&
        (allocation.state === "warming" || allocation.state === "standby") &&
        isLockedTrialOperator(value);
    if (!isUnownedTrial)
        return false;
    const desiredStatus = value.desiredStatus;
    if (desiredStatus === undefined || desiredStatus === "retired")
        return true;
    return allocation.state === "warming"
        ? desiredStatus === "running" || desiredStatus === "paused"
        : desiredStatus === "paused";
}
function hasLegalOwnershipAndAllocation(value) {
    if (value.gatewayClass === "shared") {
        return value.ownerUid === null && value.builderSlug === null &&
            (value.allocation === undefined || value.allocation === null);
    }
    return isOwnedGateway(value)
        ? hasLegalOwnedAllocation(value)
        : hasLegalUnownedTrialAllocation(value);
}
export function isBareGatewayId(value) {
    return isValidGatewayId(value) && !REVISION_GATEWAY_ID_RE.test(value);
}
// eslint-disable-next-line complexity
export function isGatewayMutableConfig(value) {
    if (!isRecord(value) || value.configSchemaVersion !== GATEWAY_CONFIG_SCHEMA_VERSION)
        return false;
    if (Object.prototype.hasOwnProperty.call(value, "byosub"))
        return false;
    return ((value.profile === null || isGatewayProfile(value.profile)) &&
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
        hasLegalOwnershipAndAllocation(value));
}
export function isGatewayMutableConfigForGateway(value, gatewayId) {
    if (!isBareGatewayId(gatewayId) || !isGatewayMutableConfig(value))
        return false;
    const serviceAccountName = value.serviceAccountName;
    if (serviceAccountName === null || serviceAccountName === "")
        return true;
    if (PLATFORM_SERVICE_ACCOUNT_NAMES.has(serviceAccountName))
        return false;
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
export function isCanonicalTrialStandbyMutableConfigForGateway(value, gatewayId) {
    if (!isGatewayMutableConfigForGateway(value, gatewayId))
        return false;
    const record = value;
    return value.ownerUid === null &&
        value.builderSlug === null &&
        isTrialGatewayAllocation(value.allocation) &&
        value.allocation.state === "standby" &&
        record.desiredStatus === "paused" &&
        isLockedTrialOperator(record);
}
export function effectiveGatewayServiceAccountNameForGateway(config, gatewayId) {
    return config.serviceAccountName || operatorGatewayServiceAccountName(gatewayId);
}
