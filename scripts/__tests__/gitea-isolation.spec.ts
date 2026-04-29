/**
 * Unit tests for per-customer Gitea isolation.
 *
 * Tests SSH key generation, permissions, slug-to-path derivation,
 * Gitea username conventions, and gitignore coverage.
 *
 * KEY LAYOUT (post-2026-04-29): per-customer SSH keys live at
 * `customer-keys/{slug}/id_ed25519`, a sibling of `customers/`. They MUST
 * NOT live nested inside the workspace dir; doing so pre-creates
 * `customers/{slug}/` and breaks `git clone <url> {slug}` on the restore
 * branch. The "key gen does not pre-create the workspace dir" test below
 * is the canonical regression pin for that bug class.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ── Inline pure functions from git.ts ──────────────────────────────────────

function customerSshKeyPath(keysDir: string, slug: string): string {
  return path.join(keysDir, slug, "id_ed25519");
}

function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}

function generateCustomerSshKey(keysDir: string, slug: string): string {
  const keyDir = path.join(keysDir, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(keyDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  fs.chmodSync(keyDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);

  return fs.readFileSync(pubPath, "utf-8").trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SSH key generation", () => {
  let openclawDir: string;
  let keysDir: string;
  let customersDir: string;

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitea-test-"));
    keysDir = path.join(openclawDir, "customer-keys");
    customersDir = path.join(openclawDir, "customers");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.mkdirSync(customersDir, { recursive: true });
  });

  it("generates an ed25519 keypair in the customer-keys directory", () => {
    const pubKey = generateCustomerSshKey(keysDir, "acme");

    expect(pubKey).toMatch(/^ssh-ed25519 /);
    expect(pubKey).toContain("octogee-acme@gateway");

    const keyPath = path.join(keysDir, "acme", "id_ed25519");
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(keyPath + ".pub")).toBe(true);
  });

  it("sets correct file permissions", () => {
    generateCustomerSshKey(keysDir, "acme");

    const keyDir = path.join(keysDir, "acme");
    const keyPath = path.join(keyDir, "id_ed25519");

    const dirStat = fs.statSync(keyDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const keyStat = fs.statSync(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);

    const pubStat = fs.statSync(keyPath + ".pub");
    expect(pubStat.mode & 0o777).toBe(0o644);
  });

  it("is idempotent — returns existing key without regenerating", () => {
    const key1 = generateCustomerSshKey(keysDir, "acme");
    const key2 = generateCustomerSshKey(keysDir, "acme");
    expect(key1).toBe(key2);
  });

  it("generates unique keys per customer", () => {
    const keyA = generateCustomerSshKey(keysDir, "acme");
    const keyB = generateCustomerSshKey(keysDir, "bob");
    expect(keyA).not.toBe(keyB);
  });

  it("private key is not readable by other users (0600)", () => {
    generateCustomerSshKey(keysDir, "acme");
    const keyPath = path.join(keysDir, "acme", "id_ed25519");
    const stat = fs.statSync(keyPath);
    // No group or other permissions
    expect(stat.mode & 0o077).toBe(0);
  });

  it("does NOT pre-create the customer workspace dir (regression: TEST 2026-04-29 buildera clone loop)", () => {
    // The whole reason keys live at customer-keys/{slug}/ instead of
    // customers/{slug}/.ssh/. If gen creates customers/{slug}/, then
    // `git clone <url> {slug}` fails on the restore branch with
    // "destination path 'slug' already exists and is not an empty directory".
    // This pins the contract that the workspace dir is ONLY created by
    // the workspace step (clone or init), not by SSH-key gen.
    generateCustomerSshKey(keysDir, "acme");
    expect(fs.existsSync(path.join(customersDir, "acme"))).toBe(false);
  });
});

describe("customer SSH key path", () => {
  it("derives correct path from slug (sibling of customers/, not nested inside)", () => {
    const p = customerSshKeyPath("/home/node/.openclaw/customer-keys", "acme-co");
    expect(p).toBe("/home/node/.openclaw/customer-keys/acme-co/id_ed25519");
  });
});

describe("Gitea username", () => {
  it("prefixes slug with ws-", () => {
    expect(giteaUsername("acme-co")).toBe("ws-acme-co");
    expect(giteaUsername("test")).toBe("ws-test");
  });

  it("is deterministic", () => {
    expect(giteaUsername("x")).toBe(giteaUsername("x"));
  });
});

describe("workspace .gitignore excludes .ssh/", () => {
  it("initWorkspaceRepo gitignore template contains .ssh/", () => {
    // Read the actual git.ts source to verify the gitignore template
    const gitTs = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "git.ts"),
      "utf-8",
    );
    // The gitignore string in initWorkspaceRepo must include .ssh/
    expect(gitTs).toContain('".ssh/",');
  });
});
