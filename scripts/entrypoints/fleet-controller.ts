import {
  AGENT_PREFIX,
  AGENTS_DIR,
  bootBanner,
  GATEWAY_CLASS,
  GATEWAY_ID,
  GATEWAY_PROFILE,
  GATEWAY_REVISION_ID,
  GIT_SYNC_INTERVAL_MS,
  isOperatorGateway,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import { syncAllWorkspaces } from "../lib/git.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import { blobSyncAllWithOptions } from "../lib/blob-sync.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import {
  PROCESS_STARTED_AT_MS,
  startFleetController,
  type StartFleetOptions,
} from "../lib/fleet-provisioner.js";
import { desiredFingerprints } from "../lib/snapshot-fingerprint.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
import { startUsageEventTailer } from "../lib/usage-log-tailer.js";
import { startWorkspaceAutosaveLoop } from "../lib/workspace-autosave-runner.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  checkpointDurableSystemConfigForSlug,
  syncSystemConfigForSlug,
  systemConfigPath,
} from "../lib/system-config.js";
import {
  assertSystemConfigMutationAllowed,
} from "../lib/system-config-roll-control.js";
import {
  abortSystemConfigV2,
  finalizeSystemConfigV2,
  freezeSystemConfigV2,
  promoteSystemConfigCandidateV2,
  readSystemConfigBootRoleState,
  type SystemConfigBootResolutionV2,
  verifySystemConfigCandidateControlObjectsV2,
} from "../lib/system-config-roll-protocol-v2.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { validateOpenClawConfig } from "../lib/openclaw-config-validation.js";
import { systemConfigBootAcceptedPath } from "../lib/system-config-status.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { startSystemConfigControlCapabilityHeartbeat } from "../lib/system-config-control-capability.js";

export interface FleetControllerEntrypointConfig {
  builderSlug: string;
  gatewayId: string;
  revisionId: string;
  port: number;
  publicKey: string;
  version: string;
}

export function resolveFleetControllerEntrypointConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayId?: string; revisionId?: string } = {
    gatewayId: GATEWAY_ID,
    revisionId: GATEWAY_REVISION_ID,
  },
): FleetControllerEntrypointConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    revisionId: runtime.revisionId ?? "",
    builderSlug: env.GATEWAY_BUILDER_SLUG?.trim() ?? "",
    port: parseInt(env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    publicKey: env.FLEET_CONTROLLER_PUBLIC_KEY || "",
    version: env.BUILD_SHA ?? "unknown",
  };
}

export function createFleetSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): (() => Promise<void>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    checkpointDurableSystemConfigForSlug(builderSlug, { log: logFn }, sync);
  };
}

export function assertFleetConfigSlug(expectedSlug: string, requestedSlug: string): void {
  if (requestedSlug !== expectedSlug) {
    throw new Error("config RPC slug does not match gateway builder");
  }
}

type SystemConfigRuntimeRpc = Pick<
  GatewayRpcClient,
  "configGet" | "channelsStatus"
>;

export function createSystemConfigMutationGatedRpc(
  rpc: GatewayRpcClient,
  openclawDir: string,
): GatewayRpcClient {
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property !== "configApply" && property !== "configPatch") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const mutation = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        const acquired = await acquireSystemConfigMutationLease({ openclawDir });
        if (!acquired.ok) {
          if (acquired.code === "config-frozen") {
            throw new Error(
              `system config is frozen by ${acquired.freezeOwner.migrationId} for ${acquired.freezeOwner.slug}`,
            );
          }
          throw new Error("system config writer lock is busy");
        }
        try {
          assertSystemConfigMutationAllowed({ openclawDir });
          return await Reflect.apply(mutation, target, args);
        } finally {
          await acquired.lease.release();
        }
      };
    },
  });
}

