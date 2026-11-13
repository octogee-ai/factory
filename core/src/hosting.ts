import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import zlib from "node:zlib";

// Firebase Hosting REST flow, split so the credentialed half can run wherever the
// Hosting token lives: cattle pods run both halves locally; operator publishing is
// CI/CD/control-plane-owned. `getToken` is injected — this module imports no GCP SDK.
// See docs/decisions/DECISIONS.md ("Operator-gateway site deploys").

export type DeployResult = { success: true; url: string } | { success: false; error: string };

export interface CollectedFiles {
  /** Hosting deploy manifest: `/url-path` → sha256 of the gzipped file. */
  files: Record<string, string>;
  /** sha256 → base64(gzip(file)). The bytes Hosting may ask us to upload. */
  blobs: Record<string, string>;
}

export type HostingTokenGetter = (scopes: string[]) => Promise<string>;

const HOSTING_SCOPE = "https://www.googleapis.com/auth/firebase.hosting";
const BASE_URL = "https://firebasehosting.googleapis.com/v1beta1";

const IMMUTABLE_CACHE = "max-age=31536000, immutable";
const DEFAULT_CACHE = "max-age=1800";

interface VersionResponse {
  name: string;
}
interface PopulateResponse {
  uploadUrl: string;
  uploadRequiredHashes?: string[];
}
interface ChannelResponse {
  name?: string;
  url?: string;
  expireTime?: string;
}
interface ReleaseResponse {
  name?: string;
  releaseTime?: string;
  message?: string;
  version?: { name?: string };
}
interface ListReleasesResponse {
  releases?: ReleaseResponse[];
}

/** A Hosting `ServingConfig` header rule. */
export interface HostingHeaderRule {
  glob: string;
  headers: Record<string, string>;
}

/** A Hosting `ServingConfig` rewrite rule (static destination only). */
export interface HostingRewriteRule {
  glob: string;
  path: string;
}

export interface HostingConfig {
  headers: HostingHeaderRule[];
  rewrites?: HostingRewriteRule[];
}

/**
 * The Hosting `ServingConfig` a project's recipe deserves.
 *
 * Hosting matches real files before rewrites, so the `vite-static` SPA fallback only
 * catches paths with no file behind them — it can never shadow a published asset.
 * Hashed build output (`/assets/**`, `/_astro/**`) is immutable; everything else stays
 * on the short TTL so a republish is visible quickly.
 */
export function hostingConfigForRecipe(recipe: string | null): HostingConfig {
  if (recipe === "vite-static") {
    return {
      rewrites: [{ glob: "**", path: "/index.html" }],
      headers: [
        { glob: "/assets/**", headers: { "Cache-Control": IMMUTABLE_CACHE } },
        { glob: "**", headers: { "Cache-Control": DEFAULT_CACHE } },
      ],
    };
  }
  if (recipe === "astro-static") {
    return {
      headers: [
        { glob: "/_astro/**", headers: { "Cache-Control": IMMUTABLE_CACHE } },
        { glob: "**", headers: { "Cache-Control": DEFAULT_CACHE } },
      ],
    };
  }
  return { headers: [{ glob: "**", headers: { "Cache-Control": DEFAULT_CACHE } }] };
}

/**
 * Walk `distDir`, gzip + sha256 each file, and return the Hosting deploy manifest
 * plus the gzipped blobs keyed by hash. Pure filesystem work — no credentials.
 * Null if no dist.
 */
export function collectDistFiles(distDir: string): CollectedFiles | null {
  if (!fs.existsSync(distDir)) return null;
  const files: Record<string, string> = {};
  const blobs: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const urlPath = prefix + entry.name;
      // Never follow symlinks. A built static site has none; a symlink here would
      // let a compromised build publish a target outside dist/ — e.g. the mounted
      // KSA token at /var/run/secrets/octogee-api/token — to public Hosting.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath, urlPath + "/");
      } else if (entry.isFile()) {
        const gzipped = zlib.gzipSync(fs.readFileSync(fullPath));
        const hash = crypto.createHash("sha256").update(gzipped).digest("hex");
        files["/" + urlPath] = hash;
        blobs[hash] = gzipped.toString("base64");
      }
    }
  };
  walk(distDir, "");
  return { files, blobs };
}

