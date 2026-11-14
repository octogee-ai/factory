import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
  type ContextFilePolicy,
} from "@octogee/shared/types/user-entitlements";

import {
  reassertConvergedContextFiles,
  reassertConvergedContextFilesForSlug,
  reassertUserTimeZoneLine,
} from "./context-file-convergence.js";
import { mapUserDocToSnapshot } from "./user-snapshot-mapping.js";

let tmpRoot: string;
let prevTemplatesDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-context-convergence-"));
  prevTemplatesDir = process.env.OCTOGEE_TEMPLATES_DIR;
  process.env.OCTOGEE_TEMPLATES_DIR = tmpRoot;

  for (const [tier, label] of [["free", "Free"], ["trial", "Trial"], ["default", "Default"]]) {
    const tierDir = path.join(tmpRoot, "tiers", tier);
    fs.mkdirSync(tierDir, { recursive: true });
    fs.writeFileSync(path.join(tierDir, "AGENTS.md"), `# ${label} AGENTS for {{slug}}\n`, "utf-8");
    fs.writeFileSync(path.join(tierDir, "TOOLS.md"), `# ${label} TOOLS\n`, "utf-8");
    fs.writeFileSync(path.join(tierDir, "SOUL.md"), `# ${label} SOUL {{ownerName}}\n`, "utf-8");
  }
});

afterEach(() => {
  if (prevTemplatesDir === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
  else process.env.OCTOGEE_TEMPLATES_DIR = prevTemplatesDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function customerDir(name = "alice"): string {
  const dir = path.join(tmpRoot, "customers", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A Signup Offer whose Personal plan is personal_free: the offer is live and
// grants a user tier, but model access still resolves house_only. The
// combination that makes template-tier order load-bearing.
function houseOnlySignupOffer(): Record<string, unknown> {
  const claimedAt = Date.now() - 24 * 60 * 60 * 1000;
  return {
    schemaVersion: 4,
    offerId: "builder-signup",
    offerVersion: 3,
    personalTier: "personal_free",
    builderTier: "hobby",
    configHash: "momentum-v3",
    claimedAt: new Date(claimedAt),
    endsAt: new Date(claimedAt + 7 * 24 * 60 * 60 * 1000),
    budgetPolicy: {
      schemaVersion: 1,
      currency: "USD",
      cumulativeUnlockUsd: [4.8, 5.6, 6.4, 6.8, 7.2, 7.6, 8],
      hardCapUsd: 8,
    },
  };
}

describe("reassertConvergedContextFiles", () => {

  it("never touches SOUL.md, USER.md, or MEMORY.md — only the two owned context files converge", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "user's personalized soul\n", "utf-8");

    reassertConvergedContextFiles("alice", dir, { planInputs: { tier: "personal_free" } });

    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe(
      "user's personalized soul\n",
    );
  });

  it("converges a paid plan onto the paid template, overwriting the user's own edits", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "paid user's own AGENTS.md\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: { tier: "pro" } }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Default AGENTS for alice\n");
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toBe("# Default TOOLS\n");
  });

  it("keeps BOOTSTRAP.md for a live Signup Offer whose model access is still house-only", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, {
      planInputs: { tier: "personal_free", trialGrant: houseOnlySignupOffer() },
    }, { slug: "alice" });

    expect(changed).not.toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
  });

  it("leaves a paid plan's BOOTSTRAP.md alone while still converging the owned context files", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# paid tier first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: { tier: "pro" } }, { slug: "alice" });

    expect(changed).not.toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "BOOTSTRAP.md"), "utf-8")).toBe(
      "# paid tier first-run ritual\n",
    );
  });

  it("converges a paying user's workspace onto the paid template — the drift that froze a user's tool manual", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "builder's own AGENTS.md\n", "utf-8");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), "# tool manual from signup day\n", "utf-8");
    const snapshot = mapUserDocToSnapshot(
      "u1",
      {
        username: "alice",
        tier: "personal_free",
        builderSubscription: { tier: "hobby", status: "active" },
      },
      [],
    );

    const changed = reassertConvergedContextFiles("alice", dir, snapshot, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toBe("# Default TOOLS\n");
  });
});

