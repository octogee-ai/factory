/**
 * Unit tests for per-customer Gitea isolation.
 *
 * Tests SSH key generation, permissions, slug-to-path derivation,
 * Gitea username conventions, and gitignore coverage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ── Inline pure functions from git.ts ──────────────────────────────────────

function customerSshKeyPath(customersDir: string, slug: string): string {
  return path.join(customersDir, slug, ".ssh", "id_ed25519");
}

function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}

function generateCustomerSshKey(customersDir: string, slug: string): string {
  const sshDir = path.join(customersDir, slug, ".ssh");
  const keyPath = path.join(sshDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(sshDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  fs.chmodSync(sshDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);

  return fs.readFileSync(pubPath, "utf-8").trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SSH key generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitea-test-"));
    fs.mkdirSync(path.join(tmpDir, "acme"), { recursive: true });
  });

  it("generates an ed25519 keypair in the customer .ssh directory", () => {
    const pubKey = generateCustomerSshKey(tmpDir, "acme");

    expect(pubKey).toMatch(/^ssh-ed25519 /);
    expect(pubKey).toContain("octogee-acme@gateway");

    const keyPath = path.join(tmpDir, "acme", ".ssh", "id_ed25519");
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(keyPath + ".pub")).toBe(true);
  });

  it("sets correct file permissions", () => {
    generateCustomerSshKey(tmpDir, "acme");

    const sshDir = path.join(tmpDir, "acme", ".ssh");
    const keyPath = path.join(sshDir, "id_ed25519");

    const dirStat = fs.statSync(sshDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const keyStat = fs.statSync(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);

    const pubStat = fs.statSync(keyPath + ".pub");
    expect(pubStat.mode & 0o777).toBe(0o644);
  });

  it("is idempotent — returns existing key without regenerating", () => {
    const key1 = generateCustomerSshKey(tmpDir, "acme");
    const key2 = generateCustomerSshKey(tmpDir, "acme");
    expect(key1).toBe(key2);
  });

  it("generates unique keys per customer", () => {
    fs.mkdirSync(path.join(tmpDir, "bob"), { recursive: true });
    const keyA = generateCustomerSshKey(tmpDir, "acme");
    const keyB = generateCustomerSshKey(tmpDir, "bob");
    expect(keyA).not.toBe(keyB);
  });

  it("private key is not readable by other users (0600)", () => {
    generateCustomerSshKey(tmpDir, "acme");
    const keyPath = path.join(tmpDir, "acme", ".ssh", "id_ed25519");
    const stat = fs.statSync(keyPath);
    // No group or other permissions
    expect(stat.mode & 0o077).toBe(0);
  });
});

describe("customer SSH key path", () => {
  it("derives correct path from slug", () => {
    const p = customerSshKeyPath("/home/node/.openclaw/customers", "acme-co");
    expect(p).toBe("/home/node/.openclaw/customers/acme-co/.ssh/id_ed25519");
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
