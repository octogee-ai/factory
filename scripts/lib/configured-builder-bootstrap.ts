import type { FleetBrokerConfiguredBuilderBootstrap } from "../../shared/types/fleet-broker.js";
import {
  createFleetBrokerClient,
  type FleetBrokerClient,
} from "./fleet-broker-client.js";
import { updateMattermostAccountSecrets } from "./mattermost-account-secrets.js";

interface ConfiguredBuilderBootstrapInput {
  openclawDir: string;
  gatewayId: string;
  slug: string;
}

interface ConfiguredBuilderBootstrapDependencies {
  createClient?: (
    gatewayId: string,
  ) => Pick<
    FleetBrokerClient,
    | "configuredBuilderBootstrap"
    | "uidForSlug"
    | "provisionMattermost"
    | "setMattermostFields"
    | "setAgentIds"
  >;
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

function isConfiguredBuilderBootstrapUnavailable(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("→ 404") &&
    error.message.includes('"error":"configured_builder_bootstrap_unavailable"');
}

export async function hydrateConfiguredBuilderBootstrap(
  input: ConfiguredBuilderBootstrapInput,
  dependencies: ConfiguredBuilderBootstrapDependencies = {},
): Promise<void> {
  const createClient = dependencies.createClient ?? createFleetBrokerClient;
  const writeSecrets = dependencies.writeSecrets ?? updateMattermostAccountSecrets;
  const client = createClient(input.gatewayId);
  let bootstrap: FleetBrokerConfiguredBuilderBootstrap;
  try {
    bootstrap = await client.configuredBuilderBootstrap(input.slug);
  } catch (error) {
    if (!isConfiguredBuilderBootstrapUnavailable(error)) throw error;
    const uid = await client.uidForSlug(input.slug);
    if (!uid) throw new Error(`configured builder ${input.slug} has no assigned uid`);
    const mmUpdate = await client.provisionMattermost(uid);
    await client.setMattermostFields(uid, mmUpdate);
    await client.setAgentIds(uid, [`octogee-${input.slug}-coach`]);
    bootstrap = await client.configuredBuilderBootstrap(input.slug);
  }
  if (!matchesConfiguredBuilder(bootstrap, input.slug)) {
    throw new Error("configured builder bootstrap identity mismatch");
  }
  await writeSecrets(input.openclawDir, {
    set: { [bootstrap.accountId]: bootstrap.coachToken },
  });
}
