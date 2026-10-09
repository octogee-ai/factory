export const MANIFEST_OBJECT_SUFFIX = ".files/manifest.json";
export const GENERATION_ABSENT = "0";
const MANIFEST_OBJECT_TAIL = `/${MANIFEST_OBJECT_SUFFIX}`;
const RESERVED_MANIFEST_PATH_SEGMENTS = new Set(["runtime-state", "__proto__", "constructor", "prototype"]);
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
function manifestPrefix(objectPath) {
    if (!objectPath.endsWith(MANIFEST_OBJECT_TAIL))
        return null;
    return objectPath.slice(0, -MANIFEST_OBJECT_TAIL.length);
}
function isManifestPath(value) {
    if (value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
        return false;
    }
    const parts = value.split("/");
    return !parts.some((part) => part.length === 0 || part === "." || part === ".." || part.startsWith(".") || RESERVED_MANIFEST_PATH_SEGMENTS.has(part));
}
function isManifestEntry(value, gcsPrefix, path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entry = value;
    return (entry.type === "blob" &&
        (entry.sha256 === undefined
            ? entry.gcsPath === `${gcsPrefix}/${path}`
            : typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.gcsPath === `${gcsPrefix}/.objects/${entry.sha256}`) &&
        typeof entry.mimeType === "string" &&
        typeof entry.uploadedAt === "string" &&
        isNonNegativeInteger(entry.size) &&
        (entry.hasThumbnail === undefined || typeof entry.hasThumbnail === "boolean"));
}
export function parseManifest(objectPath, contents) {
    const gcsPrefix = manifestPrefix(objectPath);
    if (gcsPrefix === null) {
        throw new ManifestCorruptError(objectPath, "invalid manifest object path");
    }
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
        if (!isManifestPath(path) || !isManifestEntry(value, gcsPrefix, path)) {
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
export async function mutateManifest(store, gcsPrefix, mutate, attempts = 3) {
    const objectPath = manifestObjectPath(gcsPrefix);
    let lastConflict;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const found = await store.read(objectPath);
        const manifest = found ? parseManifest(objectPath, found.contents) : {};
        if (!mutate(manifest))
            return;
        try {
            const contents = serializeManifest(manifest);
            parseManifest(objectPath, contents);
            await store.write(objectPath, contents, found ? found.generation : GENERATION_ABSENT);
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
    parseManifest(manifestObjectPath(gcsPrefix), serializeManifest(entries));
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
            for (let attempt = 0; attempt < 2; attempt += 1) {
                let metadata;
                try {
                    [metadata] = await bucket.file(objectPath).getMetadata();
                }
                catch (err) {
                    const code = err?.code;
                    if (code === 404 || code === "404")
                        return null;
                    throw err;
                }
                const generation = metadata.generation === undefined || metadata.generation === null
                    ? null
                    : String(metadata.generation);
                if (!generation) {
                    throw new ManifestCorruptError(objectPath, "object metadata carries no generation");
                }
                try {
                    const [buffer] = await bucket.file(objectPath, { generation }).download();
                    return { contents: buffer.toString("utf-8"), generation };
                }
                catch (err) {
                    const code = err?.code;
                    if ((code === 404 || code === "404") && attempt === 0)
                        continue;
                    throw err;
                }
            }
            throw new ManifestCorruptError(objectPath, "manifest generation disappeared during read");
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
