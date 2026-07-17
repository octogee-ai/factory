import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const COACH_AGENT_ID = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;

export interface EnsureConfiguredAgentRuntimeDirsOptions {
  configPath: string;
  agentsDir: string;
}

function configuredCoachAgentIds(config: unknown): string[] {
  const agents = (config as { agents?: { list?: unknown } })?.agents?.list;
  if (!Array.isArray(agents)) return [];
  return [
    ...new Set(
      agents.flatMap((agent) => {
        const id = (agent as { id?: unknown })?.id;
        return typeof id === "string" && COACH_AGENT_ID.test(id) ? [id] : [];
      }),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function ensureConfiguredAgentRuntimeDirs(
  options: EnsureConfiguredAgentRuntimeDirsOptions,
): string[] {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(options.configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[agent-runtime] ${options.configPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const agentIds = configuredCoachAgentIds(config);
  for (const agentId of agentIds) {
    const agentDir = path.join(options.agentsDir, agentId, "agent");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(agentDir, 0o700);
  }
  return agentIds;
}

function main(): void {
  const openclawDir = process.env.OPENCLAW_DIR || "/home/node/.openclaw";
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH || path.join(openclawDir, "openclaw.json");
  const agentsDir =
    process.env.OPENCLAW_AGENTS_DIR || path.join(openclawDir, "agents");
  const agentIds = ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir });
  process.stderr.write(
    `[agent-runtime] ensured ${agentIds.length} configured coach runtime dir(s)\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
