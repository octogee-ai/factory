import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("agent-anchor-restore");
import { pathToFileURL } from "node:url";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";
import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { readOpenClawConfig } from "@octogee/core/config";
import {
  landAgentAnchors,
  landGatewayStateAnchor,
  verifyAgentAnchorInPostgres,
  type AgentAnchorVerifier,
  type GatewayStateAnchorVerifier,
} from "../lib/agent-anchor-record.js";
import { clusterBuilderGateway, openclawStateRoot } from "../lib/openclaw-state-store.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";

export interface AgentAnchorRestoreResult {
  landed: string[];
  preserved: string[];
  state?: "landed" | "preserved";
  skipped: boolean;
}

function nonBlank(value: string | undefined): string {
  return value?.trim() ?? "";
}

export async function runAgentAnchorRestore(input: {
  env?: NodeJS.ProcessEnv;
  broker: Pick<FleetBrokerClient, "readAgentAnchors">;
  readConfig?: () => unknown;
  verify?: AgentAnchorVerifier;
  verifyState?: GatewayStateAnchorVerifier;
  log: (message: string) => void;
}): Promise<AgentAnchorRestoreResult> {
  const env = input.env ?? process.env;
  const slug = nonBlank(env.GATEWAY_CLASS) === "shared" ? null : builderClaimSlug(env);
  if (!slug) return { landed: [], preserved: [], skipped: true };
  const configured = new Set(agentIdsFromConfig((input.readConfig ?? readOpenClawConfig)()));
  const { anchors, state } = await input.broker.readAgentAnchors({ slug });
  const stateRoot = openclawStateRoot(env);
  const result = await landAgentAnchors(
    stateRoot,
    anchors.filter((anchor) => configured.has(anchor.agentId)),
    input.verify ?? verifyAgentAnchorInPostgres,
  );
  input.log(`[agent-anchors] landed ${result.landed.length} agent anchor(s) for ${slug}; ${result.preserved.length} already present; ${anchors.length} recorded`);
  if (!state || !clusterBuilderGateway(env)) return { ...result, skipped: false };
  const landedState = await landGatewayStateAnchor(stateRoot, state, input.verifyState);
  input.log(`[agent-anchors] gateway state anchor for ${slug} ${landedState === "landed" ? "landed" : "already present"}`);
  return { ...result, state: landedState, skipped: false };
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
