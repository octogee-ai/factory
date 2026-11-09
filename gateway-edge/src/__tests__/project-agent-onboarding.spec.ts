import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const h = vi.hoisted(() => ({
  docs: new Map<string, any>(), versions: new Map<string, number>(), refused: new Set<string>(),
  afterRead: new Map<string, () => void>(), afterWrite: new Map<string, () => void>(),
  mm: vi.fn(), seed: vi.fn(), avatar: vi.fn(), blob: vi.fn(), log: vi.fn(),
}));
function rewrite(path: string, value: unknown) {
  h.docs.set(path, structuredClone(value));
  h.versions.set(path, (h.versions.get(path) ?? 0) + 1);
}
function ref(path: string) {
  const write = (value: unknown) => {
    if (h.refused.has(path)) throw new Error('intent write refused');
    rewrite(path, value);
    h.afterWrite.get(path)?.();
  };
  return { path, set: async (value: unknown) => write(value), create: async (value: unknown) => {
    if (h.docs.get(path) !== undefined) throw Object.assign(new Error('document already exists'), { code: 6 });
    write(value);
    return { writeTime: h.versions.get(path) };
  }, get: async () => {
    const data = structuredClone(h.docs.get(path));
    const snapshot = { exists: data !== undefined, updateTime: h.versions.get(path) ?? 0, data: () => structuredClone(data) };
    h.afterRead.get(path)?.();
    return snapshot;
  }, update: async (patch: Record<string, unknown>, precondition?: { lastUpdateTime?: number }) => {
    if (precondition?.lastUpdateTime !== undefined && precondition.lastUpdateTime !== (h.versions.get(path) ?? 0)) {
      throw Object.assign(new Error('document changed since the precondition read'), { code: 9 });
    }
    const data = structuredClone(h.docs.get(path));
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = data;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      if (value === 'DELETE') delete target[parts.at(-1)!]; else target[parts.at(-1)!] = structuredClone(value);
    }
    rewrite(path, data);
    h.afterWrite.get(path)?.();
  } };
}
vi.mock('../lib/db.js', () => ({ db: { doc: ref, runTransaction: async (fn: any) => {
  const writes: Array<() => Promise<unknown>> = [];
  const result = await fn({ get: (r: any) => r.get(), set: (r: any, p: any) => { writes.push(() => r.set(p)); }, update: (r: any, p: any) => { writes.push(() => r.update(p)); } });
  for (const write of writes) await write();
  return result;
} }, FieldValue: { delete: () => 'DELETE', serverTimestamp: () => 'NOW', increment: () => 1 } }));
vi.mock('../lib/platform-state.js', async () => {
  const { createDocumentFixtureStore } = await import('@octogee/core/testing/journal-store');
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock('../lib/mattermost.js', () => ({ mmApi: h.mm, mmUploadAvatarBuffer: h.avatar }));
vi.mock('../middleware/logging.js', () => ({ logger: { error: h.log } }));
vi.mock('../lib/gitea.js', () => ({ giteaWriteFiles: h.seed }));
vi.mock('../lib/fileTarget.js', () => ({ resolveFileTarget: async () => ({ ok: true, target: {} }) }));
vi.mock('../lib/workspace-blob.js', () => ({ storeWorkspaceBlob: h.blob }));
import { parseProjectHandoff, queueProjectHandoff, deliverProjectAgentOnboarding } from '../lib/project-agent-onboarding.js';
import { syncProjectAgentIdentity } from '../lib/project-agent-identity.js';
import { parseManifest } from '@octogee/core/workspace-manifest';
import { projectAgentSecretDocId } from '@octogee/core/mattermost/project-agent';
const projectPath = 'workspaces/alice/projects/golf';
const handoff = { name: 'Chip', emoji: '⛳', persona: 'A calm golf caddie, with Piper’s practical style.', message: 'Build Chris and Robert a shared golf dashboard. Chris prefers simple controls.' };
beforeEach(() => {
  vi.clearAllMocks(); h.docs.clear(); h.versions.clear(); h.refused.clear(); h.afterRead.clear(); h.afterWrite.clear();
  h.docs.set(projectPath, { ownerUid: 'u', name: 'Fairway Partners', tagline: 'A shared golf dashboard', provisioningState: 'active', agent: { mode: 'scoped', enabled: true, status: 'ready', requestedName: '', identity: { name: 'golf', emoji: '🤖', persona: '' } } });
  h.docs.set(`${projectPath}/channels/general`, { mattermost: { channelId: 'general' } });
  h.docs.set('workspaces/alice/channels/coach-dm', { mattermost: { channelId: 'coach-dm' } });
  h.docs.set('users/u/secrets/coachMattermost', { personalToken: 'coach-token' });
  h.docs.set('agents/u', { mattermost: { userId: 'coach' }, name: 'Piper' });
  h.docs.set('users/u', { displayName: 'Private Builder Name' });
  h.docs.set('users/u/secrets/mattermost', { personalToken: 'builder-token' });
  h.docs.set(`users/u/secrets/${projectAgentSecretDocId('golf')}`, { personalToken: 'chip-token', mmUserId: 'chip' });
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
  expect(h.docs.get(projectPath).agent.handoff).toEqual({ status: 'pending', generation: 1 });
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
it('refuses a handoff when a delivery lease appears after the preflight reads', async () => {
  h.afterRead.set(`${projectPath}/agentState/kickoffDelivery`, () => {
    h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() + 60_000;
  });
  await expect(queueProjectHandoff('u', 'alice', 'golf', handoff)).rejects.toThrow('in progress');
  expect(h.docs.get(`${projectPath}/agentState/handoff`)).toBeUndefined();
  expect(h.docs.get(projectPath).agent.handoff).toBeUndefined();
});
it('refuses a handoff when the project leaves active after the preflight reads', async () => {
  h.afterRead.set(`${projectPath}/agentState/kickoffDelivery`, () => {
    h.docs.get(projectPath).provisioningState = 'failed';
  });
  await expect(queueProjectHandoff('u', 'alice', 'golf', handoff)).rejects.toThrow('active project');
  expect(h.docs.get(`${projectPath}/agentState/handoff`)).toBeUndefined();
});
it('writes the handoff message on retry after the message write was interrupted', async () => {
  h.refused.add(`${projectPath}/agentState/handoff`);
  await expect(queueProjectHandoff('u', 'alice', 'golf', handoff)).rejects.toThrow('intent write refused');
  expect(h.docs.get(projectPath).agent.handoff).toEqual({ status: 'pending', generation: 1 });
  expect(h.docs.get(`${projectPath}/agentState/handoff`)).toBeUndefined();
  h.refused.clear();
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  expect(h.docs.get(`${projectPath}/agentState/handoff`).message).toBe(handoff.message);
  expect(h.docs.get(projectPath).agent.handoff).toEqual({ status: 'pending', generation: 2 });
});
it('keeps the newer handoff message when the older request finishes writing last', async () => {
  const { platformStateStore } = await import('../lib/platform-state.js');
  const commit = platformStateStore.transaction.bind(platformStateStore);
  const newer = { ...handoff, persona: 'Patient golf tutor', message: 'Newer task' };
  const transaction = vi.spyOn(platformStateStore, 'transaction').mockImplementationOnce(async (options: any, work: any) => {
    const committed = await commit(options, work);
    await queueProjectHandoff('u', 'alice', 'golf', newer);
    return committed;
  });
  try {
    await queueProjectHandoff('u', 'alice', 'golf', handoff);
  } finally {
    transaction.mockRestore();
  }
  expect(h.docs.get(projectPath).agent.identity.persona).toBe(newer.persona);
  expect(h.docs.get(`${projectPath}/agentState/handoff`)).toMatchObject({ message: newer.message, generation: 2 });
});
it('refuses to deliver a handoff message that belongs to another generation of the project agent', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.get(projectPath).agent.handoff.generation = 2;
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('handoff identity is missing');
  expect(h.mm).not.toHaveBeenCalledWith('/posts', 'POST', expect.anything(), expect.anything());
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('pending');
});
it('waits for readiness, then delivers the complete handoff once without writing to the remote repo', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.docs.get(projectPath).agent.status = 'provisioning';
  await deliverProjectAgentOnboarding('u', 'alice', 'golf'); expect(h.mm).not.toHaveBeenCalled();
  h.docs.get(projectPath).agent.status = 'ready';
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.seed).not.toHaveBeenCalled();
  const message = h.mm.mock.calls.find(call => call[0] === '/posts')[2].message;
  for (const context of [handoff.message, handoff.persona, 'BRIEF.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']) expect(message).toContain(context);
  expect(h.mm).toHaveBeenCalledWith('/posts', 'POST', expect.objectContaining({ channel_id: 'general', message: expect.stringContaining('@alice-proj-golf-coach') }), 'coach-token');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('sent');
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.filter(c => c[0] === '/posts')).toHaveLength(1);
});
it('sends GitHub-backed coaches to their private workspace for persona files', async () => {
  h.docs.get(projectPath).repoSource = { provider: 'github', owner: 'alice', repo: 'golf' };
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  const message = h.mm.mock.calls.find(call => call[0] === '/posts')[2].message;
  expect(message).toContain('private coach workspace');
  expect(message).toContain('Use the GitHub checkout, when available, for source');
  expect(message).not.toContain('octogee_project_commit');
  expect(h.seed).not.toHaveBeenCalled();
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
  await queueProjectHandoff('u', 'alice', 'golf', handoff); h.mm.mockRejectedValueOnce(new Error('Mattermost unavailable'));
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Mattermost unavailable');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('pending');
  expect(h.docs.get(projectPath).agent.lastError).toBe('Mattermost unavailable');
  expect(h.docs.get(projectPath).agent.deliveryLeaseUntil).toBeUndefined();
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.docs.get(projectPath).agent.handoff.status).toBe('sent');
});
const handoffIntent = `${projectPath}/agentState/handoffDelivery`;
it('recovers the post of a delivery intent another worker created between the read and the create, without reposting', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  const created = { startedAt: Date.now() - 5_000, postAttempted: true, recoveryBefore: 'cursor' };
  h.afterRead.set(handoffIntent, () => { h.afterRead.delete(handoffIntent); rewrite(handoffIntent, created); });
  h.mm.mockImplementation(async (path: string) => path.includes('/posts?')
    ? { order: ['prior'], posts: { prior: { id: 'prior', create_at: Date.now(), props: { octogee_project_delivery: 'alice/golf/handoff' } } } }
    : {});
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.docs.get(handoffIntent)).toEqual(created);
  expect(h.mm.mock.calls.filter(c => c[0].includes('/posts?')).map(c => c[0])).toEqual(['/channels/general/posts?per_page=100&before=cursor']);
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
  expect(h.docs.get(projectPath).agent.handoff).toEqual({ status: 'sent', generation: 1, postId: 'prior' });
});
it('stops before preparing the post when its lease was replaced right after it created the delivery intent', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.afterWrite.set(handoffIntent, () => {
    h.docs.get(projectPath).agent.deliveryLeaseId = 'replacement';
    h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() + 120_000;
  });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Project delivery lease was replaced');
  expect(h.mm).not.toHaveBeenCalled();
  expect(h.docs.get(projectPath).agent.deliveryLeaseId).toBe('replacement');
  expect(h.docs.get(handoffIntent)).toEqual({ startedAt: expect.any(Number) });
});
it('refuses its post-attempt write when another worker rewrote the delivery intent after this worker opened it', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  const newer = { startedAt: 7, postAttempted: true, recoveryBefore: 'cursor' };
  h.mm.mockImplementationOnce(async () => { rewrite(handoffIntent, newer); });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Project delivery lease was replaced');
  expect(h.docs.get(handoffIntent)).toEqual(newer);
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
});
it('refuses its recovery-cursor write when another worker rewrote the delivery intent during the receipt scan', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  const kickoffIntent = `${projectPath}/agentState/kickoffDelivery`;
  h.docs.set(kickoffIntent, { startedAt: Date.now() - 5_000, postAttempted: true });
  const newer = { startedAt: 7, postAttempted: true, recoveryBefore: 'newer-cursor' };
  let pages = 0;
  h.mm.mockImplementation(async (path: string) => {
    if (!path.includes('/posts?')) return {};
    pages += 1;
    if (pages === 1) rewrite(kickoffIntent, newer);
    const posts = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${pages}-${i}`, { id: `p${pages}-${i}`, create_at: Date.now() + 60_000 }]));
    return { order: Object.keys(posts), posts };
  });
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Project delivery lease was replaced');
  expect(pages).toBe(3);
  expect(h.docs.get(kickoffIntent)).toEqual(newer);
});
it('releases the delivery lease and records the error when its delivery intent cannot be opened', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.refused.add(`${projectPath}/agentState/handoffDelivery`);
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('intent write refused');
  expect(h.docs.get(projectPath).agent).toMatchObject({ handoff: { status: 'pending' }, lastError: 'intent write refused' });
  expect(h.docs.get(projectPath).agent.deliveryLeaseId).toBeUndefined();
  expect(h.mm.mock.calls.some(c => c[0] === '/posts')).toBe(false);
});
it('starts UI-created projects with their own agent in project general', async () => {
  h.docs.get(projectPath).agent.kickoff = { status: 'pending' };
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm).toHaveBeenCalledWith('/posts', 'POST', expect.objectContaining({ channel_id: 'general', message: expect.stringContaining('A shared golf dashboard') }), 'coach-token');
});
it('stores the project avatar at a path the workspace manifest actually accepts', async () => {
  await syncProjectAgentIdentity('u', 'alice', 'golf', { avatarPng: Buffer.from('png') });

  const [, avatarPath] = h.blob.mock.calls.at(-1)!;
  // storeWorkspaceBlob is mocked here, so run the real manifest guard the live
  // write hits: a dot-prefixed segment is refused and surfaces as a 502.
  expect(() =>
    parseManifest('customers/alice/projects/golf/.files/manifest.json', JSON.stringify({
      [avatarPath]: {
        type: 'blob',
        gcsPath: `customers/alice/projects/golf/${avatarPath}`,
        size: 3,
        mimeType: 'image/png',
        uploadedAt: '2026-09-17T00:00:00.000Z',
      },
    })),
  ).not.toThrow();
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
  h.mm.mockRejectedValueOnce(new Error('Mattermost unavailable'));
  await expect(deliverProjectAgentOnboarding('u', 'alice', 'golf')).rejects.toThrow('Mattermost unavailable');
  await deliverProjectAgentOnboarding('u', 'alice', 'golf');
  expect(h.mm.mock.calls.some(c => c[0].includes('/posts?'))).toBe(false);
  expect(h.docs.get(`${projectPath}/agentState/handoffDelivery`).startedAt).toBeGreaterThan(1);
});
it('does not post after preparation outlives its delivery lease', async () => {
  await queueProjectHandoff('u', 'alice', 'golf', handoff);
  h.mm.mockImplementationOnce(async () => { h.docs.get(projectPath).agent.deliveryLeaseUntil = Date.now() - 1; });
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
  h.mm.mockImplementationOnce(async () => {
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

it('lets an already-cloned project checkpoint its first implementation after the coach handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-handoff-'));
  const remote = join(root, 'remote.git');
  const server = join(root, 'server');
  const agent = join(root, 'agent');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'clone', remote, server);
    writeFileSync(join(server, 'index.html'), '<main>Starter</main>');
    git(server, 'add', '.');
    git(server, 'commit', '-m', 'Seed project starter');
    git(server, 'push', 'origin', 'main');
    git(root, 'clone', remote, agent);
    for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']) writeFileSync(join(agent, file), '# OpenClaw default\n');
    h.seed.mockImplementation(async (_org, _repo, files) => {
      for (const file of files) writeFileSync(join(server, file.path), file.content);
      git(server, 'add', '.');
      git(server, 'commit', '-m', 'Initialize project agent');
      git(server, 'push', 'origin', 'main');
    });
    await queueProjectHandoff('u', 'alice', 'golf', handoff);
    await deliverProjectAgentOnboarding('u', 'alice', 'golf');
    writeFileSync(join(agent, 'IDENTITY.md'), `# Identity\n\nName: ${handoff.name}\n`);
    writeFileSync(join(agent, 'BRIEF.md'), handoff.message);
    writeFileSync(join(agent, 'index.html'), '<main>Completed clubhouse</main>');
    git(agent, 'add', '.');
    git(agent, 'commit', '-m', 'Build first project slice');
    const push = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'main'], { cwd: agent, encoding: 'utf8' });
    expect({ status: push.status, error: push.stderr }).toMatchObject({ status: 0 });
    expect(git(root, '--git-dir', remote, 'show', 'main:index.html')).toBe('<main>Completed clubhouse</main>');
    expect(git(root, '--git-dir', remote, 'show', 'main:BRIEF.md')).toBe(handoff.message);
    const message = h.mm.mock.calls.find(call => call[0] === '/posts')[2].message;
    expect(message).toContain(handoff.persona);
    expect(message).toContain(handoff.message);
    expect(message).toContain('BRIEF.md');
    expect(h.seed).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
