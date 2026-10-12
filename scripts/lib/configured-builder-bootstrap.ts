import type {
  FleetBrokerConfiguredBuilderBootstrap,
  FleetBrokerConfiguredBuilderDesk,
  FleetBrokerConfiguredBuilderProjectCredential,
} from "../../shared/types/fleet-broker.js";
import { isValidProjectId, projectAgentId } from "../../shared/types/identity.js";
import {
  createFleetBrokerClient,
  type FleetBrokerClient,
} from "./fleet-broker-client.js";
import { MalformedDeskFileError, localDeskIdentityFs, parseDeskIdentity, writeDeskIdentity } from "./desk-identity.js";
import { updateMattermostAccountSecrets } from "./mattermost-account-secrets.js";

interface ConfiguredBuilderBootstrapInput {
  openclawDir: string;
  gatewayId: string;
  slug: string;
  desktopHome?: string;
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
  writeDesk?: (desktopHome: string, desk: FleetBrokerConfiguredBuilderDesk) => Promise<{ written: boolean }>;
  log?: (message: string) => void;
}

function matchesProjectCredential(
  value: unknown,
  slug: string,
  seen: Set<string>,
): value is FleetBrokerConfiguredBuilderProjectCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<FleetBrokerConfiguredBuilderProjectCredential>;
  if (
    !isValidProjectId(credential.projectId) ||
    credential.agentId !== projectAgentId(slug, credential.projectId) ||
    credential.accountId !== `${slug}-proj-${credential.projectId}` ||
    typeof credential.token !== "string" ||
    credential.token.length === 0 ||
    seen.has(credential.projectId)
  ) return false;
  seen.add(credential.projectId);
  return true;
}

function matchesConfiguredBuilder(
  bootstrap: FleetBrokerConfiguredBuilderBootstrap,
  slug: string,
): boolean {
  if (bootstrap.slug !== slug) return false;
  if (
    bootstrap.agentId !== `octogee-${slug}-coach` ||
    bootstrap.accountId !== `${slug}-coach` ||
    typeof bootstrap.coachToken !== "string" ||
    bootstrap.coachToken.length === 0 ||
    !Array.isArray(bootstrap.projectCredentials)
  ) return false;
  const seen = new Set<string>();
  for (const credential of bootstrap.projectCredentials) {
    if (!matchesProjectCredential(credential, slug, seen)) return false;
  }
  return true;
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
  const writeDesk = dependencies.writeDesk ?? ((desktopHome, desk) => writeDeskIdentity(localDeskIdentityFs, desktopHome, desk));
  const log = dependencies.log ?? ((message: string) => console.error(message));
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
  const desk = input.desktopHome === undefined ? null : requireDesk(bootstrap);
  const projectSecrets = Object.fromEntries(
    bootstrap.projectCredentials.map((credential) => [
      credential.accountId,
      credential.token,
    ]),
  );
  await writeSecrets(input.openclawDir, {
    removePrefixes: [`${input.slug}-proj-`],
    set: {
      [bootstrap.accountId]: bootstrap.coachToken,
      ...projectSecrets,
    },
  });
  if (input.desktopHome !== undefined && desk) await writeDeskReportingCorruption(writeDesk, log, input.desktopHome, desk);
}

async function writeDeskReportingCorruption(
  writeDesk: NonNullable<ConfiguredBuilderBootstrapDependencies["writeDesk"]>,
  log: (message: string) => void,
  desktopHome: string,
  desk: FleetBrokerConfiguredBuilderDesk,
): Promise<void> {
  try {
    await writeDesk(desktopHome, desk);
  } catch (error) {
    if (!(error instanceof MalformedDeskFileError)) throw error;
    log(`[configured-builder-bootstrap] ${error.message}; writing a fresh Desk without the stored note`);
    await writeDesk(desktopHome, desk);
  }
}

function requireDesk(bootstrap: FleetBrokerConfiguredBuilderBootstrap): FleetBrokerConfiguredBuilderDesk {
  const desk = parseDeskIdentity(bootstrap.desk);
  if (!desk) throw new Error("configured builder bootstrap carries no valid desk identity");
  return desk;
}
