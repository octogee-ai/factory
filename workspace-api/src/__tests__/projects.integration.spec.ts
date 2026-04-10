/**
 * Integration tests for /api/projects routes.
 *
 * Covers:
 *   POST   /api/projects              — create project
 *   POST   /api/projects/:id/join     — join a project
 *   POST   /api/projects/:id/star     — toggle star
 *   DELETE /api/projects/:id/members/:guestUid — remove guest
 */
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockMmApi = vi.fn();
const mockGiteaApi = vi.fn();

// ── Firestore mock state ─────────────────────────────────────────────────────

const firestoreData: Record<string, any> = {};

const mockSet = vi.fn().mockResolvedValue(undefined);
const mockUpdate = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockResolvedValue(undefined);

// ── db mock ──────────────────────────────────────────────────────────────────

vi.mock('../lib/db', () => ({
  auth: {
    verifyIdToken: vi.fn().mockResolvedValue({ uid: 'caller-uid' }),
  },
  db: {
    doc: (path: string) => ({
      get: async () => {
        const data = firestoreData[path];
        return { exists: !!data, data: () => data };
      },
      set: (data: any) => mockSet(path, data),
      update: (data: any) => mockUpdate(path, data),
      delete: () => mockDelete(path),
    }),
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = firestoreData[`${name}/${id}`];
          return { exists: !!data, data: () => data };
        },
        set: (data: any) => mockSet(`${name}/${id}`, data),
        update: (data: any) => mockUpdate(`${name}/${id}`, data),
        collection: (sub: string) => ({
          doc: (subId: string) => ({
            get: async () => {
              const key = `${name}/${id}/${sub}/${subId}`;
              const data = firestoreData[key];
              return { exists: !!data, data: () => data };
            },
          }),
        }),
      }),
      where: (_field: string, _op: string, _val: any) => ({
        where: (_f2: string, _o2: string, _v2: any) => ({
          limit: (_n: number) => ({
            get: async () => ({ empty: true, docs: [] }),
          }),
        }),
        limit: (_n: number) => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
  },
  FieldValue: {
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    increment: (n: number) => ({ __op: 'increment', value: n }),
    arrayUnion: (v: any) => ({ __op: 'arrayUnion', value: v }),
    arrayRemove: (v: any) => ({ __op: 'arrayRemove', value: v }),
  },
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d }),
  },
}));

vi.mock('../lib/mattermost', () => ({
  mmApi: (...args: any[]) => mockMmApi(...args),
  MM_URL: 'http://mattermost-test:8065',
}));

vi.mock('../lib/gitea', () => ({
  giteaApi: (...args: any[]) => mockGiteaApi(...args),
  giteaApiAllowNotFound: vi.fn(),
  GITEA_ORG: 'octogee-test',
}));

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEvent: vi.fn() } }),
  getWebhookSecret: () => 'whsec_test',
}));

// Stub generateProjectSlug to a deterministic hash4 so test assertions can
// pin the canonical {wsSlug}-proj-{projSlug}-general channel name without
// dealing with randomness.
vi.mock('../lib/channelNames', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/channelNames')>();
  return {
    ...actual,
    generateProjectSlug: vi.fn(() => 'c91d'),
  };
});

import { createApp } from '../index';

// Canonical fixtures: workspace slugs follow {noun}-{verb}-{hash4},
// project slugs are {hash4}. See shared/types/slugGenerator.ts.
const WS = 'alive-fired-a3f2';
const PJ = 'c91d';
const PROJECT_ID = `${WS}_${PJ}`;

// ── Shared seed helpers ──────────────────────────────────────────────────────

function seedBaseData() {
  firestoreData['users/caller-uid'] = {
    workspaceSlug: WS,
    mattermost: { teamId: 'team-1', userId: 'mm-caller' },
  };
  firestoreData['users/owner-uid'] = {
    mattermost: { teamId: 'team-1' },
  };
  firestoreData['users/guest-uid'] = {
    mattermost: { userId: 'mm-guest' },
    workspaceSlug: 'guest-slug',
  };
}

// ── beforeAll / beforeEach ───────────────────────────────────────────────────

beforeAll(() => {
  process.env.INVITE_SECRET = 'test-secret';
});

