import type { GatewayClass, GatewayProfile } from './glm.js';

export const SIZING_TIERS = [
  'micro',
  'mini',
  'nano',
  'small',
  'medium',
  'large',
  'xlarge',
  '2xlarge',
] as const;

export type SizingTier = (typeof SIZING_TIERS)[number];

// Runtime guard for tiers sourced from outside the type system (Firestore
// desired state, persisted helm values). A stale pre-rename tier must read as
// "not a tier" so callers fall back to the profile default rather than
// forwarding an unknown value to the chart — which rejects it and loops the
// reconciler.
export function isSizingTier(value: unknown): value is SizingTier {
  return typeof value === 'string' && (SIZING_TIERS as readonly string[]).includes(value);
}

export interface TierResources {
  requests: { cpu: string; memory: string; 'ephemeral-storage'?: string };
  limits: { cpu: string; memory: string; 'ephemeral-storage'?: string };
}

export interface TierNodeRuntime {
  uvThreadpoolSize: string;
  maxOldSpaceSizeMb: string;
}

export interface TierCapacity {
  targetActiveBuilders: number;
  typicalBuilders: number;
}

export interface SizingTierPreset {
  description: string;
  resources: TierResources;
  nodejs: TierNodeRuntime;
  capacity: TierCapacity;
}

export const TIER_PRESETS: Record<SizingTier, SizingTierPreset> = {
  micro: {
    description: 'One-builder floor — Spot/emptyDir active session',
    resources: {
      requests: { cpu: '500m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
      limits: { cpu: '500m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '1536' },
    capacity: { targetActiveBuilders: 1, typicalBuilders: 1 },
  },
  mini: {
    description: 'Warm standby — one active builder with cold-start headroom',
    resources: {
      requests: { cpu: '1000m', memory: '4Gi', 'ephemeral-storage': '4Gi' },
      limits: { cpu: '1000m', memory: '4Gi', 'ephemeral-storage': '6Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '3072' },
    capacity: { targetActiveBuilders: 1, typicalBuilders: 2 },
  },
  nano: {
    description: 'F&F floor — light shared use',
    resources: {
      requests: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '4096' },
    capacity: { targetActiveBuilders: 2, typicalBuilders: 3 },
  },
  small: {
    description: 'Default — small teams and shared F&F',
    resources: {
      requests: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '6', maxOldSpaceSizeMb: '10240' },
    capacity: { targetActiveBuilders: 4, typicalBuilders: 6 },
  },
  medium: {
    description: 'Mac-Mini class — solo operator or busy shared',
    resources: {
      requests: { cpu: '8000m', memory: '32Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '8000m', memory: '32Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '8', maxOldSpaceSizeMb: '20480' },
    capacity: { targetActiveBuilders: 8, typicalBuilders: 12 },
  },
  large: {
    description: 'Mac-Studio class — dedicated operator',
    resources: {
      requests: { cpu: '16000m', memory: '64Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '16000m', memory: '64Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '12', maxOldSpaceSizeMb: '40960' },
    capacity: { targetActiveBuilders: 16, typicalBuilders: 24 },
  },
  xlarge: {
    description: 'Heavy operator — multi-codex / MCP-heavy',
    resources: {
      requests: { cpu: '32000m', memory: '128Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '32000m', memory: '128Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '16', maxOldSpaceSizeMb: '81920' },
    capacity: { targetActiveBuilders: 30, typicalBuilders: 45 },
  },
  '2xlarge': {
    description: 'Max — rarely needed, headroom ceiling',
    resources: {
      requests: { cpu: '56000m', memory: '224Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '56000m', memory: '224Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '16', maxOldSpaceSizeMb: '147456' },
    capacity: { targetActiveBuilders: 50, typicalBuilders: 80 },
  },
};

export const PROFILE_DEFAULT_TIER: Record<GatewayProfile, SizingTier> = {
  standard: 'small',
  operator: 'small',
};

export const GATEWAY_CLASS_DEFAULT_TIER: Record<GatewayClass, SizingTier> = {
  shared: 'small',
  builder: 'micro',
  operator: 'small',
};

export const FALLBACK_DEFAULT_TIER: SizingTier = 'small';

export type TierResolvedFrom = 'explicit' | 'class-default' | 'profile-default';

export interface ResolveSizingTierInput {
  sizingTier?: SizingTier;
  gatewayClass?: GatewayClass;
  profile?: GatewayProfile;
}

export interface ResolvedSizingTier {
  tier: SizingTier;
  resolvedFrom: TierResolvedFrom;
  preset: SizingTierPreset;
}

export function resolveSizingTier(input: ResolveSizingTierInput): ResolvedSizingTier {
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
