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
export interface ManifestEntry {
    type: "blob";
    gcsPath: string;
    size: number;
    mimeType: string;
    uploadedAt: string;
    /**
     * Whether a thumbnail object was actually written. The URL itself is signed at
     * read time and never stored — a stored signed URL expires while the manifest
     * that holds it does not.
     */
    hasThumbnail?: boolean;
}
export type Manifest = Record<string, ManifestEntry>;
export declare const MANIFEST_OBJECT_SUFFIX = ".files/manifest.json";
/** Only-if-absent, in the generation-precondition vocabulary. */
export declare const GENERATION_ABSENT = "0";
export declare function manifestObjectPath(gcsPrefix: string): string;
export declare class ManifestGenerationConflict extends Error {
    constructor(objectPath: string);
}
export declare class ManifestCorruptError extends Error {
    constructor(objectPath: string, detail: string);
}
export interface ManifestReadResult {
    contents: string;
    generation: string;
}
/**
 * A conditional object store. The generation is what keeps two writers from
 * clobbering each other, so `write` must fail rather than overwrite when the
 * precondition does not hold.
 */
export interface ManifestStore {
    read(objectPath: string): Promise<ManifestReadResult | null>;
    write(objectPath: string, contents: string, ifGenerationMatch: string): Promise<void>;
}
export declare function parseManifest(objectPath: string, contents: string): Manifest;
export declare function serializeManifest(manifest: Manifest): string;
export declare function readManifest(store: ManifestStore, gcsPrefix: string): Promise<Manifest>;
/**
 * Read-modify-write under a generation precondition. `mutate` reports whether it
 * changed anything so an unchanged manifest costs no write and no new
 * generation. A losing write is retried against freshly read state — never
 * forced — because the other writer's entries must survive.
 */
export declare function mutateManifest(store: ManifestStore, gcsPrefix: string, mutate: (manifest: Manifest) => boolean, attempts?: number): Promise<void>;
export declare function putManifestEntries(store: ManifestStore, gcsPrefix: string, entries: Manifest): Promise<void>;
export declare function removeManifestEntries(store: ManifestStore, gcsPrefix: string, paths: string | string[]): Promise<void>;
export interface ManifestBucketFile {
    download(): Promise<[Buffer, ...unknown[]]>;
    getMetadata(): Promise<[{
        generation?: string | number | null;
    }, ...unknown[]]>;
    save(contents: string, options: unknown): Promise<unknown>;
}
export interface ManifestBucket {
    file(path: string): ManifestBucketFile;
}
export declare function createGcsManifestStore(bucket: ManifestBucket): ManifestStore;
