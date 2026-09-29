import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertCarriedAgentSessionsDrained, listSqliteStores } from "./agent-store-carry.js";
import { upgradeStagedAgentStores } from "./agent-store-upgrade.js";
import { assertNotHeld, matchFiles, sqliteFamily } from "./held-files.js";
import { runOpenClaw, type OpenClawCommand, type OpenClawCommandResult } from "./openclaw-cli.js";

export const AGENT_STORE_BASENAME = "openclaw-agent.sqlite";
export const AGENT_SNAPSHOT_DIRNAME = ".octogee-snapshot";
export const AGENT_IMPORT_DIRNAME = ".octogee-import";

export const LIVE_AGENT_STORE_EXCLUDE_ARGS = [
  `--exclude=${AGENT_STORE_BASENAME}`,
  `--exclude=${AGENT_STORE_BASENAME}-*`,
];

export interface PortableAgentStore {
  agentId: string;
  agentDir: string;
  sourceAgentDir: string;
}

interface SnapshotCommandContext {
  run?: OpenClawCommand;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function agentIdOfStateRelativePath(relative: string): string | null {
  const segments = relative.split("/");
  return segments[0] === "agents" && segments.length >= 3 ? segments[1]! : null;
}

export async function findPortableAgentStores(
  sources: ReadonlyArray<{ cwd: string; path: string }>,
): Promise<PortableAgentStore[]> {
  const byAgent = new Map<string, PortableAgentStore>();
  for (const source of sources) {
    for (const store of await listSqliteStores(path.join(source.cwd, source.path))) {
      const relative = posixRelative(source.cwd, store);
      const agentId = agentIdOfStateRelativePath(relative);
      if (agentId === null) continue;
      if (path.posix.basename(relative) !== AGENT_STORE_BASENAME) {
        throw new Error(`unexpected OpenClaw SQLite store in agent state: ${relative}`);
      }
      const agentDir = path.posix.dirname(relative);
      const sourceAgentDir = path.resolve(path.dirname(store));
      const existing = byAgent.get(agentId);
      if (existing && existing.sourceAgentDir !== sourceAgentDir) {
        throw new Error(`agent ${agentId} has more than one database: ${existing.sourceAgentDir}, ${sourceAgentDir}`);
      }
      byAgent.set(agentId, { agentId, agentDir, sourceAgentDir });
    }
  }
  return [...byAgent.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

function parseOkJson(label: string, result: OpenClawCommandResult): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`OpenClaw ${label} returned invalid JSON (exit ${result.code})`);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  if (result.code !== 0 || record.ok !== true) {
    const error = record.error as { message?: unknown } | undefined;
    const message = typeof error?.message === "string" ? error.message : `exit ${result.code}`;
    throw new Error(`OpenClaw ${label} failed: ${message}`);
  }
  return record;
}

export async function exportAgentStoreSnapshots(
  input: Pick<SnapshotCommandContext, "run" | "signal"> & {
    sources: ReadonlyArray<{ cwd: string; path: string }>;
    exportRoot: string;
  },
): Promise<Array<{ cwd: string; path: string }>> {
  const run = input.run ?? runOpenClaw;
  const stores = await findPortableAgentStores(input.sources);
  if (stores.length === 0) return [];
  const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "octogee-store-snapshot-")));
  const configPath = path.join(privateRoot, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1",
    OPENCLAW_STATE_DIR: privateRoot, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_CONFIG_READONLY: "1",
  };
  const carried: Array<{ cwd: string; path: string }> = [];
  try {
    await fs.writeFile(configPath, JSON.stringify({
      plugins: { enabled: false },
      agents: { entries: Object.fromEntries(stores.map((store) => [store.agentId, { agentDir: store.sourceAgentDir }])) },
    }), { mode: 0o600 });
    for (const store of stores) {
      input.signal?.throwIfAborted();
      const repositoryRelative = path.posix.join(store.agentDir, AGENT_SNAPSHOT_DIRNAME);
      const repository = path.join(input.exportRoot, ...repositoryRelative.split("/"));
      await fs.mkdir(repository, { recursive: true, mode: 0o700 });
      const result = parseOkJson(
        `snapshot of ${store.agentId}`,
        await run(
          ["backup", "sqlite", "create", "--agent", store.agentId, "--repository", repository, "--json"],
          { env, signal: input.signal },
        ),
      );
      if (typeof result.snapshotPath !== "string" || path.dirname(result.snapshotPath) !== repository) {
        throw new Error(`OpenClaw snapshot of ${store.agentId} was not published in ${repository}`);
      }
      carried.push({ cwd: input.exportRoot, path: repositoryRelative });
    }
    return carried;
  } finally {
    await fs.rm(privateRoot, { recursive: true, force: true });
  }
}

export interface StagedAgentSnapshot {
  agentId: string;
  agentDir: string;
  snapshotDir: string;
}

