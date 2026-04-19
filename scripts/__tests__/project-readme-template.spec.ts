/**
 * Tests for the README-template renderer used when provisioning a new
 * project (PROJECTS-CANVAS-SPEC §D3).
 *
 * Two layers:
 *   - `substitute` — pure string-level var replacement, unit-tested
 *     without filesystem access.
 *   - `renderReadmeTemplate` — reads the per-projectType template from
 *     `shared/templates/project-readmes/{type}.md` and applies
 *     substitution. Unknown projectTypes fall back to `default.md`.
 */
import { describe, it, expect } from "vitest";
import {
  substitute,
  renderReadmeTemplate,
} from "../lib/project-readme-template.js";

describe("substitute", () => {
  it("replaces known variables", () => {
    expect(substitute("hello {{name}}", { name: "alice" })).toBe("hello alice");
  });

  it("handles multiple occurrences of the same variable", () => {
    expect(substitute("{{x}}-{{x}}", { x: "foo" })).toBe("foo-foo");
  });

  it("leaves unknown placeholders literal so template bugs surface", () => {
    expect(substitute("hello {{unknown}} there", { other: "x" })).toBe(
      "hello {{unknown}} there",
    );
  });

  it("does not recurse through replacement values", () => {
    // Replacements containing `{{y}}` are NOT re-expanded. Guards against
    // runaway templates and keeps the pass single-shot.
    expect(substitute("{{x}}", { x: "{{y}}", y: "loop" })).toBe("{{y}}");
  });
});

describe("renderReadmeTemplate", () => {
  const baseVars = {
    name: "My Game",
    tagline: "A tiny rogue-like",
    owner: "dannyboy",
    workspaceSlug: "dannyboy",
    projectSlug: "mygame",
    date: "2026-04-19",
  };

  it("renders the game template with all variables substituted", () => {
    const out = renderReadmeTemplate("game", baseVars);
    expect(out).toContain("# My Game");
    expect(out).toContain("A tiny rogue-like");
    expect(out).toContain("[@dannyboy](dannyboy)");
    expect(out).toContain("2026-04-19");
    // Game-specific section appears.
    expect(out).toMatch(/engine/i);
  });

  it("falls back to the default template for unknown project types", () => {
    const out = renderReadmeTemplate("unknown-type-xyz", baseVars);
    expect(out).toContain("# My Game");
    // Default README has a neutral "What is this?" section instead of a
    // game-specific one.
    expect(out).toContain("What is this?");
    expect(out).not.toMatch(/engine/i);
  });

  it("falls back to the default template when projectType is null/undefined", () => {
    expect(() => renderReadmeTemplate(null, baseVars)).not.toThrow();
    expect(() => renderReadmeTemplate(undefined, baseVars)).not.toThrow();
  });

  it("supplies a default tagline when the caller passes blank", () => {
    const out = renderReadmeTemplate(null, { ...baseVars, tagline: "  " });
    expect(out).toContain("Describe your project in one sentence.");
  });

  it("stamps today's date when `date` is omitted", () => {
    const withoutDate = { ...baseVars };
    delete (withoutDate as Partial<typeof baseVars>).date;
    const out = renderReadmeTemplate("default", withoutDate);
    // ISO date prefix — e.g. "2026-04-19". Match shape, not exact day.
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
