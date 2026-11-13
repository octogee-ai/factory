#!/usr/bin/env tsx
import "../src/main.js";
import { pathToFileURL } from "node:url";
import { applyGatewayRootPatch } from "@octogee/core/admin-fleet-router";
import { centralGatewayReleasePayload, createCentralReleaseAuthority } from "@octogee/core/artifact-registry";
import { deploymentEnvironmentSettings, type DeploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { checkIsolatedGateway } from "../lib/isolated-gateway-check.js";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { observeGatewayPods, parseFleetDeployArgs, readFleetSnapshot } from "./deploy-fleet.js";

export function isolatedGatewayToCheck(
  settings: Pick<DeploymentEnvironmentSettings, "targetId" | "shipTestIsolatedGatewayId">,
  log: (message: string) => void,
): string | null {
  if (settings.shipTestIsolatedGatewayId) return settings.shipTestIsolatedGatewayId;
  log(`skipped the isolated gateway check: deployment target ${settings.targetId} names no shipTestIsolatedGatewayId`);
  return null;
}

export async function setIsolatedGatewayDesiredStatus(store: PlatformStateStore, input: {
  gatewayId: string; desiredStatus: "running" | "paused"; sourceSha: string; actor: string;
}): Promise<void> {
  const root = await store.gateways.roots.get(input.gatewayId);
  if (!root) throw new Error(`isolated gateway ${input.gatewayId} does not exist`);
  const patch = { desiredStatus: input.desiredStatus };
  const result = await runNormalFleetMutation(store, {
    actor: input.actor, forced: false,
    what: input.desiredStatus === "running" ? "resume isolated gateway for the Ship TEST check" : "park isolated gateway after the Ship TEST check",
    why: `Ship TEST checks ${input.sourceSha} on an isolated gateway`,
    target: { gatewayId: input.gatewayId, environment: "test" },
    preActionStatus: { desiredStatus: root.desiredStatus, desiredRelease: root.desiredRelease },
    mutation: { kind: "patch-gateway", gatewayId: input.gatewayId, patch },
    testProvenance: { environment: "test", sourceCommit: input.sourceSha },
    action: () => applyGatewayRootPatch(store, input.gatewayId, patch, input.actor),
    classifyResult: (applied) => applied.ok ? { outcome: "completed" } : { outcome: "failed", error: applied.error },
  });
  if (!result.ok) throw new Error(`${input.gatewayId} was not set ${input.desiredStatus}: ${result.error}`);
}

export async function runIsolatedGatewayCheck(argv: string[]): Promise<void> {
  const options = parseFleetDeployArgs(argv);
  if (process.env.RELEASE_ENVIRONMENT !== "test") throw new Error("the isolated gateway check runs only in Ship TEST");
  const settings = deploymentEnvironmentSettings("test");
  const log = (message: string) => process.stdout.write(`${message}\n`);
  const gatewayId = isolatedGatewayToCheck(settings, log);
  if (!gatewayId) return;
  const authority = createCentralReleaseAuthority({ project: settings.artifactRegistryProjectId, location: settings.artifactRegistryLocation, repository: settings.artifactRegistryName });
  const manifest = await authority.resolveManifest(options.sourceSha);
  if (manifest.sourceSha !== options.sourceSha) throw new Error("resolved immutable manifest differs from requested source SHA");
  const actor = process.env.RELEASE_ACTOR ?? "operator:test-fleet";
  const store = await operatorPlatformStateStore(settings.targetId);
  try {
    const result = await checkIsolatedGateway({ gatewayId, sourceSha: options.sourceSha, payload: centralGatewayReleasePayload(manifest), timeoutMs: options.timeoutMs }, {
      readGateway: async (id) => (await readFleetSnapshot(store, () => observeGatewayPods("test"))).gateways.find((gateway) => gateway.gatewayId === id) ?? null,
      setDesiredStatus: (id, desiredStatus) => setIsolatedGatewayDesiredStatus(store, { gatewayId: id, desiredStatus, sourceSha: options.sourceSha, actor }),
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runIsolatedGatewayCheck(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
