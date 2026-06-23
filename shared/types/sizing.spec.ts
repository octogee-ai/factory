import { describe, expect, it } from 'vitest';
import {
  SIZING_TIERS,
  PROFILE_DEFAULT_TIER,
  GATEWAY_CLASS_DEFAULT_TIER,
  TIER_PRESETS,
  resolveSizingTier,
  type SizingTier,
} from './sizing.js';
import { GATEWAY_CLASSES, GATEWAY_PROFILES } from './glm.js';

describe('sizing-tier SSOT', () => {
  it('declares tiers in ascending size order', () => {
    expect(SIZING_TIERS).toEqual([
      'micro',
      'mini',
      'nano',
      'small',
      'medium',
      'large',
      'xlarge',
      '2xlarge',
    ]);
  });

  it('TIER_PRESETS covers every tier with resources + capacity + nodejs', () => {
    for (const tier of SIZING_TIERS) {
      const preset = TIER_PRESETS[tier];
      expect(preset, `preset for ${tier}`).toBeDefined();
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.resources.requests.cpu).toMatch(/^\d+m$/);
      expect(preset.resources.requests.memory).toMatch(/^\d+Gi$/);
      expect(preset.resources.limits.cpu).toMatch(/^\d+m$/);
      expect(preset.resources.limits.memory).toMatch(/^\d+Gi$/);
      expect(preset.nodejs.uvThreadpoolSize).toMatch(/^\d+$/);
      expect(preset.nodejs.maxOldSpaceSizeMb).toMatch(/^\d+$/);
      expect(preset.capacity.targetActiveBuilders).toBeGreaterThan(0);
      expect(preset.capacity.typicalBuilders).toBeGreaterThanOrEqual(preset.capacity.targetActiveBuilders);
    }
  });

  it('tier resources are monotonically non-decreasing CPU and memory', () => {
    const cpu = (s: string) => parseInt(s.replace('m', ''), 10);
    const mem = (s: string) => parseInt(s.replace('Gi', ''), 10);
    for (let i = 1; i < SIZING_TIERS.length; i++) {
      const prev = TIER_PRESETS[SIZING_TIERS[i - 1]];
      const curr = TIER_PRESETS[SIZING_TIERS[i]];
      expect(cpu(curr.resources.requests.cpu)).toBeGreaterThanOrEqual(cpu(prev.resources.requests.cpu));
      expect(mem(curr.resources.requests.memory)).toBeGreaterThanOrEqual(mem(prev.resources.requests.memory));
    }
  });

  it('PROFILE_DEFAULT_TIER maps every GatewayProfile', () => {
    for (const profile of GATEWAY_PROFILES) {
      expect(PROFILE_DEFAULT_TIER[profile]).toBeDefined();
      expect(SIZING_TIERS).toContain(PROFILE_DEFAULT_TIER[profile]);
    }
  });

  it('both profiles default to small', () => {
    expect(PROFILE_DEFAULT_TIER.operator).toBe('small');
    expect(PROFILE_DEFAULT_TIER.standard).toBe('small');
  });

  it('GATEWAY_CLASS_DEFAULT_TIER maps every GatewayClass', () => {
    for (const gatewayClass of GATEWAY_CLASSES) {
      expect(GATEWAY_CLASS_DEFAULT_TIER[gatewayClass]).toBeDefined();
      expect(SIZING_TIERS).toContain(GATEWAY_CLASS_DEFAULT_TIER[gatewayClass]);
    }
  });

  it('builder class defaults to micro; shared and operator default to small', () => {
    expect(GATEWAY_CLASS_DEFAULT_TIER.builder).toBe('micro');
    expect(GATEWAY_CLASS_DEFAULT_TIER.shared).toBe('small');
    expect(GATEWAY_CLASS_DEFAULT_TIER.operator).toBe('small');
  });

  it('mini is the warm-standby tier between micro and nano', () => {
    expect(TIER_PRESETS.mini.resources.requests.cpu).toBe('1000m');
    expect(TIER_PRESETS.mini.resources.requests.memory).toBe('4Gi');
    expect(TIER_PRESETS.mini.nodejs.maxOldSpaceSizeMb).toBe('3072');
    expect(TIER_PRESETS.mini.capacity.targetActiveBuilders).toBe(1);
  });
});

describe('resolveSizingTier', () => {
  it('returns the explicit tier when set, regardless of profile', () => {
    const result = resolveSizingTier({ sizingTier: 'medium', profile: 'operator' });
    expect(result.tier).toBe('medium');
    expect(result.resolvedFrom).toBe('explicit');
  });

  it('falls back to the profile default (small) when sizingTier is missing', () => {
    const result = resolveSizingTier({ sizingTier: undefined, profile: 'operator' });
    expect(result.tier).toBe('small');
    expect(result.resolvedFrom).toBe('profile-default');
  });

  it('falls back to small when both sizingTier and profile are missing', () => {
    const result = resolveSizingTier({ sizingTier: undefined, profile: undefined });
    expect(result.tier).toBe('small');
    expect(result.resolvedFrom).toBe('profile-default');
  });

  it('uses the class default before the legacy profile default', () => {
    const result = resolveSizingTier({
      sizingTier: undefined,
      gatewayClass: 'builder',
      profile: 'standard',
    });
    expect(result.tier).toBe('micro');
    expect(result.resolvedFrom).toBe('class-default');
  });

  it('narrows to SizingTier (compile-time guard)', () => {
    const result = resolveSizingTier({ sizingTier: '2xlarge', profile: undefined });
    const tier: SizingTier = result.tier;
    expect(tier).toBe('2xlarge');
  });
});
