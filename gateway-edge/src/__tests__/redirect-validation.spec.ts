import { describe, it, expect } from 'vitest';
import { buildOAuthRedirect, sanitizeReturnUrl } from '../lib/redirect-validation.js';

const BASE = 'https://app.octogee.com';

describe('buildOAuthRedirect — query params land BEFORE the fragment', () => {
  it('keeps a #connections deep-link working after the OAuth callback', () => {
    const out = buildOAuthRedirect('/@me/account#connections', BASE, {
      github_connected: 'true',
      github_account: 'chris-e',
    });
    expect(out).toBe(
      'https://app.octogee.com/@me/account?github_connected=true&github_account=chris-e#connections',
    );
  });

  it('appends normally when there is no fragment', () => {
    expect(buildOAuthRedirect('/dashboard', BASE, { connect_error: 'cancelled' })).toBe(
      'https://app.octogee.com/dashboard?connect_error=cancelled',
    );
  });

  it('uses & when the path already carries a query, still before the fragment', () => {
    expect(buildOAuthRedirect('/p?tab=files#x', BASE, { ok: '1' })).toBe(
      'https://app.octogee.com/p?tab=files&ok=1#x',
    );
  });

  it('returns the bare URL when there are no params', () => {
    expect(buildOAuthRedirect('/@me/account#connections', BASE, {})).toBe(
      'https://app.octogee.com/@me/account#connections',
    );
  });
});

describe('sanitizeReturnUrl — existing contract pins', () => {
  it('keeps relative paths and rejects protocol-relative ones', () => {
    expect(sanitizeReturnUrl('/w/me/files')).toBe('/w/me/files');
    expect(sanitizeReturnUrl('//evil.com/x')).toBe('/dashboard');
  });

  it('rejects offsite absolute URLs', () => {
    expect(sanitizeReturnUrl('https://evil.com/phish')).toBe('/dashboard');
  });
});
