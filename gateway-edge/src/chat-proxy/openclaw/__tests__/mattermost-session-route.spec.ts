import { describe, expect, it } from 'vitest';
import { parseMattermostSessionRoute } from '../mattermost-session-route.js';

describe('parseMattermostSessionRoute', () => {
  it('keeps the primary Mattermost channel separate from a modern thread root', () => {
    expect(
      parseMattermostSessionRoute(
        'agent:octogee-alice-coach:mattermost:channel:channel-1:thread:turn-root-1',
      ),
    ).toEqual({
      agentId: 'octogee-alice-coach',
      peerKind: 'channel',
      primaryChannelId: 'channel-1',
      threadRootPostId: 'turn-root-1',
    });
  });

  it('parses channel-scoped and group-scoped sessions without fabricating a thread', () => {
    expect(
      parseMattermostSessionRoute('agent:coach:mattermost:channel:channel-1'),
    ).toEqual({
      agentId: 'coach',
      peerKind: 'channel',
      primaryChannelId: 'channel-1',
    });
    expect(parseMattermostSessionRoute('agent:coach:mattermost:group:group-1')).toEqual({
      agentId: 'coach',
      peerKind: 'group',
      primaryChannelId: 'group-1',
    });
    expect(parseMattermostSessionRoute('agent:coach:mattermost:direct:user-1')).toEqual({
      agentId: 'coach',
      peerKind: 'direct',
      primaryChannelId: 'user-1',
    });
  });

  it.each([
    '',
    'agent:coach:main',
    'agent:coach:mattermost:channel:channel-1:thread',
    'agent:coach:mattermost:channel:channel-1:thread:root:extra',
  ])('rejects malformed or non-channel Mattermost session key %j', (sessionKey) => {
    expect(parseMattermostSessionRoute(sessionKey)).toBeNull();
  });
});