// ── POST /api/projects ───────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset firestoreData in-place
    for (const key of Object.keys(firestoreData)) delete firestoreData[key];

    const { auth } = await import('../lib/db');
    (auth.verifyIdToken as any).mockResolvedValue({ uid: 'caller-uid' });

    seedBaseData();

    // MM channel creation returns a new channel id
    mockMmApi.mockResolvedValue({ id: 'ch-new' });
    mockGiteaApi.mockResolvedValue({});
  });

  it('creates project with correct canonical shape', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Alpha Project', visibility: 'public' });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(PROJECT_ID);
    expect(res.body.slug).toBe(PJ);
    expect(res.body.workspaceSlug).toBe(WS);

    // Initial set call must include provisioningState + private during provisioning
    const setCall = mockSet.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(setCall).toBeDefined();
    expect(setCall![1]).toMatchObject({
      ownerUid: 'caller-uid',
      provisioningState: 'provisioning',
      visibility: 'private',
      guestUids: [],
    });

    // Update call must flip to active + requested visibility
    const updateCall = mockUpdate.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toMatchObject({
      provisioningState: 'active',
      visibility: 'public',
    });
  });

  it('rejects missing project name', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects when workspace not provisioned', async () => {
    firestoreData['users/caller-uid'] = {}; // no workspaceSlug

    const app = createApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Alpha Project' });

    expect(res.status).toBe(422);
  });

  it('rejects duplicate project', async () => {
    firestoreData[`projects/${PROJECT_ID}`] = { ownerUid: 'caller-uid' };

    const app = createApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Alpha' });

    expect(res.status).toBe(409);
  });

  it('provisions MM channel with correct naming convention', async () => {
    const app = createApp();
    await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Alpha Project', visibility: 'public' });

    expect(mockMmApi).toHaveBeenCalledWith(
      '/channels',
      'POST',
      expect.objectContaining({
        name: `${WS}-proj-${PJ}-general`,
        team_id: 'team-1',
      }),
    );
  });
});

// ── POST /api/projects/:id/join ──────────────────────────────────────────────

describe('POST /api/projects/:id/join', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(firestoreData)) delete firestoreData[key];

    const { auth } = await import('../lib/db');
    (auth.verifyIdToken as any).mockResolvedValue({ uid: 'caller-uid' });

    seedBaseData();

    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'owner-uid',
      visibility: 'public',
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: [],
    };

    // Default: workspace membership check succeeds
    mockMmApi.mockResolvedValue({});
    mockGiteaApi.mockResolvedValue({});
  });

  it('public project join succeeds when caller is workspace member', async () => {
    // GET /teams/team-1/members/mm-caller — returns success (member found)
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (path === '/teams/team-1/members/mm-caller' && !method) return { user_id: 'mm-caller' };
      return {};
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/join`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);

    // guestUids arrayUnion was applied
    const updateCall = mockUpdate.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toMatchObject({
      guestUids: expect.objectContaining({ __op: 'arrayUnion', value: 'caller-uid' }),
    });
  });

  it('private project join rejects without invite', async () => {
    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'owner-uid',
      visibility: 'private',
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: [],
    };

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/join`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/private/i);
  });

  it('project join succeeds WITHOUT workspace membership — adds silent team membership', async () => {
    // Independent membership (epic #428): user NOT in team → gets added to
    // team silently (for channel access) but NOT to #general.
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      // Team membership check: user is NOT a member yet
      if (path === '/teams/team-1/members/mm-caller' && !method) {
        throw new Error('MM API 404: not a team member');
      }
      return {};
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/join`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);

    // User was added to MM team (silent membership)
    expect(mockMmApi).toHaveBeenCalledWith(
      '/teams/team-1/members',
      'POST',
      expect.objectContaining({ user_id: 'mm-caller' }),
    );

    // User was NOT added to #general channel — only project channel
    const channelMemberCalls = mockMmApi.mock.calls.filter(
      ([path, method]) => path.includes('/channels/') && path.includes('/members') && method === 'POST',
    );
    // Only the project channel join, not #general
    expect(channelMemberCalls).toHaveLength(1);
    expect(channelMemberCalls[0][0]).toBe('/channels/ch-alpha/members');

    // guestUids was updated
    const updateCall = mockUpdate.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toMatchObject({
      guestUids: expect.objectContaining({ __op: 'arrayUnion', value: 'caller-uid' }),
    });
  });

  it('project join succeeds when caller is already a team member', async () => {
    // User already in team (workspace member) — no extra team add needed
    mockMmApi.mockImplementation(async (path: string, method?: string) => {
      if (path === '/teams/team-1/members/mm-caller' && !method) return { user_id: 'mm-caller' };
      return {};
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/join`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
  });

  it('owner cannot join their own project as guest', async () => {
    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'caller-uid', // caller IS the owner
      visibility: 'public',
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: [],
    };

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/join`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own/i);
  });

  it('rejects join for nonexistent project', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/nonexistent/join')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });
});

// ── POST /api/projects/:id/star ──────────────────────────────────────────────

describe('POST /api/projects/:id/star', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(firestoreData)) delete firestoreData[key];

    const { auth } = await import('../lib/db');
    (auth.verifyIdToken as any).mockResolvedValue({ uid: 'caller-uid' });

    seedBaseData();

    firestoreData[`projects/${PROJECT_ID}`] = { ownerUid: 'owner-uid' };
  });

  it('stars a project (creates star doc)', async () => {
    // stars/caller-uid_${PROJECT_ID} is NOT in firestoreData — so star doesn't exist yet

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/star`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.starred).toBe(true);

    // Star doc was created with starrerUid
    const setCall = mockSet.mock.calls.find(
      ([path]) => path === `stars/caller-uid_${PROJECT_ID}`,
    );
    expect(setCall).toBeDefined();
    expect(setCall![1]).toMatchObject({ starrerUid: 'caller-uid' });
  });

  it('unstars a project (deletes star doc)', async () => {
    firestoreData[`stars/caller-uid_${PROJECT_ID}`] = {
      starrerUid: 'caller-uid',
      projectId: PROJECT_ID,
    };

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/star`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.starred).toBe(false);

    const deleteCall = mockDelete.mock.calls.find(
      ([path]) => path === `stars/caller-uid_${PROJECT_ID}`,
    );
    expect(deleteCall).toBeDefined();
  });

  it('rejects star on nonexistent project', async () => {
    // Remove the project from firestoreData
    delete firestoreData[`projects/${PROJECT_ID}`];

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/star`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });
});

