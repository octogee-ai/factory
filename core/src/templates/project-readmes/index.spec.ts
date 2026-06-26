import { describe, it, expect } from "vitest";
import { renderReadmeTemplate, substitute } from "./index.js";

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
    expect(out).toMatch(/engine/i);
  });

  it("falls back to the default template for unknown project types", () => {
    const out = renderReadmeTemplate("unknown-type-xyz", baseVars);
    expect(out).toContain("# My Game");
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
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("each known projectType picks its own template body", () => {
    const g = renderReadmeTemplate("game", baseVars);
    const t = renderReadmeTemplate("trip", baseVars);
    const s = renderReadmeTemplate("social", baseVars);
    const p = renderReadmeTemplate("planner", baseVars);
    expect(g).toMatch(/engine/i);
    expect(t).toMatch(/itinerary/i);
    expect(s).toMatch(/audience/i);
    expect(p).toMatch(/milestone/i);
  });
});
