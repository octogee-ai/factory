import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";
import { pathToFileURL } from "node:url";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { landGatewayStateAnchor, type GatewayStateAnchorVerifier } from "../lib/agent-anchor-record.js";
import { localStateStoreKind, localStateStorePath, openclawStateRoot } from "../lib/openclaw-state-store.js";

const runtimeLogger = createServiceLogger("builder-runtime-state-restore");
class BuilderStatePolicyError extends Error {}

export async function runBuilderRuntimeStateRestore(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    broker?: Pick<FleetBrokerClient, "readAgentAnchors">;
    verifyState?: GatewayStateAnchorVerifier;
  } = {},
): Promise<void> {
  if (env.GATEWAY_CLASS !== "builder") return;
  const gatewayId = env.GATEWAY_ID?.trim();
  const slug = builderClaimSlug(env);
  if (!gatewayId || !slug) throw new BuilderStatePolicyError("Builder PostgreSQL state recovery requires a Gateway ID and verified claim");
  const stateDir = openclawStateRoot(env);
  const stateFile = localStateStorePath(stateDir);
  let kind: ReturnType<typeof localStateStoreKind>;
  try {
    kind = localStateStoreKind(stateFile);
  } catch (error) {
    throw new BuilderStatePolicyError(
      `Cannot inspect retained Builder state at ${stateFile}; repair the local state before restarting: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (kind === "sqlite") {
    throw new BuilderStatePolicyError("Retained SQLite Builder state requires an offline native database port --family state --to postgres; refusing checkpoint restore or engine-selector changes");
  }
  if (kind === "anchor") {
    runtimeLogger.info("restore preserved PostgreSQL state anchor");
    return;
  }
  const broker = dependencies.broker ?? createFleetBrokerClient(gatewayId);
  const { state } = await broker.readAgentAnchors({ slug });
  if (state) {
    await landGatewayStateAnchor(stateDir, state, dependencies.verifyState);
    runtimeLogger.info("restore recovered recorded PostgreSQL state anchor");
  } else {
    runtimeLogger.info("restore no recorded PostgreSQL state anchor");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuilderRuntimeStateRestore().catch((error: unknown) => {
    runtimeLogger.error(`[runtime-state] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof BuilderStatePolicyError ? 2 : 1;
  });
}