// ── POST /api/projects/:id/leave ─────────────────────────────────────────────

describe('POST /api/projects/:id/leave', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(firestoreData)) delete firestoreData[key];

    const { auth } = await import('../lib/db');
    (auth.verifyIdToken as any).mockResolvedValue({ uid: 'caller-uid' });

    seedBaseData();

    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'owner-uid',
      workspaceSlug: WS,
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: ['caller-uid'],
    };

    mockMmApi.mockResolvedValue({});
    mockGiteaApi.mockResolvedValue({});
  });

  it('removes caller from guestUids, MM channel, and Gitea', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/leave`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);

    // guestUids arrayRemove was applied
    const updateCall = mockUpdate.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toMatchObject({
      guestUids: expect.objectContaining({ __op: 'arrayRemove', value: 'caller-uid' }),
    });

    // MM channel member removal was called
    expect(mockMmApi).toHaveBeenCalledWith(
      '/channels/ch-alpha/members/mm-caller',
      'DELETE',
    );

    // Gitea collaborator removal was called
    expect(mockGiteaApi).toHaveBeenCalledWith(
      `${WS}-proj-${PJ}/collaborators/ws-${WS}`,
      'DELETE',
    );
  });

  it('rejects leave on nonexistent project', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/projects/nonexistent/leave')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });

  it('owner cannot leave their own project', async () => {
    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'caller-uid', // caller IS the owner
      workspaceSlug: WS,
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: [],
    };

    const app = createApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/leave`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/projects/:id/members/:guestUid ───────────────────────────────

describe('DELETE /api/projects/:id/members/:guestUid', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(firestoreData)) delete firestoreData[key];

    const { auth } = await import('../lib/db');
    (auth.verifyIdToken as any).mockResolvedValue({ uid: 'caller-uid' });

    seedBaseData();

    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'caller-uid',
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: ['guest-uid'],
    };

    mockMmApi.mockResolvedValue({});
    mockGiteaApi.mockResolvedValue({});
  });

  it('owner can remove guest', async () => {
    const app = createApp();
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/members/guest-uid`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);

    // guestUids arrayRemove was applied
    const updateCall = mockUpdate.mock.calls.find(
      ([path]) => path === `projects/${PROJECT_ID}`,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toMatchObject({
      guestUids: expect.objectContaining({ __op: 'arrayRemove', value: 'guest-uid' }),
    });

    // MM channel member removal was called
    expect(mockMmApi).toHaveBeenCalledWith(
      '/channels/ch-alpha/members/mm-guest',
      'DELETE',
    );
  });

  it('non-owner cannot remove guest', async () => {
    firestoreData[`projects/${PROJECT_ID}`] = {
      ownerUid: 'someone-else',
      mmChannelId: 'ch-alpha',
      giteaRepoName: `${WS}-proj-${PJ}`,
      guestUids: ['guest-uid'],
    };

    const app = createApp();
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/members/guest-uid`)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
  });
});
