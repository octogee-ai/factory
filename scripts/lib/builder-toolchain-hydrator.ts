import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { x as extractTar } from "tar";

import {
  DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
  isDeveloperToolchainStatus,
  parseDeveloperToolchainStatusArtifact,
  type DeveloperToolchainStatus,
  type DeveloperToolchainStatusArtifact,
} from "../../shared/types/developer-toolchain.js";

export const BUILDER_TOOLCHAIN_COMMANDS = ["claude", "codex"] as const;

export type BuilderToolchainCommand = typeof BUILDER_TOOLCHAIN_COMMANDS[number];

export interface BuilderToolchainManifest {
  schemaVersion: 1;
  id: string;
  artifact: {
    format: "tar.gz";
    sha256: string;
    sizeBytes: number;
    unpackedSizeBytes: number;
  };
  commands: Record<BuilderToolchainCommand, string>;
}

export type BuilderToolchainStatus = DeveloperToolchainStatusArtifact;

export interface BuilderToolchainDetail {
  schemaVersion: 1;
  status: DeveloperToolchainStatus;
  toolchainId?: string;
  artifactSha256?: string;
  attempt?: number;
  reasonCode?: string;
  nextRetryAt?: string;
}

export class BuilderToolchainHydrationError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(`Builder toolchain hydration failed: ${reasonCode}`);
    this.name = "BuilderToolchainHydrationError";
    this.reasonCode = reasonCode;
  }
}

export interface ExtractToolchainArchiveInput {
  archivePath: string;
  destination: string;
  expectedUnpackedSizeBytes: number;
}

export interface HydrateBuilderToolchainOptions {
  root: string;
  manifestPath: string;
  manifestSha256: string;
  artifactUrl: string;
  attempt?: number;
  fetchArtifact?: typeof fetch;
  extractArchive?: (
    input: ExtractToolchainArchiveInput,
  ) => Promise<{ unpackedSizeBytes: number }>;
  publishStatus?: (status: BuilderToolchainStatus) => Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
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

const STATUS_FILE = "status.json";
const DETAIL_FILE = "detail.json";
const INSTALLED_MANIFEST_FILE = ".toolchain-manifest.json";
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1_000;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_ARTIFACT_BYTES = 2 * 1_024 * 1_024 * 1_024;
const MAX_UNPACKED_BYTES = 4 * 1_024 * 1_024 * 1_024;
const MAX_ARCHIVE_ENTRIES = 100_000;

function hydrationError(reasonCode: string): BuilderToolchainHydrationError {
  return new BuilderToolchainHydrationError(reasonCode);
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function digestBytes(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (value.startsWith("/") || value.endsWith("/")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function nonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function parseBuilderToolchainManifest(value: unknown): BuilderToolchainManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hydrationError("invalid-manifest");
  }
  const candidate = value as Record<string, unknown>;
  const artifact = candidate.artifact;
  const commands = candidate.commands;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(candidate.id) ||
    !artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
    !commands || typeof commands !== "object" || Array.isArray(commands)
  ) {
    throw hydrationError("invalid-manifest");
  }
  const artifactRecord = artifact as Record<string, unknown>;
  const commandRecord = commands as Record<string, unknown>;
  if (
    artifactRecord.format !== "tar.gz" ||
    !isSha256(artifactRecord.sha256) ||
    !positiveInteger(artifactRecord.sizeBytes, MAX_ARTIFACT_BYTES) ||
    !nonNegativeInteger(artifactRecord.unpackedSizeBytes, MAX_UNPACKED_BYTES) ||
    Object.keys(commandRecord).sort().join(",") !== [...BUILDER_TOOLCHAIN_COMMANDS].sort().join(",") ||
    !BUILDER_TOOLCHAIN_COMMANDS.every((command) => safeRelativePath(commandRecord[command]))
  ) {
    throw hydrationError("invalid-manifest");
  }
  return {
    schemaVersion: 1,
    id: candidate.id,
    artifact: {
      format: "tar.gz",
      sha256: artifactRecord.sha256,
      sizeBytes: artifactRecord.sizeBytes,
      unpackedSizeBytes: artifactRecord.unpackedSizeBytes,
    },
    commands: {
      claude: commandRecord.claude as string,
      codex: commandRecord.codex as string,
    },
  };
}

async function readPinnedManifest(
  manifestPath: string,
  expectedSha256: string,
): Promise<BuilderToolchainManifest> {
  if (!isSha256(expectedSha256)) throw hydrationError("invalid-manifest-pin");
  const file = await fs.readFile(manifestPath).catch(() => {
    throw hydrationError("manifest-unavailable");
  });
  if (file.byteLength > MAX_MANIFEST_BYTES) throw hydrationError("invalid-manifest");
  const actual = digestBytes(file);
  const expected = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw hydrationError("manifest-digest-mismatch");
  try {
    return parseBuilderToolchainManifest(JSON.parse(file.toString("utf8")));
  } catch (error) {
    if (error instanceof BuilderToolchainHydrationError) throw error;
    throw hydrationError("invalid-manifest");
  }
}

function validatedArtifactUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw hydrationError("invalid-artifact-url");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw hydrationError("invalid-artifact-url");
  }
  return url;
}

