export const GATEWAY_PROFILES = ["standard", "operator"];
export const GATEWAY_CLASSES = ["shared", "builder", "operator"];
export const GATEWAY_IMAGE_PROFILES = ["standard", "operator"];
export const OPERATOR_GATEWAY_LOCKED_ACCESS = {
    shellsEnabled: false,
    controlUiEnabled: false,
    reason: "runtime-trust-boundary-not-provisioned",
};
export function defaultOperatorGatewayAccess(ownerUid, shellsEnabled = true) {
    return ownerUid
        ? {
            shellsEnabled,
            controlUiEnabled: true,
            reason: "owned-runtime-gateway",
        }
        : OPERATOR_GATEWAY_LOCKED_ACCESS;
}
export function resolveOperatorGatewayAccess(ownerUid, operatorAccess) {
    return {
        ...defaultOperatorGatewayAccess(ownerUid),
        ...(operatorAccess ?? {}),
    };
}
export const OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export const GATEWAY_ID_MAX_LENGTH = 32;
export const GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";
export const OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT = {
    create: true,
};
export function isValidGatewayId(id) {
    if (typeof id !== "string" || id.length === 0 || id.length > GATEWAY_ID_MAX_LENGTH) {
        return false;
    }
    if (!isGatewayIdEndpoint(id.charCodeAt(0)))
        return false;
    if (!isGatewayIdEndpoint(id.charCodeAt(id.length - 1)))
        return false;
    for (let i = 1; i < id.length - 1; i += 1) {
        const code = id.charCodeAt(i);
        if (!isGatewayIdEndpoint(code) && code !== 45)
            return false;
    }
    return true;
}
function isGatewayIdEndpoint(code) {
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}
const ROLL_ROLE_SUFFIXES = ["-blue", "-green"];
export const NEW_GATEWAY_ID_REQUIREMENT = `${GATEWAY_ID_REQUIREMENT}; the -blue/-green suffixes are reserved for roll roles`;
// Creation-time validator: roll-role suffixes are reserved so the
// deriveGatewayIdentity convention fallback is safe by construction.
// Instance ids minted by the blue/green machinery (default-blue) stay valid
// under isValidGatewayId for routing and reconciliation.
export function isValidNewGatewayId(id) {
    if (!isValidGatewayId(id))
        return false;
    return !ROLL_ROLE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}
// Resolves the durable gateway identity for an instance: the explicit
// `gateway` field when present, else a naming-convention fallback that
// strips a trailing -blue/-green roll-role suffix. Instance ids without that
// suffix are their own bare identity (dedicated gateways, never rolled).
export function deriveGatewayIdentity(gatewayId, explicitGateway) {
    if (typeof explicitGateway === "string" && explicitGateway.length > 0) {
        return explicitGateway;
    }
    for (const suffix of ROLL_ROLE_SUFFIXES) {
        if (gatewayId.endsWith(suffix))
            return gatewayId.slice(0, -suffix.length);
    }
    return gatewayId;
}
export function operatorGatewayServiceAccountName(gatewayId) {
    return `${OPERATOR_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}
export function isOperatorGatewayShellAccessEnabled(profile, operatorAccess) {
    return profile === "operator" && operatorAccess?.shellsEnabled === true;
}
export function isGatewayClassShellAccessEnabled(gatewayClass, operatorAccess) {
    return ((gatewayClass === "builder" || gatewayClass === "operator") &&
        operatorAccess?.shellsEnabled === true);
}
export function isGatewayClassControlUiAccessEnabled(gatewayClass, operatorAccess) {
    return ((gatewayClass === "builder" || gatewayClass === "operator") &&
        operatorAccess?.controlUiEnabled !== false);
}
// The user-doc shell state the PWA gates BuilderShell on (gatewayProfile +
// shellsEnabled). A Builder gets BuilderShell when placed on a shell-enabled
// builder/operator gateway they OWN; a guest migrated onto someone else's
// gateway does not.
export function resolveUserGatewayShellState(data, uid) {
    const gatewayClass = resolveGatewayClass({
        gatewayClass: isGatewayClass(data?.gatewayClass) ? data.gatewayClass : undefined,
        profile: isGatewayProfile(data?.profile) ? data.profile : undefined,
        imageProfile: isGatewayProfile(data?.imageProfile) ? data.imageProfile : undefined,
    });
    const userOwns = data?.ownerUid === uid;
    return {
        gatewayProfile: gatewayClass === "operator" ? "operator" : "standard",
        shellsEnabled: userOwns && isGatewayClassShellAccessEnabled(gatewayClass, data?.operatorAccess),
    };
}
export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
export const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION = "glmMigrationTransferTasks";
export function isGatewayClass(value) {
    return (typeof value === "string" &&
        GATEWAY_CLASSES.includes(value));
}
export function isGatewayProfile(value) {
    return (typeof value === "string" &&
        GATEWAY_PROFILES.includes(value));
}
export function resolveGatewayClass(input) {
    if (input.gatewayClass)
        return input.gatewayClass;
    return input.profile === "operator" || input.imageProfile === "operator"
        ? "operator"
        : "shared";
}
export function resolveGatewayImageProfile(input) {
    if (input.imageProfile)
        return input.imageProfile;
    if (!input.gatewayClass && input.profile)
        return input.profile;
    return resolveGatewayClass(input) === "operator" ? "operator" : "standard";
}
