import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROJECT_RECIPE,
  PROJECT_RECIPE_IDS,
  isProjectRecipeId,
  projectRepoSourceFromDoc,
} from './project.js';

describe('project recipe catalog', () => {
  it('bounds the catalog to the recipes Preview and Publish can actually run', () => {
    expect(PROJECT_RECIPE_IDS).toEqual(['static-site', 'vite-static', 'astro-static']);
  });

  it('accepts every catalog id, including the create-time default', () => {
    for (const id of PROJECT_RECIPE_IDS) expect(isProjectRecipeId(id)).toBe(true);
    expect(isProjectRecipeId(DEFAULT_PROJECT_RECIPE)).toBe(true);
  });

  it('rejects unknown, empty, and non-string recipes', () => {
    expect(isProjectRecipeId('node-service')).toBe(false);
    expect(isProjectRecipeId('STATIC-SITE')).toBe(false);
    expect(isProjectRecipeId('')).toBe(false);
    expect(isProjectRecipeId(null)).toBe(false);
    expect(isProjectRecipeId(undefined)).toBe(false);
    expect(isProjectRecipeId(42)).toBe(false);
    expect(isProjectRecipeId({ id: 'vite-static' })).toBe(false);
  });
});

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