export interface ProveRevisionSystemConfigCandidateOptions {
  migrationId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  checkpointCommit: string;
  freezeObject: string;
  openclawDir: string;
  revisionId: string;
  env: NodeJS.ProcessEnv;
  rpc: SystemConfigRuntimeRpc;
  startedAt: number;
  now?: () => number;
  bootAccepted?: () => boolean;
  readBootRole?: () => SystemConfigBootResolutionV2;
  hashConfig?: (configPath: string) => string;
  verifyControlObjects?: typeof verifySystemConfigCandidateControlObjectsV2;
}

function requiredIdentity(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`target ${key} is unavailable for config proof`);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashConfigFile(configPath: string): string {
  return createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
}

type LoadedCandidateBootRole = SystemConfigBootResolutionV2 & {
  role: "target-candidate";
  candidateExists: true;
  candidateCommit: string;
  candidateHash: string;
};

function requireCandidateBootRole(
  options: ProveRevisionSystemConfigCandidateOptions,
): LoadedCandidateBootRole {
  if (!options.revisionId) throw new Error("target revision id unavailable for config proof");
  if (options.targetRevisionId !== options.revisionId) {
    throw new Error("target revision does not match running revision");
  }
  const bootAccepted = options.bootAccepted ??
    (() => fs.existsSync(systemConfigBootAcceptedPath(options.openclawDir)));
  if (!bootAccepted()) throw new Error("target config is not boot-accepted");
  const role = (options.readBootRole ?? (() => readSystemConfigBootRoleState(options.openclawDir)))();
  if (role.role !== "target-candidate" || !role.candidateExists) {
    throw new Error("target candidate is not loaded and fenced");
  }
  const bindings = [
    ["migration", role.migrationId, options.migrationId],
    ["source revision", role.sourceRevisionId, options.sourceRevisionId],
    ["target revision", role.targetRevisionId, options.targetRevisionId],
    ["checkpoint", role.checkpointCommit, options.checkpointCommit],
    ["freeze object", role.freezeObject, options.freezeObject],
  ] as const;
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected) throw new Error(`target ${label} proof binding mismatch`);
  }
  if (!role.candidateCommit || !role.candidateHash) {
    throw new Error("target candidate identity is unavailable");
  }
  return role as LoadedCandidateBootRole;
}

export async function proveRevisionSystemConfigCandidate(
  options: ProveRevisionSystemConfigCandidateOptions,
) {
  const role = requireCandidateBootRole(options);
  const verifiedControl = (
    options.verifyControlObjects ?? verifySystemConfigCandidateControlObjectsV2
  )({
    gatewayId: requiredIdentity(options.env, "GATEWAY_ID"),
    slug: requiredIdentity(options.env, "GATEWAY_BUILDER_SLUG"),
    migrationId: options.migrationId,
    sourceRevisionId: options.sourceRevisionId,
    targetRevisionId: options.targetRevisionId,
    checkpointCommit: options.checkpointCommit,
    freezeObject: options.freezeObject,
    candidateCommit: role.candidateCommit,
    candidateHash: role.candidateHash,
    openclawDir: options.openclawDir,
    env: options.env,
  });
  const configPath = systemConfigPath(options.openclawDir);
  const candidateHash = (options.hashConfig ?? hashConfigFile)(configPath);
  if (candidateHash !== role.candidateHash) throw new Error("active config does not match candidate hash");
  const observed = await options.rpc.configGet();
  const candidateConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (stableJson(observed.config) !== stableJson(candidateConfig)) {
    throw new Error("runtime config does not match candidate config");
  }
  await options.rpc.channelsStatus();
  return {
    checkpointCommit: options.checkpointCommit,
    candidateCommit: role.candidateCommit,
    candidateHash: role.candidateHash,
    candidateRef: verifiedControl.candidateRef,
    freezeObject: options.freezeObject,
    runtimeConfigHash: observed.hash,
    observedRevisionId: options.revisionId,
    targetStartedAt: options.startedAt,
    imageTag: requiredIdentity(options.env, "GATEWAY_IMAGE_TAG"),
    buildSha: requiredIdentity(options.env, "BUILD_SHA"),
    openclawVersion: requiredIdentity(options.env, "OPENCLAW_VERSION"),
    configReady: true as const,
    provenAt: (options.now ?? Date.now)(),
  };
}

