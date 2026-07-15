import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import zlib from "node:zlib";
const HOSTING_SCOPE = "https://www.googleapis.com/auth/firebase.hosting";
const BASE_URL = "https://firebasehosting.googleapis.com/v1beta1";
/**
 * Walk `distDir`, gzip + sha256 each file, and return the Hosting deploy manifest
 * plus the gzipped blobs keyed by hash. Pure filesystem work — no credentials.
 * Null if no dist.
 */
export function collectDistFiles(distDir) {
    if (!fs.existsSync(distDir))
        return null;
    const files = {};
    const blobs = {};
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            const urlPath = prefix + entry.name;
            // Never follow symlinks. A built static site has none; a symlink here would
            // let a compromised build publish a target outside dist/ — e.g. the mounted
            // KSA token at /var/run/secrets/octogee-api/token — to public Hosting.
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                walk(fullPath, urlPath + "/");
            }
            else if (entry.isFile()) {
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
 * Deploy already-collected files to a Hosting site: create a version, populate the
 * file manifest, upload only the blobs Hosting reports missing, finalize, release.
 * `getToken` supplies the Hosting access token from whatever ADC is in scope.
 */
export async function deployCollectedFiles(siteId, collected, opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const log = opts.log ?? (() => { });
    const token = await opts.getToken([HOSTING_SCOPE]);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const versionRes = await fetchImpl(`${BASE_URL}/sites/${siteId}/versions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            config: { headers: [{ glob: "**", headers: { "Cache-Control": "max-age=1800" } }] },
        }),
    });
    if (!versionRes.ok)
        return { success: false, error: `Create version: ${await versionRes.text()}` };
    const versionName = (await versionRes.json()).name;
    const populateRes = await fetchImpl(`${BASE_URL}/${versionName}:populateFiles`, {
        method: "POST",
        headers,
        body: JSON.stringify({ files: collected.files }),
    });
    if (!populateRes.ok)
        return { success: false, error: `Populate: ${await populateRes.text()}` };
    const populate = (await populateRes.json());
    const uploadUrl = populate.uploadUrl;
    const required = populate.uploadRequiredHashes ?? [];
    log(`Uploading ${required.length}/${Object.keys(collected.files).length} files`);
    for (const hash of required) {
        const b64 = collected.blobs[hash];
        if (!b64)
            return { success: false, error: `Missing blob for required hash ${hash}` };
        const gzipped = Buffer.from(b64, "base64");
        const uploadRes = await fetchImpl(`${uploadUrl}/${hash}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
            body: new Uint8Array(gzipped),
        });
        if (!uploadRes.ok)
            return { success: false, error: `Upload failed: ${uploadRes.status}` };
    }
    const finalizeRes = await fetchImpl(`${BASE_URL}/${versionName}?update_mask=status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "FINALIZED" }),
    });
    if (!finalizeRes.ok)
        return { success: false, error: `Finalize: ${await finalizeRes.text()}` };
    const releaseRes = await fetchImpl(`${BASE_URL}/sites/${siteId}/releases?versionName=${versionName}`, { method: "POST", headers });
    if (!releaseRes.ok)
        return { success: false, error: `Release: ${await releaseRes.text()}` };
    const url = `https://${siteId}.web.app`;
    log(`Deployed: ${url}`);
    return { success: true, url };
}
