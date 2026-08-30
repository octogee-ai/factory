import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { DeveloperToolchainStatusArtifact } from "../../shared/types/developer-toolchain.js";
import type { FleetBrokerNpmRegistryCredentials } from "../../shared/types/fleet-broker.js";
import {
  DEFAULT_BUILDER_NPM_FALLBACK_REGISTRY,
  hydrateBuilderToolchain,
  runBuilderToolchainHydrationLoop,
  writeToolchainStatus,
} from "../lib/builder-toolchain-hydrator.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";

export interface BuilderToolchainHydratorConfig {
  root: string;
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  fallbackRegistryUrl: string;
  gatewayId: string;
  builderSlug: string;
  readinessUrl: string;
}

function envValue(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

export function resolveBuilderToolchainHydratorConfig(
  env: NodeJS.ProcessEnv = process.env,
): BuilderToolchainHydratorConfig {
  const home = envValue(env, "HOME", "/home/node");
  const fleetControllerPort = envValue(env, "FLEET_CONTROLLER_PORT", "3003");
  return {
    root: path.join(home, ".octogee", "toolchains"),
    packageJsonPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_JSON_PATH",
      "/octogee/toolchain/package.json",
    ),
    packageLockPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH",
      "/octogee/toolchain/package-lock.json",
    ),
    packageLockSha256: envValue(env, "OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256"),
    fallbackRegistryUrl: envValue(
      env,
      "OCTOGEE_BUILDER_NPM_FALLBACK_REGISTRY",
      DEFAULT_BUILDER_NPM_FALLBACK_REGISTRY,
    ),
    gatewayId: envValue(env, "GATEWAY_ID"),
    builderSlug: envValue(env, "GATEWAY_BUILDER_SLUG"),
    readinessUrl: `http://127.0.0.1:${fleetControllerPort}/surge-ready`,
  };
}

export function createBuilderNpmProxyCredentialsProvider(input: {
  client: Pick<FleetBrokerClient, "npmRegistryCredentials">;
  builderSlug: string;
}): () => Promise<FleetBrokerNpmRegistryCredentials> {
  return () => input.client.npmRegistryCredentials(input.builderSlug);
}

export function createBuilderToolchainStatusPublisher(input: {
  client: Pick<FleetBrokerClient, "uidForSlug" | "setToolchainStatus">;
  builderSlug: string;
}): (artifact: DeveloperToolchainStatusArtifact) => Promise<void> {
  let uidPromise: Promise<string> | null = null;
  const assignedUid = (): Promise<string> => {
    uidPromise ??= input.client.uidForSlug(input.builderSlug)
      .then((uid) => {
        if (!uid) throw new Error("configured Builder is not assigned to this gateway");
        return uid;
      })
      .catch((error) => {
        uidPromise = null;
        throw error;
      });
    return uidPromise;
  };
  return async (artifact) => {
    const uid = await assignedUid();
    await input.client.setToolchainStatus(uid, artifact.status);
  };
}

export async function probeBuilderInteractiveReadiness(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function statusArtifact(status: DeveloperToolchainStatusArtifact["status"]): DeveloperToolchainStatusArtifact {
  return { schemaVersion: 1, status, updatedAt: new Date().toISOString() };
}

const abortableSleep = (signal: AbortSignal) => (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function runBuilderToolchainHydrator(input: {
  config: BuilderToolchainHydratorConfig;
  client?: Pick<
    FleetBrokerClient,
    "npmRegistryCredentials" | "uidForSlug" | "setToolchainStatus"
  >;
  signal?: AbortSignal;
  log?: (message: string) => void;
  registryCredentialsProvider?: () => Promise<FleetBrokerNpmRegistryCredentials>;
}): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? console.error;
  const client = input.client ?? createFleetBrokerClient(input.config.gatewayId);
  const publishStatus = createBuilderToolchainStatusPublisher({
    client,
    builderSlug: input.config.builderSlug,
  });
  const registryCredentialsProvider = input.registryCredentialsProvider
    ?? createBuilderNpmProxyCredentialsProvider({
      client,
      builderSlug: input.config.builderSlug,
    });
  const writeStatus = (status: DeveloperToolchainStatusArtifact["status"]): Promise<void> =>
    writeToolchainStatus(input.config.root, statusArtifact(status), { publishStatus, log });

  await runBuilderToolchainHydrationLoop({
    probeInteractiveReadiness: () => probeBuilderInteractiveReadiness(input.config.readinessUrl),
    hydrate: (attempt) => hydrateBuilderToolchain({
      root: input.config.root,
      packageJsonPath: input.config.packageJsonPath,
      packageLockPath: input.config.packageLockPath,
      packageLockSha256: input.config.packageLockSha256,
      fallbackRegistryUrl: input.config.fallbackRegistryUrl,
      registryCredentialsProvider,
      attempt,
      publishStatus,
      log,
      signal,
    }),
    writeStatus,
    sleep: abortableSleep(signal),
    waitAfterReady: () => new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    shouldStop: () => signal.aborted,
  });
}

async function main(): Promise<void> {
  const config = resolveBuilderToolchainHydratorConfig();
  if (!config.gatewayId || !config.builderSlug) {
    throw new Error("GATEWAY_ID and GATEWAY_BUILDER_SLUG are required for Builder toolchain hydration");
  }
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await runBuilderToolchainHydrator({ config, signal: controller.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[builder-toolchain] fatal runner error (${error instanceof Error ? error.name : typeof error})`);
    process.exit(1);
  });
}
