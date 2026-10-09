import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseManifest, manifestObjectPath } from "./workspace-manifest.js";
import { initializeProjectAssetManifest, readProjectAssetManifest, withMaterializedProjectAssets, writeProjectRestoreReady } from "./project-asset-state.js";
import { acquireWorkspaceMutationLeaseSync, projectMutationLeaseGitDir } from "./workspace-mutation-lease.js";
import { CUSTOMERS_DIR } from "./config.js";
const DEADLINE_MS = 5 * 60_000;
const MANIFEST_MAX_BYTES = 10 * 1024 * 1024;
async function boundedBody(response, limit, consume) {
    if (!response.body)
        throw new Error("project blob response has no body");
    const reader = response.body.getReader();
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                return bytes;
            bytes += chunk.value.byteLength;
            if (bytes > limit)
                throw new Error("project blob exceeds byte quota");
            await consume(chunk.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
async function prepareBlobPath(root, relative, preserveExisting = false) {
    let current = root;
    for (const segment of relative.split("/").slice(0, -1)) {
        current = path.join(current, segment);
        await fs.mkdir(current).catch(error => { if (error.code !== "EEXIST") {
            throw error;
        } });
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("project blob parent is a symlink or non-directory");
    }
    const destination = path.join(root, relative);
    try {
        const existing = await fs.lstat(destination);
        if (preserveExisting && existing.isFile())
            return null;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return destination;
        }
        throw error;
    }
    throw new Error("project blob would overwrite an existing committed file");
}
async function downloadBlob(client, input) {
    const signed = await client.blobMaterializationReadUrl({ slug: input.slug, path: `projects/${input.project}/${input.relative}`, size: input.size, ...(input.sha256 ? { sha256: input.sha256 } : {}) });
    validateIdentity(signed, input);
    const response = await fetch(signed.download.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(DEADLINE_MS) });
    if (!response.ok)
        throw new Error(`project blob download failed: ${response.status}`);
    const staging = await fs.mkdtemp(path.join(path.dirname(input.destination), ".blob-"));
    const file = path.join(staging, "contents");
    try {
        if (response.headers.get("x-goog-generation") !== signed.generation)
            throw new Error("project blob generation changed");
        // eslint-disable-next-line sonarjs/hashing -- compares the trusted GCS object checksum; not an authentication hash
        const hash = createHash("md5");
        const contentHash = createHash("sha256");
        const output = await fs.open(file, "wx", 0o600);
        let bytes;
        try {
            bytes = await boundedBody(response, signed.size, async (chunk) => { hash.update(chunk); contentHash.update(chunk); await output.writeFile(chunk); });
            await output.sync();
        }
        finally {
            await output.close();
        }
        if (bytes !== signed.size || hash.digest("base64") !== signed.md5Hash)
            throw new Error("project blob size or checksum mismatch");
        if (input.sha256 && contentHash.digest("hex") !== input.sha256)
            throw new Error("project blob content hash mismatch");
        await fs.link(file, input.destination);
    }
    finally {
        await response.body?.cancel().catch(() => { });
        await fs.rm(staging, { recursive: true, force: true });
    }
}
function validateIdentity(signed, input) {
    if (signed.download.gcsPath !== input.gcsPath || signed.download.method !== "GET" || signed.size !== input.size ||
        !/^[1-9]\d{0,19}$/u.test(signed.generation) || !/^[A-Za-z0-9+/]{22}==$/u.test(signed.md5Hash)) {
        throw new Error("project blob broker identity mismatch");
    }
}
async function hydrationManifest(client, input, prefix) {
    let manifest = await readProjectAssetManifest(input.destination, prefix);
    let generation = null;
    if (manifest === null) {
        const signed = await client.workspaceManifestReadUrl({ slug: input.slug, projectSlug: input.project });
        const response = await fetch(signed.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(DEADLINE_MS) });
        if (response.status === 404) {
            await initializeProjectAssetManifest(input.destination, prefix, {});
            return { manifest: {}, generation: null, missing: true };
        }
        if (!response.ok)
            throw new Error(`project blob manifest failed: ${response.status}`);
        generation = response.headers.get("x-goog-generation");
        if (!generation || !/^[1-9]\d{0,19}$/u.test(generation))
            throw new Error("project blob manifest lacks generation");
        const parts = [];
        await boundedBody(response, MANIFEST_MAX_BYTES, async (chunk) => { parts.push(Buffer.from(chunk)); });
        manifest = parseManifest(manifestObjectPath(prefix), Buffer.concat(parts).toString("utf8"));
        await initializeProjectAssetManifest(input.destination, prefix, manifest);
    }
    return { manifest, generation, missing: false };
}
async function hydrationPlan(input, prefix, manifest) {
    const materialized = await withMaterializedProjectAssets(input.destination, prefix, async (files) => files);
    assertSelectedAssets(input.paths, manifest);
    const entries = Object.entries(manifest).filter(([relative]) => !input.paths || input.paths.includes(relative));
    if (entries.length > 20_000)
        throw new Error("project blob manifest exceeds quota");
    const pending = [];
    let bytes = 0;
    let deferred = 0;
    for (const [relative, entry] of entries) {
        const destination = await prepareBlobPath(input.destination, relative, input.preserveExisting);
        if (destination === null) {
            materialized[relative] = entry;
            continue;
        }
        if (!input.paths && input.preserveExisting && materialized[relative]?.gcsPath === entry.gcsPath && materialized[relative]?.uploadedAt === entry.uploadedAt)
            continue;
        if (entry.size > 512 * 1024 * 1024 || bytes + entry.size > input.maxBytes) {
            if (!input.allowDeferred)
                throw new Error("project blob manifest exceeds quota");
            deferred += 1;
            continue;
        }
        bytes += entry.size;
        if (!Number.isSafeInteger(bytes))
            throw new Error("project blob manifest exceeds quota");
        pending.push({ relative, entry, destination });
    }
    return { materialized, pending, bytes, deferred };
}
export function createBrokeredProjectBlobHydrator(client, customersRoot = CUSTOMERS_DIR) {
    const hydrate = async (input) => {
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.slug) || !/^[a-z0-9][a-z0-9-]*$/u.test(input.project) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
            throw new Error("invalid project blob materialization scope or quota");
        }
        const root = await fs.lstat(input.destination);
        if (root.isSymbolicLink() || !root.isDirectory())
            throw new Error("project blob root is a symlink or non-directory");
        const prefix = `customers/${input.slug}/projects/${input.project}`;
        const { manifest, generation, missing } = await hydrationManifest(client, input, prefix);
        if (missing)
            return { bytes: 0, files: 0, generation: null };
        const { materialized, pending, bytes, deferred } = await hydrationPlan(input, prefix, manifest);
        for (const { relative, entry, destination } of pending) {
            await downloadBlob(client, { slug: input.slug, project: input.project, relative, size: entry.size, gcsPath: entry.gcsPath, destination, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
            materialized[relative] = entry;
        }
        await withMaterializedProjectAssets(input.destination, prefix, async (files) => { Object.assign(files, materialized); });
        return { bytes, files: pending.length, generation, ...(input.allowDeferred ? { deferred } : {}) };
    };
    return async (input) => {
        const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: input.destination, gitDir: projectMutationLeaseGitDir(input.destination, customersRoot) ?? undefined });
        if (!lease)
            throw new Error("project restore requires the workspace mutation lease");
        try {
            const result = await hydrate(input);
            if (input.markRestoreReady)
                await writeProjectRestoreReady(input.destination, input.slug, input.project);
            return result;
        }
        finally {
            lease.release();
        }
    };
}
function assertSelectedAssets(paths, manifest) {
    if (paths?.some(relative => !Object.hasOwn(manifest, relative)))
        throw new Error("requested asset is not in the project manifest");
}