type ConfigControlCallbacks = Pick<
  StartFleetOptions,
  | "freezeSystemConfigV2"
  | "proveSystemConfigCandidate"
  | "promoteSystemConfigCandidate"
  | "abortSystemConfigV2"
  | "finalizeSystemConfigV2"
>;

function createConfigControlCallbacks(
  entrypointConfig: FleetControllerEntrypointConfig,
  runtimeRpc: GatewayRpcClient,
): ConfigControlCallbacks {
  if (!entrypointConfig.builderSlug) return {};
  const assertSlug = (slug: string): void => assertFleetConfigSlug(entrypointConfig.builderSlug, slug);
  return {
    freezeSystemConfigV2: ({ migrationId, slug, sourceRevisionId, targetRevisionId }) => {
      assertSlug(slug);
      return freezeSystemConfigV2({
        gatewayId: entrypointConfig.gatewayId,
        migrationId,
        slug,
        sourceRevisionId,
        targetRevisionId,
        openclawDir: OPENCLAW_DIR,
        env: process.env,
        source: "migration-checkpoint",
        validateConfig: validateOpenClawConfig,
      });
    },
    proveSystemConfigCandidate: ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      checkpointCommit,
      freezeObject,
    }) => {
      assertSlug(slug);
      return proveRevisionSystemConfigCandidate({
        migrationId,
        sourceRevisionId,
        targetRevisionId,
        checkpointCommit,
        freezeObject,
        openclawDir: OPENCLAW_DIR,
        revisionId: entrypointConfig.revisionId,
        env: process.env,
        rpc: runtimeRpc,
        startedAt: PROCESS_STARTED_AT_MS,
      });
    },
    promoteSystemConfigCandidate: (input) => {
      assertSlug(input.slug);
      return promoteSystemConfigCandidateV2({
        ...input,
        gatewayId: entrypointConfig.gatewayId,
        openclawDir: OPENCLAW_DIR,
        env: process.env,
      });
    },
    abortSystemConfigV2: (input) => {
      assertSlug(input.slug);
      return abortSystemConfigV2({
        ...input,
        gatewayId: entrypointConfig.gatewayId,
        openclawDir: OPENCLAW_DIR,
        env: process.env,
      });
    },
    finalizeSystemConfigV2: (input) => {
      assertSlug(input.slug);
      return finalizeSystemConfigV2({
        ...input,
        gatewayId: entrypointConfig.gatewayId,
        openclawDir: OPENCLAW_DIR,
        env: process.env,
      });
    },
  };
}

