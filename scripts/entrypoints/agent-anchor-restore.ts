import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("agent-anchor-restore");
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";
import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { readOpenClawConfig } from "@octogee/core/config";
import { landAgentAnchors, verifyAgentAnchorInPostgres, type AgentAnchorVerifier } from "../lib/agent-anchor-record.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";

export interface AgentAnchorRestoreResult {
  landed: string[];
  preserved: string[];
  skipped: boolean;
}

function nonBlank(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function resolveAgentAnchorStateDir(env: NodeJS.ProcessEnv): string {
  const openclawDir = nonBlank(env.OPENCLAW_DIR) || path.join(env.HOME ?? "/home/node", ".openclaw");
  return nonBlank(env.OPENCLAW_STATE_DIR) || openclawDir;
}

export async function runAgentAnchorRestore(input: {
  env?: NodeJS.ProcessEnv;
  broker: Pick<FleetBrokerClient, "readAgentAnchors">;
  readConfig?: () => unknown;
  verify?: AgentAnchorVerifier;
  log: (message: string) => void;
}): Promise<AgentAnchorRestoreResult> {
  const env = input.env ?? process.env;
  const slug = nonBlank(env.GATEWAY_CLASS) === "shared" ? null : builderClaimSlug(env);
  if (!slug) return { landed: [], preserved: [], skipped: true };
  const configured = new Set(agentIdsFromConfig((input.readConfig ?? readOpenClawConfig)()));
  const { anchors } = await input.broker.readAgentAnchors({ slug });
  const result = await landAgentAnchors(
    resolveAgentAnchorStateDir(env),
    anchors.filter((anchor) => configured.has(anchor.agentId)),
    input.verify ?? verifyAgentAnchorInPostgres,
  );
  input.log(`[agent-anchors] landed ${result.landed.length} agent anchor(s) for ${slug}; ${result.preserved.length} already present; ${anchors.length} recorded`);
  return { ...result, skipped: false };
}

async function main(): Promise<void> {
  try {
    await runAgentAnchorRestore({
      broker: createFleetBrokerClient(nonBlank(process.env.GATEWAY_ID)),
      log: runtimeLogger.info,
    });
  } catch (error) {
    runtimeLogger.error(`[agent-anchors] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
