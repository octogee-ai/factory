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

interface VersionResponse {
  name: string;
}
interface PopulateResponse {
  uploadUrl: string;
  uploadRequiredHashes?: string[];
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

export interface DeployCollectedOptions {
  getToken: HostingTokenGetter;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Deploy already-collected files to a Hosting site: create a version, populate the
 * file manifest, upload only the blobs Hosting reports missing, finalize, release.
 * `getToken` supplies the Hosting access token from whatever ADC is in scope.
 */
export async function deployCollectedFiles(
  siteId: string,
  collected: CollectedFiles,
  opts: DeployCollectedOptions,
): Promise<DeployResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const token = await opts.getToken([HOSTING_SCOPE]);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const versionRes = await fetchImpl(`${BASE_URL}/sites/${siteId}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      config: { headers: [{ glob: "**", headers: { "Cache-Control": "max-age=1800" } }] },
    }),
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

  const releaseRes = await fetchImpl(
    `${BASE_URL}/sites/${siteId}/releases?versionName=${versionName}`,
    { method: "POST", headers },
  );
  if (!releaseRes.ok) return { success: false, error: `Release: ${await releaseRes.text()}` };

  const url = `https://${siteId}.web.app`;
  log(`Deployed: ${url}`);
  return { success: true, url };
}
