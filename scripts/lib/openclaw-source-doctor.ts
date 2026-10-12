import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exportAgentStoreSnapshots, findStagedAgentSnapshots } from "./agent-store-snapshot.js";
import { preflightAgentDatabase } from "./agent-store-preflight.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";

async function assertCanonicalSources(agentIds: string[], root: string): Promise<void> {
  for (const agentId of agentIds) {
    if (!/^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(agentId)) throw new Error("source Doctor agent identity is invalid");
    let directory = root;
    for (const part of ["agents", agentId, "agent"]) {
      directory = path.join(directory, part);
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`source Doctor agent directory is not canonical: ${agentId}`);
    }
    const file = path.join(directory, "openclaw-agent.sqlite"), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`source Doctor agent store is not canonical: ${agentId}`);
  }
}

export async function verifySourceDoctorAgentStores(agentIds: string[], input: {
  env?: NodeJS.ProcessEnv;
  run?: OpenClawCommand;
} = {}): Promise<void> {
  if (agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) throw new Error("source Doctor requires a unique nonempty agent roster");
  const env = input.env ?? process.env;
  const root = await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || "/home/node/.openclaw");
  await assertCanonicalSources(agentIds, root);
  const verificationRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-verification-")));
  const exportRoot = path.join(verificationRoot, "snapshots"), configPath = path.join(verificationRoot, "openclaw.json");
  const run = input.run ?? runOpenClaw;
  try {
    await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false }, agents: { ownership: "explicit", entries: {} } }), { mode: 0o600 });
    await exportAgentStoreSnapshots({ run, exportRoot, sources: agentIds.map(agentId => ({
      cwd: root, path: `agents/${agentId}/agent/openclaw-agent.sqlite`,
    })) });
    const snapshots = await findStagedAgentSnapshots(exportRoot);
    if (snapshots.length !== agentIds.length || snapshots.some(snapshot => !agentIds.includes(snapshot.agentId))) {
      throw new Error("source Doctor snapshot roster changed");
    }
    for (const snapshot of snapshots) {
      const fit = await preflightAgentDatabase(path.join(snapshot.snapshotDir, "database.sqlite"), snapshot.agentId, run, {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", OPENCLAW_STATE_DIR: verificationRoot,
          OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_CONFIG_READONLY: "1" },
      });
      if (fit !== "exact") throw new Error(`source Doctor left ${snapshot.agentId} incompatible with the installed native runtime`);
    }
  } finally {
    await fs.rm(verificationRoot, { recursive: true, force: true });
  }
}
