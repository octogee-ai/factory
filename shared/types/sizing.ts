import type { GatewayProfile } from './glm.js';

export const SIZING_TIERS = [
  'cattle-light',
  'cattle-shared',
  'cattle-heavy',
  'operator',
  'operator-plus',
] as const;

export type SizingTier = (typeof SIZING_TIERS)[number];

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
  'cattle-light': {
    description: 'F&F light-agent users (memory, cron, occasional codex)',
    resources: {
      requests: { cpu: '4000m', memory: '12Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '6000m', memory: '16Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '8', maxOldSpaceSizeMb: '8192' },
    capacity: { targetActiveBuilders: 30, typicalBuilders: 50 },
  },
  'cattle-shared': {
    description: 'Mixed-tier F&F with occasional BYOS codex',
    resources: {
      requests: { cpu: '8000m', memory: '20Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '12000m', memory: '28Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '12', maxOldSpaceSizeMb: '14336' },
    capacity: { targetActiveBuilders: 15, typicalBuilders: 25 },
  },
  'cattle-heavy': {
    description: 'F&F builders with always-on BYOS codex per user',
    resources: {
      requests: { cpu: '12000m', memory: '32Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '16000m', memory: '48Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '16', maxOldSpaceSizeMb: '22528' },
    capacity: { targetActiveBuilders: 10, typicalBuilders: 15 },
  },
  operator: {
    description: 'Dedicated to one Builder (Bender-class, gw-jack, etc.)',
    resources: {
      requests: { cpu: '16000m', memory: '48Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '24000m', memory: '64Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '16', maxOldSpaceSizeMb: '33792' },
    capacity: { targetActiveBuilders: 1, typicalBuilders: 1 },
  },
  'operator-plus': {
    description: 'Heavy operator (multi-codex, MCP-heavy, local LLM, etc.)',
    resources: {
      requests: { cpu: '24000m', memory: '64Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '32000m', memory: '96Gi', 'ephemeral-storage': '10Gi' },
    },
    nodejs: { uvThreadpoolSize: '24', maxOldSpaceSizeMb: '45056' },
    capacity: { targetActiveBuilders: 1, typicalBuilders: 1 },
  },
};

export const PROFILE_DEFAULT_TIER: Record<GatewayProfile, SizingTier> = {
  standard: 'cattle-light',
  operator: 'operator',
};

export const FALLBACK_DEFAULT_TIER: SizingTier = 'cattle-light';

export type TierResolvedFrom = 'explicit' | 'profile-default';

export interface ResolveSizingTierInput {
  sizingTier?: SizingTier;
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
  const tier = input.profile ? PROFILE_DEFAULT_TIER[input.profile] : FALLBACK_DEFAULT_TIER;
  // eslint-disable-next-line security/detect-object-injection -- tier is the typed SizingTier enum; Record lookup is exhaustive
  return { tier, resolvedFrom: 'profile-default', preset: TIER_PRESETS[tier] };
}
