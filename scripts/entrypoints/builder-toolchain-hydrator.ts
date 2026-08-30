import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { DeveloperToolchainStatusArtifact } from "../../shared/types/developer-toolchain.js";
import {
  hydrateBuilderToolchain,
  runBuilderToolchainHydrationLoop,
  writeToolchainStatus,
} from "../lib/builder-toolchain-hydrator.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";

export interface BuilderToolchainHydratorConfig {
  root: string;
  manifestPath: string;
  manifestSha256: string;
  artifactUrl: string;
  gatewayId: string;
  builderSlug: string;
  readinessUrl: string;
}

export function resolveBuilderToolchainHydratorConfig(
  env: NodeJS.ProcessEnv = process.env,
): BuilderToolchainHydratorConfig {
  const home = env.HOME?.trim() || "/home/node";
  const fleetControllerPort = env.FLEET_CONTROLLER_PORT?.trim() || "3003";
  return {
    root: path.join(home, ".octogee", "toolchains"),
    manifestPath: env.OCTOGEE_BUILDER_TOOLCHAIN_MANIFEST_PATH?.trim() || "",
    manifestSha256: env.OCTOGEE_BUILDER_TOOLCHAIN_MANIFEST_SHA256?.trim() || "",
    artifactUrl: env.OCTOGEE_BUILDER_TOOLCHAIN_ARTIFACT_URL?.trim() || "",
    gatewayId: env.GATEWAY_ID?.trim() || "",
    builderSlug: env.GATEWAY_BUILDER_SLUG?.trim() || "",
    readinessUrl: `http://127.0.0.1:${fleetControllerPort}/surge-ready`,
  };
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
  client?: Pick<FleetBrokerClient, "uidForSlug" | "setToolchainStatus">;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? console.error;
  const client = input.client ?? createFleetBrokerClient(input.config.gatewayId);
  const publishStatus = createBuilderToolchainStatusPublisher({
    client,
    builderSlug: input.config.builderSlug,
  });
  const writeStatus = (status: DeveloperToolchainStatusArtifact["status"]): Promise<void> =>
    writeToolchainStatus(input.config.root, statusArtifact(status), { publishStatus, log });

  await runBuilderToolchainHydrationLoop({
    probeInteractiveReadiness: () => probeBuilderInteractiveReadiness(input.config.readinessUrl),
    hydrate: (attempt) => hydrateBuilderToolchain({
      root: input.config.root,
      manifestPath: input.config.manifestPath,
      manifestSha256: input.config.manifestSha256,
      artifactUrl: input.config.artifactUrl,
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
