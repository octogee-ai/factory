import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("configured-builder-bootstrap");
import { pathToFileURL } from "node:url";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";

import { hydrateConfiguredBuilderBootstrap } from "../lib/configured-builder-bootstrap.js";

export const HOBBY_DESKTOP_HOME = "/home/octo";

export interface ConfiguredBuilderBootstrapInput {
  openclawDir: string;
  gatewayId: string;
  slug: string;
  desktopHome?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function claimedSlug(env: NodeJS.ProcessEnv): string {
  const slug = builderClaimSlug(env);
  if (!slug) throw new Error("a Builder claim is required for the configured Builder bootstrap");
  return slug;
}

export function resolveConfiguredBuilderBootstrapInput(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredBuilderBootstrapInput {
  const hobbyComputer = env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_COMPUTER_DESKTOP === "x11";
  return {
    openclawDir: required(env, "OPENCLAW_DIR"),
    gatewayId: required(env, "GATEWAY_ID"),
    slug: claimedSlug(env),
    ...(hobbyComputer ? { desktopHome: HOBBY_DESKTOP_HOME } : {}),
  };
}

export async function runConfiguredBuilderBootstrap(
  options: {
    env?: NodeJS.ProcessEnv;
    hydrate?: typeof hydrateConfiguredBuilderBootstrap;
  } = {},
): Promise<void> {
  await (options.hydrate ?? hydrateConfiguredBuilderBootstrap)(
    resolveConfiguredBuilderBootstrapInput(options.env),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConfiguredBuilderBootstrap().catch((error) => {
    runtimeLogger.error(
      `[configured-builder-bootstrap] Fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
