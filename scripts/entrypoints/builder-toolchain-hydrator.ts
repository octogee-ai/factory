import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("builder-toolchain-hydrator");
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { DeveloperToolchainStatusArtifact } from "../../shared/types/developer-toolchain.js";
import type { FleetBrokerNpmRegistryCredentials } from "../../shared/types/fleet-broker.js";
import {
  BUILDER_TOOLCHAIN_RUNTIME_RETIRED,
  BuilderToolchainHydrationError,
  DEFAULT_BUILDER_NPM_FALLBACK_REGISTRY,
  hydrateBuilderToolchain,
  runBuilderToolchainHydrationLoop,
  writeToolchainStatus,
} from "../lib/builder-toolchain-hydrator.js";
import {
  createFleetBrokerClient,
  isRetiredComputerBindingDenial,
  type FleetBrokerClient,
} from "../lib/fleet-broker-client.js";

export interface BuilderToolchainHydratorConfig {
  root: string;
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  groupsPath: string;
  groupsSha256: string;
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
    groupsPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOL_GROUPS_PATH",
      "/octogee/toolchain/groups.json",
    ),
    groupsSha256: envValue(env, "OCTOGEE_BUILDER_TOOL_GROUPS_SHA256"),
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

type HydratorBrokerClient = Pick<
  FleetBrokerClient,
  "npmRegistryCredentials" | "uidForSlug" | "setToolchainStatus"
>;

export function guardRetiredRuntimeBrokerClient(
  client: HydratorBrokerClient,
  log: (message: string) => void,
): HydratorBrokerClient {
  let retirement: unknown = null;
  const retiredError = (cause: unknown): BuilderToolchainHydrationError =>
    new BuilderToolchainHydrationError(BUILDER_TOOLCHAIN_RUNTIME_RETIRED, { cause });
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    if (retirement) throw retiredError(retirement);
    try {
      return await call();
    } catch (error) {
      if (!isRetiredComputerBindingDenial(error)) throw error;
      if (!retirement) {
        log(
          "[builder-toolchain] broker reports this computer's runtime retired; " +
            "stopping npm credential and toolchain status requests",
        );
      }
      retirement = error;
      throw retiredError(error);
    }
  };
  return {
    npmRegistryCredentials: (slug) => guard(() => client.npmRegistryCredentials(slug)),
    uidForSlug: (slug) => guard(() => client.uidForSlug(slug)),
    setToolchainStatus: (uid, status) => guard(() => client.setToolchainStatus(uid, status)),
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

export function createRetriableBuilderToolchainStatusPublication(input: {
  client: Pick<FleetBrokerClient, "uidForSlug" | "setToolchainStatus">;
  builderSlug: string;
}): {
  publishStatus: (artifact: DeveloperToolchainStatusArtifact) => Promise<void>;
  ensureReadyPublished: (artifact: DeveloperToolchainStatusArtifact) => Promise<void>;
} {
  const publishAssigned = createBuilderToolchainStatusPublisher(input);
  let publishedArtifactKey: string | null = null;
  const artifactKey = (artifact: DeveloperToolchainStatusArtifact): string =>
    `${artifact.schemaVersion}\0${artifact.status}\0${artifact.updatedAt}`;
  const publishStatus = async (artifact: DeveloperToolchainStatusArtifact): Promise<void> => {
    await publishAssigned(artifact);
    publishedArtifactKey = artifactKey(artifact);
  };
  return {
    publishStatus,
    async ensureReadyPublished(artifact) {
      if (publishedArtifactKey === artifactKey(artifact)) return;
      await publishStatus(artifact);
    },
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
  client?: HydratorBrokerClient;
  signal?: AbortSignal;
  log?: (message: string) => void;
  registryCredentialsProvider?: () => Promise<FleetBrokerNpmRegistryCredentials>;
}): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? runtimeLogger.info;
  const client = guardRetiredRuntimeBrokerClient(
    input.client ?? createFleetBrokerClient(input.config.gatewayId),
    log,
  );
  const publication = createRetriableBuilderToolchainStatusPublication({
    client,
    builderSlug: input.config.builderSlug,
  });
  const publishStatus = publication.publishStatus;
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
      groupsPath: input.config.groupsPath,
      groupsSha256: input.config.groupsSha256,
      fallbackRegistryUrl: input.config.fallbackRegistryUrl,
      registryCredentialsProvider,
      attempt,
      publishStatus,
      log,
      signal,
    }),
    ensureReadyPublished: async (artifact) => {
      try {
        await publication.ensureReadyPublished(artifact);
      } catch (error) {
        const retired = error instanceof BuilderToolchainHydrationError &&
          error.reasonCode === BUILDER_TOOLCHAIN_RUNTIME_RETIRED;
        if (!retired) {
          log(`[builder-toolchain] ready status publication unavailable; retrying error=${
            error instanceof Error ? error.message : String(error)
          }`);
        }
        throw error;
      }
    },
    writeStatus,
    log,
    sleep: abortableSleep(signal),
    waitForShutdown: () => new Promise((resolve) => {
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
    runtimeLogger.error(`[builder-toolchain] fatal runner error (${error instanceof Error ? error.name : typeof error})`);
    process.exit(1);
  });
}
