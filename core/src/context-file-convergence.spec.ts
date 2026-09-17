import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  reassertConvergedContextFiles,
  reassertConvergedContextFilesForSlug,
} from "./context-file-convergence.js";
import { mapUserDocToSnapshot } from "./customer-snapshot-mapping.js";

let tmpRoot: string;
let prevTemplatesDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-context-convergence-"));
  prevTemplatesDir = process.env.OCTOGEE_TEMPLATES_DIR;
  process.env.OCTOGEE_TEMPLATES_DIR = tmpRoot;

  for (const [tier, label] of [["free", "Free"], ["trial", "Trial"], ["paid", "Paid"]]) {
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

function liveSignupOffer(): Record<string, unknown> {
  const claimedAt = new Date();
  return {
    schemaVersion: 3,
    offerId: "builder-signup",
    offerVersion: 1,
    personalTier: "personal",
    builderTier: "hobby",
    configHash: "config-a",
    claimedAt,
    endsAt: new Date(claimedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
}

// A Signup Offer whose Personal plan is personal_free: the offer is live and
// grants a Builder tier, but model access still resolves house_only. The
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
  it("writes AGENTS.md and TOOLS.md from the free template for a house-only plan with no prior files", () => {
    const dir = customerDir();

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "# Free AGENTS for {{slug}}\n",
    );
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toBe("# Free TOOLS\n");
  });

  it("overwrites a house-only customer's manually edited AGENTS.md/TOOLS.md (accepted product behavior)", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "customer wrote their own rules\n", "utf-8");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), "customer's own tools notes\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "# Free AGENTS for {{slug}}\n",
    );
  });

  it("never touches SOUL.md, USER.md, or MEMORY.md — only the two owned context files converge", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "SOUL.md"), "customer's personalized soul\n", "utf-8");

    reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf-8")).toBe(
      "customer's personalized soul\n",
    );
  });

  it("is a no-op (no write, no churn) when the on-disk content already matches the converged template", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Free AGENTS for {{slug}}\n", "utf-8");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), "# Free TOOLS\n", "utf-8");
    const beforeMtime = fs.statSync(path.join(dir, "AGENTS.md")).mtimeMs;

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(changed).toEqual([]);
    expect(fs.statSync(path.join(dir, "AGENTS.md")).mtimeMs).toBe(beforeMtime);
  });

  it("converges a paid plan onto the paid template, overwriting the customer's own edits", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "paid customer's own AGENTS.md\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Paid AGENTS for alice\n");
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toBe("# Paid TOOLS\n");
  });

  it("converges a live Signup Offer onto the trial template, not the free one", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "trial customer's own AGENTS.md\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, {
      tier: "personal_free",
      trialGrant: liveSignupOffer(),
    }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Trial AGENTS for alice\n");
  });

  it("follows a house-only customer onto the paid template when they upgrade", () => {
    const dir = customerDir();
    reassertConvergedContextFiles("alice", dir, { tier: "personal_free" }, { slug: "alice" });
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Free AGENTS for alice\n");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Paid AGENTS for alice\n");
  });

  it("prefers a live Signup Offer over house-only model access when picking the template", () => {
    const dir = customerDir();

    const changed = reassertConvergedContextFiles("alice", dir, {
      tier: "personal_free",
      trialGrant: houseOnlySignupOffer(),
    }, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Trial AGENTS for alice\n");
  });

  it("keeps BOOTSTRAP.md for a live Signup Offer whose model access is still house-only", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, {
      tier: "personal_free",
      trialGrant: houseOnlySignupOffer(),
    }, { slug: "alice" });

    expect(changed).not.toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
  });

  it("applies template placeholders using the vars passed in", () => {
    const dir = customerDir();

    reassertConvergedContextFiles("alice", dir, { tier: "personal_free" }, { slug: "alice" });

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Free AGENTS for alice\n");
  });

  it("removes a lingering BOOTSTRAP.md for a house-only plan — platform onboarding already bootstrapped the workspace", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# leftover first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(changed).toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(false);
  });

  it("is a no-op on BOOTSTRAP.md when it is already absent — no churn", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Free AGENTS for {{slug}}\n", "utf-8");
    fs.writeFileSync(path.join(dir, "TOOLS.md"), "# Free TOOLS\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });

    expect(changed).toEqual([]);
  });

  it("leaves a paid plan's BOOTSTRAP.md alone while still converging the owned context files", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# paid tier first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" }, { slug: "alice" });

    expect(changed).not.toContain("BOOTSTRAP.md");
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "BOOTSTRAP.md"), "utf-8")).toBe(
      "# paid tier first-run ritual\n",
    );
  });

  it("converges a snapshot from the direct Firestore mapping carrying a live Signup Offer", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "trial customer's own AGENTS.md\n", "utf-8");
    const snapshot = mapUserDocToSnapshot(
      "u1",
      { username: "alice", tier: "personal_free", trialGrant: liveSignupOffer() },
      [],
    );

    const changed = reassertConvergedContextFiles("alice", dir, snapshot, { slug: "alice" });

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("# Trial AGENTS for alice\n");
  });

  it("converges a paying Builder's workspace onto the paid template — the drift that froze a Builder's tool manual", () => {
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
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toBe("# Paid TOOLS\n");
  });
});

describe("reassertConvergedContextFilesForSlug", () => {
  it("throws an identifiable error when the userData bag has no username — never a silent skip", () => {
    expect(() =>
      reassertConvergedContextFilesForSlug({ tier: "personal_free" }, path.join(tmpRoot, "customers")),
    ).toThrow(/username/);
    expect(() =>
      reassertConvergedContextFilesForSlug(
        { tier: "personal_free", username: 42 },
        path.join(tmpRoot, "customers"),
      ),
    ).toThrow(/username/);
  });

  it("converges via the customers-dir-derived path when username is present", () => {
    const dir = customerDir();

    const changed = reassertConvergedContextFilesForSlug(
      { tier: "personal_free", username: "alice" },
      path.join(tmpRoot, "customers"),
    );

    expect(changed.sort()).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
  });
});
