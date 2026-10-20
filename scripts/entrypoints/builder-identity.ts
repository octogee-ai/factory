import { pathToFileURL } from "node:url";
import {
  BuilderClaimError,
  DEFAULT_OPENCLAW_DIR,
  builderClaimFromIdentity,
  writeBuilderClaim,
} from "@octogee/shared/server/builder-claim";
import type { BuilderIdentity } from "../../shared/types/builder-identity.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

export const BUILDER_IDENTITY_FATAL_EXIT = 2;

export type BuilderIdentityBootResult =
  | { exitCode: 0; builderSlug: string }
  | { exitCode: 1 | typeof BUILDER_IDENTITY_FATAL_EXIT };

export async function resolveBuilderIdentityBoot(input: {
  env: NodeJS.ProcessEnv;
  fetchIdentity: () => Promise<BuilderIdentity>;
  now: () => number;
  log: (message: string) => void;
}): Promise<BuilderIdentityBootResult> {
  const gatewayId = input.env.GATEWAY_ID?.trim();
  if (!gatewayId) {
    input.log("[builder-identity] FATAL: GATEWAY_ID is required");
    return { exitCode: BUILDER_IDENTITY_FATAL_EXIT };
  }
  let identity: BuilderIdentity;
  try {
    identity = await input.fetchIdentity();
  } catch (error) {
    input.log(`[builder-identity] broker read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  }
  if (identity.state !== "claimed") {
    const detail = identity.state === "unavailable" ? `unavailable (${identity.reason})` : identity.state;
    input.log(`[builder-identity] FATAL: gateway ${gatewayId} has no claimed Builder: ${detail}`);
    return { exitCode: BUILDER_IDENTITY_FATAL_EXIT };
  }
  try {
    const claim = writeBuilderClaim(
      input.env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR,
      builderClaimFromIdentity(identity, input.now()),
    );
    return { exitCode: 0, builderSlug: claim.builderSlug };
  } catch (error) {
    if (!(error instanceof BuilderClaimError)) throw error;
    input.log(`[builder-identity] FATAL: ${error.message}`);
    return { exitCode: BUILDER_IDENTITY_FATAL_EXIT };
  }
}

interface SlugOutput {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export async function runBuilderIdentityEntrypoint(input: Parameters<typeof resolveBuilderIdentityBoot>[0] & {
  stdout: SlugOutput;
}): Promise<number> {
  const result = await resolveBuilderIdentityBoot(input);
  if (result.exitCode !== 0) return result.exitCode;
  await new Promise<void>((resolve, reject) => {
    input.stdout.write(`${result.builderSlug}\n`, (error) => (error ? reject(error) : resolve()));
  });
  return 0;
}

async function main(): Promise<void> {
  const gatewayId = process.env.GATEWAY_ID?.trim() ?? "";
  const exitCode = await runBuilderIdentityEntrypoint({
    env: process.env,
    fetchIdentity: () => createFleetBrokerClient(gatewayId).builderIdentity(),
    now: Date.now,
    log: (message) => process.stderr.write(`${message}\n`),
    stdout: process.stdout,
  });
  if (exitCode !== 0) process.exit(exitCode);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[builder-identity] FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(BUILDER_IDENTITY_FATAL_EXIT);
  });
}
