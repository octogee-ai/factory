import {
  COMPUTER_HOME_CHECKPOINT_NAME_RE,
  isGatewayVmHomeCheckpoint,
  type GatewayVmHomeCheckpoint,
} from "@octogee/shared/types/glm";

export class ComputerHomeCheckpointError extends Error {
  constructor(
    readonly code: "checkpoint_not_uploaded" | "checkpoint_size_mismatch" | "current_pointer_corrupt"
      | "checkpoint_stale" | "checkpoint_conflict" | "checkpoint_commit_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ComputerHomeCheckpointError";
  }
}

export interface ComputerHomeStore {
  commit(input: { checkpointPath: string; currentPath: string; checkpoint: GatewayVmHomeCheckpoint }): Promise<GatewayVmHomeCheckpoint>;
  readCurrent(currentPath: string): Promise<GatewayVmHomeCheckpoint | null>;
  prune(input: { checkpointsPrefix: string; currentName: string | null; keep: number }): Promise<number>;
}

export function computerHomeRoot(slug: string): string {
  return `customers/${slug}/computer-home`;
}

export function computerHomeCheckpointsPrefix(slug: string): string {
  return `${computerHomeRoot(slug)}/checkpoints`;
}

export function computerHomeCheckpointPath(slug: string, name: string): string {
  return `${computerHomeCheckpointsPrefix(slug)}/${name}`;
}

export function computerHomeCurrentPath(slug: string): string {
  return `${computerHomeRoot(slug)}/current.json`;
}

export function validComputerHomeCheckpointName(value: unknown): string | null {
  return typeof value === "string" && COMPUTER_HOME_CHECKPOINT_NAME_RE.test(value) ? value : null;
}

export function validSha256(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

export function computerHomePruneCandidates(input: {
  checkpointsPrefix: string;
  objectPaths: readonly string[];
  currentName: string | null;
  keep: number;
}): string[] {
  if (!Number.isSafeInteger(input.keep) || input.keep < 1) throw new Error("computer-home prune keep must be a positive integer");
  const prefix = `${input.checkpointsPrefix}/`;
  const checkpoints = input.objectPaths
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ path, name: path.slice(prefix.length) }))
    .filter(({ name }) => COMPUTER_HOME_CHECKPOINT_NAME_RE.test(name))
    .sort((a, b) => b.name.localeCompare(a.name));
  return checkpoints
    .filter((entry, index) => index >= input.keep && input.currentName !== null && entry.name < input.currentName)
    .map((entry) => entry.path);
}

function statusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function parseCurrent(raw: string, currentPath: string): GatewayVmHomeCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ComputerHomeCheckpointError("current_pointer_corrupt", `computer-home pointer ${currentPath} is not JSON`);
  }
  if (!isGatewayVmHomeCheckpoint(parsed)) {
    throw new ComputerHomeCheckpointError("current_pointer_corrupt", `computer-home pointer ${currentPath} is not a checkpoint record`);
  }
  return parsed;
}

async function bucket() {
  const { getStorage } = await import("firebase-admin/storage");
  return getStorage().bucket();
}

type ComputerHomeBucket = Awaited<ReturnType<typeof bucket>>;

async function verifyUploadedCheckpoint(store: ComputerHomeBucket, checkpointPath: string, expectedSize: number): Promise<void> {
  let size: unknown;
  try {
    const [metadata] = await store.file(checkpointPath).getMetadata();
    size = metadata.size;
  } catch (error) {
    if (statusOf(error) === 404) {
      throw new ComputerHomeCheckpointError("checkpoint_not_uploaded", `computer-home checkpoint ${checkpointPath} is not in the bucket`);
    }
    throw error;
  }
  if (Number(size) !== expectedSize) {
    throw new ComputerHomeCheckpointError(
      "checkpoint_size_mismatch",
      `computer-home checkpoint ${checkpointPath} is ${String(size)} bytes, commit claims ${expectedSize}`,
    );
  }
}

async function currentGeneration(store: ComputerHomeBucket, currentPath: string): Promise<string | 0> {
  try {
    const [metadata] = await store.file(currentPath).getMetadata();
    if (typeof metadata.generation !== "string" || !/^[1-9]\d*$/u.test(metadata.generation)) {
      throw new ComputerHomeCheckpointError("current_pointer_corrupt", `computer-home pointer ${currentPath} has an invalid generation`);
    }
    return metadata.generation;
  } catch (error) {
    if (statusOf(error) === 404) return 0;
    throw error;
  }
}

function alreadyCommitted(current: GatewayVmHomeCheckpoint, checkpoint: GatewayVmHomeCheckpoint): boolean {
  if (current.name > checkpoint.name) {
    throw new ComputerHomeCheckpointError("checkpoint_stale", `computer-home checkpoint ${checkpoint.name} precedes current ${current.name}`);
  }
  if (current.name !== checkpoint.name) return false;
  if (current.size !== checkpoint.size || current.sha256 !== checkpoint.sha256 || current.instanceId !== checkpoint.instanceId) {
    throw new ComputerHomeCheckpointError("checkpoint_conflict", `computer-home checkpoint ${checkpoint.name} was committed with different content or provenance`);
  }
  return true;
}

export function createGcsComputerHomeStore(): ComputerHomeStore {
  return {
    async commit({ checkpointPath, currentPath, checkpoint }) {
      const store = await bucket();
      await verifyUploadedCheckpoint(store, checkpointPath, checkpoint.size);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const generation = await currentGeneration(store, currentPath);
        if (typeof generation === "string") {
          let bytes: Buffer;
          try {
            [bytes] = await store.file(currentPath, { generation }).download();
          } catch (error) {
            if (statusOf(error) === 404 || statusOf(error) === 412) continue;
            throw error;
          }
          const current = parseCurrent(bytes.toString("utf8"), currentPath);
          if (alreadyCommitted(current, checkpoint)) return current;
        }
        try {
          await store.file(currentPath).save(JSON.stringify(checkpoint), {
            contentType: "application/json",
            resumable: false,
            preconditionOpts: { ifGenerationMatch: generation },
          });
          return checkpoint;
        } catch (error) {
          if (statusOf(error) !== 412) throw error;
        }
      }
      throw new ComputerHomeCheckpointError("checkpoint_commit_conflict", `computer-home pointer ${currentPath} kept changing during commit`);
    },
    async readCurrent(currentPath) {
      const store = await bucket();
      let raw: string;
      try {
        const [bytes] = await store.file(currentPath).download();
        raw = bytes.toString("utf8");
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
      return parseCurrent(raw, currentPath);
    },
    async prune({ checkpointsPrefix, currentName, keep }) {
      const store = await bucket();
      const [files] = await store.getFiles({ prefix: `${checkpointsPrefix}/` });
      const candidates = computerHomePruneCandidates({
        checkpointsPrefix,
        objectPaths: files.map((file) => file.name),
        currentName,
        keep,
      });
      await Promise.all(candidates.map((path) => store.file(path).delete({ ignoreNotFound: true })));
      return candidates.length;
    },
  };
}
