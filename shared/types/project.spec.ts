import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROJECT_RECIPE,
  PROJECT_RECIPE_IDS,
  defaultProjectRecipe,
  isProjectRecipeId,
  projectRepoSourceFromDoc,
  type ProjectRecipeId,
  type ProjectType,
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

describe('defaultProjectRecipe', () => {
  // Typed as a total Record so a new ProjectType cannot land without choosing
  // the recipe its projects are born on.
  const startingRecipe: Record<ProjectType, ProjectRecipeId> = {
    game: 'vite-static',
    social: 'vite-static',
    planner: 'vite-static',
    trip: 'astro-static',
    research: 'astro-static',
    event: 'astro-static',
    other: 'static-site',
  };

  it.each(Object.entries(startingRecipe))('starts a %s project on %s', (projectType, recipe) => {
    expect(defaultProjectRecipe(projectType)).toBe(recipe);
  });

  it('falls back to the flat default for absent and unknown types', () => {
    expect(defaultProjectRecipe(null)).toBe(DEFAULT_PROJECT_RECIPE);
    expect(defaultProjectRecipe('web')).toBe(DEFAULT_PROJECT_RECIPE);
    expect(defaultProjectRecipe('Game')).toBe(DEFAULT_PROJECT_RECIPE);
    expect(defaultProjectRecipe('')).toBe(DEFAULT_PROJECT_RECIPE);
  });

  it('only ever returns a recipe Preview and Publish can run', () => {
    for (const projectType of [...Object.keys(startingRecipe), 'nonsense', null]) {
      expect(isProjectRecipeId(defaultProjectRecipe(projectType))).toBe(true);
    }
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
