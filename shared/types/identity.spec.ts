/**
 * Canonical identity/naming tests.
 *
 * Sole source of truth for the rules spelled out in
 * docs/DATA-MODEL-REVIEW.md §11. Every package consumes
 * `shared/types/identity.ts` directly — no mirrors, no drift-pin tests.
 */
import { describe, expect, it } from 'vitest';
import {
  // Constants
  USERNAME_RE,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  PROJECT_ID_RE,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
  CUSTOM_CHANNEL_RE,
  CUSTOM_CHANNEL_MIN_LENGTH,
  CUSTOM_CHANNEL_MAX_LENGTH,
  CHANNEL_NAME_MAX_LENGTH,
  PROJECT_DISCRIMINATOR,
  COMMUNITY_PREFIX,
  RESERVED_WORKSPACE_CHANNELS,
  MM_SYSTEM_CHANNELS,
  RESERVED_USERNAMES,
  // Validators
  isValidUsername,
  usernameValidationError,
  isValidProjectId,
  isValidCustomChannelName,
  // Generators
  workspaceGeneralChannelName,
  workspaceCoachChannelName,
  workspaceAdminChannelName,
  workspaceCustomChannelName,
  projectGeneralChannelName,
  projectChannelName,
  // Recognizers
  isMmSystemChannel,
  isCommunityChannel,
  // Parser
  parseChannelName,
  attributeChannelToUsername,
  deriveJoinedUsernames,
} from './identity';

// Mattermost's team-name regex, sourced from
// https://github.com/mattermost/mattermost/blob/master/server/public/model/team.go.
// Every username we accept must also be accepted here.
const MM_TEAM_NAME_RE = /^[a-z0-9]+([a-z\-0-9]+|(__)?)[a-z0-9]+$/;

// ── Constants ─────────────────────────────────────────────────────────────────

describe('identity: constants', () => {
  it('USERNAME_MIN_LENGTH matches MM TeamNameMinLength (2)', () => {
    expect(USERNAME_MIN_LENGTH).toBe(2);
  });

  it('CHANNEL_NAME_MAX_LENGTH matches MM ChannelNameMaxLength (64)', () => {
    expect(CHANNEL_NAME_MAX_LENGTH).toBe(64);
  });

  it('USERNAME_MAX + "-proj-" + PROJECT_ID_MAX + "-" + CUSTOM_CHANNEL_MAX fits exactly the MM 64-char cap', () => {
    const budget =
      USERNAME_MAX_LENGTH +
      `-${PROJECT_DISCRIMINATOR}-`.length +
      PROJECT_ID_MAX_LENGTH +
      '-'.length +
      CUSTOM_CHANNEL_MAX_LENGTH;
    expect(budget).toBe(CHANNEL_NAME_MAX_LENGTH);
  });

  it('RESERVED_USERNAMES includes every MM system + reserved suffix + discriminator + community prefix', () => {
    expect(RESERVED_USERNAMES.has('town-square')).toBe(true);
    expect(RESERVED_USERNAMES.has('off-topic')).toBe(true);
    expect(RESERVED_USERNAMES.has('general')).toBe(true);
    expect(RESERVED_USERNAMES.has('coach')).toBe(true);
    expect(RESERVED_USERNAMES.has('admin')).toBe(true);
    expect(RESERVED_USERNAMES.has(PROJECT_DISCRIMINATOR)).toBe(true);
    expect(RESERVED_USERNAMES.has(COMMUNITY_PREFIX)).toBe(true);
  });

  it('RESERVED_WORKSPACE_CHANNELS is general, coach, admin (in that order)', () => {
    expect([...RESERVED_WORKSPACE_CHANNELS]).toEqual(['general', 'coach', 'admin']);
  });

  it('MM_SYSTEM_CHANNELS is town-square + off-topic', () => {
    expect(MM_SYSTEM_CHANNELS.has('town-square')).toBe(true);
    expect(MM_SYSTEM_CHANNELS.has('off-topic')).toBe(true);
    expect(MM_SYSTEM_CHANNELS.size).toBe(2);
  });
});

