import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validateIdeaSlug, ideaExists, listIdeas } from "../lib/ideas.js";

describe("validateIdeaSlug", () => {
  it("accepts a simple slug", () => {
    expect(validateIdeaSlug("coffee-shop-app")).toBe(true);
  });

  it("accepts a single word", () => {
    expect(validateIdeaSlug("marketing")).toBe(true);
  });

  it("accepts slugs with numbers", () => {
    expect(validateIdeaSlug("q4-plan-2026")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateIdeaSlug("")).toBe(false);
  });

  it("rejects uppercase characters", () => {
    expect(validateIdeaSlug("Coffee-Shop")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(validateIdeaSlug("coffee shop")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(validateIdeaSlug("coffee_shop!")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(validateIdeaSlug("coffee_shop")).toBe(false);
  });

  it("rejects leading hyphens", () => {
    expect(validateIdeaSlug("-coffee")).toBe(false);
  });

  it("rejects trailing hyphens", () => {
    expect(validateIdeaSlug("coffee-")).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(validateIdeaSlug("coffee--shop")).toBe(false);
  });

  it("rejects slugs longer than 60 characters", () => {
    const long = "a-" + "b".repeat(59);
    expect(validateIdeaSlug(long)).toBe(false);
  });

  it("accepts a slug at exactly 60 characters", () => {
    // 60 chars: "a" repeated 60 times
    const slug = "a".repeat(60);
    expect(validateIdeaSlug(slug)).toBe(true);
  });
});

// ── ideaExists ──────────────────────────────────────────────────────────────────

describe("ideaExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-test-"));
    fs.mkdirSync(path.join(tmpDir, "ideas", "coffee-shop"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when idea folder exists", () => {
    expect(ideaExists(tmpDir, "coffee-shop")).toBe(true);
  });

  it("returns false when idea folder does not exist", () => {
    expect(ideaExists(tmpDir, "nonexistent")).toBe(false);
  });

  it("returns false when ideas/ directory is missing entirely", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-empty-"));
    try {
      expect(ideaExists(emptyDir, "anything")).toBe(false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── listIdeas ───────────────────────────────────────────────────────────────────

describe("listIdeas", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-list-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when ideas/ does not exist", () => {
    expect(listIdeas(tmpDir)).toEqual([]);
  });

  it("returns empty array when ideas/ is empty", () => {
    fs.mkdirSync(path.join(tmpDir, "ideas"), { recursive: true });
    expect(listIdeas(tmpDir)).toEqual([]);
  });

  it("returns idea slugs", () => {
    const ideasDir = path.join(tmpDir, "ideas");
    fs.mkdirSync(path.join(ideasDir, "coffee-shop"), { recursive: true });
    fs.mkdirSync(path.join(ideasDir, "marketing-plan"), { recursive: true });
    const result = listIdeas(tmpDir);
    expect(result).toHaveLength(2);
    expect(result).toContain("coffee-shop");
    expect(result).toContain("marketing-plan");
  });

  it("ignores non-directory entries", () => {
    const ideasDir = path.join(tmpDir, "ideas");
    fs.mkdirSync(path.join(ideasDir, "real-idea"), { recursive: true });
    fs.mkdirSync(ideasDir, { recursive: true });
    fs.writeFileSync(path.join(ideasDir, "stray-file.md"), "not a directory");
    const result = listIdeas(tmpDir);
    expect(result).toEqual(["real-idea"]);
  });
});
