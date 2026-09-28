import { describe, expect, it } from 'vitest';
import { browserRequestParams, browserStreamPath } from './browser-policy.js';
describe('native Browser transport boundary', () => {
  it('binds native operations to the configured host profile', () => {
    expect(browserRequestParams({ method: 'GET', path: '/tabs' }, 'computer')).toEqual({ method: 'GET', path: '/tabs', target: 'host', query: { profile: 'computer' } });
    expect(browserRequestParams({ method: 'POST', path: '/act', body: { kind: 'evaluate', targetId: 't1', fn: '() => window.scrollBy(0,500)' } }, 'computer')).toMatchObject({ target: 'host', query: { profile: 'computer' } });
  });
  it('limits native takeover to the configured host profile', () => {
    expect(browserRequestParams({method:'GET',path:'/control'},'computer')).toMatchObject({target:'host',query:{profile:'computer'}});
    expect(browserRequestParams({method:'POST',path:'/control',body:{profile:'computer',control:true}},'computer')).toMatchObject({body:{profile:'computer',control:true}});
    expect(() => browserRequestParams({method:'POST',path:'/control',body:{profile:'foreign',control:true}},'computer')).toThrow();
    expect(() => browserRequestParams({method:'POST',path:'/control',body:{profile:'computer',control:true,owner:'foreign'}},'computer')).toThrow();
  });
  it.each([
    { method: 'POST', path: '/act', target: 'node', node: 'other', body: {} },
    { method: 'GET', path: '/tabs', query: { profile: 'other' } },
    { method: 'GET', path: '/tabs', sessionKey: 'foreign' },
    { method: 'GET', path: '/config' },
    { method: 'POST', path: '/act', body: { kind: 'evaluate', targetId: 't1', fn: 'x', profile: 'other' } },
    { method: 'POST', path: '/act', body: { kind: 'upload', targetId: 't1', path: '/secret' } },
    { method: 'DELETE', path: '/tabs/../config' },
  ])('denies operations outside the renderer contract %j', value => expect(() => browserRequestParams(value, 'computer')).toThrow());
  it('accepts only the native screencast endpoint and exact minted token', () => {
    expect(browserStreamPath({ token: 'valid-token', wsPath: '/browser/screencast?token=valid-token' })).toBe('/browser/screencast?token=valid-token');
    for (const wsPath of ['ws://evil/browser/screencast?token=valid-token', '/browser/screencast?token=other', '/shell?token=valid-token', '/browser/screencast?token=valid-token&host=evil']) {
      expect(() => browserStreamPath({ token: 'valid-token', wsPath })).toThrow();
    }
  });
});
