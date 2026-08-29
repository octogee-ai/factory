export interface ManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  hasThumbnail?: boolean;
}

export type Manifest = Record<string, ManifestEntry>;

export const MANIFEST_OBJECT_SUFFIX = ".files/manifest.json";

/** Only-if-absent, in the generation-precondition vocabulary. */
export const GENERATION_ABSENT = "0";

function trimTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function manifestObjectPath(gcsPrefix: string): string {
  return `${trimTrailingSlashes(gcsPrefix)}/${MANIFEST_OBJECT_SUFFIX}`;
}

export class ManifestGenerationConflict extends Error {
  constructor(objectPath: string) {
    super(`manifest generation changed under us at ${objectPath}`);
    this.name = "ManifestGenerationConflict";
  }
}

export class ManifestCorruptError extends Error {
  constructor(objectPath: string, detail: string) {
    super(`manifest at ${objectPath} is unreadable: ${detail}`);
    this.name = "ManifestCorruptError";
  }
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

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<ManifestEntry>;
  return (
    entry.type === "blob" &&
    typeof entry.gcsPath === "string" &&
    typeof entry.mimeType === "string" &&
    typeof entry.uploadedAt === "string" &&
    isNonNegativeInteger(entry.size) &&
    (entry.hasThumbnail === undefined || typeof entry.hasThumbnail === "boolean")
  );
}

export function parseManifest(objectPath: string, contents: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (err) {
    throw new ManifestCorruptError(objectPath, err instanceof Error ? err.message : String(err));
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestCorruptError(objectPath, "expected a JSON object");
  }
  const manifest: Manifest = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isManifestEntry(value)) {
      throw new ManifestCorruptError(objectPath, `invalid entry at ${path}`);
    }
    manifest[path] = value;
  }
  return manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readManifest(store: ManifestStore, gcsPrefix: string): Promise<Manifest> {
  const objectPath = manifestObjectPath(gcsPrefix);
  const found = await store.read(objectPath);
  if (!found) return {};
  return parseManifest(objectPath, found.contents);
}

export async function mutateManifest(
  store: ManifestStore,
  gcsPrefix: string,
  mutate: (manifest: Manifest) => boolean,
  attempts = 3,
): Promise<void> {
  const objectPath = manifestObjectPath(gcsPrefix);
  let lastConflict: ManifestGenerationConflict | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await store.read(objectPath);
    const manifest = found ? parseManifest(objectPath, found.contents) : {};
    if (!mutate(manifest)) return;
    try {
      await store.write(
        objectPath,
        serializeManifest(manifest),
        found ? found.generation : GENERATION_ABSENT,
      );
      return;
    } catch (err) {
      if (!(err instanceof ManifestGenerationConflict)) throw err;
      lastConflict = err;
    }
  }
  throw lastConflict ?? new ManifestGenerationConflict(objectPath);
}

export async function putManifestEntries(
  store: ManifestStore,
  gcsPrefix: string,
  entries: Manifest,
): Promise<void> {
  const paths = Object.keys(entries);
  if (paths.length === 0) return;
  await mutateManifest(store, gcsPrefix, (manifest) => {
    Object.assign(manifest, entries);
    return true;
  });
}

export async function removeManifestEntries(
  store: ManifestStore,
  gcsPrefix: string,
  paths: string | string[],
): Promise<void> {
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

function isPreconditionFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 412 || code === "412";
}

export interface ManifestBucketFile {
  download(): Promise<[Buffer, ...unknown[]]>;
  getMetadata(): Promise<[{ generation?: string | number | null }, ...unknown[]]>;
  save(contents: string, options: unknown): Promise<unknown>;
}

export interface ManifestBucket {
  file(path: string, options?: { generation?: string }): ManifestBucketFile;
}

export function createGcsManifestStore(bucket: ManifestBucket): ManifestStore {
  return {
    async read(objectPath) {
      try {
        const [metadata] = await bucket.file(objectPath).getMetadata();
        const generation = metadata.generation === undefined || metadata.generation === null
          ? null
          : String(metadata.generation);
        if (!generation) {
          throw new ManifestCorruptError(objectPath, "object metadata carries no generation");
        }
        const [buffer] = await bucket.file(objectPath, { generation }).download();
        return { contents: buffer.toString("utf-8"), generation };
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 404 || code === "404") return null;
        throw err;
      }
    },
    async write(objectPath, contents, ifGenerationMatch) {
      try {
        await bucket.file(objectPath).save(contents, {
          contentType: "application/json",
          preconditionOpts: { ifGenerationMatch },
        });
      } catch (err) {
        if (isPreconditionFailure(err)) throw new ManifestGenerationConflict(objectPath);
        throw err;
      }
    },
  };
}
