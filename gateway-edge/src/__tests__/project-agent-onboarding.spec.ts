import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ docs: new Map<string, any>(), mm: vi.fn(), seed: vi.fn(), avatar: vi.fn(), blob: vi.fn(), log: vi.fn() }));
function ref(path: string) {
  return { path, set: async (value: unknown) => { h.docs.set(path, structuredClone(value)); }, get: async () => ({ data: () => structuredClone(h.docs.get(path)) }), update: async (patch: Record<string, unknown>) => {
    const data = h.docs.get(path);
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = data;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      if (value === 'DELETE') delete target[parts.at(-1)!]; else target[parts.at(-1)!] = structuredClone(value);
    }
  } };
}
vi.mock('../lib/db.js', () => ({ db: { doc: ref, runTransaction: (fn: any) => fn({ get: (r: any) => r.get(), set: (r: any, p: any) => r.set(p), update: (r: any, p: any) => r.update(p) }) }, FieldValue: { delete: () => 'DELETE', serverTimestamp: () => 'NOW', increment: () => 1 } }));
vi.mock('../lib/mattermost.js', () => ({ mmApi: h.mm, mmUploadAvatarBuffer: h.avatar }));
vi.mock('../middleware/logging.js', () => ({ logger: { error: h.log } }));
vi.mock('../lib/gitea.js', () => ({ giteaWriteFiles: h.seed }));
vi.mock('../lib/fileTarget.js', () => ({ resolveFileTarget: async () => ({ ok: true, target: {} }) }));
vi.mock('../lib/workspace-blob.js', () => ({ storeWorkspaceBlob: h.blob }));
import { parseProjectHandoff, queueProjectHandoff, deliverProjectAgentOnboarding } from '../lib/project-agent-onboarding.js';
import { syncProjectAgentIdentity } from '../lib/project-agent-identity.js';
import { projectAgentSecretDocId } from '@octogee/core/mattermost/project-agent';
const projectPath = 'workspaces/alice/projects/golf';
const handoff = { name: 'Chip', emoji: '⛳', persona: 'A calm golf caddie, with Piper’s practical style.', message: 'Build Chris and Robert a shared golf dashboard. Chris prefers simple controls.' };
beforeEach(() => {
  vi.clearAllMocks(); h.docs.clear();
  h.docs.set(projectPath, { ownerUid: 'u', name: 'Fairway Partners', tagline: 'A shared golf dashboard', provisioningState: 'active', agent: { mode: 'scoped', enabled: true, status: 'ready', requestedName: '', identity: { name: 'golf', emoji: '🤖', persona: '' } } });
  h.docs.set(`${projectPath}/channels/general`, { mattermost: { channelId: 'general' } });
  h.docs.set('workspaces/alice/channels/coach-dm', { mattermost: { channelId: 'coach-dm' } });
  h.docs.set('users/u/secrets/coachMattermost', { personalToken: 'coach-token' });
  h.docs.set('agents/u', { mattermost: { userId: 'coach' }, name: 'Piper' });
  h.docs.set('users/u', { displayName: 'Private Builder Name' });
  h.docs.set('users/u/secrets/mattermost', { personalToken: 'builder-token' });
  h.docs.set(`users/u/secrets/${projectAgentSecretDocId('golf')}`, { mmUserId: 'chip' });
  h.mm.mockImplementation(async (path: string, method: string) => {
    if (path.includes('/posts?')) return { order: [], posts: {} };
    if (path === '/posts') return { id: 'post-1' };
    if (path.includes('/members/') && method === 'GET') throw Object.assign(new Error('missing'), { status: 404 });
    return {};
  });
  h.seed.mockResolvedValue(undefined); h.avatar.mockResolvedValue(true); h.blob.mockResolvedValue({ gcsPath: 'private/avatar' });
});
it('queues a distinct identity and context, honoring the Builder’s requested name', async () => {
  h.docs.get(projectPath).agent.requestedName = 'Birdie';
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  expect(h.docs.get(projectPath).agent.identity).toEqual({ name: 'Birdie', emoji: '⛳', persona: handoff.persona });
  expect(h.docs.get(projectPath).agent.handoff).toEqual({ status: 'pending' });
  expect(h.docs.get(`${projectPath}/agentState/handoff`).message).toBe(handoff.message);
  expect(h.mm).not.toHaveBeenCalled();
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  await queueProjectHandoff('u', 'alice', 'golf', { ...handoff, persona: 'Patient golf tutor', message: 'Different task' });
  expect(h.docs.get(`${projectPath}/agentState/handoff`).message).toBe('Different task');
  expect(h.docs.get(projectPath).agent.identity.persona).toBe('Patient golf tutor');
});
it('rejects a handoff to another Builder’s project and malformed input', async () => {
  await expect(queueProjectHandoff('other', 'alice', 'golf', handoff)).rejects.toThrow('active project');
  expect(parseProjectHandoff({ ...handoff, emoji: '' })).toBeNull();
  expect(parseProjectHandoff(handoff)).toEqual(handoff);
});
it('waits for readiness, then seeds the repo and posts the coach handoff once in project general', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.get(projectPath).agent.status = 'provisioning';
  await deliverProjectAgentOnboarding('u', 'alice', 'golf'); expect(h.mm).not.toHaveBeenCalled();
  h.docs.get(projectPath).agent.status = 'ready';
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.seed.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'BRIEF.md', content: expect.stringContaining(handoff.message) }), expect.objectContaining({ path: 'SOUL.md', content: expect.stringContaining(handoff.persona) })]));
  expect(h.mm).toHaveBeenCalledWith('/posts', 'POST', expect.objectContaining({ channel_id: 'general', message: expect.stringContaining('@alice-proj-golf-coach') }), 'coach-token');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('sent');
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.filter(c => c[0] === '/posts')).toHaveLength(1);
});
it('recovers an acknowledged post after a lost delivery receipt without reposting', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.set(`${projectPath}/agentState/handoffDelivery`, { startedAt: Date.now() - 5_000, postAttempted: true });
  h.mm.mockImplementation(async (path: string) => path.includes('/posts?') ? { order: ['prior'], posts: { prior: { id: 'prior', props: { octogee_project_delivery: 'alice/golf/handoff' } } } } : {});
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.docs.get(projectPath).agent.handoff.postId).toBe('prior');
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
});
it('keeps a failed delivery pending and records the error for retry', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff); h.seed.mockRejectedValueOnce(new Error('Gitea unavailable'));
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Gitea unavailable');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('pending');
  expect(h.docs.get(projectPath).agent.lastError).toBe('Gitea unavailable');
  expect(h.docs.get(projectPath).agent.deliveryLeaseUntil).toBeUndefined();
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('sent');
});
it('starts UI-created projects with their own agent in project general', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm).toHaveBeenCalledWith('/posts', 'POST', expect.objectContaining({ channel_id: 'general', message: expect.stringContaining('A shared golf dashboard') }), 'coach-token');
});
it('updates only the project bot, including its avatar and emoji', async () => {
  await expect(syncProjectAgentIdentity('u', 'alice', 'golf', { name: 'Chip', emoji: '⛳', avatarPng: Buffer.from('png') })).resolves.toEqual(['name', 'emoji', 'avatar']);
  expect(h.mm).toHaveBeenCalledWith('/bots/chip', 'PUT', { display_name: 'Chip' });
  expect(h.avatar).toHaveBeenCalledWith('chip', Buffer.from('png'));
  expect(h.docs.get('agents/u').name).toBe('Piper');
  expect(h.docs.get(projectPath).agent.identity.emoji).toBe('⛳');
  await expect(syncProjectAgentIdentity('other', 'alice', 'golf', { name: 'No' })).rejects.toThrow('unavailable');
});
it('does not claim that a rejected avatar upload succeeded', async () => {
  delete h.docs.get(projectPath).agent.identity;
  h.avatar.mockResolvedValueOnce(false);
  await expect(syncProjectAgentIdentity('u', 'alice', 'golf', { avatarPng: Buffer.from('png') })).rejects.toThrow('could not');
  expect(h.docs.get(projectPath).agent.identity).toBeUndefined();
});

