import { beforeEach, describe, expect, it, vi } from 'vitest';

const firestoreData: Record<string, any> = {};

function makeDocRef(path: string) {
  return {
    path,
    get: async () => {
      const data = firestoreData[path];
      return { exists: !!data, data: () => data };
    },
  };
}

vi.mock('../lib/db', () => ({
  db: {
    doc: (path: string) => makeDocRef(path),
  },
}));

import {
  readAgent,
  readChannel,
  readMember,
  readProject,
  readWorkspace,
} from '../lib/firestoreReads.js';

beforeEach(() => {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
});

describe('readProject', () => {
  it('returns null when the doc does not exist', async () => {
    const ref = makeDocRef('workspaces/alice/projects/missing') as any;
    expect(await readProject(ref)).toBeNull();
  });

  it('returns the typed Project on a present doc', async () => {
    firestoreData['workspaces/alice/projects/game'] = {
      id: 'game',
      ownerUid: 'u-alice',
      workspaceId: 'alice',
      slug: 'game',
      name: 'My Game',
      visibility: 'private',
      provisioningState: 'active',
    };
    const ref = makeDocRef('workspaces/alice/projects/game') as any;
    const project = await readProject(ref);
    expect(project).not.toBeNull();
    expect(project!.ownerUid).toBe('u-alice');
    expect(project!.visibility).toBe('private');
  });
});

describe('readWorkspace', () => {
  it('returns null when the doc does not exist', async () => {
    expect(await readWorkspace('nobody')).toBeNull();
  });

  it('returns the typed Workspace on a present doc', async () => {
    firestoreData['workspaces/alice'] = {
      id: 'alice',
      ownerUid: 'u-alice',
      slug: 'alice',
      name: 'alice',
      ownerDisplayName: 'alice',
      visibility: 'public',
      mattermost: { teamId: 'team-abc' },
      gitea: { orgName: 'alice', repoName: 'alice-workspace' },
    };
    const workspace = await readWorkspace('alice');
    expect(workspace).not.toBeNull();
    expect(workspace!.mattermost.teamId).toBe('team-abc');
    expect(workspace!.gitea.orgName).toBe('alice');
  });

  it('returns null for a slug that fails the username regex (no Firestore read)', async () => {
    firestoreData['workspaces/BAD SLUG'] = { id: 'x', ownerUid: 'u', slug: 'x' };
    expect(await readWorkspace('BAD SLUG')).toBeNull();
  });

  it('rejects path-traversal attempts in the slug', async () => {
    expect(await readWorkspace('../other')).toBeNull();
  });
});

describe('readAgent', () => {
  it('returns null when the doc does not exist', async () => {
    expect(await readAgent('u-nobody')).toBeNull();
  });

  it('returns the typed Agent on a present doc', async () => {
    firestoreData['agents/u-alice'] = {
      id: 'u-alice',
      name: 'Octo',
      persona: 'helpful coach',
      mattermost: { userId: 'mm-agent-1' },
    };
    const agent = await readAgent('u-alice');
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('Octo');
    expect(agent!.mattermost.userId).toBe('mm-agent-1');
  });
});

describe('readMember', () => {
  it('returns null when the doc does not exist', async () => {
    const ref = makeDocRef('workspaces/alice/projects/game/members/u-bob') as any;
    expect(await readMember(ref)).toBeNull();
  });

  it('returns the typed Member on a present doc', async () => {
    firestoreData['workspaces/alice/projects/game/members/u-bob'] = {
      id: 'u-bob',
      role: 'member',
      joinedAt: {},
    };
    const ref = makeDocRef('workspaces/alice/projects/game/members/u-bob') as any;
    const member = await readMember(ref);
    expect(member).not.toBeNull();
    expect(member!.role).toBe('member');
  });
});

describe('readChannel', () => {
  it('returns null when the doc does not exist', async () => {
    const ref = makeDocRef('workspaces/alice/channels/general') as any;
    expect(await readChannel(ref)).toBeNull();
  });

  it('returns the typed Channel for a general channel', async () => {
    firestoreData['workspaces/alice/channels/general'] = {
      id: 'general',
      kind: 'general',
      name: 'General',
      mattermost: { channelId: 'ch-gen' },
    };
    const ref = makeDocRef('workspaces/alice/channels/general') as any;
    const channel = await readChannel(ref);
    expect(channel).not.toBeNull();
    expect(channel!.mattermost.channelId).toBe('ch-gen');
  });

  it('accepts coach-dm kind (workspace-level channel)', async () => {
    firestoreData['workspaces/alice/channels/coach-dm'] = {
      id: 'coach-dm',
      kind: 'coach-dm',
      name: 'Coach',
      mattermost: { channelId: 'ch-coach' },
    };
    const ref = makeDocRef('workspaces/alice/channels/coach-dm') as any;
    const channel = await readChannel(ref);
    expect(channel).not.toBeNull();
    expect(channel!.kind).toBe('coach-dm');
  });
});
