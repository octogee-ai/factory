import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pipeline } from "node:stream/promises";
import { configuredBuilderPortableStatePlan } from "@octogee/core/local-coach-wired";
import { checkpointSqliteStore } from "./agent-store-carry.js";
import { preflightAgentDatabase, type AgentSchemaFit } from "./agent-store-preflight.js";
import { assertNotHeld, matchFiles, PROC_ROOT, sqliteFamily } from "./held-files.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";

async function existingCanonicalFile(file: string) {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(file) !== file)) {
    throw new Error(`Builder store inspection requires a canonical regular file: ${file}`);
  }
  return stat;
}

async function configuredStores(stateDir: string, configPath: string) {
  const plan = configuredBuilderPortableStatePlan(configPath, stateDir);
  const stores: Array<{ agentId: string; file: string }> = [];
  for (const relative of plan.agentDirs) {
    let directory = stateDir;
    for (const part of relative.split("/")) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) break;
      if (!stat.isDirectory() || await fs.realpath(directory) !== directory) {
        throw new Error(`Builder store inspection requires a canonical directory: ${directory}`);
      }
    }
    const file = path.join(stateDir, relative, "openclaw-agent.sqlite");
    const family = await Promise.all(sqliteFamily(file).map(existingCanonicalFile));
    if (!family[0]) {
      if (family.some(Boolean)) throw new Error(`Builder store inspection found an orphaned SQLite sidecar: ${file}`);
      continue;
    }
    stores.push({ agentId: relative.split("/")[1]!, file });
  }
  return stores;
}

async function copyFamilyFile(source: string, destination: string): Promise<void> {
  const stat = await existingCanonicalFile(source);
  if (!stat) return;
  const fd = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Builder store changed during inspection");
    await pipeline(fd.createReadStream({ autoClose: false }), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    const after = await fd.stat(), current = await existingCanonicalFile(source);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current?.ino !== opened.ino || current.dev !== opened.dev) {
      throw new Error("Builder store changed during inspection");
    }
  } finally { await fd.close(); }
}

export async function inspectConfiguredBuilderAgentStores(input: {
  stateDir: string;
  configPath: string;
  run?: OpenClawCommand;
  procRoot?: string;
}): Promise<AgentSchemaFit> {
  const stateDir = path.resolve(input.stateDir);
  if (await fs.realpath(stateDir) !== stateDir) throw new Error("Builder store state root is not canonical");
  const stores = await configuredStores(stateDir, input.configPath);
  await assertNotHeld(matchFiles(stores.flatMap(store => sqliteFamily(store.file))), input.procRoot ?? PROC_ROOT, { ignoreReadOnlyConnections: true });
  if (stores.length === 0) return "exact";
  const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "builder-store-inspection-")));
  const configPath = path.join(privateRoot, "openclaw.json");
  let fit: AgentSchemaFit = "exact";
  try {
    await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false }, agents: { ownership: "explicit", entries: {} } }), { mode: 0o600 });
    for (const [index, store] of stores.entries()) {
      const directory = path.join(privateRoot, String(index)); await fs.mkdir(directory, { mode: 0o700 });
      const copy = path.join(directory, "database.sqlite");
      for (const suffix of ["", "-wal", "-journal"]) await copyFamilyFile(store.file + suffix, copy + suffix);
      checkpointSqliteStore(copy);
      for (const suffix of ["-wal", "-shm", "-journal"]) await fs.rm(copy + suffix, { force: true });
      const result = await preflightAgentDatabase(copy, store.agentId, input.run ?? runOpenClaw, {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", OPENCLAW_STATE_DIR: privateRoot,
          OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_CONFIG_READONLY: "1" },
      });
      if (result === "repair-required") fit = result;
    }
    return fit;
  } finally { await fs.rm(privateRoot, { recursive: true, force: true }); }
}
