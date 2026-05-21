import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCustomerGiteaToken,
  pathHasReservedOrHiddenSegment,
  validateWorkspacePath,
} from '../routes/workspace/helpers.js';

describe('validateWorkspacePath', () => {
  it('accepts a normal nested path', () => {
    expect(validateWorkspacePath('docs/notes.md')).toBeNull();
    expect(validateWorkspacePath('NOTES.md')).toBeNull();
    expect(validateWorkspacePath('builds/site/src/index.tsx')).toBeNull();
  });

  it('rejects parent traversal', () => {
    expect(validateWorkspacePath('../etc/passwd')).toMatch(/traversal/i);
    expect(validateWorkspacePath('foo/../bar')).toMatch(/traversal/i);
    expect(validateWorkspacePath('foo/../../bar')).toMatch(/traversal/i);
  });

  it('rejects absolute paths', () => {
    expect(validateWorkspacePath('/etc/passwd')).toMatch(/absolute/i);
  });

  it('rejects backslashes (Windows traversal)', () => {
    expect(validateWorkspacePath('foo\\bar')).toMatch(/backslash/i);
  });

  it('rejects HIDDEN reserved names anywhere in the path', () => {
    expect(validateWorkspacePath('AGENTS.md')).toMatch(/reserved/i);
    expect(validateWorkspacePath('subdir/AGENTS.md')).toMatch(/reserved/i);
    expect(validateWorkspacePath('TOOLS.md')).toMatch(/reserved/i);
    expect(validateWorkspacePath('node_modules/foo')).toMatch(/reserved/i);
  });

  it('rejects hidden segments (starting with dot)', () => {
    expect(validateWorkspacePath('.gitignore')).not.toBeNull();
    expect(validateWorkspacePath('.git/config')).not.toBeNull();
    expect(validateWorkspacePath('subdir/.git/config')).not.toBeNull();
    expect(validateWorkspacePath('subdir/.env')).toMatch(/hidden/i);
  });

  it('rejects null bytes', () => {
    expect(validateWorkspacePath('foo\0bar')).toMatch(/null/i);
  });

  it('rejects empty', () => {
    expect(validateWorkspacePath('')).toMatch(/required|empty/i);
  });

  it('rejects double slash', () => {
    expect(validateWorkspacePath('foo//bar')).toMatch(/double/i);
  });

  it('rejects trailing slash (empty segment)', () => {
    expect(validateWorkspacePath('foo/bar/')).toMatch(/empty/i);
  });

  it('rejects leading slash (handled by absolute check)', () => {
    expect(validateWorkspacePath('/foo')).toMatch(/absolute/i);
  });
});

describe('pathHasReservedOrHiddenSegment', () => {
  it('returns null for normal paths', () => {
    expect(pathHasReservedOrHiddenSegment('docs/notes.md')).toBeNull();
    expect(pathHasReservedOrHiddenSegment('NOTES.md')).toBeNull();
  });

  it('flags HIDDEN reserved names', () => {
    expect(pathHasReservedOrHiddenSegment('AGENTS.md')).toMatch(/reserved/i);
    expect(pathHasReservedOrHiddenSegment('subdir/node_modules/foo')).toMatch(/reserved/i);
  });

  it('flags hidden segments', () => {
    expect(pathHasReservedOrHiddenSegment('subdir/.env')).toMatch(/hidden/i);
  });

  it('flags empty segments', () => {
    expect(pathHasReservedOrHiddenSegment('foo//bar')).toMatch(/empty/i);
    expect(pathHasReservedOrHiddenSegment('foo/bar/')).toMatch(/empty/i);
  });
});

describe('getCustomerGiteaToken — P1-5 fail-closed', () => {
  const origEnv = process.env.GITEA_TOKEN;

  beforeEach(() => {
    process.env.GITEA_TOKEN = 'global-admin-token-must-not-leak';
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.GITEA_TOKEN;
    else process.env.GITEA_TOKEN = origEnv;
  });

  it('returns the per-user token when present', () => {
    const req = { giteaToken: 'per-user-token' } as unknown as Request;
    expect(getCustomerGiteaToken(req)).toBe('per-user-token');
  });

  it('throws (does NOT fall back to process.env.GITEA_TOKEN) when per-user token is missing', () => {
    const req = { giteaToken: undefined } as unknown as Request;
    expect(() => getCustomerGiteaToken(req)).toThrowError(/not configured/i);
  });
});
