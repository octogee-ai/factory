import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
  isDeveloperToolchainStatus,
  parseDeveloperToolchainStatusArtifact,
  type DeveloperToolchainStatus,
  type DeveloperToolchainStatusArtifact,
} from "../../shared/types/developer-toolchain.js";

export const BUILDER_TOOLCHAIN_COMMANDS = ["claude", "codex"] as const;
export const DEFAULT_BUILDER_NPM_PROXY_REGISTRY =
  "https://us-central1-npm.pkg.dev/octogee/octogee-npm-cache/";
export const DEFAULT_BUILDER_NPM_FALLBACK_REGISTRY = "https://registry.npmjs.org/";

export type BuilderToolchainCommand = typeof BUILDER_TOOLCHAIN_COMMANDS[number];

export interface BuilderToolchainLock {
  schemaVersion: 1;
  id: "npm-lock-sha256";
  commands: Record<BuilderToolchainCommand, string>;
  versions: Record<BuilderToolchainCommand, string>;
}

export interface InstalledBuilderToolchainLock {
  schemaVersion: 1;
  lockSha256: string;
  commands: Record<BuilderToolchainCommand, string>;
}

export type BuilderToolchainStatus = DeveloperToolchainStatusArtifact;

export interface BuilderToolchainDetail {
  schemaVersion: 1;
  status: DeveloperToolchainStatus;
  toolchainId?: string;
  lockSha256?: string;
  attempt?: number;
  reasonCode?: string;
  nextRetryAt?: string;
}

export interface InstallBuilderToolchainOptions {
  cachePath: string;
  registryUrl: string;
  authToken?: string;
  npmExecutable?: string;
  signal?: AbortSignal;
}

export interface HydrateBuilderToolchainOptions {
  root: string;
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  proxyRegistryUrl?: string;
  fallbackRegistryUrl?: string;
  registryTokenProvider?: (registryUrl: string) => Promise<string>;
  installDependencies?: (
    destination: string,
    options: InstallBuilderToolchainOptions,
  ) => Promise<void>;
  attempt?: number;
  publishStatus?: (status: BuilderToolchainStatus) => Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
  nowMs?: () => number;
  lockStaleMs?: number;
  signal?: AbortSignal;
}

export interface RunBuilderToolchainHydrationLoopOptions {
  probeInteractiveReadiness: () => Promise<boolean>;
  hydrate: (attempt: number) => Promise<BuilderToolchainStatus>;
  writeStatus: (status: DeveloperToolchainStatus) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  waitAfterReady?: () => Promise<void>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  shouldStop?: () => boolean;
}

export class BuilderToolchainHydrationError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(`Builder toolchain hydration failed: ${reasonCode}`);
    this.name = "BuilderToolchainHydrationError";
    this.reasonCode = reasonCode;
  }
}

const STATUS_FILE = "status.json";
const DETAIL_FILE = "detail.json";
const INSTALLED_LOCK_FILE = ".toolchain-lock.json";
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1_000;
const MAX_LOCK_BYTES = 8 * 1_024 * 1_024;
const NPM_EXECUTABLE = "/usr/local/bin/npm";
const COMMAND_PATHS: Record<BuilderToolchainCommand, string> = {
  claude: "node_modules/.bin/claude",
  codex: "node_modules/.bin/codex",
};
const DEPENDENCY_PACKAGES: Record<BuilderToolchainCommand, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

