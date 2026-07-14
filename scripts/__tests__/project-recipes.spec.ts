import { describe, expect, it } from "vitest";

import { resolveStaticProjectRecipe } from "../lib/project-recipes.js";

describe("resolveStaticProjectRecipe", () => {
  it.each([
    ["static-site", { id: "static-site", buildCommand: null, outputDirectory: "public" }],
    ["vite-static", { id: "vite-static", buildCommand: "npm run build", outputDirectory: "dist" }],
    ["astro-static", { id: "astro-static", buildCommand: "npm run build", outputDirectory: "dist" }],
  ])("resolves %s to its bounded static build contract", (id, expected) => {
    expect(resolveStaticProjectRecipe({ runtime: { recipe: id } })).toEqual(expected);
  });

  it("keeps undeclared legacy projects on the exact pre-recipe build command", () => {
    expect(resolveStaticProjectRecipe({ name: "Existing site" })).toEqual({
      id: "astro-static",
      buildCommand: "npx astro build",
      outputDirectory: "dist",
    });
  });

  it("rejects unknown and non-static recipe declarations explicitly", () => {
    expect(resolveStaticProjectRecipe({ runtime: { recipe: "node-service" } })).toBeNull();
    expect(resolveStaticProjectRecipe({ runtime: { recipe: "shell-anything" } })).toBeNull();
  });
});
