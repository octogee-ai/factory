import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { listTierTemplateFiles, writeTierTemplateFiles } from "./tier-template-files.js";

let tmpRoot: string;
let prevTemplatesDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-tier-templates-"));
  prevTemplatesDir = process.env.OCTOGEE_TEMPLATES_DIR;
  process.env.OCTOGEE_TEMPLATES_DIR = tmpRoot;
});

afterEach(() => {
  if (prevTemplatesDir === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
  else process.env.OCTOGEE_TEMPLATES_DIR = prevTemplatesDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedTier(tier: string, files: Record<string, string>): void {
  const dir = path.join(tmpRoot, "tiers", tier);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content, "utf-8");
  }
}

function customerDir(name = "alice"): string {
  const dir = path.join(tmpRoot, "customers", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("listTierTemplateFiles", () => {
  it("returns sorted markdown files for the selected tier only", () => {
    seedTier("trial", {
      "SOUL.md": "# Soul\n",
      "AGENTS.md": "# Agents\n",
      "notes.txt": "ignored\n",
    });
    fs.mkdirSync(path.join(tmpRoot, "tiers", "trial", "nested"));
    fs.writeFileSync(path.join(tmpRoot, "tiers", "trial", "nested", "TOOLS.md"), "# Ignored\n");

    expect(listTierTemplateFiles("trial")).toEqual(["AGENTS.md", "SOUL.md"]);
  });

  it("throws a tier-specific error when the directory is missing", () => {
    expect(() => listTierTemplateFiles("missing")).toThrow(/tiers\/missing/);
  });
});

describe("writeTierTemplateFiles", () => {
  it("writes missing tier files without clobbering customer edits", () => {
    seedTier("hobby", {
      "AGENTS.md": "Hello {{slug}}\n",
      "SOUL.md": "Template soul\n",
    });
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "Customer soul\n", "utf-8");

    const written = writeTierTemplateFiles(dir, "hobby", { slug: "alice" });

    expect(written).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("Hello alice\n");
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe("Customer soul\n");
  });

  it("seeds NO memory note and NO memory directory — openclaw does memory, not Octogee", () => {
    seedTier("hobby", { "AGENTS.md": "# Agents\n" });
    const dir = customerDir("memoryless");

    const written = writeTierTemplateFiles(dir, "hobby", {});

    expect(written).toEqual(["AGENTS.md"]);
    expect(fs.existsSync(path.join(dir, "memory"))).toBe(false);
  });

  it("removes retired context-file ignores while preserving unrelated ignore rules", () => {
    seedTier("hobby", {
      "AGENTS.md": "# Agents\n",
      "TOOLS.md": "# Tools\n",
    });
    const dir = customerDir("owned");
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["AGENTS.md", "TOOLS.md", ".ssh/", "node_modules/", ""].join("\n"),
      "utf-8",
    );

    const written = writeTierTemplateFiles(dir, "hobby", {});

    expect(written).toContain(".gitignore");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toBe(
      [".ssh/", "node_modules/", ""].join("\n"),
    );
  });

  it("seeds a tier with no BOOTSTRAP.md template without error — only the files present are written", () => {
    seedTier("free", {
      "AGENTS.md": "# Agents\n",
      "TOOLS.md": "# Tools\n",
    });
    const dir = customerDir("bootless");

    const written = writeTierTemplateFiles(dir, "free", {});

    expect(written).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(false);
  });

  it("is a no-op when tier files and ignores are already current", () => {
    seedTier("hobby", {
      "AGENTS.md": "# Agents\n",
    });
    const dir = customerDir("current");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Existing\n", "utf-8");
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf-8");

    expect(writeTierTemplateFiles(dir, "hobby", {})).toEqual([]);
  });
});
