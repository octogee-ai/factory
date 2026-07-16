import type { FleetBrokerConfiguredBuilderBootstrap } from "../../shared/types/fleet-broker.js";
import {
  createFleetBrokerClient,
  type FleetBrokerClient,
} from "./fleet-broker-client.js";
import { updateMattermostAccountSecrets } from "./mattermost-account-secrets.js";

interface ConfiguredBuilderBootstrapInput {
  openclawDir: string;
  gatewayId: string;
  revisionId: string;
  slug: string;
}

interface ConfiguredBuilderBootstrapDependencies {
  createClient?: (
    gatewayId: string,
    revisionId: string,
  ) => Pick<FleetBrokerClient, "configuredBuilderBootstrap">;
  writeSecrets?: typeof updateMattermostAccountSecrets;
}

function matchesConfiguredBuilder(
  bootstrap: FleetBrokerConfiguredBuilderBootstrap,
  slug: string,
): boolean {
  return bootstrap.slug === slug &&
    bootstrap.agentId === `octogee-${slug}-coach` &&
    bootstrap.accountId === `${slug}-coach` &&
    bootstrap.coachToken.length > 0;
}

export async function hydrateConfiguredBuilderBootstrap(
  input: ConfiguredBuilderBootstrapInput,
  dependencies: ConfiguredBuilderBootstrapDependencies = {},
): Promise<void> {
  const createClient = dependencies.createClient ?? createFleetBrokerClient;
  const writeSecrets = dependencies.writeSecrets ?? updateMattermostAccountSecrets;
  const bootstrap = await createClient(
    input.gatewayId,
    input.revisionId,
  ).configuredBuilderBootstrap(input.slug);
  if (!matchesConfiguredBuilder(bootstrap, input.slug)) {
    throw new Error("configured builder bootstrap identity mismatch");
  }
  await writeSecrets(input.openclawDir, {
    set: { [bootstrap.accountId]: bootstrap.coachToken },
  });
}