function statusFor(
  status: DeveloperToolchainStatus,
  now: Date,
): BuilderToolchainStatus {
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
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const detail = value as BuilderToolchainDetail;
    if (detail.schemaVersion !== 1 || !isDeveloperToolchainStatus(detail.status)) return null;
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
  if (await attempt()) {
    return { acquired: true, release };
  }
  const stat = await fs.stat(lockPath).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > staleMs) {
    await fs.rm(lockPath, { recursive: true, force: true });
    if (await attempt()) {
      return { acquired: true, release };
    }
  }
  return { acquired: false, release: async () => {} };
}

async function downloadArtifact(input: {
  url: URL;
  destination: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  fetchArtifact: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  let response: Response;
  try {
    response = await input.fetchArtifact(input.url, {
      redirect: "follow",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60 * 1_000)])
        : AbortSignal.timeout(30 * 60 * 1_000),
    });
  } catch {
    throw hydrationError("download-failed");
  }
  if (!response.ok || !response.body) throw hydrationError("download-failed");
  if (response.url) validatedArtifactUrl(response.url);
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") throw hydrationError("unexpected-content-encoding");
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== input.expectedSizeBytes) {
    throw hydrationError("artifact-size-mismatch");
  }
  const handle = await fs.open(input.destination, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > input.expectedSizeBytes) {
        await reader.cancel();
        throw hydrationError("artifact-size-mismatch");
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    if (error instanceof BuilderToolchainHydrationError) throw error;
    throw hydrationError("download-failed");
  } finally {
    await handle.close();
  }
  if (size !== input.expectedSizeBytes) throw hydrationError("artifact-size-mismatch");
  const expected = Buffer.from(input.expectedSha256, "hex");
  if (!timingSafeEqual(hash.digest(), expected)) throw hydrationError("artifact-digest-mismatch");
}

function validateArchivePath(entryPath: string): void {
  if (!safeRelativePath(entryPath.replace(/\/$/, ""))) throw hydrationError("unsafe-archive");
}

export async function extractToolchainArchive(
  input: ExtractToolchainArchiveInput,
): Promise<{ unpackedSizeBytes: number }> {
  await fs.mkdir(input.destination, { recursive: true, mode: 0o700 });
  let unpackedSizeBytes = 0;
  let entryCount = 0;
  let rejectionReason: string | null = null;
  try {
    await extractTar({
      cwd: input.destination,
      file: input.archivePath,
      gzip: true,
      noChmod: true,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        if (rejectionReason) return false;
        entryCount += 1;
        try {
          if (entryCount > MAX_ARCHIVE_ENTRIES) throw hydrationError("unsafe-archive");
          validateArchivePath(entryPath);
          const entryType = "type" in entry
            ? entry.type
            : entry.isFile()
              ? "File"
              : entry.isDirectory()
                ? "Directory"
                : "Unsupported";
          if (entryType !== "File" && entryType !== "Directory") {
            throw hydrationError("unsafe-archive");
          }
          if (entryType === "File") {
            unpackedSizeBytes += entry.size;
            if (unpackedSizeBytes > input.expectedUnpackedSizeBytes) {
              throw hydrationError("unpacked-size-mismatch");
            }
          }
          return true;
        } catch (error) {
          rejectionReason = error instanceof BuilderToolchainHydrationError
            ? error.reasonCode
            : "unsafe-archive";
          return false;
        }
      },
    });
  } catch (error) {
    if (error instanceof BuilderToolchainHydrationError) throw error;
    throw hydrationError("archive-extraction-failed");
  }
  if (rejectionReason) throw hydrationError(rejectionReason);
  if (unpackedSizeBytes !== input.expectedUnpackedSizeBytes) {
    throw hydrationError("unpacked-size-mismatch");
  }
  return { unpackedSizeBytes };
}

