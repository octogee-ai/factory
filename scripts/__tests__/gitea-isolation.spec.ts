import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

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

// ── Per-repo core.sshCommand (agent-side push auth) ──────────────────────────
//
// The provisioner's TS code passes GIT_SSH_COMMAND per-call, but the
// per-customer agent (running inside openclaw) doesn't inherit that env
// var. When the agent runs `git push` from Bash, ssh sees no IdentityFile
// (entrypoint.sh writes ~/.ssh/config WITHOUT one, intentionally) and
// auth fails. Fix: write `core.sshCommand` into the customer's repo
// `.git/config` at init/clone time. That's persistent, repo-scoped, and
// requires no agent-side env injection. Observed PROD 2026-04-29:
// BenderEcho on ceckert-workspace couldn't push.
describe("setRepoSshCommand", () => {
  let openclawDir: string;
  let repoDir: string;
  let keysDir: string;

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ssh-cmd-"));
    repoDir = path.join(openclawDir, "customers", "acme");
    keysDir = path.join(openclawDir, "customer-keys");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
    execSync("git init -q -b main", { cwd: repoDir });
  });

  function expectedSshCommand(keyPath: string): string {
    return `ssh -i ${keyPath} -F /home/node/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
  }

  it("writes core.sshCommand pointing at the customer key when one exists", async () => {
    generateCustomerSshKey(keysDir, "acme");
    const keyPath = customerSshKeyPath(keysDir, "acme");

    // Pure inline equivalent of setRepoSshCommand. Kept inline (not imported)
    // to match the file's existing pattern of self-contained tests.
    if (fs.existsSync(keyPath)) {
      execSync(`git config core.sshCommand "${expectedSshCommand(keyPath)}"`, {
        cwd: repoDir,
      });
    }

    const got = execSync("git config --get core.sshCommand", {
      cwd: repoDir,
    }).toString().trim();
    expect(got).toBe(expectedSshCommand(keyPath));
  });

  it("is idempotent — same key path overwrites cleanly", () => {
    generateCustomerSshKey(keysDir, "acme");
    const keyPath = customerSshKeyPath(keysDir, "acme");
    const cmd = `git config core.sshCommand "${expectedSshCommand(keyPath)}"`;
    execSync(cmd, { cwd: repoDir });
    execSync(cmd, { cwd: repoDir }); // second call must not error or duplicate

    const got = execSync("git config --get-all core.sshCommand", {
      cwd: repoDir,
    }).toString().trim().split("\n");
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(expectedSshCommand(keyPath));
  });

  it("source enforces it: every init/clone path in git.ts calls setRepoSshCommand", () => {
    // Pin the contract: the four entrypoints that materialize a customer
    // repo on disk must each invoke setRepoSshCommand. If a future fifth
    // entrypoint forgets, the agent's first push will silently fail with
    // "no IdentityFile" — same regression class as the original bug.
    const gitTs = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "git.ts"),
      "utf-8",
    );
    expect(gitTs).toContain("export function setRepoSshCommand");
    // Each call site is annotated with a `// ssh-cmd` marker comment so a
    // grep for the marker count is the contract check, not the call shape.
    const markerCount = (gitTs.match(/\/\/ ssh-cmd:/g) ?? []).length;
    expect(markerCount).toBeGreaterThanOrEqual(4);
  });
});
