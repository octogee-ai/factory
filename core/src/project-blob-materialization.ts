import { isBlobObjectVersion } from "@octogee/shared/types/fleet-broker";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseManifest, manifestObjectPath, type Manifest, type ManifestEntry } from "./workspace-manifest.js";
import { initializeProjectAssetManifest, readProjectAssetManifest, withMaterializedProjectAssets, writeProjectRestoreReady, readProjectRestoreState } from "./project-asset-state.js";
import { acquireWorkspaceMutationLeaseSync, projectMutationLeaseGitDir } from "./workspace-mutation-lease.js";
import { CUSTOMERS_DIR } from "./config.js";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import type { FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";

interface BlobMaterialization {
  download: FleetBrokerBlobSignedUrl;
  generation: string;
  size: number;
  md5Hash: string;
}
export interface ProjectBlobHydrationClient {
  workspaceManifestReadUrl(input: { slug: string; projectSlug?: string }): Promise<FleetBrokerBlobSignedUrl>;
  blobMaterializationReadUrl(input: { slug: string; path: string; size: number; sha256?: string }): Promise<BlobMaterialization>;
}

export interface ProjectBlobHydration {
  bytes: number;
  files: number;
  generation: string | null;
  deferred?: number;
}
export type ProjectBlobHydrator = (input: { slug: string; project: string; destination: string; maxBytes: number; preserveExisting?: boolean; allowDeferred?: boolean; paths?: string[]; markRestoreReady?: boolean; requireRestoredCheckout?: boolean }) => Promise<ProjectBlobHydration>;
const DEADLINE_MS = 5 * 60_000;
const MANIFEST_MAX_BYTES = 10 * 1024 * 1024;

async function boundedBody(response: Response, limit: number, consume: (bytes: Uint8Array) => Promise<void>): Promise<number> {
  if (!response.body) throw new Error("project blob response has no body");
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("project blob exceeds byte quota");
      await consume(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sameBlobSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function existingBlobSnapshot(destination: string): Promise<{ sha256: string; stat: BigIntStats }> {
  const file = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > 512n * 1024n * 1024n) throw new Error("invalid materialized project blob");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (!sameBlobSnapshot(stat, await file.stat({ bigint: true }))) throw new Error("project blob changed while reading");
    return { sha256: hash.digest("hex"), stat };
  } finally { await file.close(); }
}

async function removeDeletedMaterializedBlob(root: string, relative: string, entry: ManifestEntry): Promise<void> {
  const handles = [await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  try {
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) handles.push(await fs.open(`${fdRoot}/${handles.at(-1)!.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const destination = `${fdRoot}/${handles.at(-1)!.fd}/${parts.at(-1)}`;
    const snapshot = await existingBlobSnapshot(destination);
    if (!entry.sha256 || entry.sha256 !== snapshot.sha256 || BigInt(entry.size) !== snapshot.stat.size) throw new Error(`remote project asset deletion conflicts with local work: ${relative}`);
    if (!sameBlobSnapshot(snapshot.stat, await fs.lstat(destination, { bigint: true }))) throw new Error("project blob changed during restoration");
    await fs.unlink(destination);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  finally { for (const handle of handles.reverse()) await handle.close(); }
}

async function reconcileDeletedMaterializedAssets(input: HydrationInput, materialized: Manifest, manifest: Manifest): Promise<string[]> {
  if (input.paths) return [];
  const removed = [];
  for (const [relative, entry] of Object.entries(materialized)) {
    if (manifest[relative]) continue;
    await removeDeletedMaterializedBlob(input.destination, relative, entry);
    delete materialized[relative];
    removed.push(relative);
  }
  return removed;
}

interface BlobDestination {
  destination: string;
  replacement?: BigIntStats;
  retained?: { sha256: string; stat: BigIntStats };
}

async function prepareExistingBlob(destination: string, relative: string, entry: ManifestEntry, prior: ManifestEntry | undefined): Promise<BlobDestination | null> {
  if (prior?.gcsPath === entry.gcsPath && prior.uploadedAt === entry.uploadedAt) return null;
  const snapshot = await existingBlobSnapshot(destination);
  if (entry.sha256 === snapshot.sha256 && BigInt(entry.size) === snapshot.stat.size) return null;
  if (!entry.sha256 && !prior?.sha256) return { destination, retained: snapshot };
  if (!prior?.sha256 || prior.sha256 !== snapshot.sha256 || BigInt(prior.size) !== snapshot.stat.size) throw new Error(`remote project asset conflicts with local work: ${relative}`);
  return { destination, replacement: snapshot.stat };
}

async function prepareBlobPath(root: string, relative: string, entry: ManifestEntry, prior: ManifestEntry | undefined, preserveExisting = false): Promise<BlobDestination | null> {
  let current = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch(error => { if (error.code !== "EEXIST") { throw error; } });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("project blob parent is a symlink or non-directory");
  }
  const destination = path.join(root, relative);
  try {
    const existing = await fs.lstat(destination);
    if (preserveExisting && existing.isFile()) return await prepareExistingBlob(destination, relative, entry, prior);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return { destination }; } throw error; }
  throw new Error("project blob would overwrite an existing committed file");
}

async function downloadBlob(client: Pick<ProjectBlobHydrationClient, "blobMaterializationReadUrl">, input: { slug: string; project: string; relative: string; size: number; gcsPath: string; sha256?: string } & BlobDestination): Promise<void> {
  const signed = await client.blobMaterializationReadUrl({ slug: input.slug, path: `projects/${input.project}/${input.relative}`, size: input.size, ...(input.sha256 ? { sha256: input.sha256 } : {}) });
  validateIdentity(signed, input);
  const response = await fetch(signed.download.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(DEADLINE_MS) });
  if (!response.ok) throw new Error(`project blob download failed: ${response.status}`);
  const staging = await fs.mkdtemp(path.join(path.dirname(input.destination), ".blob-"));
  const file = path.join(staging, "contents");
  try {
    if (response.headers.get(signed.download.storage === "s3" ? "x-amz-version-id" : "x-goog-generation") !== signed.generation) throw new Error("project blob generation changed");
    // eslint-disable-next-line sonarjs/hashing -- compares the trusted GCS object checksum; not an authentication hash
    const hash = createHash("md5");
    const contentHash = createHash("sha256");
    const output = await fs.open(file, "wx", 0o600);
    let bytes;
    try {
      bytes = await boundedBody(response, signed.size, async chunk => { hash.update(chunk); contentHash.update(chunk); await output.writeFile(chunk); });
      await output.sync();
    } finally { await output.close(); }
    if (bytes !== signed.size || hash.digest("base64") !== signed.md5Hash) throw new Error("project blob size or checksum mismatch");
    const sha256 = contentHash.digest("hex");
    if (input.sha256 && sha256 !== input.sha256) throw new Error("project blob content hash mismatch");
    if (input.retained) {
      if (sha256 !== input.retained.sha256) throw new Error(`remote project asset conflicts with local work: ${input.relative}`);
      if (!sameBlobSnapshot(input.retained.stat, await fs.lstat(input.destination, { bigint: true }))) throw new Error("project blob changed during restoration");
    } else if (input.replacement) {
      if (!sameBlobSnapshot(input.replacement, await fs.lstat(input.destination, { bigint: true }))) throw new Error("project blob changed during restoration");
      await fs.rename(file, input.destination);
    } else await fs.link(file, input.destination);
  } finally { await response.body?.cancel().catch(() => {}); await fs.rm(staging, { recursive: true, force: true }); }
}

function validateIdentity(signed: BlobMaterialization, input: { gcsPath: string; size: number }): void {
  if (signed.download.gcsPath !== input.gcsPath || signed.download.method !== "GET" || signed.size !== input.size ||
      !isBlobObjectVersion(signed.generation, signed.download.storage) || !/^[A-Za-z0-9+/]{22}==$/u.test(signed.md5Hash)) {
    throw new Error("project blob broker identity mismatch");
  }
}

type HydrationClient = ProjectBlobHydrationClient;
type HydrationInput = Parameters<ProjectBlobHydrator>[0];

async function hydrationManifest(client: HydrationClient, input: HydrationInput, prefix: string): Promise<{ manifest: Manifest; generation: string | null }> {
    let manifest = await readProjectAssetManifest(input.destination, prefix);
    let generation: string | null = null;
    if (manifest === null) {
      const signed = await client.workspaceManifestReadUrl({ slug: input.slug, projectSlug: input.project });
      const response = await fetch(signed.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(DEADLINE_MS) });
      if (response.status === 404) {
        await initializeProjectAssetManifest(input.destination, prefix, {});
        return { manifest: {}, generation: null };
      }
      if (!response.ok) throw new Error(`project blob manifest failed: ${response.status}`);
      generation = response.headers.get(signed.storage === "s3" ? "x-amz-version-id" : "x-goog-generation");
      if (!generation || !isBlobObjectVersion(generation, signed.storage)) throw new Error("project blob manifest lacks generation");
      const parts: Buffer[] = [];
      await boundedBody(response, MANIFEST_MAX_BYTES, async chunk => { parts.push(Buffer.from(chunk)); });
      manifest = parseManifest(manifestObjectPath(prefix), Buffer.concat(parts).toString("utf8"));
      await initializeProjectAssetManifest(input.destination, prefix, manifest);
    }
    return { manifest, generation };
}

function canDeferMissingBlob(input: HydrationInput, destination: BlobDestination): boolean {
  return input.allowDeferred === true && !destination.replacement && !destination.retained;
}

async function hydrationPlan(input: HydrationInput, prefix: string, manifest: Manifest) {
    const materialized = await withMaterializedProjectAssets(input.destination, prefix, async files => files);
    assertSelectedAssets(input.paths, manifest);
    const removed = await reconcileDeletedMaterializedAssets(input, materialized, manifest);
    const entries = Object.entries(manifest).filter(([relative]) => !input.paths || input.paths.includes(relative));
    if (entries.length > 20_000) throw new Error("project blob manifest exceeds quota");
    const pending = [];
    let bytes = 0;
    let deferred = 0;
    for (const [relative, entry] of entries) {
      const destination = await prepareBlobPath(input.destination, relative, entry, materialized[relative], input.preserveExisting);
      if (destination === null) { materialized[relative] = entry; continue; }
      if (!input.paths && input.preserveExisting && materialized[relative]?.gcsPath === entry.gcsPath && materialized[relative]?.uploadedAt === entry.uploadedAt) continue;
      if (entry.size > 512 * 1024 * 1024 || bytes + entry.size > input.maxBytes) {
        if (!canDeferMissingBlob(input, destination)) throw new Error("project blob manifest exceeds quota");
        deferred += 1;
        continue;
      }
      bytes += entry.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("project blob manifest exceeds quota");
      pending.push({ relative, entry, ...destination });
    }
    return { materialized, pending, bytes, deferred, removed };
}

export function createBrokeredProjectBlobHydrator(client: ProjectBlobHydrationClient, usersRoot = CUSTOMERS_DIR): ProjectBlobHydrator {
  const hydrate: ProjectBlobHydrator = async input => {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.slug) || !/^[a-z0-9][a-z0-9-]*$/u.test(input.project) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new Error("invalid project blob materialization scope or quota");
    }
    const root = await fs.lstat(input.destination);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("project blob root is a symlink or non-directory");
    const prefix = `customers/${input.slug}/projects/${input.project}`;
    const { manifest, generation } = await hydrationManifest(client, input, prefix);
    const { materialized, pending, bytes, deferred, removed } = await hydrationPlan(input, prefix, manifest);
    for (const { relative, entry, ...destination } of pending) {
      await downloadBlob(client, { slug: input.slug, project: input.project, relative, size: entry.size, gcsPath: entry.gcsPath, ...destination, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
      materialized[relative] = entry;
    }
    await withMaterializedProjectAssets(input.destination, prefix, async files => {
      for (const relative of removed) delete files[relative];
      Object.assign(files, materialized);
    });
    return { bytes, files: pending.filter(item => !item.retained).length, generation, ...(input.allowDeferred ? { deferred } : {}) };
  };
  return async input => {
    const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: input.destination, gitDir: projectMutationLeaseGitDir(input.destination, usersRoot) ?? undefined });
    if (!lease) throw new Error("project restore requires the workspace mutation lease");
    try {
      if (input.requireRestoredCheckout && await readProjectRestoreState(input.destination, input.slug, input.project) === "unrestored") throw new Error("project restore requires its previously restored checkout");
      const result = await hydrate(input);
      if (input.markRestoreReady) await writeProjectRestoreReady(input.destination, input.slug, input.project);
      return result;
    }
    finally { lease.release(); }
  };
}

function assertSelectedAssets(paths: string[] | undefined, manifest: Manifest): void {
  if (paths?.some(relative => !Object.hasOwn(manifest, relative))) throw new Error("requested asset is not in the project manifest");
}

export async function prepareUserProjectAssets(input: { projects: string; slug: string; project: string; hydrate: ProjectBlobHydrator; log?: (message: string) => void; requireRestoredCheckout?: boolean }): Promise<void> {
  if (!isValidUsername(input.slug) || !isValidProjectId(input.project)) throw new Error("invalid project restore scope");
  const destination = path.join(input.projects, input.project);
  if (!(await fs.lstat(input.projects)).isDirectory() || !(await fs.lstat(destination)).isDirectory()) throw new Error("project restore requires directories");
  const space = await fs.statfs(destination);
  const maxBytes = Math.max(0, space.bavail * space.bsize - 128 * 1024 * 1024);
  const result = await input.hydrate({ slug: input.slug, project: input.project, destination, maxBytes, preserveExisting: true, allowDeferred: true, markRestoreReady: true, ...(input.requireRestoredCheckout ? { requireRestoredCheckout: true } : {}) });
  if (result.deferred) input.log?.(`[project-restore] ${input.slug}/${input.project}: ${result.deferred} assets remain in remote storage; use octo-project restore for selected files`);
}