export async function findStagedAgentSnapshots(stageDir: string): Promise<StagedAgentSnapshot[]> {
  const found: StagedAgentSnapshot[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.name !== AGENT_SNAPSHOT_DIRNAME) {
        await walk(absolute);
        continue;
      }
      const agentDir = posixRelative(stageDir, dir);
      const agentId = agentIdOfStateRelativePath(`${agentDir}/${AGENT_STORE_BASENAME}`);
      if (agentId === null) throw new Error(`staged agent snapshot outside agent state: ${agentDir}`);
      const snapshots = (await fs.readdir(absolute, { withFileTypes: true })).filter((item) => item.isDirectory());
      if (snapshots.length !== 1) {
        throw new Error(`staged agent ${agentId} must carry exactly one snapshot (found ${snapshots.length})`);
      }
      if (found.some((item) => item.agentId === agentId)) {
        throw new Error(`staged agent ${agentId} carries more than one snapshot directory`);
      }
      found.push({ agentId, agentDir, snapshotDir: path.join(absolute, snapshots[0]!.name) });
    }
  }
  await walk(stageDir);
  return found.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export async function findStagedLiveAgentStores(stageDir: string): Promise<string[]> {
  const live: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name === AGENT_STORE_BASENAME || entry.name.startsWith(`${AGENT_STORE_BASENAME}-`)) {
        live.push(posixRelative(stageDir, absolute));
      }
    }
  }
  await walk(stageDir);
  return live.sort();
}

export interface PreparedAgentStore {
  agentId: string;
  restoredPath: string;
  destinationPath: string;
}

export interface PreparedAgentStores {
  landingRoot: string | null;
  stores: PreparedAgentStore[];
}

export async function prepareAgentStoreSnapshots(
  input: SnapshotCommandContext & {
    stageDir: string;
    importDir: string;
    migrationId: string;
    requireDrained: boolean;
    log?: (message: string) => void;
  },
): Promise<PreparedAgentStores> {
  const run = input.run ?? runOpenClaw;
  const env = input.env ?? process.env;
  const snapshots = await findStagedAgentSnapshots(input.stageDir);
  if (snapshots.length === 0) return { landingRoot: null, stores: [] };
  const importRoot = path.join(input.importDir, AGENT_IMPORT_DIRNAME);
  const landingRoot = path.join(importRoot, input.migrationId);
  await fs.mkdir(importRoot, { recursive: true, mode: 0o700 });
  await fs.rm(landingRoot, { recursive: true, force: true });
  await fs.mkdir(landingRoot, { mode: 0o700 });
  const stores: PreparedAgentStore[] = [];
  for (const snapshot of snapshots) {
    parseOkJson(
      `verify of ${snapshot.agentId}`,
      await run(["backup", "sqlite", "verify", snapshot.snapshotDir, "--json"], { env, signal: input.signal }),
    );
    const restoredDir = path.join(landingRoot, ...snapshot.agentDir.split("/"));
    await fs.mkdir(restoredDir, { recursive: true, mode: 0o700 });
    const restoredPath = path.join(restoredDir, AGENT_STORE_BASENAME);
    parseOkJson(
      `restore of ${snapshot.agentId}`,
      await run(
        ["backup", "sqlite", "restore", snapshot.snapshotDir, "--target", restoredPath, "--json"],
        { env, signal: input.signal },
      ),
    );
    await fs.rm(path.dirname(snapshot.snapshotDir), { recursive: true, force: true });
    stores.push({
      agentId: snapshot.agentId,
      restoredPath,
      destinationPath: path.join(input.importDir, ...snapshot.agentDir.split("/"), AGENT_STORE_BASENAME),
    });
  }
  await upgradeStagedAgentStores(landingRoot, { signal: input.signal, log: input.log });
  if (input.requireDrained) await assertCarriedAgentSessionsDrained(landingRoot);
  input.log?.(`[agent-store-snapshot] restored ${stores.length} carried agent database(s)`);
  return { landingRoot, stores };
}

async function existingFamilyFiles(databasePath: string): Promise<string[]> {
  const existing: string[] = [];
  for (const file of sqliteFamily(databasePath)) {
    try {
      await fs.lstat(file);
      existing.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

export async function installPreparedAgentStores(input: {
  prepared: PreparedAgentStores;
  releaseAgent: (agentId: string) => Promise<void>;
  procRoot: string;
  log?: (message: string) => void;
}): Promise<void> {
  for (const store of input.prepared.stores) {
    const occupied = await existingFamilyFiles(store.destinationPath);
    if (occupied.length > 0) {
      input.log?.(`[agent-store-snapshot] releasing ${store.agentId} before replacing its database`);
      await input.releaseAgent(store.agentId);
      const family = sqliteFamily(store.destinationPath);
      await assertNotHeld(matchFiles(family), input.procRoot);
      for (const file of family) await fs.rm(file, { force: true });
    }
    await fs.mkdir(path.dirname(store.destinationPath), { recursive: true, mode: 0o700 });
    await fs.rename(store.restoredPath, store.destinationPath);
    await fs.chmod(store.destinationPath, 0o600);
  }
  if (input.prepared.landingRoot) await fs.rm(input.prepared.landingRoot, { recursive: true, force: true });
}

export function isAgentSnapshotArtifact(storePath: string): boolean {
  return storePath.split(path.sep).includes(AGENT_SNAPSHOT_DIRNAME);
}
