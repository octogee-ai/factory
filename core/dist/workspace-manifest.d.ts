export interface ManifestEntry {
    type: "blob";
    gcsPath: string;
    size: number;
    mimeType: string;
    uploadedAt: string;
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
    file(path: string, options?: {
        generation?: string;
    }): ManifestBucketFile;
}
export declare function createGcsManifestStore(bucket: ManifestBucket): ManifestStore;
