export function isBlobObjectVersion(version, storage) {
    if (typeof version !== "string")
        return false;
    return storage === "s3" ? /^[!-~]{1,1024}$/u.test(version) : /^[1-9]\d{0,19}$/u.test(version);
}
export const RETIRED_VM_BINDING_DENIAL_REASON = "retired computer bindings may only reach final-checkpoint routes";
export const GATEWAY_BINDING_MISMATCH_REASON = "request names a gatewayId other than the bound gateway";
export const BUILDER_RUNTIME_STATE_RECOVERY_TIERS = ["minute", "hour", "day"];