describe("reassertConvergedContextFiles under a product-supplied policy", () => {
  const productResolver = userEntitlements();

  function installPolicy(policy: ContextFilePolicy): void {
    installUserEntitlements({ ...productResolver, contextFilePolicy: () => policy });
  }

  function seedCustomTemplate(key: string): void {
    const dir = path.join(tmpRoot, "tiers", key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `# ${key} AGENTS\n`, "utf-8");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), `# ${key} TOOLS\n`, "utf-8");
  }

  afterEach(() => {
    installUserEntitlements(productResolver);
  });

  it("converges onto whatever template key the policy names", () => {
    seedCustomTemplate("studio-eu");
    installPolicy({ templateKey: "studio-eu", removedFiles: [] });
    const dir = customerDir();

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: {} });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# studio-eu AGENTS\n");
  });

  it("removes exactly the files the policy lists and reports them as changed", () => {
    seedCustomTemplate("studio-eu");
    installPolicy({ templateKey: "studio-eu", removedFiles: ["HEARTBEAT.md"] });
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "HEARTBEAT.md"), "retired\n", "utf-8");
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "kept\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: {} });

    expect(changed).toContain("HEARTBEAT.md");
    expect(fs.existsSync(path.join(dir, "HEARTBEAT.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "BOOTSTRAP.md"), "utf-8")).toBe("kept\n");
  });

  it("removes nothing when the policy lists nothing", () => {
    seedCustomTemplate("studio-eu");
    installPolicy({ templateKey: "studio-eu", removedFiles: [] });
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "kept\n", "utf-8");

    expect(reassertConvergedContextFiles("alice", dir, { planInputs: {} })).not.toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
  });

  it.each(["USER.md", "SOUL.md", "MEMORY.md"])("refuses a policy that would remove the user-owned %s and leaves it intact", (file) => {
    seedCustomTemplate("studio-eu");
    installPolicy({ templateKey: "studio-eu", removedFiles: [file] });
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, file), "user content\n", "utf-8");

    expect(() => reassertConvergedContextFiles("alice", dir, { planInputs: {} })).toThrow(/user-owned/);
    expect(fs.readFileSync(path.join(dir, file), "utf-8")).toBe("user content\n");
  });

  it("preserves USER.md through convergence and removal", () => {
    seedCustomTemplate("studio-eu");
    installPolicy({ templateKey: "studio-eu", removedFiles: ["BOOTSTRAP.md"] });
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "USER.md"), "- **Name:** Alice\nCoach notes stay.\n", "utf-8");
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "retired\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: {} });

    expect(changed).toContain("BOOTSTRAP.md");
    expect(changed).not.toContain("USER.md");
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe("- **Name:** Alice\nCoach notes stay.\n");
  });

  it("converges a bare platform onto the default template and removes nothing", () => {
    installUserEntitlements(staticUserEntitlements);
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "kept\n", "utf-8");
    fs.writeFileSync(path.join(dir, "USER.md"), "user content\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { planInputs: { tier: "personal_free" } }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Default AGENTS for alice\n");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe("user content\n");
  });

  it("fails loud when the policy names a template that does not exist", () => {
    installPolicy({ templateKey: "absent", removedFiles: [] });

    expect(() => reassertConvergedContextFiles("alice", customerDir(), { planInputs: {} })).toThrow(/tiers\/absent/);
  });
});

describe("reassertConvergedContextFilesForSlug", () => {
  it("throws an identifiable error when the userData bag has no username — never a silent skip", () => {
    expect(() =>
      reassertConvergedContextFilesForSlug({ planInputs: { tier: "personal_free" } }, path.join(tmpRoot, "customers")),
    ).toThrow(/username/);
    expect(() =>
      reassertConvergedContextFilesForSlug(
        { planInputs: { tier: "personal_free" }, username: 42 },
        path.join(tmpRoot, "customers"),
      ),
    ).toThrow(/username/);
  });

  it("converges via the users-dir-derived path when username is present", () => {
    const dir = customerDir();

    const changed = reassertConvergedContextFilesForSlug(
      { planInputs: { tier: "personal_free" }, username: "alice" },
      path.join(tmpRoot, "customers"),
    );

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
  });
});

describe("reassertUserTimeZoneLine", () => {
  const seeded = "# USER.md — About You\n\n## The Basics\n- **Name:** Alice\n- **Timezone:** unknown\n\n## Notes\nCoach notes stay.\n";

  it("rewrites only the time zone line of the user-owned USER.md", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "USER.md"), seeded, "utf-8");
    expect(reassertUserTimeZoneLine(dir, "America/Chicago")).toBe(true);
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe(seeded.replace("- **Timezone:** unknown", "- **Timezone:** America/Chicago"));
    expect(reassertUserTimeZoneLine(dir, "America/Chicago")).toBe(false);
  });

  it("adds the line under the Name line when the user's file predates it, keeping the trial template's spelling", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "USER.md"), "- **Name:** Alice\n- **Pronouns:** she\n", "utf-8");
    expect(reassertUserTimeZoneLine(dir, "Europe/Berlin")).toBe(true);
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe("- **Name:** Alice\n- **Timezone:** Europe/Berlin\n- **Pronouns:** she\n");
    fs.writeFileSync(path.join(dir, "USER.md"), "- **Time zone:** old\n", "utf-8");
    reassertUserTimeZoneLine(dir, "Europe/Berlin");
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe("- **Time zone:** Europe/Berlin\n");
  });

  it("leaves a file without an anchor, a missing file, and a user without a zone alone", () => {
    const dir = customerDir();
    expect(reassertUserTimeZoneLine(dir, "Europe/Berlin")).toBe(false);
    fs.writeFileSync(path.join(dir, "USER.md"), "Free-form notes only.\n", "utf-8");
    expect(reassertUserTimeZoneLine(dir, "Europe/Berlin")).toBe(false);
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toBe("Free-form notes only.\n");
    fs.writeFileSync(path.join(dir, "USER.md"), seeded, "utf-8");
    expect(reassertUserTimeZoneLine(dir, null)).toBe(false);
  });

  it("rides the context-file reassert off the snapshot's time zone", () => {
    const dir = customerDir("bob");
    fs.writeFileSync(path.join(dir, "USER.md"), seeded, "utf-8");
    const changed = reassertConvergedContextFilesForSlug(
      { ...mapUserDocToSnapshot("uid-bob", { username: "bob", tier: "free" }, []), username: "bob", timeZone: "Asia/Tokyo" },
      path.join(tmpRoot, "customers"),
    );
    expect(changed).toContain("USER.md");
    expect(fs.readFileSync(path.join(dir, "USER.md"), "utf-8")).toContain("- **Timezone:** Asia/Tokyo");
    expect(reassertConvergedContextFilesForSlug(
      { ...mapUserDocToSnapshot("uid-bob", { username: "bob", tier: "free" }, []), username: "bob", timeZone: "../etc" },
      path.join(tmpRoot, "customers"),
    )).not.toContain("USER.md");
  });
});