async function validateCommandFiles(
  objectPath: string,
  manifest: BuilderToolchainManifest,
  makeExecutable: boolean,
): Promise<void> {
  const realRoot = await fs.realpath(objectPath);
  for (const command of BUILDER_TOOLCHAIN_COMMANDS) {
    const commandPath = path.join(objectPath, manifest.commands[command]);
    const stat = await fs.lstat(commandPath).catch(() => null);
    if (!stat?.isFile()) throw hydrationError("missing-command");
    const realCommand = await fs.realpath(commandPath);
    if (!realCommand.startsWith(`${realRoot}${path.sep}`)) throw hydrationError("unsafe-command-path");
    if (makeExecutable) await fs.chmod(commandPath, 0o755);
  }
}

async function validateInstalledObject(
  objectPath: string,
  expected: BuilderToolchainManifest,
): Promise<boolean> {
  try {
    const installed = parseBuilderToolchainManifest(JSON.parse(
      await fs.readFile(path.join(objectPath, INSTALLED_MANIFEST_FILE), "utf8"),
    ));
    if (
      installed.id !== expected.id ||
      installed.artifact.sha256 !== expected.artifact.sha256 ||
      JSON.stringify(installed.commands) !== JSON.stringify(expected.commands)
    ) return false;
    await validateCommandFiles(objectPath, installed, true);
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

export async function hydrateBuilderToolchain(
  options: HydrateBuilderToolchainOptions,
): Promise<BuilderToolchainStatus> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.error;
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  const lock = await acquireHydrationLock(
    options.root,
    options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
  );
  const persist = async (
    status: BuilderToolchainStatus,
    detail: BuilderToolchainDetail,
  ): Promise<BuilderToolchainStatus> => {
    await writeToolchainDetail(options.root, detail);
    await writeToolchainStatus(options.root, status, {
      publishStatus: options.publishStatus,
      log,
    });
    return status;
  };
  if (!lock.acquired) {
    return persist(statusFor("pending", now()), detailFor("pending", {
      attempt: options.attempt,
      reasonCode: "hydration-in-progress",
    }));
  }

  let manifest: BuilderToolchainManifest | undefined;
  const stagingPath = path.join(options.root, "staging", `${process.pid}-${randomUUID()}`);
  try {
    manifest = await readPinnedManifest(options.manifestPath, options.manifestSha256);
    const artifactUrl = validatedArtifactUrl(options.artifactUrl);
    const objectPath = path.join(options.root, "objects", `sha256-${manifest.artifact.sha256}`);
    if (await validateInstalledObject(objectPath, manifest)) {
      await activateObject(options.root, objectPath);
      return persist(statusFor("ready", now()), detailFor("ready", {
        toolchainId: manifest.id,
        artifactSha256: manifest.artifact.sha256,
        attempt: options.attempt,
      }));
    }
    if (await fs.lstat(objectPath).catch(() => null)) {
      await fs.rm(objectPath, { recursive: true, force: true });
    }

    await persist(statusFor("downloading", now()), detailFor("downloading", {
      toolchainId: manifest.id,
      artifactSha256: manifest.artifact.sha256,
      attempt: options.attempt,
    }));
    await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });
    const archivePath = path.join(stagingPath, "payload.tar.gz");
    await downloadArtifact({
      url: artifactUrl,
      destination: archivePath,
      expectedSha256: manifest.artifact.sha256,
      expectedSizeBytes: manifest.artifact.sizeBytes,
      fetchArtifact: options.fetchArtifact ?? fetch,
      signal: options.signal,
    });
    await persist(statusFor("verifying", now()), detailFor("verifying", {
      toolchainId: manifest.id,
      artifactSha256: manifest.artifact.sha256,
      attempt: options.attempt,
    }));
    const contentPath = path.join(stagingPath, "content");
    await (options.extractArchive ?? extractToolchainArchive)({
      archivePath,
      destination: contentPath,
      expectedUnpackedSizeBytes: manifest.artifact.unpackedSizeBytes,
    });
    await validateCommandFiles(contentPath, manifest, true);
    await fs.writeFile(
      path.join(contentPath, INSTALLED_MANIFEST_FILE),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 },
    );
    await fs.mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    if (await fs.lstat(objectPath).catch(() => null)) {
      if (!(await validateInstalledObject(objectPath, manifest))) {
        throw hydrationError("invalid-existing-object");
      }
    } else {
      await fs.rename(contentPath, objectPath);
    }
    await activateObject(options.root, objectPath);
    return persist(statusFor("ready", now()), detailFor("ready", {
      toolchainId: manifest.id,
      artifactSha256: manifest.artifact.sha256,
      attempt: options.attempt,
    }));
  } catch (error) {
    const reasonCode = error instanceof BuilderToolchainHydrationError
      ? error.reasonCode
      : "internal-error";
    await persist(statusFor("failed", now()), detailFor("failed", {
      ...(manifest ? {
        toolchainId: manifest.id,
        artifactSha256: manifest.artifact.sha256,
      } : {}),
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