function hydrationError(reasonCode: string): BuilderToolchainHydrationError {
  return new BuilderToolchainHydrationError(reasonCode);
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isExactVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isIntegrity(value: unknown): value is string {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseBuilderToolchainLock(value: unknown): BuilderToolchainLock {
  const lock = objectRecord(value);
  const packages = objectRecord(lock?.packages);
  const root = objectRecord(packages?.[""]);
  const dependencies = objectRecord(root?.dependencies);
  if (
    !lock || lock.lockfileVersion !== 3 || !packages || !root || !dependencies ||
    !exactKeys(dependencies, Object.values(DEPENDENCY_PACKAGES))
  ) {
    throw hydrationError("invalid-toolchain-lock");
  }

  const versions = {} as Record<BuilderToolchainCommand, string>;
  for (const command of BUILDER_TOOLCHAIN_COMMANDS) {
    const packageName = DEPENDENCY_PACKAGES[command];
    const requested = dependencies[packageName];
    const installed = objectRecord(packages[`node_modules/${packageName}`]);
    if (
      !isExactVersion(requested) || !installed || installed.version !== requested ||
      !isIntegrity(installed.integrity)
    ) {
      throw hydrationError("invalid-toolchain-lock");
    }
    versions[command] = requested;
  }

  return {
    schemaVersion: 1,
    id: "npm-lock-sha256",
    commands: { ...COMMAND_PATHS },
    versions,
  };
}

function parsePackageJson(value: unknown, expected: BuilderToolchainLock): void {
  const packageJson = objectRecord(value);
  const dependencies = objectRecord(packageJson?.dependencies);
  if (!packageJson || packageJson.private !== true || !dependencies) {
    throw hydrationError("invalid-toolchain-package");
  }
  const expectedPackages = Object.values(DEPENDENCY_PACKAGES);
  if (!exactKeys(dependencies, expectedPackages)) {
    throw hydrationError("invalid-toolchain-package");
  }
  for (const command of BUILDER_TOOLCHAIN_COMMANDS) {
    if (dependencies[DEPENDENCY_PACKAGES[command]] !== expected.versions[command]) {
      throw hydrationError("invalid-toolchain-package");
    }
  }
}

function validatedRegistryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw hydrationError("invalid-registry-url");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw hydrationError("invalid-registry-url");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function digestBytes(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

async function readPinnedToolchain(options: HydrateBuilderToolchainOptions): Promise<{
  descriptor: BuilderToolchainLock;
  lockBytes: Buffer;
}> {
  if (!isSha256(options.packageLockSha256)) {
    throw hydrationError("invalid-toolchain-lock-pin");
  }
  const [lockBytes, packageBytes] = await Promise.all([
    fs.readFile(options.packageLockPath).catch(() => {
      throw hydrationError("toolchain-lock-unavailable");
    }),
    fs.readFile(options.packageJsonPath).catch(() => {
      throw hydrationError("toolchain-package-unavailable");
    }),
  ]);
  if (lockBytes.byteLength > MAX_LOCK_BYTES) throw hydrationError("invalid-toolchain-lock");
  if (!timingSafeEqual(digestBytes(lockBytes), Buffer.from(options.packageLockSha256, "hex"))) {
    throw hydrationError("toolchain-lock-digest-mismatch");
  }
  let lockValue: unknown;
  let packageValue: unknown;
  try {
    lockValue = JSON.parse(lockBytes.toString("utf8"));
    packageValue = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    throw hydrationError("invalid-toolchain-lock");
  }
  const descriptor = parseBuilderToolchainLock(lockValue);
  parsePackageJson(packageValue, descriptor);
  return { descriptor, lockBytes };
}

function statusFor(status: DeveloperToolchainStatus, now: Date): BuilderToolchainStatus {
  return {
    schemaVersion: DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
    status,
    updatedAt: now.toISOString(),
  };
}

function detailFor(
  status: DeveloperToolchainStatus,
  fields: Omit<BuilderToolchainDetail, "schemaVersion" | "status"> = {},
): BuilderToolchainDetail {
  return { schemaVersion: 1, status, ...fields };
}

async function writeAtomicJson(root: string, fileName: string, value: unknown): Promise<void> {
  const destination = path.join(root, fileName);
  const temporary = path.join(root, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function writeToolchainStatus(
  root: string,
  status: BuilderToolchainStatus,
  options: {
    publishStatus?: (status: BuilderToolchainStatus) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (!parseDeveloperToolchainStatusArtifact(status)) {
    throw new Error("invalid developer toolchain status artifact");
  }
  await writeAtomicJson(root, STATUS_FILE, status);
  if (options.publishStatus) {
    try {
      await options.publishStatus(status);
    } catch (error) {
      const type = error instanceof Error ? error.name : typeof error;
      (options.log ?? console.error)(`[builder-toolchain] status publication failed (${type})`);
    }
  }
}

export async function readToolchainStatus(root: string): Promise<BuilderToolchainStatus | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, STATUS_FILE), "utf8")) as unknown;
    return parseDeveloperToolchainStatusArtifact(value);
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeToolchainDetail(root: string, detail: BuilderToolchainDetail): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomicJson(root, DETAIL_FILE, detail);
}

export async function readToolchainDetail(root: string): Promise<BuilderToolchainDetail | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, DETAIL_FILE), "utf8")) as unknown;
    const detail = objectRecord(value) as unknown as BuilderToolchainDetail | null;
    if (!detail || detail.schemaVersion !== 1 || !isDeveloperToolchainStatus(detail.status)) return null;
    return detail;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquireHydrationLock(
  root: string,
  staleMs: number,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const lockPath = path.join(root, ".hydrate.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  const attempt = async (): Promise<boolean> => {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, ownerToken }), { mode: 0o600 });
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
  };
  const release = async (): Promise<void> => {
    const owner = await fs.readFile(ownerPath, "utf8").then(
      (raw) => JSON.parse(raw) as { ownerToken?: unknown },
      () => null,
    );
    if (owner?.ownerToken === ownerToken) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  };
  if (await attempt()) return { acquired: true, release };
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleMs) {
    await fs.rm(lockPath, { recursive: true, force: true });
    if (await attempt()) return { acquired: true, release };
  }
  return { acquired: false, release: async () => {} };
}