/**
 * A copy of `collected` with one more file in the manifest, gzipped + hashed the same
 * way `collectDistFiles` does. Lets a caller add bytes that were never on disk — the
 * publish-time social image — without re-walking the artifact.
 */
export function withCollectedFile(
  collected: CollectedFiles,
  urlPath: string,
  contents: Buffer,
): CollectedFiles {
  const gzipped = zlib.gzipSync(contents);
  const hash = crypto.createHash("sha256").update(gzipped).digest("hex");
  return {
    files: { ...collected.files, [urlPath]: hash },
    blobs: { ...collected.blobs, [hash]: gzipped.toString("base64") },
  };
}

export interface HostingApiOptions {
  getToken: HostingTokenGetter;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface DeployCollectedOptions extends HostingApiOptions {
  /** Serving config baked into the version. Defaults to the recipe-less config. */
  config?: HostingConfig;
}

export type UploadVersionResult =
  | { success: true; versionName: string }
  | { success: false; error: string };

export type ReleaseResult = { success: true } | { success: false; error: string };

export type ChannelResult =
  | { success: true; url: string; expireTime: string }
  | { success: false; error: string };

export interface HostingReleaseSummary {
  versionName: string;
  releaseTime: string;
  live: boolean;
  message?: string;
}

export type ListReleasesResult =
  | { success: true; releases: HostingReleaseSummary[] }
  | { success: false; error: string };

function jsonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Create a version carrying the recipe's serving config, populate its manifest, upload
 * only the blobs Hosting reports missing, and finalize it. The result is a version that
 * is ready to be released — to the live channel or to a preview channel.
 */
export async function uploadVersion(
  siteId: string,
  collected: CollectedFiles,
  opts: DeployCollectedOptions,
): Promise<UploadVersionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const token = await opts.getToken([HOSTING_SCOPE]);
  const headers = jsonHeaders(token);
  const config = opts.config ?? hostingConfigForRecipe(null);

  const versionRes = await fetchImpl(`${BASE_URL}/sites/${siteId}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config }),
  });
  if (!versionRes.ok) return { success: false, error: `Create version: ${await versionRes.text()}` };
  const versionName = ((await versionRes.json()) as VersionResponse).name;

  const populateRes = await fetchImpl(`${BASE_URL}/${versionName}:populateFiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ files: collected.files }),
  });
  if (!populateRes.ok) return { success: false, error: `Populate: ${await populateRes.text()}` };
  const populate = (await populateRes.json()) as PopulateResponse;
  const uploadUrl = populate.uploadUrl;
  const required = populate.uploadRequiredHashes ?? [];

  log(`Uploading ${required.length}/${Object.keys(collected.files).length} files`);
  for (const hash of required) {
    const b64 = collected.blobs[hash];
    if (!b64) return { success: false, error: `Missing blob for required hash ${hash}` };
    const gzipped = Buffer.from(b64, "base64");
    const uploadRes = await fetchImpl(`${uploadUrl}/${hash}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(gzipped),
    });
    if (!uploadRes.ok) return { success: false, error: `Upload failed: ${uploadRes.status}` };
  }

  const finalizeRes = await fetchImpl(`${BASE_URL}/${versionName}?update_mask=status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "FINALIZED" }),
  });
  if (!finalizeRes.ok) return { success: false, error: `Finalize: ${await finalizeRes.text()}` };

  return { success: true, versionName };
}

/**
 * Point the site's live channel at `versionName`. This is both the last step of a deploy
 * and — when the version is an older one — a Hosting rollback: the history gains a new
 * release rather than losing one.
 */
export async function releaseVersion(
  siteId: string,
  versionName: string,
  opts: HostingApiOptions,
): Promise<ReleaseResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await opts.getToken([HOSTING_SCOPE]);
  const releaseRes = await fetchImpl(
    `${BASE_URL}/sites/${siteId}/releases?versionName=${versionName}`,
    { method: "POST", headers: jsonHeaders(token) },
  );
  if (!releaseRes.ok) return { success: false, error: `Release: ${await releaseRes.text()}` };
  return { success: true };
}

/**
 * Deploy already-collected files to a Hosting site's live channel: upload a version
 * carrying the recipe's serving config, then release it.
 */
