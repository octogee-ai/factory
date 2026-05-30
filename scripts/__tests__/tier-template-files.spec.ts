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

function customerDir(name = "alice"): string {
  const dir = path.join(tmpRoot, "customers", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("writeTierTemplateFiles — write-if-missing (cattle recovery)", () => {
  it("regenerates a missing gitignored file without clobbering a present tracked one", async () => {
    seedTier("hobby", ["AGENTS.md", "SOUL.md"]);
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "USER-EDITED SOUL\n", "utf-8");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "hobby", { slug: "alice" }, "2026-05-30");

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe("USER-EDITED SOUL\n");
    expect(written).toContain("AGENTS.md");
    expect(written).not.toContain("SOUL.md");
  });

  it("writes every template file on a fresh dir", async () => {
    seedTier("hobby", ["AGENTS.md", "SOUL.md", "TOOLS.md"]);
    const dir = customerDir("bob");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "hobby", {}, "2026-05-30");

    for (const f of ["AGENTS.md", "SOUL.md", "TOOLS.md"]) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    expect(written).toEqual(expect.arrayContaining(["AGENTS.md", "SOUL.md", "TOOLS.md"]));
  });

  it("is a no-op when every file already exists", async () => {
    seedTier("hobby", ["AGENTS.md"]);
    const dir = customerDir("carol");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "EXISTING\n", "utf-8");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "2026-05-30.md"), "NOTE\n", "utf-8");

    const { writeTierTemplateFiles } = await load();
    const written = writeTierTemplateFiles(dir, "hobby", {}, "2026-05-30");

    expect(written).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("EXISTING\n");
  });

  it("applies template placeholders in regenerated files", async () => {
    const tierDir = path.join(tmpRoot, "tiers", "hobby");
    fs.mkdirSync(tierDir, { recursive: true });
    fs.writeFileSync(path.join(tierDir, "AGENTS.md"), "Hello {{slug}}\n", "utf-8");
    const dir = customerDir("dave");

    const { writeTierTemplateFiles } = await load();
    writeTierTemplateFiles(dir, "hobby", { slug: "dave" }, "2026-05-30");

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("Hello dave\n");
  });
});

describe("writeCustomerConfig — write-if-missing (cattle recovery)", () => {
  function ctxFor(dir: string, slug = "alice") {
    return { uid: "u1", slug, tier: "hobby", customerDir: dir } as never;
  }

  it("does not clobber an existing customer-config.json", async () => {
    const dir = customerDir("eve");
    fs.writeFileSync(
      path.join(dir, "customer-config.json"),
      JSON.stringify({ preserved: true, dataApiKey: "old-key" }),
      "utf-8",
    );

    const { writeCustomerConfig } = await load();
    writeCustomerConfig(ctxFor(dir, "eve"), "new-key");

    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "customer-config.json"), "utf-8"));
    expect(parsed.preserved).toBe(true);
    expect(parsed.dataApiKey).toBe("old-key");
  });

  it("writes customer-config.json when missing", async () => {
    const dir = customerDir("frank");

    const { writeCustomerConfig } = await load();
    writeCustomerConfig(ctxFor(dir, "frank"), "fresh-key");

    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "customer-config.json"), "utf-8"));
    expect(parsed.slug).toBe("frank");
    expect(parsed.dataApiKey).toBe("fresh-key");
  });
});
