import { execFileSync, execSync } from "child_process";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import {
  log, GIT_API_URL, GIT_SSH_HOST,
  OPENCLAW_DIR, CUSTOMERS_DIR, CUSTOMER_KEYS_DIR,
} from "./config.js";
import {
  workspaceGiteaOrg, workspaceRepoName, projectRepoName, systemConfigRepoName,
} from "./gitea-naming.js";
import * as giteaBroker from "./gitea-admin-broker-client.js";
import { cloneGithubProjectViaBroker } from "./github-project-clone-broker.js";
import { notesWelcomeSeed } from "@octogee/core/templates/project-seeds";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import type { ProjectRepoSource } from "@octogee/shared/types/project";

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function execErrStderr(err: unknown): string {
  return execErrStream(err, "stderr");
}

export function execErrStdout(err: unknown): string {
  return execErrStream(err, "stdout");
}

export function execErrCode(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function execErrStream(err: unknown, stream: "stderr" | "stdout"): string {
  if (
    err &&
    typeof err === "object" &&
    stream in err &&
    typeof (err as Record<string, { toString?: () => string } | undefined>)[stream]?.toString ===
      "function"
  ) {
    return (err as Record<string, { toString: () => string }>)[stream].toString().trim();
  }
  return "";
}

export function customerSshKeyPath(slug: string): string {
  return path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519");
}

export interface CustomerGitRefreshDeps {
  fetchCanonical?: (repoDir: string, gitDir: string) => void;
  repoSource?: ProjectRepoSource | null;
  giteaRepoName?: string;
  githubToken?: string | null;
}

export function setRepoSshCommand(
  repoDir: string,
  slug: string,
  deps: CustomerGitRefreshDeps = {},
): void {
  const gitDir = externalizeCustomerGitDir(repoDir, deps);
  if (gitDir) {
    const identity = customerGitIdentity(repoDir);
    if (!identity || identity.slug !== slug || identity.metadataDir !== gitDir) {
      throw new Error(`[git] customer repository identity does not match ${repoDir}`);
    }
    writeCanonicalGitConfig(gitDir, slug, canonicalCustomerGitSource(identity, deps));
    return;
  }
  if (path.resolve(repoDir) === path.resolve(OPENCLAW_DIR, "system_config")) {
    const systemGitDir = trustedGitDir(repoDir);
    if (!systemGitDir) throw new Error(`[git] system config repository metadata is missing for ${repoDir}`);
    writeCanonicalGitConfig(systemGitDir, slug, {
      kind: "gitea",
      repoName: systemConfigRepoName(),
      remoteUrl: sshRemoteUrl(workspaceGiteaOrg(slug), systemConfigRepoName()),
    });
    return;
  }
  removePersistedRepoSshCommand(repoDir);
}

const CUSTOMER_GIT_METADATA_ROOT = path.join(OPENCLAW_DIR, "git-metadata");
const CUSTOMER_GIT_TRUST_RECEIPT_VERSION = "octogee-customer-git-v3";
const SAFE_GIT_IDENTITY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SAFE_GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/u;
const GIT_BINARY = "/usr/bin/git";
const DISABLED_EXECUTABLE = "/bin/false";

interface CustomerGitIdentity {
  slug: string;
  repoName: string;
  metadataDir: string;
}

type CanonicalCustomerGitSource =
  | { kind: "gitea"; repoName: string; remoteUrl: string }
  | { kind: "github"; owner: string; repo: string; remoteUrl: string };

function customerGitIdentity(repoDir: string): CustomerGitIdentity | null {
  const relative = path.relative(path.resolve(CUSTOMERS_DIR), path.resolve(repoDir));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const slug = parts[0] ?? "";
  if (!SAFE_GIT_IDENTITY_RE.test(slug)) return null;
  if (parts.length === 1) {
    return {
      slug,
      repoName: workspaceRepoName(),
      metadataDir: path.join(CUSTOMER_GIT_METADATA_ROOT, slug, "workspace.git"),
    };
  }
  const projectSlug = parts[2] ?? "";
  if (parts.length === 3 && parts[1] === "projects" && SAFE_GIT_IDENTITY_RE.test(projectSlug)) {
    return {
      slug,
      repoName: projectRepoName(projectSlug),
      metadataDir: path.join(CUSTOMER_GIT_METADATA_ROOT, slug, "projects", `${projectSlug}.git`),
    };
  }
  return null;
}

function customerGitMetadataDir(repoDir: string): string | null {
  return customerGitIdentity(repoDir)?.metadataDir ?? null;
}

function githubSource(repoSource: ProjectRepoSource): CanonicalCustomerGitSource {
  if (!SAFE_GITHUB_OWNER_RE.test(repoSource.owner) || !SAFE_GITHUB_REPO_RE.test(repoSource.repo)) {
    throw new Error("[git] invalid GitHub repository source");
  }
  return {
    kind: "github",
    owner: repoSource.owner,
    repo: repoSource.repo,
    remoteUrl: githubHttpsRemoteUrl(repoSource.owner, repoSource.repo),
  };
}

function giteaSource(slug: string, repoName: string): CanonicalCustomerGitSource {
  if (!SAFE_GIT_IDENTITY_RE.test(repoName)) throw new Error("[git] invalid Gitea repository name");
  return {
    kind: "gitea",
    repoName,
    remoteUrl: sshRemoteUrl(workspaceGiteaOrg(slug), repoName),
  };
}

function canonicalCustomerGitSource(
  identity: CustomerGitIdentity,
  deps: CustomerGitRefreshDeps,
): CanonicalCustomerGitSource {
  if (deps.repoSource?.provider === "github") return githubSource(deps.repoSource);
  if (deps.giteaRepoName) return giteaSource(identity.slug, deps.giteaRepoName);
  return trustedCustomerGitSource(identity) ?? giteaSource(identity.slug, identity.repoName);
}

function sourceReceiptValue(source: CanonicalCustomerGitSource): string {
  return source.kind === "github"
    ? `github:${source.owner}/${source.repo}`
    : `gitea:${source.repoName}`;
}

function sourceFromReceipt(
  identity: CustomerGitIdentity,
  receipt: string,
): CanonicalCustomerGitSource | null {
  const lines = receipt.split("\n");
  if (lines.length !== 3 || lines[0] !== CUSTOMER_GIT_TRUST_RECEIPT_VERSION || lines[2] !== "") return null;
  const source = lines[1] ?? "";
  if (source.startsWith("gitea:")) {
    const repoName = source.slice("gitea:".length);
    return SAFE_GIT_IDENTITY_RE.test(repoName) ? giteaSource(identity.slug, repoName) : null;
  }
  if (source.startsWith("github:")) {
    const [owner, repo, extra] = source.slice("github:".length).split("/");
    if (!owner || !repo || extra) return null;
    return githubSource({ provider: "github", owner, repo });
  }
  return null;
}

function writeCanonicalGitConfig(
  gitDir: string,
  slug: string,
  source: CanonicalCustomerGitSource,
): void {
  const configPath = path.join(gitDir, "config");
  const configTmp = `${configPath}.octogee.tmp`;
  const contents = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "[user]",
    `\temail = ${slug}@octogee.com`,
    `\tname = Octo (${slug})`,
    '[remote "origin"]',
    `\turl = ${source.remoteUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
  fs.writeFileSync(configTmp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(configTmp, configPath);
}

function customerGitTrustReceipt(target: string): string {
  return `${target}.octogee-trusted-v3`;
}

function customerGitRefreshMarker(target: string): string {
  return `${target}.octogee-refresh-required`;
}

function quarantineCustomerGitEntry(source: string, identity: CustomerGitIdentity): void {
  try {
    fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const quarantineRoot = path.join(CUSTOMER_GIT_METADATA_ROOT, "quarantine", identity.slug);
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const quarantine = path.join(
    quarantineRoot,
    `${path.basename(identity.metadataDir)}-${randomUUID()}`,
  );
  fs.renameSync(source, quarantine);
  const stat = fs.lstatSync(quarantine);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const stack = [quarantine];
    while (stack.length > 0) {
      const current = stack.pop()!;
      fs.chmodSync(current, 0o700);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        const childStat = fs.lstatSync(child);
        if (childStat.isSymbolicLink()) continue;
        if (childStat.isDirectory()) stack.push(child);
        else fs.chmodSync(child, 0o600);
      }
    }
  } else {
    fs.chmodSync(quarantine, 0o600);
  }
}

function customerGitEnvironmentForRefresh(
  slug: string,
  githubToken?: string | null,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedGitProcessEnvironment(),
    ...githubCloneCredentialEnv(githubToken),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: DISABLED_EXECUTABLE,
    SSH_ASKPASS: DISABLED_EXECUTABLE,
    GIT_EDITOR: DISABLED_EXECUTABLE,
    GIT_SEQUENCE_EDITOR: DISABLED_EXECUTABLE,
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_SSH_COMMAND: `/usr/bin/ssh -i "${customerSshKeyPath(slug)}" -F /home/node/.ssh/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`,
  };
}

function runFreshCustomerGit(
  repoDir: string,
  gitDir: string,
  slug: string,
  argv: string[],
  githubToken?: string | null,
): string {
  return execFileSync(
    GIT_BINARY,
    [
      ...gitHardeningArgs(),
      ...githubCredentialArgs(githubToken),
      "--git-dir",
      gitDir,
      "--work-tree",
      repoDir,
      ...argv,
    ],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: customerGitEnvironmentForRefresh(slug, githubToken),
    },
  ).trim();
}

function initializeFreshCustomerGit(
  repoDir: string,
  identity: CustomerGitIdentity,
  deps: CustomerGitRefreshDeps,
): void {
  const source = canonicalCustomerGitSource(identity, deps);
  const staging = `${identity.metadataDir}.octogee-new-${randomUUID()}`;
  fs.mkdirSync(path.dirname(identity.metadataDir), { recursive: true, mode: 0o700 });
  try {
    execFileSync(
      GIT_BINARY,
      ["init", "--bare", "--initial-branch=main", staging],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: customerGitEnvironmentForRefresh(identity.slug, deps.githubToken),
      },
    );
    writeCanonicalGitConfig(staging, identity.slug, source);
    if (deps.fetchCanonical) deps.fetchCanonical(repoDir, staging);
    else runFreshCustomerGit(repoDir, staging, identity.slug, [
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ], deps.githubToken);
    const remoteMain = runFreshCustomerGit(
      repoDir,
      staging,
      identity.slug,
      ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"],
      deps.githubToken,
    );
    runFreshCustomerGit(
      repoDir,
      staging,
      identity.slug,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      deps.githubToken,
    );
    if (remoteMain) {
      runFreshCustomerGit(
        repoDir,
        staging,
        identity.slug,
        ["update-ref", "refs/heads/main", remoteMain],
        deps.githubToken,
      );
      runFreshCustomerGit(
        repoDir,
        staging,
        identity.slug,
        ["read-tree", "refs/heads/main"],
        deps.githubToken,
      );
    } else {
      runFreshCustomerGit(
        repoDir,
        staging,
        identity.slug,
        ["read-tree", "--empty"],
        deps.githubToken,
      );
    }
    fs.renameSync(staging, identity.metadataDir);
    const receipt = customerGitTrustReceipt(identity.metadataDir);
    const receiptTmp = `${receipt}.octogee.tmp`;
    fs.writeFileSync(receiptTmp, `${CUSTOMER_GIT_TRUST_RECEIPT_VERSION}\n${sourceReceiptValue(source)}\n`, { encoding: "utf8", mode: 0o400 });
    fs.renameSync(receiptTmp, receipt);
    fs.rmSync(customerGitRefreshMarker(identity.metadataDir), { force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function trustedCustomerGitSource(identity: CustomerGitIdentity): CanonicalCustomerGitSource | null {
  const receipt = customerGitTrustReceipt(identity.metadataDir);
  try {
    const targetStat = fs.lstatSync(identity.metadataDir);
    const receiptStat = fs.lstatSync(receipt);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()
      || !receiptStat.isFile() || receiptStat.isSymbolicLink()) return null;
    return sourceFromReceipt(identity, fs.readFileSync(receipt, "utf8"));
  } catch {
    return null;
  }
}

export function customerRepositoryHasCanonicalRemote(repoDir: string): boolean {
  const identity = customerGitIdentity(repoDir);
  if (!identity) return false;
  const source = trustedCustomerGitSource(identity);
  if (!source) return false;
  const localGit = path.join(repoDir, ".git");
  const configPath = path.join(identity.metadataDir, "config");
  try {
    const localGitStat = fs.lstatSync(localGit);
    const configStat = fs.lstatSync(configPath);
    if (!localGitStat.isFile() || localGitStat.isSymbolicLink()
      || !configStat.isFile() || configStat.isSymbolicLink()) return false;
    if (fs.readFileSync(localGit, "utf8") !== `gitdir: ${identity.metadataDir}\n`) return false;
    const remoteUrl = execFileSync(
      GIT_BINARY,
      ["config", "--file", configPath, "--get", "remote.origin.url"],
      {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    ).trim();
    return remoteUrl === source.remoteUrl;
  } catch {
    return false;
  }
}

export function externalizeCustomerGitDir(
  repoDir: string,
  deps: CustomerGitRefreshDeps = {},
): string | null {
  const identity = customerGitIdentity(repoDir);
  if (!identity) return null;
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const target = identity.metadataDir;
  const localGit = path.join(repoDir, ".git");
  const expectedSource = canonicalCustomerGitSource(identity, deps);
  const trustedSource = trustedCustomerGitSource(identity);
  if (!trustedSource || sourceReceiptValue(trustedSource) !== sourceReceiptValue(expectedSource)) {
    const refreshMarker = customerGitRefreshMarker(target);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const refreshMarkerTmp = `${refreshMarker}.octogee-${randomUUID()}`;
    fs.writeFileSync(refreshMarkerTmp, `${CUSTOMER_GIT_TRUST_RECEIPT_VERSION}\n`, { encoding: "utf8", mode: 0o400 });
    fs.renameSync(refreshMarkerTmp, refreshMarker);
    quarantineCustomerGitEntry(target, identity);
    quarantineCustomerGitEntry(customerGitTrustReceipt(target), identity);
    quarantineCustomerGitEntry(localGit, identity);
    initializeFreshCustomerGit(repoDir, identity, deps);
  }
  fs.rmSync(customerGitRefreshMarker(target), { force: true });
  const pointer = `gitdir: ${target}\n`;
  const pointerTmp = `${localGit}.octogee.tmp`;
  fs.writeFileSync(pointerTmp, pointer, { encoding: "utf8", mode: 0o444 });
  fs.renameSync(pointerTmp, localGit);
  return target;
}

function trustedGitDir(cwd: string): string | null {
  const customerMetadata = customerGitMetadataDir(cwd);
  if (customerMetadata) return customerMetadata;
  const localGit = path.join(cwd, ".git");
  try {
    const stat = fs.lstatSync(localGit);
    return stat.isDirectory() && !stat.isSymbolicLink() ? localGit : null;
  } catch {
    return null;
  }
}

function repositoryMetadataExists(repoDir: string): boolean {
  const customerMetadata = customerGitMetadataDir(repoDir);
  const candidates = [
    customerMetadata,
    ...(customerMetadata ? [customerGitRefreshMarker(customerMetadata)] : []),
    path.join(repoDir, ".git"),
  ]
    .filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function projectCheckoutMatchesSource(
  slug: string,
  projectSlug: string,
  giteaRepoName: string,
  repoSource?: ProjectRepoSource | null,
): boolean {
  const repoDir = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);
  if (!repositoryMetadataExists(repoDir)) return false;
  const identity = customerGitIdentity(repoDir);
  if (!identity) return false;
  const current = trustedCustomerGitSource(identity);
  if (!current) return false;
  const expected = canonicalCustomerGitSource(identity, { giteaRepoName, repoSource });
  return sourceReceiptValue(current) === sourceReceiptValue(expected);
}

export function removePersistedRepoSshCommand(repoDir: string): void {
  const gitDir = trustedGitDir(repoDir);
  if (!gitDir) return;
  try {
    execFileSync(
      GIT_BINARY,
      ["config", "--file", path.join(gitDir, "config"), "--unset-all", "core.sshCommand"],
      { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch (error) {
    if (execErrCode(error) !== 5) {
      log(`⚠ [git] failed to remove persisted core.sshCommand in ${repoDir}`);
    }
  }
}

export function generateCustomerSshKey(slug: string): string {
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    log(`[git] SSH key already exists for ${slug}`);
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(keyDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  /* eslint-disable sonarjs/file-permissions -- restrictive (private key dir), correct */
  fs.chmodSync(keyDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);
  /* eslint-enable sonarjs/file-permissions */

  log(`[git] SSH keypair generated for ${slug}`);
  return fs.readFileSync(pubPath, "utf-8").trim();
}

export async function readGiteaCustomerPubKeys(slug: string): Promise<string[]> {
  return giteaBroker.readGiteaUserPubKeys(slug);
}

export async function deleteCustomerSshKey(slug: string): Promise<void> {
  const keyDir = path.join(CUSTOMER_KEYS_DIR, slug);
  await fs.promises.rm(keyDir, { recursive: true, force: true });
}

export function readLocalCustomerPubKey(slug: string): string | null {
  const pubPath = path.join(CUSTOMER_KEYS_DIR, slug, "id_ed25519.pub");
  try {
    return fs.readFileSync(pubPath, "utf-8").trim();
  } catch {
    return null;
  }
}

export interface LocalCustomerPubKey {
  slug: string;
  pubKey: string;
}

export function listLocalCustomerPubKeys(): LocalCustomerPubKey[] {
  if (!fs.existsSync(CUSTOMER_KEYS_DIR)) return [];
  return fs.readdirSync(CUSTOMER_KEYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pubKey = readLocalCustomerPubKey(entry.name);
      if (pubKey === null) {
        throw new Error(`[git] local SSH public key is missing for ${entry.name}`);
      }
      return { slug: entry.name, pubKey };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Ensures the per-customer Gitea user exists and its SSH key is registered.
// The admin work happens in the gateway-edge sidecar; this is the provisioner's
// thin call into it. Throws (loud) on failure — the mount retries.
export async function createGiteaUser(slug: string, pubKey: string): Promise<void> {
  await giteaBroker.ensureGiteaUser(slug, pubKey);
}

function sshRemoteUrl(org: string, repoName: string): string {
  return `git@${GIT_SSH_HOST}:${org}/${repoName}.git`;
}

function githubHttpsRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function gitExec(
  cwd: string,
  argv: string[],
  sshKeyPath?: string,
  githubToken?: string | null,
): string | null {
  try {
    const command = argv[0];
    if (command !== "config" && command !== "init" && command !== "clone") {
      const unsafeConfigKey = unsafeLocalRepositoryConfigKey(cwd);
      if (unsafeConfigKey) {
        log(`⚠ [git] refusing repository with unsafe local config: ${unsafeConfigKey}`);
        return null;
      }
    }
    const env: Record<string, string | undefined> = {
      ...sanitizedGitProcessEnvironment(),
      ...githubCloneCredentialEnv(githubToken),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: DISABLED_EXECUTABLE,
      SSH_ASKPASS: DISABLED_EXECUTABLE,
      GIT_EDITOR: DISABLED_EXECUTABLE,
      GIT_SEQUENCE_EDITOR: DISABLED_EXECUTABLE,
      GIT_PAGER: "cat",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const customerIdentity = customerGitIdentity(cwd);
    const effectiveSshKeyPath = sshKeyPath ?? (
      customerIdentity ? customerSshKeyPath(customerIdentity.slug) : undefined
    );
    if (effectiveSshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${effectiveSshKeyPath}" -F /home/node/.ssh/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    }
    const gitDir = trustedGitDir(cwd);
    const repositoryArgs = gitDir && !["config", "init", "clone"].includes(command ?? "")
      ? ["--git-dir", gitDir, "--work-tree", cwd]
      : [];
    return execFileSync(GIT_BINARY, [
      ...gitHardeningArgs(),
      ...githubCredentialArgs(githubToken),
      ...repositoryArgs,
      ...argv,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }).trim();
  } catch (err: unknown) {
    const detail =
      [execErrStderr(err), execErrStdout(err)].filter(Boolean).join(" | ") || errMessage(err);
    const code = execErrCode(err);
    const safeArgs = argv.join(" ").replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    const safeDetail = detail.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");
    log(`⚠ [git] exec failed: git ${safeArgs} → code=${code ?? "?"} ${safeDetail}`);
    return null;
  }
}

const GIT_HARDENING_ARGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", `gpg.program=${DISABLED_EXECUTABLE}`,
  "-c", "protocol.allow=never",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
] as const;

function gitHardeningArgs(): string[] {
  return [...GIT_HARDENING_ARGS];
}

const UNSAFE_LOCAL_CONFIG_PREFIXES = [
  "alias.", "credential.", "diff.", "filter.", "http.", "https.",
  "include.", "includeif.", "merge.", "protocol.", "url.",
];
const UNSAFE_LOCAL_CONFIG_KEYS = new Set([
  "core.askpass", "core.editor", "core.fsmonitor", "core.gitproxy",
  "core.hookspath", "core.pager", "core.sshcommand", "core.worktree",
  "extensions.worktreeconfig", "gpg.program", "sequence.editor", "ssh.variant",
]);

function isUnsafeLocalConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return UNSAFE_LOCAL_CONFIG_KEYS.has(normalized)
    || UNSAFE_LOCAL_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function unsafeLocalRepositoryConfigKey(cwd: string): string | null {
  const gitDir = trustedGitDir(cwd);
  if (!gitDir) return null;
  const configPath = path.join(gitDir, "config");
  if (!fs.existsSync(configPath)) return null;
  try {
    const output = execFileSync(
      GIT_BINARY,
      ["config", "--file", configPath, "--null", "--name-only", "--list"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return output.split("\0").find(isUnsafeLocalConfigKey) ?? null;
  } catch {
    return "<malformed>";
  }
}

// Workspace + project clones run over the per-customer SSH key. The key is
// registered (createGiteaUser) before any clone in the mount flow, so there is
// no admin-token HTTP fallback: a missing key is a loud failure the reconcile
// heals by regenerating + re-registering. Repo existence is checked through the
// admin broker (no admin token on this container).
export interface WorkspaceTreeState {
  tracked: number;
  missing: number;
}

export function workspaceTreeState(repoDir: string): WorkspaceTreeState | null {
  const listed = gitExec(repoDir, ["ls-files", "-z"]);
  if (listed === null) return null;
  const tracked = listed.split("\0").filter((entry) => entry.length > 0);
  let missing = 0;
  for (const entry of tracked) {
    try {
      fs.lstatSync(path.join(repoDir, entry));
    } catch {
      missing += 1;
    }
  }
  return { tracked: tracked.length, missing };
}

function restoreEmptiedWorkspaceTree(dest: string, slug: string): boolean | null {
  const state = workspaceTreeState(dest);
  if (state === null) {
    log(`⚠ [git] ${slug} workspace has git metadata that git cannot read — refusing to treat it as cloned`);
    return null;
  }
  if (state.tracked === 0 || state.missing < state.tracked) return false;
  if (gitExec(dest, ["checkout", "--", "."]) === null) {
    log(`⚠ [git] ${slug} workspace tree is empty and could not be restored from its checkout`);
    return null;
  }
  log(`[git] ${slug} workspace tree was empty — restored ${state.tracked} tracked file(s) from the checkout`);
  return true;
}

export async function cloneWorkspaceRepo(slug: string, _repoUrl?: string): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug);

  if (repositoryMetadataExists(dest)) {
    if (restoreEmptiedWorkspaceTree(dest, slug) === null) return false;
    setRepoSshCommand(dest, slug);
    return true;
  }

  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  const sshKey = customerSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug} — per-customer SSH key missing (registered before clone in the mount flow)`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await giteaBroker.repoExists(org, repoName);
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${repoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Repo ${org}/${repoName} not found on Gitea — skipping clone`);
    return false;
  }

  const result = gitExec(path.dirname(dest), ["clone", sshRemoteUrl(org, repoName), slug], sshKey);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${slug}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return false;
  }

  gitExec(dest, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dest, ["config", "user.name", `Octo (${slug})`]);

  setRepoSshCommand(dest, slug);

  log(`[git] ✅ Cloned ${org}/${repoName} → customers/${slug}/`);
  return true;
}

export interface CloneProjectRepoOptions {
  repoSource?: ProjectRepoSource | null;
  githubToken?: string | null;
  gitExec?: GitRunner;
  prepareRepository?: typeof setRepoSshCommand;
  acquireMutationLease?: typeof acquireWorkspaceMutationLeaseSync;
}

export async function cloneProjectRepo(
  slug: string,
  projectSlug: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions = {},
): Promise<boolean> {
  const dest = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);

  if (repositoryMetadataExists(dest)) {
    if (!existingProjectGitDir(dest)) {
      return restoreMissingProjectGitMetadata(slug, projectSlug, dest, giteaRepoName, opts);
    }
    if (!projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)) {
      if (githubCloneIsBrokered(opts.repoSource, opts.githubToken)) {
        return switchProjectCheckoutViaBroker(slug, projectSlug, dest, opts.repoSource!, opts);
      }
      return replaceProjectRepoCheckout(slug, projectSlug, dest, giteaRepoName, opts);
    }
    setRepoSshCommand(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    });
    return projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
      && customerRepositoryHasCanonicalRemote(dest);
  }

  if (opts.repoSource?.provider === "github") {
    return cloneGithubProjectRepo(
      slug,
      projectSlug,
      dest,
      opts.repoSource,
      opts.githubToken,
      opts.gitExec ?? gitExec,
      opts.prepareRepository ?? setRepoSshCommand,
    );
  }
  return cloneGiteaProjectRepo(
    slug,
    projectSlug,
    dest,
    giteaRepoName,
    opts.gitExec ?? gitExec,
    opts.prepareRepository ?? setRepoSshCommand,
  );
}

function restoreMissingProjectGitMetadata(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions,
): boolean {
  try {
    (opts.prepareRepository ?? setRepoSshCommand)(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    });
  } catch (error) {
    log(`⚠ [git] Cannot restore ${slug}/${projectSlug} metadata: ${errMessage(error)}`);
    return false;
  }
  if (
    !projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
    || !customerRepositoryHasCanonicalRemote(dest)
  ) {
    log(`⚠ [git] Cannot restore ${slug}/${projectSlug} metadata — canonical source verification failed`);
    return false;
  }
  log(`[git] ✅ Restored ${slug}/${projectSlug} canonical metadata`);
  return true;
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- source switching is a rollback-capable filesystem state machine
async function replaceProjectRepoCheckout(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  opts: CloneProjectRepoOptions,
): Promise<boolean> {
  const runGit = opts.gitExec ?? gitExec;
  const source = opts.repoSource?.provider === "github"
    ? githubSource(opts.repoSource)
    : giteaSource(slug, giteaRepoName);
  const sshKey = source.kind === "gitea" ? customerSshKeyPath(slug) : undefined;
  if (source.kind === "gitea") {
    if (!fs.existsSync(sshKey!)) {
      log(`⚠ [git] Cannot switch ${slug}/${projectSlug} — per-customer SSH key missing`);
      return false;
    }
    if (!(await giteaBroker.repoExists(workspaceGiteaOrg(slug), giteaRepoName))) return false;
  }

  const parent = path.dirname(dest);
  const staging = fs.mkdtempSync(path.join(parent, `.${projectSlug}-source-`));
  const clone = runGit(
    parent,
    ["clone", source.remoteUrl, staging],
    sshKey,
    opts.githubToken,
  );
  if (clone === null) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }

  const gitDir = existingProjectGitDir(dest);
  if (!gitDir) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`⚠ [git] Cannot switch ${slug}/${projectSlug} — git metadata is missing`);
    return false;
  }
  let lease: ReturnType<typeof acquireWorkspaceMutationLeaseSync>;
  try {
    lease = acquireProjectSourceSwitchLease(
      opts.acquireMutationLease ?? acquireWorkspaceMutationLeaseSync,
      dest,
      slug,
      projectSlug,
    );
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`⚠ [git] Cannot lease ${slug}/${projectSlug}: ${errMessage(error)}`);
    return false;
  }
  if (!lease) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
  const quarantineRoot = path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug);
  const quarantine = path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`);
  const metadataBackupRoot = path.join(
    OPENCLAW_DIR,
    "git-metadata-source-switch-backups",
    slug,
    `${projectSlug}-${randomUUID()}`,
  );
  const identity = customerGitIdentity(dest);
  const metadataBackups: Array<{ original: string; backup: string }> = [];
  let previousMoved = false;
  let replacementInstalled = false;
  try {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(metadataBackupRoot, { recursive: true, mode: 0o700 });
    if (identity) {
      for (const original of [
        identity.metadataDir,
        customerGitTrustReceipt(identity.metadataDir),
        customerGitRefreshMarker(identity.metadataDir),
      ]) {
        if (!fs.existsSync(original)) continue;
        const backup = path.join(metadataBackupRoot, path.basename(original));
        fs.renameSync(original, backup);
        metadataBackups.push({ original, backup });
      }
    }
    fs.renameSync(dest, quarantine);
    previousMoved = true;
    fs.renameSync(staging, dest);
    replacementInstalled = true;
    (opts.prepareRepository ?? setRepoSshCommand)(dest, slug, {
      repoSource: opts.repoSource,
      giteaRepoName,
      githubToken: opts.githubToken,
    });
    if (
      !projectCheckoutMatchesSource(slug, projectSlug, giteaRepoName, opts.repoSource)
      || !customerRepositoryHasCanonicalRemote(dest)
    ) {
      throw new Error("replacement repository source was not prepared canonically");
    }
    log(`[git] ✅ Switched ${slug}/${projectSlug} to ${sourceReceiptValue(source)}`);
    return true;
  } catch (error) {
    if (replacementInstalled && fs.existsSync(dest)) {
      try {
        fs.renameSync(dest, path.join(quarantineRoot, `${projectSlug}-failed-${randomUUID()}`));
      } catch (rollbackError) {
        log(`⚠ [git] Failed to quarantine replacement for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
      }
    }
    if (identity) {
      for (const current of [
        identity.metadataDir,
        customerGitTrustReceipt(identity.metadataDir),
        customerGitRefreshMarker(identity.metadataDir),
      ]) {
        try {
          quarantineCustomerGitEntry(current, identity);
        } catch (rollbackError) {
          log(`⚠ [git] Failed to quarantine replacement metadata for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
        }
      }
      for (const { original, backup } of metadataBackups) {
        try {
          // eslint-disable-next-line max-depth -- each rollback artifact is restored independently after a failed source switch
          if (fs.existsSync(backup)) fs.renameSync(backup, original);
        } catch (rollbackError) {
          log(`⚠ [git] Failed to restore prior metadata for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
        }
      }
    }
    if (previousMoved && !fs.existsSync(dest) && fs.existsSync(quarantine)) {
      try {
        fs.renameSync(quarantine, dest);
      } catch (rollbackError) {
        log(`⚠ [git] Failed to restore prior checkout for ${slug}/${projectSlug}: ${errMessage(rollbackError)}`);
      }
    }
    log(`⚠ [git] Failed to switch ${slug}/${projectSlug}: ${errMessage(error)}`);
    return false;
  } finally {
    lease.release();
  }
}

function acquireProjectSourceSwitchLease(
  acquire: typeof acquireWorkspaceMutationLeaseSync,
  dest: string,
  slug: string,
  projectSlug: string,
): ReturnType<typeof acquireWorkspaceMutationLeaseSync> {
  const stableGitDir = path.join(
    OPENCLAW_DIR,
    "git-source-switch-locks",
    slug,
    `${projectSlug}.git`,
  );
  fs.mkdirSync(stableGitDir, { recursive: true, mode: 0o700 });
  return acquire({ workspaceDir: dest, gitDir: stableGitDir });
}

function existingProjectGitDir(repoDir: string): string | null {
  const external = customerGitMetadataDir(repoDir);
  const candidates = [external, path.join(repoDir, ".git")]
    .filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// eslint-disable-next-line max-params -- clone dependencies remain explicit to preserve credential and metadata boundaries
async function cloneGiteaProjectRepo(
  slug: string,
  projectSlug: string,
  dest: string,
  giteaRepoName: string,
  runGit: GitRunner,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  const org = workspaceGiteaOrg(slug);
  const sshKey = customerSshKeyPath(slug);
  if (!fs.existsSync(sshKey)) {
    log(`⚠ [git] Cannot clone ${slug}/${projectSlug} — per-customer SSH key missing`);
    return false;
  }

  let exists: boolean;
  try {
    exists = await giteaBroker.repoExists(org, giteaRepoName);
  } catch (err: unknown) {
    log(`⚠ [git] Gitea repo-exists check failed for ${org}/${giteaRepoName}: ${errMessage(err)}`);
    return false;
  }
  if (!exists) {
    log(`[git] Project repo ${org}/${giteaRepoName} not found on Gitea — skipping clone`);
    return false;
  }

  const cloned = checkoutProjectRepo({
    dest,
    projectSlug,
    label: `${slug}/${projectSlug}`,
    remoteUrl: sshRemoteUrl(org, giteaRepoName),
    sshKey,
    runGit,
  });
  if (!cloned) return false;

  setProjectCommitIdentity(dest, slug, runGit);
  prepareRepository(dest, slug, { giteaRepoName });

  log(`[git] ✅ Cloned ${org}/${giteaRepoName} → customers/${slug}/projects/${projectSlug}/`);
  return true;
}

function githubCloneIsBrokered(
  repoSource: ProjectRepoSource | null | undefined,
  githubToken: string | null | undefined,
): boolean {
  return repoSource?.provider === "github" && !githubToken && Boolean(process.env.GATEWAY_EDGE_INTERNAL_URL);
}

function localCloneOriginUrl(gitDir: string): string | null {
  try {
    return execFileSync(
      GIT_BINARY,
      ["config", "--file", path.join(gitDir, "config"), "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

// The edge broker leaves a plain clone (its own .git directory, no canonical metadata or
// trust receipt), so the next probe would not recognise it as this project's source. Set the
// broker's .git aside, let the externalizer build fresh canonical metadata from it — the
// provisioner holds no GitHub credential, so the canonical remote cannot be fetched here —
// and verify the checkout the same way a direct clone is verified.
async function cloneGithubProjectViaBrokerCanonically(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  const label = `${slug}/${projectSlug}`;
  try {
    if (!(await cloneGithubProjectViaBroker(slug, projectSlug))) return false;
  } catch (error) {
    log(`⚠ [git] GitHub project clone broker failed for ${label}: ${errMessage(error)}`);
    return false;
  }
  const localGit = path.join(dest, ".git");
  let localGitStat: fs.Stats;
  try {
    localGitStat = fs.lstatSync(localGit);
  } catch (error) {
    log(`⚠ [git] brokered GitHub checkout for ${label} has no git metadata: ${errMessage(error)}`);
    return false;
  }
  if (!localGitStat.isDirectory() || localGitStat.isSymbolicLink()) {
    if (projectCheckoutMatchesSource(slug, projectSlug, "", repoSource) && customerRepositoryHasCanonicalRemote(dest)) {
      return true;
    }
    log(`⚠ [git] brokered GitHub checkout for ${label} carries metadata that does not verify`);
    return false;
  }
  const expectedRemote = githubHttpsRemoteUrl(repoSource.owner, repoSource.repo);
  const actualRemote = localCloneOriginUrl(localGit);
  if (actualRemote !== expectedRemote) {
    log(`⚠ [git] brokered GitHub checkout for ${label} points at ${actualRemote ?? "no remote"}, expected ${expectedRemote}`);
    return false;
  }
  const sideline = path.join(path.dirname(dest), `.${projectSlug}-brokered-git-${randomUUID()}`);
  fs.renameSync(localGit, sideline);
  try {
    prepareRepository(dest, slug, {
      repoSource,
      fetchCanonical: (_worktree, gitDir) => {
        execFileSync(
          GIT_BINARY,
          [
            ...gitHardeningArgs(),
            "-c",
            "protocol.file.allow=always",
            "--git-dir",
            gitDir,
            "fetch",
            "--quiet",
            sideline,
            "+refs/heads/*:refs/remotes/origin/*",
          ],
          { cwd: dest, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: customerGitEnvironmentForRefresh(slug) },
        );
      },
    });
  } catch (error) {
    fs.rmSync(localGit, { recursive: true, force: true });
    fs.renameSync(sideline, localGit);
    log(`⚠ [git] brokered GitHub checkout for ${label} could not be prepared canonically: ${errMessage(error)}`);
    return false;
  }
  fs.rmSync(sideline, { recursive: true, force: true });
  if (!projectCheckoutMatchesSource(slug, projectSlug, "", repoSource) || !customerRepositoryHasCanonicalRemote(dest)) {
    log(`⚠ [git] brokered GitHub checkout for ${label} did not verify against its canonical source`);
    return false;
  }
  log(`[git] ✅ Cloned ${repoSource.owner}/${repoSource.repo} → customers/${slug}/projects/${projectSlug}/ via the edge broker`);
  return true;
}

async function switchProjectCheckoutViaBroker(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  opts: CloneProjectRepoOptions,
): Promise<boolean> {
  const label = `${slug}/${projectSlug}`;
  let lease: ReturnType<typeof acquireWorkspaceMutationLeaseSync>;
  try {
    lease = acquireProjectSourceSwitchLease(
      opts.acquireMutationLease ?? acquireWorkspaceMutationLeaseSync,
      dest,
      slug,
      projectSlug,
    );
  } catch (error) {
    log(`⚠ [git] Cannot lease ${label}: ${errMessage(error)}`);
    return false;
  }
  if (!lease) return false;
  const quarantineRoot = path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug);
  const quarantine = path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`);
  const identity = customerGitIdentity(dest);
  try {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    if (identity) {
      for (const entry of [
        identity.metadataDir,
        customerGitTrustReceipt(identity.metadataDir),
        customerGitRefreshMarker(identity.metadataDir),
      ]) {
        quarantineCustomerGitEntry(entry, identity);
      }
    }
    fs.renameSync(dest, quarantine);
  } catch (error) {
    log(`⚠ [git] Cannot set aside ${label} before the brokered clone: ${errMessage(error)}`);
    return false;
  } finally {
    lease.release();
  }
  log(`[git] ${label} checkout did not match its GitHub source — set aside at ${quarantine}; cloning via the edge broker`);
  return cloneGithubProjectViaBrokerCanonically(
    slug,
    projectSlug,
    dest,
    repoSource,
    opts.prepareRepository ?? setRepoSshCommand,
  );
}

// eslint-disable-next-line max-params -- clone dependencies remain explicit to preserve credential and metadata boundaries
async function cloneGithubProjectRepo(
  slug: string,
  projectSlug: string,
  dest: string,
  repoSource: ProjectRepoSource,
  githubToken: string | null | undefined,
  runGit: GitRunner,
  prepareRepository: typeof setRepoSshCommand,
): Promise<boolean> {
  if (githubCloneIsBrokered(repoSource, githubToken)) {
    return cloneGithubProjectViaBrokerCanonically(slug, projectSlug, dest, repoSource, prepareRepository);
  }
  const remoteUrl = githubHttpsRemoteUrl(repoSource.owner, repoSource.repo);
  const cloned = checkoutProjectRepo({
    dest,
    projectSlug,
    label: `${slug}/${projectSlug}`,
    remoteUrl,
    githubToken,
    runGit,
    replaceExisting: true,
    quarantineRoot: path.join(OPENCLAW_DIR, "git-worktree-quarantine", slug),
  });
  if (!cloned) return false;

  setProjectCommitIdentity(dest, slug, runGit);
  prepareRepository(dest, slug, { repoSource, githubToken });

  log(
    `[git] ✅ Cloned ${repoSource.owner}/${repoSource.repo} → customers/${slug}/projects/${projectSlug}/`,
  );
  return true;
}

const GITHUB_CLONE_TOKEN_ENV = "OCTOGEE_GITHUB_CLONE_TOKEN";

function sanitizedGitProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key === "GH_TOKEN"
      || key === "GITHUB_TOKEN"
      || key === "GH_ENTERPRISE_TOKEN"
      || key === "GITHUB_ENTERPRISE_TOKEN"
      || key === GITHUB_CLONE_TOKEN_ENV
      || key === "GIT_CONFIG"
      || key === "GIT_CONFIG_COUNT"
      || key === "GIT_CONFIG_PARAMETERS"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export function githubCloneCredentialEnv(
  token: string | null | undefined,
): Record<string, string> | undefined {
  if (!token) return undefined;
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1:
      `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' ` +
      `"$${GITHUB_CLONE_TOKEN_ENV}"; }; f`,
    [GITHUB_CLONE_TOKEN_ENV]: token,
  };
}

function githubCredentialArgs(token: string | null | undefined): string[] {
  if (!token) return [];
  return [
    "-c",
    "credential.https://github.com.helper=!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$OCTOGEE_GITHUB_CLONE_TOKEN\"; }; f",
  ];
}

function setProjectCommitIdentity(dest: string, slug: string, runGit: GitRunner): void {
  runGit(dest, ["config", "user.email", `${slug}@octogee.com`]);
  runGit(dest, ["config", "user.name", `Octo (${slug})`]);
}

interface ProjectCheckout {
  dest: string;
  projectSlug: string;
  label: string;
  remoteUrl: string;
  sshKey?: string;
  githubToken?: string | null;
  runGit: GitRunner;
  replaceExisting?: boolean;
  quarantineRoot?: string;
}

function checkoutProjectRepo(checkout: ProjectCheckout): boolean {
  const {
    dest,
    projectSlug,
    label,
    remoteUrl,
    sshKey,
    githubToken,
    runGit,
    replaceExisting,
    quarantineRoot,
  } = checkout;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const cloneDir = fs.existsSync(dest)
    ? fs.mkdtempSync(path.join(parent, `.${projectSlug}-clone-`))
    : dest;

  const result = runGit(parent, ["clone", remoteUrl, cloneDir], sshKey, githubToken);
  if (result === null) {
    log(`⚠ [git] Clone failed for ${label}`);
    fs.rmSync(cloneDir, { recursive: true, force: true });
    return false;
  }

  if (cloneDir !== dest) {
    try {
      if (replaceExisting) {
        if (!quarantineRoot) throw new Error("missing project checkout quarantine root");
        const lease = repositoryMetadataExists(dest)
          ? acquireWorkspaceMutationLeaseSync({ workspaceDir: dest })
          : null;
        if (repositoryMetadataExists(dest) && !lease) {
          throw new Error("workspace mutation lease unavailable");
        }
        try {
          fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
          fs.renameSync(dest, path.join(quarantineRoot, `${projectSlug}-${randomUUID()}`));
          fs.renameSync(cloneDir, dest);
        } finally {
          lease?.release();
        }
      } else {
        adoptProjectClone(cloneDir, dest);
      }
    } catch (err) {
      log(`⚠ [git] Failed to adopt clone for ${label}: ${errMessage(err)}`);
      fs.rmSync(cloneDir, { recursive: true, force: true });
      return false;
    }
  }
  return true;
}

function copyMissingCloneTree(source: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(dest, entry.name);
    const destEntry = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (!destEntry) {
      fs.cpSync(sourcePath, destPath, { recursive: true, preserveTimestamps: true });
      continue;
    }
    if (destEntry.isSymbolicLink()) {
      throw new Error(`cannot adopt checkout over symbolic link: ${destPath}`);
    }
    if (!destEntry.isDirectory() && !destEntry.isFile()) {
      throw new Error(`cannot adopt checkout over special filesystem entry: ${destPath}`);
    }
    if (entry.isDirectory() && destEntry.isDirectory()) {
      copyMissingCloneTree(sourcePath, destPath);
    }
  }
}

export function adoptProjectClone(cloneDir: string, dest: string): void {
  copyMissingCloneTree(cloneDir, dest);
  fs.renameSync(path.join(cloneDir, ".git"), path.join(dest, ".git"));
  fs.rmSync(cloneDir, { recursive: true, force: true });
}

interface InitWorkspaceRepoDeps {
  ensureWorkspaceRepo: (slug: string) => Promise<void>;
  prepareRepository: (repoDir: string, slug: string) => void;
  workspaceRemoteUrl?: (slug: string) => string;
}

function runWorkspaceBootstrapGit(
  coachDir: string,
  gitDir: string,
  slug: string,
  argv: string[],
): string | null {
  try {
    return execFileSync(GIT_BINARY, [
      ...gitHardeningArgs(),
      "-c",
      "protocol.file.allow=always",
      "--git-dir",
      gitDir,
      "--work-tree",
      coachDir,
      ...argv,
    ], {
      cwd: coachDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: customerGitEnvironmentForRefresh(slug),
    }).trim();
  } catch (err: unknown) {
    const detail =
      [execErrStderr(err), execErrStdout(err)].filter(Boolean).join(" | ") || errMessage(err);
    log(`⚠ [git] workspace bootstrap failed: git ${argv.join(" ")} → ${detail}`);
    return null;
  }
}

function pushWorkspaceBootstrap(
  coachDir: string,
  slug: string,
  originUrl: string,
): boolean {
  if (!SAFE_GIT_IDENTITY_RE.test(slug)) return false;
  const bootstrapRoot = path.join(OPENCLAW_DIR, "git-bootstrap");
  fs.mkdirSync(bootstrapRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = fs.mkdtempSync(path.join(bootstrapRoot, `${slug}-`));
  const gitDir = path.join(stagingRoot, "workspace.git");
  try {
    execFileSync(GIT_BINARY, ["init", "--bare", "--initial-branch=main", gitDir], {
      cwd: coachDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: customerGitEnvironmentForRefresh(slug),
    });
    const run = (argv: string[]) => runWorkspaceBootstrapGit(coachDir, gitDir, slug, argv);
    if (run(["config", "user.email", `${slug}@octogee.com`]) === null) return false;
    if (run(["config", "user.name", `Octo (${slug})`]) === null) return false;
    if (run(["remote", "add", "origin", originUrl]) === null) return false;
    const remoteMain = run(["ls-remote", "--heads", "origin", "refs/heads/main"]);
    if (remoteMain === null) return false;
    if (remoteMain !== "") {
      log(`[git] ${slug} canonical workspace already has main`);
      return true;
    }
    if (run(["add", "-A", "--", ".", ":(exclude).git"]) === null) return false;
    if (run(["commit", "--allow-empty", "-m", "initial workspace skeleton"]) === null) {
      return false;
    }
    if (run(["push", "origin", "HEAD:refs/heads/main"]) === null) return false;
    log(`[git] ${slug} initial push: OK`);
    return true;
  } catch (err: unknown) {
    log(`⚠ [git] workspace bootstrap initialization failed for ${slug}: ${errMessage(err)}`);
    return false;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function invalidateWorkspaceGitProjection(coachDir: string): void {
  const identity = customerGitIdentity(coachDir);
  if (!identity) return;
  quarantineCustomerGitEntry(identity.metadataDir, identity);
  quarantineCustomerGitEntry(customerGitTrustReceipt(identity.metadataDir), identity);
  quarantineCustomerGitEntry(customerGitRefreshMarker(identity.metadataDir), identity);
  quarantineCustomerGitEntry(path.join(coachDir, ".git"), identity);
}

export async function initWorkspaceRepo(
  coachDir: string,
  slug: string,
  deps: InitWorkspaceRepoDeps = {
    ensureWorkspaceRepo: giteaBroker.ensureWorkspaceRepo,
    prepareRepository: setRepoSshCommand,
  },
): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();

  fs.writeFileSync(path.join(coachDir, ".gitignore"), workspaceGitignore(), "utf-8");

  const welcome = notesWelcomeSeed("this workspace");
  const welcomeDest = path.join(coachDir, welcome.relPath);
  fs.mkdirSync(path.dirname(welcomeDest), { recursive: true });
  if (!fs.existsSync(welcomeDest)) fs.writeFileSync(welcomeDest, welcome.content, "utf-8");

  try {
    await deps.ensureWorkspaceRepo(slug);
  } catch (err) {
    log(`⚠ [git] Failed to create repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = deps.workspaceRemoteUrl?.(slug) ?? sshRemoteUrl(org, repoName);
  log(`[git] Initializing repo in ${coachDir}`);
  if (!pushWorkspaceBootstrap(coachDir, slug, originUrl)) {
    log(`⚠ [git] initial workspace push failed for ${slug} — aborting repo setup`);
    return null;
  }
  invalidateWorkspaceGitProjection(coachDir);
  deps.prepareRepository(coachDir, slug);

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Workspace repo ready: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function workspaceGitignore(): string {
  return [
    "# Octogee workspace — track user-visible files, exclude system/build artifacts",
    "",
    "# System files (provisioner-managed, not user-visible)",
    "PROJECTS.md",
    "HEARTBEAT.md",
    "crew-webhooks.json",
    "_pending_*.json",
    ".byot-managed",
    ".system/",
    // openclaw's own state — `.openclaw/` is the current directory form, and
    // the root-level file is the pre-2026.7.2 one. Committing either lets a
    // mount's clone restore state openclaw has already migrated away, which
    // 2026.7.2 rejects outright ("Legacy workspace setup state requires
    // migration") on every agent turn.
    ".openclaw/",
    "openclaw-workspace-state.json",
    ".ssh/",
    "",
    "# Blob cache (provisioner-managed, synced from GCS)",
    ".blobs/",
    "",
    "# Inbound media (ephemeral, 7-day retention)",
    "media/",
    "",
    "# Project repos are their own Gitea clones — committed via their own",
    "# commit path (octogee_project_commit), never swept by workspace commits",
    "projects/",
    "",
    "# Blob manifest — server-side state in GCS beside the blobs it indexes",
    ".files/",
    "",
    "# Build artifacts",
    "node_modules/",
    "",
    "# User-visible files are tracked:",
    "# AGENTS.md, TOOLS.md, SOUL.md, USER.md, MEMORY.md, memory/*",
  ].join("\n") + "\n";
}

function projectGitignore(): string {
  return [
    "# Build artifacts",
    "node_modules/",
    ".astro/",
    "dist/",
    "",
    "# OS files",
    ".DS_Store",
  ].join("\n") + "\n";
}

export async function initProjectRepo(
  projectDir: string,
  slug: string,
  projectName: string,
  committerName = "Octogee",
  committerEmail = "octo@octogee.com",
): Promise<string | null> {
  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  fs.writeFileSync(path.join(projectDir, ".gitignore"), projectGitignore(), "utf-8");

  log(`[git] Initializing project repo: ${slug}/${projectName}`);
  gitExec(projectDir, ["init", "-b", "main"]);
  gitExec(projectDir, ["config", "user.email", committerEmail]);
  gitExec(projectDir, ["config", "user.name", committerName]);

  setRepoSshCommand(projectDir, slug);
  gitExec(projectDir, ["add", "-A"]);
  const commitResult = gitExec(projectDir, ["commit", "-m", `initial: ${projectName} project created`]);
  if (commitResult === null) {
    log(`⚠ [git] Failed to create initial commit for project ${slug}/${projectName}`);
    return null;
  }

  try {
    await giteaBroker.ensureProjectRepo(slug, projectName);
  } catch (err) {
    log(`⚠ [git] Failed to create project repo ${org}/${repoName}: ${errMessage(err)}`);
    return null;
  }

  const originUrl = sshRemoteUrl(org, repoName);
  gitExec(projectDir, ["remote", "set-url", "origin", originUrl]);
  const pushResult = gitExec(projectDir, ["push", "-u", "origin", "main"], keyArg);
  log(`[git] project push: ${pushResult !== null ? "OK" : "FAILED"}`);

  if (pushResult === null) {
    log(`⚠ [git] Failed to push project ${slug}/${projectName}`);
    return null;
  }

  const gitHost = new URL(GIT_API_URL).origin;
  const repoUrlDisplay = `${gitHost}/${org}/${repoName}`;
  log(`[git] ✅ Project repo created: ${repoUrlDisplay}`);
  return repoUrlDisplay;
}

export function pushInitialSkeleton(
  coachDir: string,
  slug: string,
  sshKeyPath?: string,
): void {
  if (gitExec(coachDir, ["status", "--porcelain"])) {
    gitExec(coachDir, ["add", "-A"]);
    if (gitExec(coachDir, ["commit", "-m", "initial workspace skeleton"]) === null) {
      log(`⚠ [git] ${slug} initial commit failed — sync will retry`);
    }
  }
  if (gitExec(coachDir, ["push", "-u", "origin", "main"], sshKeyPath) === null) {
    log(`⚠ [git] ${slug} initial push failed — sync will retry`);
  } else {
    log(`[git] ${slug} initial push: OK`);
  }
}

export async function commitAndPush(repoDir: string, message: string): Promise<boolean> {
  const relPath = path.relative(CUSTOMERS_DIR, repoDir);
  const slug = relPath.split(path.sep)[0];
  const sshKey = customerSshKeyPath(slug);
  const keyArg = fs.existsSync(sshKey) ? sshKey : undefined;

  const status = gitExec(repoDir, ["status", "--porcelain"]);
  if (!status) {
    log(`[git] commitAndPush: nothing to commit in ${repoDir}`);
    return true;
  }
  gitExec(repoDir, ["add", "-A"]);
  const commitResult = gitExec(repoDir, ["commit", "-m", message]);
  if (commitResult === null) {
    log(`⚠ [git] commitAndPush: commit failed in ${repoDir}`);
    return false;
  }
  const pushResult = gitExec(repoDir, ["push", "origin", "main"], keyArg);
  if (pushResult === null) {
    log(`⚠ [git] commitAndPush: push failed in ${repoDir}`);
    return false;
  }
  log(`[git] commitAndPush: OK in ${repoDir}`);
  return true;
}

export function listOnDiskCustomerSlugs(): string[] {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR).filter((d) => {
    try {
      return fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

type GitRunner = typeof gitExec;

export async function archiveWorkspaceRepo(slug: string): Promise<void> {
  const org = workspaceGiteaOrg(slug);
  const repoName = workspaceRepoName();
  try {
    await giteaBroker.archiveRepo(org, repoName);
    log(`[git] Archived repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive repo ${org}/${repoName}: ${errMessage(err)}`);
  }
}

export async function archiveProjectRepo(slug: string, projectName: string): Promise<void> {
  const org = workspaceGiteaOrg(slug);
  const repoName = projectRepoName(projectName);
  try {
    await giteaBroker.archiveRepo(org, repoName);
    log(`[git] Archived project repo: ${org}/${repoName}`);
  } catch (err) {
    log(`⚠ [git] Failed to archive project repo ${org}/${repoName}: ${errMessage(err)}`);
  }
}