export async function deployCollectedFiles(
  siteId: string,
  collected: CollectedFiles,
  opts: DeployCollectedOptions,
): Promise<DeployResult> {
  const log = opts.log ?? (() => {});
  const uploaded = await uploadVersion(siteId, collected, opts);
  if (!uploaded.success) return uploaded;

  const released = await releaseVersion(siteId, uploaded.versionName, opts);
  if (!released.success) return released;

  const url = `https://${siteId}.web.app`;
  log(`Deployed: ${url}`);
  return { success: true, url };
}

/**
 * Create the preview channel, or extend an existing one's TTL.
 *
 * `channelId` is immutable, so a second create returns ALREADY_EXISTS (409); the
 * documented way to move the expiry out is PATCH with `updateMask=ttl` (`ttl` is an
 * input-only Channel field that rewrites `expireTime`). Both verbs answer with the
 * Channel resource, whose `url` is the preview address.
 */
export async function ensureChannel(
  siteId: string,
  channelId: string,
  ttlSeconds: number,
  opts: HostingApiOptions,
): Promise<ChannelResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await opts.getToken([HOSTING_SCOPE]);
  const headers = jsonHeaders(token);
  const body = JSON.stringify({ ttl: `${ttlSeconds}s` });

  const createRes = await fetchImpl(
    `${BASE_URL}/sites/${siteId}/channels?channelId=${channelId}`,
    { method: "POST", headers, body },
  );
  if (createRes.ok) return channelResult(await createRes.json(), channelId);
  if (createRes.status !== 409) {
    return { success: false, error: `Create channel ${channelId}: ${await createRes.text()}` };
  }

  const patchRes = await fetchImpl(
    `${BASE_URL}/sites/${siteId}/channels/${channelId}?updateMask=ttl`,
    { method: "PATCH", headers, body },
  );
  if (!patchRes.ok) {
    return { success: false, error: `Extend channel ${channelId}: ${await patchRes.text()}` };
  }
  return channelResult(await patchRes.json(), channelId);
}

function channelResult(payload: unknown, channelId: string): ChannelResult {
  const channel = (payload ?? {}) as ChannelResponse;
  if (!channel.url) return { success: false, error: `Channel ${channelId} returned no url` };
  if (!channel.expireTime) {
    return { success: false, error: `Channel ${channelId} returned no expireTime` };
  }
  return { success: true, url: channel.url, expireTime: channel.expireTime };
}

/** Point a preview channel at an already-finalized version. */
export async function releaseToChannel(
  siteId: string,
  channelId: string,
  versionName: string,
  opts: HostingApiOptions,
): Promise<ReleaseResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await opts.getToken([HOSTING_SCOPE]);
  const res = await fetchImpl(
    `${BASE_URL}/sites/${siteId}/channels/${channelId}/releases?versionName=${versionName}`,
    { method: "POST", headers: jsonHeaders(token) },
  );
  if (!res.ok) {
    return { success: false, error: `Release to channel ${channelId}: ${await res.text()}` };
  }
  return { success: true };
}

/**
 * The site's live-channel release history, newest first. Only releases that still name a
 * version are returned — a release without one (a site-disable) is not a rollback target.
 */
export async function listReleases(
  siteId: string,
  opts: HostingApiOptions & { pageSize?: number },
): Promise<ListReleasesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const pageSize = opts.pageSize ?? 20;
  const token = await opts.getToken([HOSTING_SCOPE]);
  const res = await fetchImpl(`${BASE_URL}/sites/${siteId}/releases?pageSize=${pageSize}`, {
    method: "GET",
    headers: jsonHeaders(token),
  });
  if (!res.ok) return { success: false, error: `List releases: ${await res.text()}` };

  const payload = ((await res.json()) ?? {}) as ListReleasesResponse;
  const raw = payload.releases ?? [];
  const newestFirst = raw.slice().sort((a, b) => releaseSortKey(b) - releaseSortKey(a));

  const releases: HostingReleaseSummary[] = [];
  let skipped = 0;
  for (const release of newestFirst) {
    const versionName = release.version?.name;
    if (!versionName) {
      skipped += 1;
      continue;
    }
    const summary: HostingReleaseSummary = {
      versionName,
      releaseTime: release.releaseTime ?? "",
      live: releases.length === 0,
    };
    if (release.message) summary.message = release.message;
    releases.push(summary);
  }
  if (skipped > 0) log(`Skipped ${skipped} release(s) with no version on ${siteId}`);

  return { success: true, releases };
}

function releaseSortKey(release: ReleaseResponse): number {
  const parsed = Date.parse(release.releaseTime ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}