async function main(): Promise<void> {
  const entrypointConfig = resolveFleetControllerEntrypointConfig();
  log(bootBanner("fleet-controller"));
  const runtimeRpc = createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
  });
  const rpc = createSystemConfigMutationGatedRpc(runtimeRpc, OPENCLAW_DIR);
  const openclawVersion = probeOpenClawVersion({
    execFile: execFileSync,
    binaryPath: "/usr/local/bin/openclaw",
  });
  if (!entrypointConfig.publicKey) {
    throw new Error("fleet controller public key unavailable: expected FLEET_CONTROLLER_PUBLIC_KEY");
  }
  const operator = isOperatorGateway();
  const brokerClient = createFleetBrokerClient(
    entrypointConfig.gatewayId,
    entrypointConfig.revisionId,
  );
  const adapter = buildBrokeredLifecycleAdapter({
    client: brokerClient,
    rpc,
    log,
    adminMmUserId: process.env.MM_ADMIN_USER_ID,
    isOperatorGateway,
  });
  const fleetHandle = await startFleetController({
    rpc,
    adapter,
    gatewayId: entrypointConfig.gatewayId,
    revisionId: entrypointConfig.revisionId,
    log,
    port: entrypointConfig.port,
    publicKey: entrypointConfig.publicKey,
    version: entrypointConfig.version,
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: !operator,
    localReconcile: true,
    // Non-operator (shared/builder) gateways always re-apply the config patch on ensure,
    // so a fingerprint drift can reconverge a mounted customer — this is what makes a
    // project-agent toggle land without a remount. Operator gateways short-circuit a
    // coach-wired resync in addCustomerToGateway, where a recorded "applied" fingerprint
    // would falsely mark an unpatched config current; they fall back to slug-only roster
    // and reconverge on remount.
    ...(operator
      ? {
          readDesiredSlugs: async () => {
            const users = await brokerClient.assignedUsers({ completeOnly: false });
            return users.map((user) => user.slug);
          },
        }
      : {
          readDesiredFingerprints: async () => {
            const users = await brokerClient.assignedUsers({ completeOnly: false });
            // Seed the adapter's snapshot cache from the same fetch: the ensure a
            // fingerprint drift triggers must apply exactly the content that was
            // fingerprinted, not whatever the TTL-less cache still holds.
            return desiredFingerprints(users, adapter.seedUserSnapshotForMigration);
          },
        }),
    stampMounted: (uid, mounted) => brokerClient.setMounted(uid, mounted),
    recordReconcileError: (slug, message) => brokerClient.recordReconcileError(slug, message),
    clearReconcileError: (slug) => brokerClient.clearReconcileError(slug),
    flushLocalState: async ({ reason }) => {
      log(`[fleet] controller-requested flush reason=${reason}`);
      return runGatewayPreStopFlush({
        gatewayId: entrypointConfig.gatewayId,
        gatewayClass: GATEWAY_CLASS,
        syncWorkspaces: syncAllWorkspaces,
        syncBlobs: operator
          ? undefined
          : () => blobSyncAllWithOptions({
              storeForSlug: () => createBrokeredBlobStore(brokerClient),
            }),
        syncSystemConfig: createFleetSystemConfigFlush(entrypointConfig.builderSlug),
        log,
      });
    },
    ...createConfigControlCallbacks(entrypointConfig, runtimeRpc),
    // Db-less: gateway pods hold NO Firestore credentials. Cowboy polls
    // /health and writes gateways/{id} on the trusted side. Gateway pods run
    // only the local mount reconcile from brokered assigned snapshots; all
    // trusted-side provisioning mutations go through octogee-api.
    reportState: false,
    internalServiceKey: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  const configControlCapability = entrypointConfig.builderSlug
    ? startSystemConfigControlCapabilityHeartbeat({
        openclawDir: OPENCLAW_DIR,
        revisionId: entrypointConfig.revisionId,
        log,
      })
    : null;

  const autosaveTimer = startWorkspaceAutosaveLoop(
    {
      envValue: process.env.WORKSPACE_AUTOSAVE_ENABLED,
      isOperatorGateway,
      syncWorkspaces: syncAllWorkspaces,
      syncBlobs: operator
        ? undefined
        : () => blobSyncAllWithOptions({
            storeForSlug: () => createBrokeredBlobStore(brokerClient!),
          }),
      log,
    },
    GIT_SYNC_INTERVAL_MS,
  );
  const usageTimer = operator
    ? null
    : startUsageEventTailer({
        agentPrefix: AGENT_PREFIX,
        agentsDir: AGENTS_DIR,
        submit: async (event) => {
          await brokerClient!.recordUsageEvent({
            agentId: event.agentId,
            usage: event.usage,
          });
        },
        log,
        gatewayId: entrypointConfig.gatewayId,
      });
  log(`Local fleet controller running (profile=${GATEWAY_PROFILE}). Press Ctrl+C to stop.`);
  const cleanup = async () => {
    configControlCapability?.close();
    if (autosaveTimer) clearInterval(autosaveTimer);
    if (usageTimer) clearInterval(usageTimer);
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
