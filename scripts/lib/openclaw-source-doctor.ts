import * as fs from "node:fs/promises";
import * as path from "node:path";
import { preflightAgentDatabase } from "./agent-store-preflight.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";

export async function verifySourceDoctorAgentStores(agentIds: string[], input: {
  env?: NodeJS.ProcessEnv;
  run?: OpenClawCommand;
} = {}): Promise<void> {
  if (agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) throw new Error("source Doctor requires a unique nonempty agent roster");
  const env = input.env ?? process.env;
  const root = await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || "/home/node/.openclaw");
  for (const agentId of agentIds) {
    if (!/^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(agentId)) throw new Error("source Doctor agent identity is invalid");
    let directory = root;
    for (const part of ["agents", agentId, "agent"]) {
      directory = path.join(directory, part);
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`source Doctor agent directory is not canonical: ${agentId}`);
    }
    const file = path.join(directory, "openclaw-agent.sqlite"), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`source Doctor agent store is not canonical: ${agentId}`);
    const fit = await preflightAgentDatabase(file, agentId, input.run ?? runOpenClaw, {
      env: { ...env, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_READONLY: "1" },
    });
    if (fit !== "exact") throw new Error(`source Doctor left ${agentId} incompatible with the installed native runtime`);
  }
}
