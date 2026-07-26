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

  const freeDir = path.join(tmpRoot, "tiers", "free");
  fs.mkdirSync(freeDir, { recursive: true });
  fs.writeFileSync(path.join(freeDir, "AGENTS.md"), "# Free AGENTS for {{slug}}\n", "utf-8");
  fs.writeFileSync(path.join(freeDir, "TOOLS.md"), "# Free TOOLS\n", "utf-8");
  fs.writeFileSync(path.join(freeDir, "SOUL.md"), "# Free SOUL {{ownerName}}\n", "utf-8");
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

  it("does not converge a paid plan's context files, even if they differ from the free template", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "paid customer's own AGENTS.md\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" });

    expect(changed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "paid customer's own AGENTS.md\n",
    );
  });

  it("does not converge a live Signup Offer (catalog access), even though the base tier is personal_free", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "trial customer's own AGENTS.md\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, {
      tier: "personal_free",
      trialGrant: liveSignupOffer(),
    });

    expect(changed).toEqual([]);
  });

  it("stops converging once a house-only customer upgrades — leaves their edits alone from then on", () => {
    const dir = customerDir();
    reassertConvergedContextFiles("alice", dir, { tier: "personal_free" });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "now-paid customer's own edits\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" });

    expect(changed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "now-paid customer's own edits\n",
    );
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

  it("leaves a paid plan's BOOTSTRAP.md alone", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "# paid tier first-run ritual\n", "utf-8");

    const changed = reassertConvergedContextFiles("alice", dir, { tier: "pro" });

    expect(changed).toEqual([]);
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
  });

  it("does not converge a snapshot from the direct Firestore mapping when the user doc carries a live Signup Offer", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "trial customer's own AGENTS.md\n", "utf-8");
    const snapshot = mapUserDocToSnapshot(
      "u1",
      { username: "alice", tier: "personal_free", trialGrant: liveSignupOffer() },
      [],
    );

    const changed = reassertConvergedContextFiles("alice", dir, snapshot);

    expect(changed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "trial customer's own AGENTS.md\n",
    );
  });

  it("does not converge a snapshot from the direct Firestore mapping when the user doc carries an active builder subscription", () => {
    const dir = customerDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "builder's own AGENTS.md\n", "utf-8");
    const snapshot = mapUserDocToSnapshot(
      "u1",
      {
        username: "alice",
        tier: "personal_free",
        builderSubscription: { tier: "hobby", status: "active" },
      },
      [],
    );

    const changed = reassertConvergedContextFiles("alice", dir, snapshot);

    expect(changed).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      "builder's own AGENTS.md\n",
    );
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
