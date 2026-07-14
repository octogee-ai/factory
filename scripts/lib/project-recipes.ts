export type StaticProjectRecipeId = "static-site" | "vite-static" | "astro-static";

export interface StaticProjectRecipe {
  id: StaticProjectRecipeId;
  buildCommand: string | null;
  outputDirectory: string;
}

const STATIC_PROJECT_RECIPES: Record<StaticProjectRecipeId, StaticProjectRecipe> = {
  "static-site": { id: "static-site", buildCommand: null, outputDirectory: "public" },
  "vite-static": { id: "vite-static", buildCommand: "npm run build", outputDirectory: "dist" },
  "astro-static": { id: "astro-static", buildCommand: "npm run build", outputDirectory: "dist" },
};

// Undeclared projects predate any build-script guarantee — keep the exact
// pre-recipe CLI invocation rather than the declared recipe's `npm run build`.
const LEGACY_ASTRO_RECIPE: StaticProjectRecipe = {
  id: "astro-static",
  buildCommand: "npx astro build",
  outputDirectory: "dist",
};

function isRuntimeDeclaration(value: unknown): value is { recipe?: unknown } {
  return typeof value === "object" && value !== null;
}

export function resolveStaticProjectRecipe(projectJson: unknown): StaticProjectRecipe | null {
  if (typeof projectJson !== "object" || projectJson === null) return null;

  const runtime = (projectJson as { runtime?: unknown }).runtime;
  if (runtime === undefined) return LEGACY_ASTRO_RECIPE;
  if (!isRuntimeDeclaration(runtime) || typeof runtime.recipe !== "string") return null;

  return STATIC_PROJECT_RECIPES[runtime.recipe as StaticProjectRecipeId] ?? null;
}