it('initializes a complete independent identity when customizing a project that has not been named yet', async () => {
  delete h.docs.get(projectPath).agent.identity;
  await syncProjectAgentIdentity('u', 'alice', 'golf', { emoji: '⛳' });
  expect(h.docs.get(projectPath).agent.identity).toEqual({ name: 'Fairway Partners', emoji: '⛳', persona: '' });
});

it('refuses corrections after delivery or while a delivery owns the lease', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() + 120_000;
  await expect(queueProjectHandoff('u', 'alice', 'golf', { ...handoff, message: 'Correction' })).rejects.toThrow('in progress');
  delete h.docs.get(projectPath).agent.deliveryLeaseUntil;
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  await expect(queueProjectHandoff('u', 'alice', 'golf', { ...handoff, message: 'Correction' })).rejects.toThrow('already');
});
it('does not rescan old project chat history when starting a kickoff', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  const posts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), { id: String(i), create_at: 1 }]));
  h.mm.mockImplementation(async (path: string) => path.includes('/posts?') ? { order: Object.keys(posts), posts } : { id: 'post-1' });
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.filter(c => c[0].includes('/posts?'))).toHaveLength(0);
});
it('continues bounded receipt recovery after 300 newer posts without repeating or skipping pages', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  h.docs.set(`${projectPath}/agentState/kickoffDelivery`, { startedAt: Date.now() - 5_000, postAttempted: true });
  let pages = 0;
  h.mm.mockImplementation(async (path: string) => {
    if (!path.includes('/posts?')) return {};
    pages += 1;
    if (pages === 4) return { order: ['prior'], posts: { prior: { id: 'prior', props: { octogee_project_delivery: 'alice/golf/kickoff' } } } };
    const posts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${pages}-${i}`, { id: `p${pages}-${i}`, create_at: Date.now() + 60_000 }]));
    return { order: Object.keys(posts), posts };
  });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('receipt history limit');
  expect(pages).toBe(3);
  expect(h.docs.get(`${projectPath}/agentState/kickoffDelivery`).recoveryBefore).toBe('p3-99');
  expect(h.docs.get(projectPath).agent.kickoff.status).toBe('pending');
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.filter(c => c[0].includes('/posts?')).map(c => c[0])).toEqual([
    '/channels/general/posts?per_page=100', '/channels/general/posts?per_page=100&before=p1-99',
    '/channels/general/posts?per_page=100&before=p2-99', '/channels/general/posts?per_page=100&before=p3-99',
  ]);
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
  expect(h.docs.get(projectPath).agent.kickoff).toEqual({ status: 'sent', postId: 'prior' });
});
it('skips receipt scans for an intent that failed before attempting a post', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.set(`${projectPath}/agentState/handoffDelivery`, { startedAt: 1 });
  h.seed.mockRejectedValueOnce(new Error('Gitea unavailable'));
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Gitea unavailable');
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.some(c => c[0].includes('/posts?'))).toBe(false);
  expect(h.docs.get(`${projectPath}/agentState/handoffDelivery`).startedAt).toBeGreaterThan(1);
});
it('does not post after preparation outlives its delivery lease', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.seed.mockImplementationOnce(async () => { h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() - 1; });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('lease expired');
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
});
it('asks the new project agent to greet the Builder and wait when no idea was provided', async () => {
  h.docs.get(projectPath).tagline = '';
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  const post = h.mm.mock.calls.find(c => c[0] === '/posts')[2];
  expect(post.message).toContain('ask what they would like to create');
  expect(post.message).toContain('wait for their direction');
  expect(post.message).not.toContain('I created');
});

it('keeps the workspace coach in project general after the handoff', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm).toHaveBeenCalledWith('/channels/general/members', 'POST', { user_id: 'coach' });
  expect(h.mm.mock.calls.some(c => c[1] === 'DELETE')).toBe(false);
});

it('cannot rewrite a handoff whose post may have landed before an upstream timeout', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.mm.mockImplementation(async (path: string) => {
    if (path.includes('/posts?')) return { order: [], posts: {} };
    if (path === '/posts') throw new Error('Mattermost timeout');
    return {};
  });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Mattermost timeout');
  await expect(queueProjectHandoff('u', 'alice', 'golf', { ...handoff, message: 'Correction' })).rejects.toThrow('already');
});
it('does not release a lease acquired by another delivery after the first lease expires', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.seed.mockImplementationOnce(async () => {
    h.docs.get(projectPath).agent.deliveryLeaseId = 'replacement';
    h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() + 120_000;
  });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('lease expired');
  expect(h.log).toHaveBeenCalledWith('Project onboarding delivery failed', expect.objectContaining({ error: expect.objectContaining({ message: 'Project delivery lease expired before posting' }) }));
  expect(h.docs.get(projectPath).agent.deliveryLeaseId).toBe('replacement');
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
});

it('treats a repeated handoff as delivered without reverting the project agent’s later customization', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  h.docs.get(projectPath).agent.identity.name = 'Birdie';
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  expect(h.docs.get(projectPath).agent.identity.name).toBe('Birdie');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('sent');
});

it.each(['sent', 'uncertain'])('does not replace a UI-created agent after its kickoff is %s', async (status) => {
  h.docs.get(projectPath).agent.kickoff = { status: status === 'sent' ? 'sent' : 'pending' };
  h.docs.get(projectPath).agent.identity = { name: 'Birdie', emoji: '⛳', persona: 'Helpful caddie' };
  if (status === 'uncertain') h.docs.set(`${projectPath}/agentState/kickoffDelivery`, { postAttempted: true });
  await expect(queueProjectHandoff('u', 'alice', 'golf', handoff)).rejects.toThrow('already');
  expect(h.docs.get(projectPath).agent.identity.name).toBe('Birdie');
  expect(h.docs.has(`${projectPath}/agentState/handoff`)).toBe(false);
});
it('does not seed a UI-created agent with a placeholder identity or instruction-only brief', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.seed).not.toHaveBeenCalled();
  expect(h.mm.mock.calls.find(c => c[0] === '/posts')[2].message).toContain('identity files');
});