// ── USERNAME_RE ───────────────────────────────────────────────────────────────

describe('identity: USERNAME_RE', () => {
  it.each([
    ['kyle'],
    ['ab'],
    ['a1'],
    ['kyle2'],
    ['christopher-eckert'],
    ['ai-2026'],
    ['one-two-three-four'],
  ])('accepts %s', (name) => {
    expect(USERNAME_RE.test(name)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['-kyle', 'leading hyphen'],
    ['kyle-', 'trailing hyphen'],
    ['kyle--dev', 'double hyphen'],
    ['Kyle', 'uppercase'],
    ['kyle_dev', 'underscore'],
    ['kyle.dev', 'dot'],
    ['kyle dev', 'space'],
    ['kyle/dev', 'slash'],
  ])('rejects %s (%s)', (name) => {
    expect(USERNAME_RE.test(name)).toBe(false);
  });
});

// ── isValidUsername / usernameValidationError ────────────────────────────────

describe('identity: isValidUsername', () => {
  it('accepts realistic handles', () => {
    expect(isValidUsername('kyle')).toBe(true);
    expect(isValidUsername('christopher-eckert')).toBe(true);
    expect(isValidUsername('a1')).toBe(true); // at min boundary
  });

  it('rejects below USERNAME_MIN_LENGTH', () => {
    expect(isValidUsername('a')).toBe(false);
    expect(isValidUsername('')).toBe(false);
  });

  it('rejects above USERNAME_MAX_LENGTH', () => {
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('accepts exactly USERNAME_MAX_LENGTH', () => {
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
  });

  it('rejects every reserved username', () => {
    for (const reserved of RESERVED_USERNAMES) {
      expect(isValidUsername(reserved)).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    expect(isValidUsername(undefined as unknown as string)).toBe(false);
    expect(isValidUsername(null as unknown as string)).toBe(false);
    expect(isValidUsername(123 as unknown as string)).toBe(false);
  });
});

describe('identity: usernameValidationError', () => {
  it('returns null for a valid handle', () => {
    expect(usernameValidationError('kyle')).toBeNull();
  });

  it('returns a message for empty', () => {
    expect(usernameValidationError('')).toMatch(/required/i);
  });

  it('returns a length message for too-short', () => {
    const err = usernameValidationError('a');
    expect(err).toMatch(new RegExp(String(USERNAME_MIN_LENGTH)));
  });

  it('returns a length message for too-long', () => {
    const err = usernameValidationError('a'.repeat(USERNAME_MAX_LENGTH + 1));
    expect(err).toMatch(new RegExp(String(USERNAME_MAX_LENGTH)));
  });

  it('returns a shape message for bad characters', () => {
    expect(usernameValidationError('Kyle')).toMatch(/lowercase|letters|hyphen/i);
    expect(usernameValidationError('kyle--dev')).toMatch(/lowercase|letters|hyphen/i);
    expect(usernameValidationError('-kyle')).toMatch(/lowercase|letters|hyphen/i);
  });

  it('returns a reserved message for reserved names', () => {
    expect(usernameValidationError('general')).toMatch(/reserved/i);
    expect(usernameValidationError('town-square')).toMatch(/reserved/i);
  });
});

// ── Project ID + custom channel validation ───────────────────────────────────

describe('identity: isValidProjectId', () => {
  it('accepts lowercase alphanumeric', () => {
    expect(isValidProjectId('dragonfly')).toBe(true);
    expect(isValidProjectId('ai2026')).toBe(true);
    expect(isValidProjectId('a')).toBe(true);
  });

  it('rejects hyphens, uppercase, and other characters', () => {
    expect(isValidProjectId('ai-coach')).toBe(false);
    expect(isValidProjectId('Dragonfly')).toBe(false);
    expect(isValidProjectId('ai_coach')).toBe(false);
  });

  it('rejects empty and over-max', () => {
    expect(isValidProjectId('')).toBe(false);
    expect(isValidProjectId('a'.repeat(PROJECT_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('accepts exactly PROJECT_ID_MAX_LENGTH', () => {
    expect(isValidProjectId('a'.repeat(PROJECT_ID_MAX_LENGTH))).toBe(true);
  });
});

describe('identity: isValidCustomChannelName', () => {
  it('accepts lowercase alphanumeric, no hyphens', () => {
    expect(isValidCustomChannelName('standups')).toBe(true);
    expect(isValidCustomChannelName('q1goals')).toBe(true);
    expect(isValidCustomChannelName('a')).toBe(true);
  });

  it('rejects hyphens and other characters', () => {
    expect(isValidCustomChannelName('daily-standup')).toBe(false);
    expect(isValidCustomChannelName('standup ')).toBe(false);
    expect(isValidCustomChannelName('Standups')).toBe(false);
  });

  it('rejects empty and over-max', () => {
    expect(isValidCustomChannelName('')).toBe(false);
    expect(isValidCustomChannelName('a'.repeat(CUSTOM_CHANNEL_MAX_LENGTH + 1))).toBe(false);
  });

  it('accepts exactly CUSTOM_CHANNEL_MAX_LENGTH', () => {
    expect(isValidCustomChannelName('a'.repeat(CUSTOM_CHANNEL_MAX_LENGTH))).toBe(true);
  });
});

// ── Generators ────────────────────────────────────────────────────────────────

describe('identity: generators', () => {
  it('workspaceGeneralChannelName', () => {
    expect(workspaceGeneralChannelName('kyle')).toBe('kyle-general');
    expect(workspaceGeneralChannelName('christopher-eckert')).toBe('christopher-eckert-general');
  });

  it('workspaceCoachChannelName', () => {
    expect(workspaceCoachChannelName('kyle')).toBe('kyle-coach');
  });

  it('workspaceAdminChannelName', () => {
    expect(workspaceAdminChannelName('kyle')).toBe('kyle-admin');
  });

  it('workspaceCustomChannelName', () => {
    expect(workspaceCustomChannelName('kyle', 'standups')).toBe('kyle-standups');
  });

  it('projectGeneralChannelName', () => {
    expect(projectGeneralChannelName('kyle', 'dragonfly')).toBe('kyle-proj-dragonfly-general');
  });

  it('projectChannelName', () => {
    expect(projectChannelName('kyle', 'dragonfly', 'retro')).toBe('kyle-proj-dragonfly-retro');
  });

  it('longest possible generated name fits MM 64-char cap exactly', () => {
    const u = 'a'.repeat(USERNAME_MAX_LENGTH);
    const p = 'a'.repeat(PROJECT_ID_MAX_LENGTH);
    const c = 'a'.repeat(CUSTOM_CHANNEL_MAX_LENGTH);
    const longest = projectChannelName(u, p, c);
    expect(longest.length).toBe(CHANNEL_NAME_MAX_LENGTH);
  });
});

// ── Recognizers ───────────────────────────────────────────────────────────────

describe('identity: recognizers', () => {
  it('isMmSystemChannel', () => {
    expect(isMmSystemChannel('town-square')).toBe(true);
    expect(isMmSystemChannel('off-topic')).toBe(true);
    expect(isMmSystemChannel('kyle-general')).toBe(false);
  });

  it('isCommunityChannel', () => {
    expect(isCommunityChannel('community-general')).toBe(true);
    expect(isCommunityChannel('community-announcements')).toBe(true);
    expect(isCommunityChannel('kyle-general')).toBe(false);
    expect(isCommunityChannel('community')).toBe(false); // needs hyphen suffix
    expect(isCommunityChannel('')).toBe(false);
  });
});

// ── Parser ────────────────────────────────────────────────────────────────────

describe('identity: parseChannelName', () => {
  it('parses workspace reserved: {u}-general', () => {
    expect(parseChannelName('kyle-general', 'kyle')).toEqual({
      kind: 'workspace',
      username: 'kyle',
      channel: 'general',
      reserved: true,
    });
  });

  it('parses workspace reserved: {u}-coach', () => {
    expect(parseChannelName('kyle-coach', 'kyle')).toEqual({
      kind: 'workspace',
      username: 'kyle',
      channel: 'coach',
      reserved: true,
    });
  });

  it('parses workspace reserved: {u}-admin', () => {
    expect(parseChannelName('kyle-admin', 'kyle')).toEqual({
      kind: 'workspace',
      username: 'kyle',
      channel: 'admin',
      reserved: true,
    });
  });

  it('parses workspace custom: {u}-{custom}', () => {
    expect(parseChannelName('kyle-standups', 'kyle')).toEqual({
      kind: 'workspace',
      username: 'kyle',
      channel: 'standups',
      reserved: false,
    });
  });

  it('parses project general: {u}-proj-{p}-general', () => {
    expect(parseChannelName('kyle-proj-dragonfly-general', 'kyle')).toEqual({
      kind: 'project',
      username: 'kyle',
      project: 'dragonfly',
      channel: 'general',
    });
  });

  it('parses project custom: {u}-proj-{p}-{c}', () => {
    expect(parseChannelName('kyle-proj-dragonfly-retro', 'kyle')).toEqual({
      kind: 'project',
      username: 'kyle',
      project: 'dragonfly',
      channel: 'retro',
    });
  });

  it('handles hyphenated usernames cleanly (no ambiguity)', () => {
    // Because custom channels can't contain hyphens, parsing of
    // {christopher-eckert}-{standups} is unambiguous.
    expect(parseChannelName('christopher-eckert-standups', 'christopher-eckert')).toEqual({
      kind: 'workspace',
      username: 'christopher-eckert',
      channel: 'standups',
      reserved: false,
    });
  });

  it('handles hyphenated usernames with project channels', () => {
    expect(parseChannelName('christopher-eckert-proj-ai-retro', 'christopher-eckert')).toEqual({
      kind: 'project',
      username: 'christopher-eckert',
      project: 'ai',
      channel: 'retro',
    });
  });

  it('returns kind:system for MM system channels regardless of username', () => {
    expect(parseChannelName('town-square', 'kyle')).toEqual({ kind: 'system', name: 'town-square' });
    expect(parseChannelName('off-topic', 'kyle')).toEqual({ kind: 'system', name: 'off-topic' });
  });

  it('returns kind:community for community-* channels', () => {
    expect(parseChannelName('community-general', 'kyle')).toEqual({
      kind: 'community',
      name: 'community-general',
    });
  });

  it('returns kind:foreign when the prefix does not match the username', () => {
    expect(parseChannelName('christopher-eckert-general', 'kyle')).toEqual({
      kind: 'foreign',
      name: 'christopher-eckert-general',
    });
  });

  it('returns kind:unknown for channels that fit no rule', () => {
    // Extra segment between username and channel portion
    expect(parseChannelName('kyle-proj-dragonfly-with-dash', 'kyle').kind).toBe('unknown');
    // Username present but rest has unexpected shape
    expect(parseChannelName('kyle-', 'kyle').kind).toBe('unknown');
  });

  it('returns kind:unknown for empty input', () => {
    expect(parseChannelName('', 'kyle').kind).toBe('unknown');
  });
});

// ── Cross-workspace attribution ──────────────────────────────────────────────

describe('identity: attributeChannelToUsername', () => {
  it('returns the owning username for workspace channels', () => {
    expect(attributeChannelToUsername('kyle-general', ['kyle', 'chris'])).toBe('kyle');
  });

  it('returns the owning username for project channels', () => {
    expect(attributeChannelToUsername('chris-proj-ai-retro', ['kyle', 'chris'])).toBe('chris');
  });

  it('returns null for MM system channels', () => {
    expect(attributeChannelToUsername('town-square', ['kyle'])).toBeNull();
  });

  it('returns null for community channels', () => {
    expect(attributeChannelToUsername('community-general', ['kyle'])).toBeNull();
  });

  it('returns null when no known username matches', () => {
    expect(attributeChannelToUsername('alice-general', ['kyle', 'chris'])).toBeNull();
  });

  it('disambiguates prefix-ambiguous usernames by longest match', () => {
    // If both kyle and kyle-x exist and we see kyle-x-general, attribution
    // must pick kyle-x — the longest-matching username — not kyle.
    expect(attributeChannelToUsername('kyle-x-general', ['kyle', 'kyle-x'])).toBe('kyle-x');
    // Reverse order in the usernames list should not change the outcome.
    expect(attributeChannelToUsername('kyle-x-general', ['kyle-x', 'kyle'])).toBe('kyle-x');
  });
});

// ── deriveJoinedUsernames ────────────────────────────────────────────────────

describe('identity: deriveJoinedUsernames', () => {
  it('collects usernames from each reserved-suffix channel', () => {
    const channels = [
      { name: 'kyle-general', type: 'P' },
      { name: 'chris-coach', type: 'P' },
      { name: 'alice-admin', type: 'P' },
    ];
    expect(deriveJoinedUsernames(channels, null)).toEqual(['alice', 'chris', 'kyle']);
  });

  it('handles hyphenated usernames by stripping only the reserved suffix', () => {
    const channels = [
      { name: 'christopher-eckert-general', type: 'P' },
      { name: 'ai-2026-coach', type: 'P' },
    ];
    expect(deriveJoinedUsernames(channels, null)).toEqual(['ai-2026', 'christopher-eckert']);
  });

  it('excludes the caller\'s own username', () => {
    const channels = [
      { name: 'kyle-general', type: 'P' },
      { name: 'chris-general', type: 'P' },
    ];
    expect(deriveJoinedUsernames(channels, 'kyle')).toEqual(['chris']);
  });

  it('ignores DM channels, project channels, and custom channels', () => {
    const channels = [
      { name: 'user1__user2', type: 'D' },                     // DM
      { name: 'kyle-proj-dragonfly-general', type: 'P' },      // project channel
      { name: 'kyle-standups', type: 'P' },                    // custom workspace channel
      { name: 'town-square', type: 'O' },                      // MM system
      { name: 'community-general', type: 'O' },                // community
      { name: 'kyle-general', type: 'P' },                     // <- the only counter
    ];
    expect(deriveJoinedUsernames(channels, null)).toEqual(['kyle']);
  });

  it('deduplicates — one user with multiple reserved channels counts once', () => {
    const channels = [
      { name: 'kyle-general', type: 'P' },
      { name: 'kyle-coach', type: 'P' },
      { name: 'kyle-admin', type: 'P' },
    ];
    expect(deriveJoinedUsernames(channels, null)).toEqual(['kyle']);
  });

  it('returns empty for empty input', () => {
    expect(deriveJoinedUsernames([], null)).toEqual([]);
  });
});

// ── MM compatibility ────────────────────────────────────────────────────────

describe('identity: MM compatibility', () => {
  it('every valid username also satisfies MM\'s team-name regex', () => {
    const cases = [
      'ab', 'kyle', 'christopher-eckert', 'ai-2026', 'a1', 'one-two-three-four',
      'a'.repeat(USERNAME_MAX_LENGTH),
    ];
    for (const name of cases) {
      expect(isValidUsername(name)).toBe(true);
      expect(MM_TEAM_NAME_RE.test(name)).toBe(true);
    }
  });
});
