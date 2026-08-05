import { describe, it, expect } from 'vitest';
import { projectRepoSourceFromDoc } from './project.js';

describe('projectRepoSourceFromDoc', () => {
  it('narrows a stored github repoSource', () => {
    expect(projectRepoSourceFromDoc({ provider: 'github', owner: 'octogee-ai', repo: 'octogee' })).toEqual({
      provider: 'github',
      owner: 'octogee-ai',
      repo: 'octogee',
    });
  });

  it('drops everything but provider/owner/repo so nothing else rides into a clone', () => {
    expect(
      projectRepoSourceFromDoc({
        provider: 'github',
        owner: 'octogee-ai',
        repo: 'octogee',
        token: 'ghs_leaked',
      }),
    ).toEqual({ provider: 'github', owner: 'octogee-ai', repo: 'octogee' });
  });

  it('returns null for an absent, non-github, or incomplete repoSource', () => {
    expect(projectRepoSourceFromDoc(undefined)).toBeNull();
    expect(projectRepoSourceFromDoc(null)).toBeNull();
    expect(projectRepoSourceFromDoc('octogee-ai/octogee')).toBeNull();
    expect(projectRepoSourceFromDoc({ provider: 'gitlab', owner: 'octogee-ai', repo: 'octogee' })).toBeNull();
    expect(projectRepoSourceFromDoc({ provider: 'github', owner: 'octogee-ai' })).toBeNull();
    expect(projectRepoSourceFromDoc({ provider: 'github', owner: '', repo: 'octogee' })).toBeNull();
    expect(projectRepoSourceFromDoc({ provider: 'github', owner: 'octogee-ai', repo: '' })).toBeNull();
  });
});
