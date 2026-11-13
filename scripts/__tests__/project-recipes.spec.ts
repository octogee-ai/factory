import { describe, expect, it } from "vitest";

import { resolveStaticProjectRecipe } from "../lib/project-recipes.js";

describe("resolveStaticProjectRecipe", () => {
  it.each([
    ["static-site", { id: "static-site", buildCommand: null, outputDirectory: "public" }],
    ["vite-static", { id: "vite-static", buildCommand: "npm run build", outputDirectory: "dist" }],
    ["astro-static", { id: "astro-static", buildCommand: "npm run build", outputDirectory: "dist" }],
  ])("resolves %s to its bounded static build contract", (id, expected) => {
    expect(resolveStaticProjectRecipe(id)).toEqual(expected);
  });

  it("keeps projects with no recipe on the exact pre-recipe build command", () => {
    const legacy = { id: "astro-static", buildCommand: "npx astro build", outputDirectory: "dist" };
    expect(resolveStaticProjectRecipe(null)).toEqual(legacy);
    expect(resolveStaticProjectRecipe(undefined)).toEqual(legacy);
  });

  it("rejects unknown, non-static, and malformed recipes explicitly", () => {
    expect(resolveStaticProjectRecipe("node-service")).toBeNull();
    expect(resolveStaticProjectRecipe("shell-anything")).toBeNull();
    expect(resolveStaticProjectRecipe(42)).toBeNull();
  });
});