function npmAuthKey(registryUrl: string): string {
  const url = new URL(registryUrl);
  return `//${url.host}${url.pathname}:_authToken`;
}

export async function installBuilderToolchainDependencies(
  destination: string,
  options: InstallBuilderToolchainOptions,
): Promise<void> {
  const npmrcPath = path.join(destination, ".npmrc.hydration");
  const npmrc = [
    `registry=${options.registryUrl}`,
    "replace-registry-host=always",
    "audit=false",
    "fund=false",
    ...(options.authToken ? [`${npmAuthKey(options.registryUrl)}=\${NODE_AUTH_TOKEN}`] : []),
    "",
  ].join("\n");
  await fs.writeFile(npmrcPath, npmrc, { mode: 0o600 });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.npmExecutable ?? NPM_EXECUTABLE, [
        "ci",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ], {
        cwd: destination,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: options.cachePath,
          NPM_CONFIG_USERCONFIG: npmrcPath,
          ...(options.authToken ? { NODE_AUTH_TOKEN: options.authToken } : {}),
        },
        signal: options.signal,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`npm ci exited ${code ?? signal ?? "unknown"}`));
      });
    });
  } finally {
    await fs.rm(npmrcPath, { force: true });
  }
}

interface HydrationRuntime {
  fallbackRegistryUrl: string;
  installDependencies: NonNullable<HydrateBuilderToolchainOptions["installDependencies"]>;
  lockStaleMs: number;
  log: (message: string) => void;
  now: () => Date;
  nowMs: () => number;
  proxyRegistryUrl: string;
}

function resolveHydrationRuntime(options: HydrateBuilderToolchainOptions): HydrationRuntime {
  return {
    fallbackRegistryUrl: validatedRegistryUrl(
      options.fallbackRegistryUrl ?? DEFAULT_BUILDER_NPM_FALLBACK_REGISTRY,
    ),
    installDependencies: options.installDependencies ?? installBuilderToolchainDependencies,
    lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    log: options.log ?? console.error,
    now: options.now ?? (() => new Date()),
    nowMs: options.nowMs ?? Date.now,
    proxyRegistryUrl: validatedRegistryUrl(
      options.proxyRegistryUrl ?? DEFAULT_BUILDER_NPM_PROXY_REGISTRY,
    ),
  };
}

async function validateCommandFiles(objectPath: string): Promise<void> {
  const realRoot = await fs.realpath(objectPath);
  for (const command of BUILDER_TOOLCHAIN_COMMANDS) {
    const commandPath = path.join(objectPath, COMMAND_PATHS[command]);
    const stat = await fs.lstat(commandPath).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw hydrationError("missing-command");
    }
    const realCommand = await fs.realpath(commandPath);
    if (!realCommand.startsWith(`${realRoot}${path.sep}`)) {
      throw hydrationError("unsafe-command-path");
    }
    await fs.access(realCommand, fsConstants.X_OK);
  }
}

