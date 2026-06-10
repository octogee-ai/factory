import { describe, expect, it } from 'vitest';
import { githubContentsUrl, githubHeaders } from '../lib/github.js';

describe('githubContentsUrl', () => {
  it('builds the contents URL for a file path', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', 'README.md')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents/README.md',
    );
  });

  it('builds the root contents URL when path is empty', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', '')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents',
    );
  });

  it('builds a nested directory URL', () => {
    expect(githubContentsUrl('octogee-ai', 'octogee', 'app/src')).toBe(
      'https://api.github.com/repos/octogee-ai/octogee/contents/app/src',
    );
  });

  it('rejects an invalid owner', () => {
    expect(() => githubContentsUrl('bad owner!', 'octogee', '')).toThrow(/Invalid GitHub owner/);
  });

  it('rejects an invalid repo', () => {
    expect(() => githubContentsUrl('octogee-ai', 'bad repo!', '')).toThrow(/Invalid GitHub repo/);
  });
});

describe('githubHeaders', () => {
  it('includes Bearer auth + Accept + User-Agent when a token is present', () => {
    expect(githubHeaders('tok123')).toEqual({
      Authorization: 'Bearer tok123',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'octogee-workspace',
    });
  });

  it('omits Authorization for an anonymous (public-repo) request', () => {
    expect(githubHeaders(undefined)).toEqual({
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'octogee-workspace',
    });
  });
});
