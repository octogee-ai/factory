import {
  COMPUTER_HOME_CHECKPOINT_CONTENT_TYPE,
  COMPUTER_HOME_CHECKPOINT_MAX_BYTES,
  COMPUTER_HOME_CHECKPOINT_NAME_RE,
  type GatewayVmRuntimeBundle,
} from "@octogee/shared/types/glm";
import type {
  FleetBrokerComputerHomeCheckpointCommit,
  FleetBrokerComputerHomeCheckpointUrl,
  FleetBrokerComputerHomeDownload,
  FleetBrokerComputerHomePruneResult,
} from "@octogee/shared/types/fleet-broker";
import { brokerFailure, brokerPost, type BrokerClientDeps } from "./broker.js";
import { volumeHostPath } from "./plan.js";
import type { DesktopControl } from "./desktop-control.js";

export const HOME_VOLUME_NAME = "data";
export const HOME_CHECKPOINT_INTERVAL_MS = 30 * 60_000;
export const HOME_CHECKPOINT_MARKER = "home-checkpoint.marker";
export const HOME_RESTORE_PENDING = "home-restore.pending";
export const DESKTOP_HOME_PATHS = [".config/octogee-chromium", ".config/hypr", ".config/omarchy", "Documents"] as const;
export const HOME_CHECKPOINT_EXCLUDES = [
  "node_modules",
  ".npm",
  ".npm-cache",
  ".cache",
  ".pnpm-store",
  "Trash",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "GrShaderCache",
  "ShaderCache",
  "CacheStorage",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "DevToolsActivePort",
] as const;
const BUILDER_SLUG_ENV = "GATEWAY_BUILDER_SLUG";
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface HomeShell {
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface HomeFs {
  listDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  fileSize(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
  touch(path: string, atMs: number): Promise<void>;
  uploadBody(path: string): Promise<BodyInit>;
  saveResponse(response: Response, path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  replaceDirectory(source: string, target: string): Promise<void>;
}

export interface HomeCheckpointDeps extends BrokerClientDeps {
  stateRoot: string;
  shell: HomeShell;
  fs: HomeFs;
  now: () => number;
  log: (msg: string) => void;
  desktop: DesktopControl;
  snapshot(work: () => Promise<void>): Promise<void>;
}

export interface HomeScope {
  slug: string;
  dataDir: string;
  marker: string;
  desktopDir: string;
  restorePending: string;
}

export type HomeCheckpointResult =
  | { status: "clean" }
  | { status: "uploaded"; name: string; size: number; pruned: number | null };

export type HomeRestoreResult =
  | { status: "preserved" }
  | { status: "none" }
  | { status: "restored"; name: string; size: number };

export function homeScope(stateRoot: string, bundle: GatewayVmRuntimeBundle): HomeScope | null {
  const volume = bundle.volumes.find((candidate) => candidate.name === HOME_VOLUME_NAME && candidate.kind === "emptyDir");
  const slug = [bundle.init, ...bundle.containers].find((container) => container?.env[BUILDER_SLUG_ENV])?.env[BUILDER_SLUG_ENV];
  if (!volume || !slug) return null;
  return {
    slug, dataDir: volumeHostPath(stateRoot, volume), marker: `${stateRoot}/${HOME_CHECKPOINT_MARKER}`,
    desktopDir: `${stateRoot}/desktop-home`, restorePending: `${stateRoot}/${HOME_RESTORE_PENDING}`,
  };
}

export function tarCreateArgs(archive: string, scope: HomeScope, desktopPaths: readonly string[]): string[] {
  return [
    "--create",
    "--gzip",
    "--numeric-owner",
    `--file=${archive}`,
    ...HOME_CHECKPOINT_EXCLUDES.map((name) => `--exclude=${name}`),
    `--directory=${scope.dataDir}/..`, "data",
    `--directory=${scope.desktopDir}/..`,
    ...desktopPaths.map((path) => `desktop-home/${path}`),
  ];
}

export function tarExtractArgs(archive: string, dataDir: string): string[] {
  return ["--extract", "--gzip", "--numeric-owner", "--same-owner", "--same-permissions", `--file=${archive}`, `--directory=${dataDir}`];
}

export function findDirtyArgs(dataDir: string, marker: string): string[] {
  const prune = HOME_CHECKPOINT_EXCLUDES.flatMap((name, index) => (index === 0 ? ["-name", name] : ["-o", "-name", name]));
  return [dataDir, "(", ...prune, ")", "-prune", "-o", "-newer", marker, "-print", "-quit"];
}

async function sh(deps: HomeCheckpointDeps, command: string, args: string[], okCodes: readonly number[]): Promise<string> {
  const result = await deps.shell.run(command, args);
  if (!okCodes.includes(result.code)) {
    throw new Error(`${command} ${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim().slice(-300)}`);
  }
  return result.stdout;
}

export async function homeIsDirty(deps: HomeCheckpointDeps, scope: HomeScope): Promise<boolean> {
  if (!(await deps.fs.exists(scope.marker))) return true;
  const changed = await sh(deps, "find", findDirtyArgs(scope.dataDir, scope.marker), [0]);
  if (changed.trim().length > 0) return true;
  for (const parent of [scope.desktopDir, `${scope.desktopDir}/.config`]) {
    if (await deps.fs.exists(parent) && (await sh(deps, "find", [parent, "-maxdepth", "0", "-newer", scope.marker, "-print"], [0])).trim()) return true;
  }
  for (const path of DESKTOP_HOME_PATHS) {
    const target = `${scope.desktopDir}/${path}`;
    if (!(await deps.fs.exists(target))) continue;
    if ((await sh(deps, "find", findDirtyArgs(target, scope.marker), [0])).trim()) return true;
  }
  return false;
}

async function post<T>(deps: HomeCheckpointDeps, path: string, body: Record<string, unknown>, label: string): Promise<T> {
  const res = await brokerPost(deps, `computer-home/${path}`, body);
  if (!res.ok) throw await brokerFailure(label, res);
  return (await res.json()) as T;
}

async function pruneCheckpoints(deps: HomeCheckpointDeps, slug: string): Promise<number | null> {
  try {
    const pruned = await post<FleetBrokerComputerHomePruneResult>(deps, "prune", { slug }, "computer-home prune");
    return pruned.deleted;
  } catch (err) {
    deps.log(`[vm-agent] home checkpoint prune failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function checkpointHome(deps: HomeCheckpointDeps, scope: HomeScope, opts: { force: boolean; requestedAt?: number | null }): Promise<HomeCheckpointResult> {
  if (!opts.force && !(await homeIsDirty(deps, scope))) return { status: "clean" };
  const startedAt = deps.now();
  const tempDir = await deps.fs.mkdtemp("octogee-home-checkpoint-");
  const archive = `${tempDir}/home.tar.gz`;
  try {
    await deps.snapshot(async () => {
      const desktopPaths: string[] = [];
      for (const path of DESKTOP_HOME_PATHS) {
        if (await deps.fs.exists(`${scope.desktopDir}/${path}`)) desktopPaths.push(path);
      }
      await sh(deps, "sync", ["-f", scope.dataDir], [0]);
      await sh(deps, "tar", tarCreateArgs(archive, scope, desktopPaths), [0]);
    });
    const size = await deps.fs.fileSize(archive);
    if (size <= 0) throw new Error("home checkpoint archive is empty");
    if (size > COMPUTER_HOME_CHECKPOINT_MAX_BYTES) {
      throw new Error(`home checkpoint archive is ${size} bytes, over the ${COMPUTER_HOME_CHECKPOINT_MAX_BYTES} byte cap`);
    }
    const sha256 = await deps.fs.sha256(archive);
    const signed = await post<FleetBrokerComputerHomeCheckpointUrl>(deps, "checkpoint-url", { slug: scope.slug, size }, "computer-home checkpoint-url");
    if (!COMPUTER_HOME_CHECKPOINT_NAME_RE.test(signed.name)) throw new Error(`computer-home checkpoint-url returned an invalid name ${signed.name}`);
    const upload = await deps.fetchImpl(signed.upload.url, {
      method: signed.upload.method,
      signal: AbortSignal.timeout(10 * 60_000),
      headers: { "content-type": COMPUTER_HOME_CHECKPOINT_CONTENT_TYPE, ...signed.upload.requiredHeaders },
      body: await deps.fs.uploadBody(archive),
    });
    if (!upload.ok) throw await brokerFailure("computer-home upload", upload);
    const committed = await post<FleetBrokerComputerHomeCheckpointCommit>(
      deps,
      "commit",
      { slug: scope.slug, name: signed.name, size, sha256, requestedAt: opts.requestedAt ?? null },
      "computer-home commit",
    );
    await deps.fs.touch(scope.marker, startedAt);
    const pruned = await pruneCheckpoints(deps, scope.slug);
    return { status: "uploaded", name: committed.name, size, pruned };
  } finally {
    await deps.fs.rm(tempDir);
  }
}

function validateHomeDownload(current: FleetBrokerComputerHomeDownload): void {
  if (!COMPUTER_HOME_CHECKPOINT_NAME_RE.test(current.name) || !SHA256_RE.test(current.sha256) || !Number.isSafeInteger(current.size) || current.size <= 0) {
    throw new Error("computer-home download-url returned an invalid checkpoint record");
  }
}

export async function restoreHome(deps: HomeCheckpointDeps, scope: HomeScope): Promise<HomeRestoreResult> {
  const pending = await deps.fs.exists(scope.restorePending);
  if (!pending && (await deps.fs.listDir(scope.dataDir)).length > 0) return { status: "preserved" };
  const res = await brokerPost(deps, "computer-home/download-url", { slug: scope.slug });
  if (res.status === 404) {
    if (pending) throw new Error("home restore is incomplete but its checkpoint is unavailable");
    return { status: "none" };
  }
  if (!res.ok) throw await brokerFailure("computer-home download-url", res);
  const current = (await res.json()) as FleetBrokerComputerHomeDownload;
  validateHomeDownload(current);
  const tempDir = await deps.fs.mkdtemp("octogee-home-restore-");
  const archive = `${tempDir}/home.tar.gz`;
  const staged = `${tempDir}/staged`;
  try {
    const download = await deps.fetchImpl(current.download.url, { method: current.download.method, signal: AbortSignal.timeout(10 * 60_000) });
    if (!download.ok) throw await brokerFailure("computer-home download", download);
    await deps.fs.saveResponse(download, archive);
    const size = await deps.fs.fileSize(archive);
    if (size !== current.size) throw new Error(`home checkpoint ${current.name} downloaded ${size} bytes, expected ${current.size}`);
    const sha256 = await deps.fs.sha256(archive);
    if (sha256 !== current.sha256) throw new Error(`home checkpoint ${current.name} sha256 mismatch`);
    await deps.fs.mkdir(staged);
    await sh(deps, "tar", tarExtractArgs(archive, staged), [0]);
    if (!(await deps.fs.exists(`${staged}/data`))) throw new Error("home checkpoint has no gateway data directory");
    await deps.desktop.run("stop");
    await deps.fs.touch(scope.restorePending, deps.now());
    await deps.fs.replaceDirectory(`${staged}/data`, scope.dataDir);
    for (const path of DESKTOP_HOME_PATHS) {
      const source = `${staged}/desktop-home/${path}`;
      if (await deps.fs.exists(source)) await deps.fs.replaceDirectory(source, `${scope.desktopDir}/${path}`);
    }
    await deps.fs.touch(scope.marker, deps.now());
    await deps.fs.rm(scope.restorePending);
    await deps.desktop.run("start");
    return { status: "restored", name: current.name, size };
  } finally {
    await deps.fs.rm(tempDir);
  }
}