function installedDescriptor(lockSha256: string): InstalledBuilderToolchainLock {
  return { schemaVersion: 1, lockSha256, commands: { ...COMMAND_PATHS } };
}

async function validateInstalledObject(objectPath: string, lockSha256: string): Promise<boolean> {
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(objectPath, INSTALLED_LOCK_FILE), "utf8"),
    ) as InstalledBuilderToolchainLock;
    if (
      installed.schemaVersion !== 1 || installed.lockSha256 !== lockSha256 ||
      JSON.stringify(installed.commands) !== JSON.stringify(COMMAND_PATHS)
    ) return false;
    await validateCommandFiles(objectPath);
    return true;
  } catch {
    return false;
  }
}

async function activateObject(root: string, objectPath: string): Promise<void> {
  const activePath = path.join(root, "active");
  const existing = await fs.lstat(activePath).catch(() => null);
  if (existing && !existing.isSymbolicLink()) throw hydrationError("invalid-active-path");
  const relativeTarget = path.relative(root, objectPath);
  const temporaryLink = path.join(root, `.active.${process.pid}.${randomUUID()}.tmp`);
  await fs.symlink(relativeTarget, temporaryLink, "dir");
  try {
    await fs.rename(temporaryLink, activePath);
  } finally {
    await fs.rm(temporaryLink, { force: true });
  }
}

async function installWithRegistryFallback(input: {
  destination: string;
  cachePath: string;
  proxyRegistryUrl: string;
  fallbackRegistryUrl: string;
  registryTokenProvider?: (registryUrl: string) => Promise<string>;
  installDependencies: (
    destination: string,
    options: InstallBuilderToolchainOptions,
  ) => Promise<void>;
  signal?: AbortSignal;
  log: (message: string) => void;
  nowMs: () => number;
}): Promise<void> {
  const run = async (kind: "proxy" | "direct", registryUrl: string, authToken?: string) => {
    const startedAt = input.nowMs();
    try {
      await input.installDependencies(input.destination, {
        cachePath: input.cachePath,
        registryUrl,
        ...(authToken ? { authToken } : {}),
        signal: input.signal,
      });
      input.log(
        `[builder-toolchain] npm install registry=${kind} outcome=ready durationMs=${input.nowMs() - startedAt}`,
      );
    } catch (error) {
      input.log(
        `[builder-toolchain] npm install registry=${kind} outcome=failed durationMs=${input.nowMs() - startedAt}`,
      );
      throw error;
    }
  };

  let token: string | undefined;
  if (input.registryTokenProvider) {
    try {
      token = await input.registryTokenProvider(input.proxyRegistryUrl);
      if (!token) throw new Error("empty token");
    } catch {
      input.log("[builder-toolchain] npm proxy token unavailable; falling back to direct npm");
    }
  } else {
    input.log("[builder-toolchain] npm proxy token provider unavailable; falling back to direct npm");
  }

  if (token) {
    try {
      await run("proxy", input.proxyRegistryUrl, token);
      return;
    } catch {
      input.log("[builder-toolchain] npm proxy install failed; falling back to direct npm");
    }
  }
  try {
    await run("direct", input.fallbackRegistryUrl);
  } catch {
    throw hydrationError("npm-install-failed");
  }
}

