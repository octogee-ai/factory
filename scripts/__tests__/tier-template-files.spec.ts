import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier-tpl-"));
  prevEnv = process.env.OCTOGEE_TEMPLATES_DIR;
  process.env.OCTOGEE_TEMPLATES_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
  else process.env.OCTOGEE_TEMPLATES_DIR = prevEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedTier(tier: string, files: string[]): void {
  const dir = path.join(tmpRoot, "tiers", tier);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), `# ${f}\n`, "utf-8");
}

async function load() {
  const mod = await import(
    "../lib/provisionSteps.ts?t=" + Date.now()
  );
  return mod;
}

describe("listTierTemplateFiles", () => {
  it("returns only the files present in the tier directory", async () => {
    seedTier("trial", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md", "IDENTITY.md"]);
    seedTier("hobby", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md", "MEMORY.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial").sort()).toEqual(
      ["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md"],
    );
    expect(listTierTemplateFiles("hobby").sort()).toEqual(
      ["AGENTS.md", "BOOTSTRAP.md", "MEMORY.md", "SOUL.md"],
    );
  });

  it("does not include files removed from a tier", async () => {
    seedTier("trial", ["AGENTS.md", "BOOTSTRAP.md", "SOUL.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial")).not.toContain("MEMORY.md");
  });

  it("includes new files added to a tier without a code change", async () => {
    seedTier("trial", ["AGENTS.md", "IDENTITY.md"]);
    const { listTierTemplateFiles } = await load();
    expect(listTierTemplateFiles("trial")).toContain("IDENTITY.md");
  });

  it("ignores subdirectories and non-md files", async () => {
    const trialDir = path.join(tmpRoot, "tiers", "trial");
    fs.mkdirSync(trialDir, { recursive: true });
    fs.writeFileSync(path.join(trialDir, "AGENTS.md"), "# A\n");
    fs.writeFileSync(path.join(trialDir, "config.json"), "{}\n");
    fs.writeFileSync(path.join(trialDir, ".DS_Store"), "");
    fs.mkdirSync(path.join(trialDir, "subdir"));
    fs.writeFileSync(path.join(trialDir, "subdir", "SHOULD_NOT_COPY.md"), "x");

    const { listTierTemplateFiles } = await load();
    const out = listTierTemplateFiles("trial");
    expect(out).toEqual(["AGENTS.md"]);
  });

  it("throws a clear error when the tier directory does not exist", async () => {
    const { listTierTemplateFiles } = await load();
    expect(() => listTierTemplateFiles("nope-not-a-tier")).toThrow(
      /tiers\/nope-not-a-tier/,
    );
  });
});
