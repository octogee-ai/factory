/**
 * The blob manifest — the index that lets a file listing show binaries stored in
 * GCS alongside the text files tracked in git.
 *
 * It lives beside the blobs it indexes rather than inside the workspace repo.
 * In the repo it had two writers on two channels — the Gitea Contents API
 * server-side and blob-sync through the worktree — and every upload advanced
 * origin/main behind the pod's clone, diverging any workspace holding unpushed
 * work. gateway-edge and blob-sync both read and write this one object, so the
 * shape and the read-modify-write live here, in one place, for both.
 */
export const MANIFEST_OBJECT_SUFFIX = ".files/manifest.json";
/** Only-if-absent, in the generation-precondition vocabulary. */
export const GENERATION_ABSENT = "0";
function trimTrailingSlashes(value) {
    let out = value;
    while (out.endsWith("/"))
        out = out.slice(0, -1);
    return out;
}
export function manifestObjectPath(gcsPrefix) {
    return `${trimTrailingSlashes(gcsPrefix)}/${MANIFEST_OBJECT_SUFFIX}`;
}
export class ManifestGenerationConflict extends Error {
    constructor(objectPath) {
        super(`manifest generation changed under us at ${objectPath}`);
        this.name = "ManifestGenerationConflict";
    }
}
export class ManifestCorruptError extends Error {
    constructor(objectPath, detail) {
        super(`manifest at ${objectPath} is unreadable: ${detail}`);
        this.name = "ManifestCorruptError";
    }
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isManifestEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entry = value;
    return (entry.type === "blob" &&
        typeof entry.gcsPath === "string" &&
        typeof entry.mimeType === "string" &&
        typeof entry.uploadedAt === "string" &&
        isNonNegativeInteger(entry.size) &&
        (entry.hasThumbnail === undefined || typeof entry.hasThumbnail === "boolean"));
}
export function parseManifest(objectPath, contents) {
    let raw;
    try {
        raw = JSON.parse(contents);
    }
    catch (err) {
        throw new ManifestCorruptError(objectPath, err instanceof Error ? err.message : String(err));
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ManifestCorruptError(objectPath, "expected a JSON object");
    }
    const manifest = {};
    for (const [path, value] of Object.entries(raw)) {
        if (!isManifestEntry(value)) {
            throw new ManifestCorruptError(objectPath, `invalid entry at ${path}`);
        }
        manifest[path] = value;
    }
    return manifest;
}
export function serializeManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}
export async function readManifest(store, gcsPrefix) {
    const objectPath = manifestObjectPath(gcsPrefix);
    const found = await store.read(objectPath);
    if (!found)
        return {};
    return parseManifest(objectPath, found.contents);
}
/**
 * Read-modify-write under a generation precondition. `mutate` reports whether it
 * changed anything so an unchanged manifest costs no write and no new
 * generation. A losing write is retried against freshly read state — never
 * forced — because the other writer's entries must survive.
 */
export async function mutateManifest(store, gcsPrefix, mutate, attempts = 3) {
    const objectPath = manifestObjectPath(gcsPrefix);
    let lastConflict;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const found = await store.read(objectPath);
        const manifest = found ? parseManifest(objectPath, found.contents) : {};
        if (!mutate(manifest))
            return;
        try {
            await store.write(objectPath, serializeManifest(manifest), found ? found.generation : GENERATION_ABSENT);
            return;
        }
        catch (err) {
            if (!(err instanceof ManifestGenerationConflict))
                throw err;
            lastConflict = err;
        }
    }
    throw lastConflict ?? new ManifestGenerationConflict(objectPath);
}
export async function putManifestEntries(store, gcsPrefix, entries) {
    const paths = Object.keys(entries);
    if (paths.length === 0)
        return;
    await mutateManifest(store, gcsPrefix, (manifest) => {
        Object.assign(manifest, entries);
        return true;
    });
}
export async function removeManifestEntries(store, gcsPrefix, paths) {
    const targets = Array.isArray(paths) ? paths : [paths];
    await mutateManifest(store, gcsPrefix, (manifest) => {
        let changed = false;
        for (const path of targets) {
            if (manifest[path] !== undefined) {
                delete manifest[path];
                changed = true;
            }
        }
        return changed;
    });
}
function isPreconditionFailure(err) {
    const code = err?.code;
    return code === 412 || code === "412";
}
export function createGcsManifestStore(bucket) {
    return {
        async read(objectPath) {
            const file = bucket.file(objectPath);
            try {
                const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
                return { contents: buffer.toString("utf-8"), generation: String(metadata.generation ?? "") };
            }
            catch (err) {
                const code = err?.code;
                if (code === 404 || code === "404")
                    return null;
                throw err;
            }
        },
        async write(objectPath, contents, ifGenerationMatch) {
            try {
                await bucket.file(objectPath).save(contents, {
                    contentType: "application/json",
                    preconditionOpts: { ifGenerationMatch },
                });
            }
            catch (err) {
                if (isPreconditionFailure(err))
                    throw new ManifestGenerationConflict(objectPath);
                throw err;
            }
        },
    };
}
