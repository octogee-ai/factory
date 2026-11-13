import { describe, expect, it } from 'vitest';
import { browserRequestParams, browserStreamPath } from './browser-policy.js';
const binding = { sessionKey: 'agent:octogee-alice-coach:mattermost:group:channel', referencedTabs: new Map() };
describe('native Browser transport boundary', () => {
  it('binds native operations to the configured host profile', () => {
    expect(browserRequestParams({ method: 'GET', path: '/tabs' }, 'computer', binding)).toEqual({ method: 'GET', path: '/tabs', target: 'host', query: { profile: 'computer' }, tabScope: { sessionKey: binding.sessionKey, referencedTabs: [] } });
    expect(browserRequestParams({ method: 'POST', path: '/act', body: { kind: 'evaluate', targetId: 't1', fn: '() => window.scrollBy(0,500)' } }, 'computer', binding)).toMatchObject({ target: 'host', query: { profile: 'computer' } });
  });
  it('limits native takeover to the configured host profile', () => {
    expect(browserRequestParams({method:'GET',path:'/control'},'computer', binding)).toMatchObject({target:'host',query:{profile:'computer'}});
    expect(browserRequestParams({method:'POST',path:'/control',body:{profile:'computer',control:true}},'computer', binding)).toMatchObject({body:{profile:'computer',control:true}});
    expect(() => browserRequestParams({method:'POST',path:'/control',body:{profile:'foreign',control:true}},'computer', binding)).toThrow();
    expect(() => browserRequestParams({method:'POST',path:'/control',body:{profile:'computer',control:true,owner:'foreign'}},'computer', binding)).toThrow();
  });
  it.each([
    { method: 'POST', path: '/act', target: 'node', node: 'other', body: {} },
    { method: 'GET', path: '/tabs', query: { profile: 'other' } },
    { method: 'GET', path: '/tabs', sessionKey: 'foreign' },
    { method: 'GET', path: '/config' },
    { method: 'POST', path: '/act', body: { kind: 'evaluate', targetId: 't1', fn: 'x', profile: 'other' } },
    { method: 'POST', path: '/act', body: { kind: 'upload', targetId: 't1', path: '/secret' } },
    { method: 'DELETE', path: '/tabs/../config' },
  ])('denies operations outside the renderer contract %j', value => expect(() => browserRequestParams(value, 'computer', binding)).toThrow());
  it.each([
    { method: 'POST', path: '/start', body: {} },
    { method: 'POST', path: '/tabs/open', body: { url: 'https://example.com' } },
    { method: 'POST', path: '/tabs/focus', body: { targetId: 't1' } },
    { method: 'DELETE', path: '/tabs/t1' },
    { method: 'POST', path: '/navigate', body: { targetId: 't1', url: 'https://example.com' } },
    { method: 'POST', path: '/screenshot', body: { targetId: 't1', type: 'png' } },
    { method: 'POST', path: '/screencast', body: { targetId: 't1', maxWidth: 800, maxHeight: 600 } },
    { method: 'POST', path: '/download', body: { targetId: 't1', currentDocument: true, expectedUrl: 'https://example.com', timeoutMs: 120000 }, timeoutMs: 150000 },
    { method: 'POST', path: '/act', body: { kind: 'clickCoords', targetId: 't1', x: 1, y: 2, doubleClick: true } },
    { method: 'POST', path: '/act', body: { kind: 'press', targetId: 't1', key: 'Enter' } },
    { method: 'POST', path: '/act', body: { kind: 'insertText', targetId: 't1', text: 'hello' } },
    { method: 'POST', path: '/act', body: { kind: 'resize', targetId: 't1', width: 800, height: 600 } },
    { method: 'POST', path: '/act', body: { kind: 'evaluate', targetId: 't1', fn: '() => history.go(-1)' } },
  ])('preserves native panel operations with session scope %j', envelope => {
    expect(browserRequestParams({ ...envelope, tabScope: { sessionKey: binding.sessionKey } }, 'computer', binding)).toEqual({
      ...envelope, target: 'host', query: { profile: 'computer' }, tabScope: { sessionKey: binding.sessionKey },
    });
  });
  it.each([
    null,
    {},
    { sessionKey: 'foreign' },
    { sessionKey: binding.sessionKey, agentId: 'foreign' },
    { sessionKey: binding.sessionKey, referencedTabs: {} },
    { sessionKey: binding.sessionKey, referencedTabs: Array(65).fill({ target: 'host', targetId: 't1' }) },
    { sessionKey: binding.sessionKey, referencedTabs: [null] },
    { sessionKey: binding.sessionKey, referencedTabs: [{ target: 'host', targetId: 't1', profile: 'foreign' }] },
    { sessionKey: binding.sessionKey, referencedTabs: [{ target: 'host', targetId: 't1', node: 'foreign' }] },
  ])('rejects malformed or foreign tab authority %j', tabScope => {
    const admitted = { ...binding, referencedTabs: new Map([['t1', { target: 'host' as const, targetId: 't1', profile: 'computer' }]]) };
    expect(() => browserRequestParams({ method: 'GET', path: '/tabs', tabScope }, 'computer', admitted)).toThrow();
  });
  it('canonicalizes admitted native references and rejects references on non-list operations', () => {
    const tab = { target: 'host' as const, targetId: 't1', profile: 'computer' };
    const admitted = { ...binding, referencedTabs: new Map([['t1', tab]]) };
    expect(browserRequestParams({ method: 'GET', path: '/tabs', tabScope: { sessionKey: binding.sessionKey, referencedTabs: [{ target: 'host', targetId: 't1' }] } }, 'computer', admitted).tabScope).toEqual({ sessionKey: binding.sessionKey, referencedTabs: [tab] });
    expect(() => browserRequestParams({ method: 'POST', path: '/start', body: {}, tabScope: { sessionKey: binding.sessionKey, referencedTabs: [tab] } }, 'computer', admitted)).toThrow();
  });
  it('accepts only the native screencast endpoint and exact minted token', () => {
    expect(browserStreamPath({ token: 'valid-token', wsPath: '/browser/screencast?token=valid-token' })).toBe('/browser/screencast?token=valid-token');
    for (const wsPath of ['ws://evil/browser/screencast?token=valid-token', '/browser/screencast?token=other', '/shell?token=valid-token', '/browser/screencast?token=valid-token&host=evil']) {
      expect(() => browserStreamPath({ token: 'valid-token', wsPath })).toThrow();
    }
  });
});
