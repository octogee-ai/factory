export const SIZING_TIERS = ['xs', 's', 'm', 'l'];
// Runtime guard for tiers sourced from outside the type system (Firestore
// desired state, persisted helm values). A stale pre-rename tier must read as
// "not a tier" so callers fall back to the profile default rather than
// forwarding an unknown value to the chart — which rejects it and loops the
// reconciler.
export function isSizingTier(value) {
    return typeof value === 'string' && SIZING_TIERS.includes(value);
}
export const TIER_PRESETS = {
    xs: {
        description: 'One-builder floor — Spot/emptyDir active session',
        resources: {
            requests: { cpu: '500m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
            limits: { cpu: '1000m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
        },
        nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '1536' },
        capacity: { targetActiveBuilders: 1, typicalBuilders: 1 },
    },
    s: {
        description: 'One active builder with extra runtime headroom',
        resources: {
            requests: { cpu: '1000m', memory: '4Gi', 'ephemeral-storage': '4Gi' },
            limits: { cpu: '1000m', memory: '4Gi', 'ephemeral-storage': '4Gi' },
        },
        nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '3072' },
        capacity: { targetActiveBuilders: 1, typicalBuilders: 2 },
    },
    m: {
        description: 'Shared default — light shared use',
        resources: {
            requests: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '5Gi' },
            limits: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '5Gi' },
        },
        nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '4096' },
        capacity: { targetActiveBuilders: 2, typicalBuilders: 3 },
    },
    l: {
        description: 'Ceiling — small teams and heavier shared use',
        resources: {
            requests: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '5Gi' },
            limits: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '5Gi' },
        },
        nodejs: { uvThreadpoolSize: '6', maxOldSpaceSizeMb: '10240' },
        capacity: { targetActiveBuilders: 4, typicalBuilders: 6 },
    },
};
export const PROFILE_DEFAULT_TIER = {
    standard: 'l',
    builder: 's',
};
export const GATEWAY_CLASS_DEFAULT_TIER = {
    shared: 'm',
    builder: 's',
};
export const FALLBACK_DEFAULT_TIER = 'l';
export function resolveSizingTier(input) {
    if (input.sizingTier) {
        return {
            tier: input.sizingTier,
            resolvedFrom: 'explicit',
            preset: TIER_PRESETS[input.sizingTier],
        };
    }
    if (input.gatewayClass) {
        const tier = GATEWAY_CLASS_DEFAULT_TIER[input.gatewayClass];
        return { tier, resolvedFrom: 'class-default', preset: TIER_PRESETS[tier] };
    }
    const tier = input.profile ? PROFILE_DEFAULT_TIER[input.profile] : FALLBACK_DEFAULT_TIER;
    return { tier, resolvedFrom: 'profile-default', preset: TIER_PRESETS[tier] };
}
