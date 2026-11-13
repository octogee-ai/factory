import { describe, expect, it } from 'vitest';
import {
  parseChannelScopedMattermostSessionRoute,
  parseMattermostSessionRoute,
  parseThreadedMattermostSessionRoute,
} from './mattermost-session-route.js';

const CHANNEL_ID = 'a'.repeat(26);
const OWNER_USER_ID = 'b'.repeat(26);
const ROOT_POST_ID = 'c'.repeat(26);

describe('parseMattermostSessionRoute', () => {
  it('preserves legacy and unthreaded Mattermost activity routes', () => {
    expect(parseMattermostSessionRoute('agent:coach:mattermost:channel:channel-1')).toEqual({
      agentId: 'coach',
      peerKind: 'channel',
      primaryChannelId: 'channel-1',
    });
    expect(
      parseMattermostSessionRoute(
        'agent:coach:mattermost:direct:user-1:thread:root-1',
      ),
    ).toEqual({
      agentId: 'coach',
      peerKind: 'direct',
      primaryChannelId: 'user-1',
      threadRootPostId: 'root-1',
    });
  });

  it.each([
    undefined,
    '',
    'agent:coach:main',
    'agent:coach:mattermost:channel:channel-1:thread',
    'agent:coach:mattermost:channel:channel-1:thread:root:extra',
  ])('rejects malformed Mattermost activity route %j', (sessionKey) => {
    expect(parseMattermostSessionRoute(sessionKey)).toBeNull();
  });
});

describe('parseChannelScopedMattermostSessionRoute', () => {
  it.each(['group', 'channel'] as const)(
    'parses a canonical channel-scoped %s route',
    (peerKind) => {
      expect(
        parseChannelScopedMattermostSessionRoute(
          `agent:octogee-alice-coach:mattermost:${peerKind}:${CHANNEL_ID}`,
        ),
      ).toEqual({
        agentId: 'octogee-alice-coach',
        peerKind,
        primaryChannelId: CHANNEL_ID,
      });
    },
  );

  it.each([
    `agent:octogee-alice-coach:mattermost:direct:${OWNER_USER_ID}`,
    `agent:octogee-alice-coach:mattermost:group:${CHANNEL_ID}:thread:${ROOT_POST_ID}`,
    `agent:coach:mattermost:group:${CHANNEL_ID}`,
    `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(25)}`,
  ])('rejects a non-channel session %j', (sessionKey) => {
    expect(parseChannelScopedMattermostSessionRoute(sessionKey)).toBeNull();
  });
});

describe('parseThreadedMattermostSessionRoute', () => {
  it.each([
    ['group', CHANNEL_ID],
    ['channel', CHANNEL_ID],
    ['direct', OWNER_USER_ID],
  ] as const)('parses a canonical threaded %s route', (peerKind, primaryChannelId) => {
    expect(
      parseThreadedMattermostSessionRoute(
        `agent:octogee-alice-coach:mattermost:${peerKind}:${primaryChannelId}:thread:${ROOT_POST_ID}`,
      ),
    ).toEqual({
      agentId: 'octogee-alice-coach',
      peerKind,
      primaryChannelId,
      threadRootPostId: ROOT_POST_ID,
    });
  });

  it('accepts a canonical project Agent id', () => {
    expect(
      parseThreadedMattermostSessionRoute(
        `agent:octogee-alice-proj-orbit-coach:mattermost:group:${CHANNEL_ID}:thread:${ROOT_POST_ID}`,
      )?.agentId,
    ).toBe('octogee-alice-proj-orbit-coach');
  });

  it.each([
    `agent:octogee-alice-coach:mattermost:group:${CHANNEL_ID}`,
    `agent:coach:mattermost:group:${CHANNEL_ID}:thread:${ROOT_POST_ID}`,
    `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(25)}:thread:${ROOT_POST_ID}`,
    `agent:octogee-alice-coach:mattermost:group:${'A'.repeat(26)}:thread:${ROOT_POST_ID}`,
    `agent:octogee-alice-coach:mattermost:direct:${OWNER_USER_ID}:thread:${'c'.repeat(27)}`,
    `agent:octogee-alice-coach:mattermost:direct:${OWNER_USER_ID}:thread:${'c'.repeat(25)}`,
    `agent:octogee-alice-coach:mattermost:direct:${OWNER_USER_ID}:thread:${ROOT_POST_ID}:extra`,
  ])('rejects non-canonical composer route %j', (sessionKey) => {
    expect(parseThreadedMattermostSessionRoute(sessionKey)).toBeNull();
  });
});