export async function hydrateBuilderToolchain(
  options: HydrateBuilderToolchainOptions,
): Promise<BuilderToolchainStatus> {
  const runtime = resolveHydrationRuntime(options);
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  const lock = await acquireHydrationLock(options.root, runtime.lockStaleMs);
  const persist = async (
    status: BuilderToolchainStatus,
    detail: BuilderToolchainDetail,
  ): Promise<BuilderToolchainStatus> => {
    await writeToolchainDetail(options.root, detail);
    await writeToolchainStatus(options.root, status, {
      publishStatus: options.publishStatus,
      log: runtime.log,
    });
    return status;
  };
  if (!lock.acquired) {
    return persist(statusFor("pending", runtime.now()), detailFor("pending", {
      attempt: options.attempt,
      reasonCode: "hydration-in-progress",
    }));
  }

  let lockSha256: string | undefined;
  let toolchainId: string | undefined;
  const stagingPath = path.join(options.root, "staging", `${process.pid}-${randomUUID()}`);
  try {
    const pinned = await readPinnedToolchain(options);
    lockSha256 = options.packageLockSha256;
    toolchainId = `npm-lock-${lockSha256}`;
    const objectPath = path.join(options.root, "objects", `sha256-${lockSha256}`);
    if (await validateInstalledObject(objectPath, lockSha256)) {
      await activateObject(options.root, objectPath);
      return persist(statusFor("ready", runtime.now()), detailFor("ready", {
        toolchainId,
        lockSha256,
        attempt: options.attempt,
      }));
    }
    await fs.rm(objectPath, { recursive: true, force: true });

    await persist(statusFor("downloading", runtime.now()), detailFor("downloading", {
      toolchainId,
      lockSha256,
      attempt: options.attempt,
    }));
    await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.copyFile(options.packageJsonPath, path.join(stagingPath, "package.json")),
      fs.writeFile(path.join(stagingPath, "package-lock.json"), pinned.lockBytes, { mode: 0o600 }),
    ]);
    await installWithRegistryFallback({
      destination: stagingPath,
      cachePath: path.join(options.root, "npm-cache"),
      proxyRegistryUrl: runtime.proxyRegistryUrl,
      fallbackRegistryUrl: runtime.fallbackRegistryUrl,
      registryTokenProvider: options.registryTokenProvider,
      installDependencies: runtime.installDependencies,
      signal: options.signal,
      log: runtime.log,
      nowMs: runtime.nowMs,
    });

    await persist(statusFor("verifying", runtime.now()), detailFor("verifying", {
      toolchainId,
      lockSha256,
      attempt: options.attempt,
    }));
    await validateCommandFiles(stagingPath);
    await fs.writeFile(
      path.join(stagingPath, INSTALLED_LOCK_FILE),
      `${JSON.stringify(installedDescriptor(lockSha256))}\n`,
      { mode: 0o600 },
    );
    await fs.mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    if (await fs.lstat(objectPath).catch(() => null)) {
      if (!(await validateInstalledObject(objectPath, lockSha256))) {
        throw hydrationError("invalid-existing-object");
      }
      await fs.rm(stagingPath, { recursive: true, force: true });
    } else {
      await fs.rename(stagingPath, objectPath);
    }
    await activateObject(options.root, objectPath);
    return persist(statusFor("ready", runtime.now()), detailFor("ready", {
      toolchainId,
      lockSha256,
      attempt: options.attempt,
    }));
  } catch (error) {
    const reasonCode = error instanceof BuilderToolchainHydrationError
      ? error.reasonCode
      : "internal-error";
    await persist(statusFor("failed", runtime.now()), detailFor("failed", {
      ...(toolchainId ? { toolchainId } : {}),
      ...(lockSha256 ? { lockSha256 } : {}),
      attempt: options.attempt,
      reasonCode,
    }));
    throw error instanceof BuilderToolchainHydrationError ? error : hydrationError(reasonCode);
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true });
    await lock.release();
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitForever = (): Promise<void> => new Promise(() => {});

export async function runBuilderToolchainHydrationLoop(
  options: RunBuilderToolchainHydrationLoopOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const initialBackoffMs = options.initialBackoffMs ?? 5_000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const shouldStop = options.shouldStop ?? (() => false);
  let attempt = 0;
  let pendingWritten = false;
  while (!shouldStop() && !(await options.probeInteractiveReadiness())) {
    if (!pendingWritten) {
      await options.writeStatus("pending");
      pendingWritten = true;
    }
    await sleep(1_000);
  }
  if (shouldStop()) return;
  let backoffMs = initialBackoffMs;
  while (!shouldStop()) {
    attempt += 1;
    try {
      const status = await options.hydrate(attempt);
      if (status.status === "ready") {
        await (options.waitAfterReady ?? waitForever)();
        return;
      }
    } catch {
      if (shouldStop()) return;
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }
}
