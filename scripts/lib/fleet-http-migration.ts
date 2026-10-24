import { assertSafeStagedSymlinks, RSYNC_DAEMON_SYMLINK_POLICY, STAGED_RSYNC_COPY_OPTIONS } from "./rsync-staged-symlinks.js";
import { recoverSharedAgentContextCheckpoint } from "./shared-agent-context-checkpoint.js";
import { upgradeStagedAgentStores } from "./agent-store-upgrade.js";
import { assertMatchingSharedContextPreparation } from "./shared-agent-context-preparation.js";
import { readSharedAgentContextRestoreReceipt, writeSharedAgentContextRestoreReceipt } from "./shared-agent-context-restore-receipt.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { archivedSharedAgentExportPaths, archiveNativeSharedAgentContext, assertNativeAgentContextTransfer, assertRetainedNativeAgentContext } from "./native-shared-agent-context.js";
import { projectCheckoutEnabled } from "../../shared/types/project.js";
import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import { updateVoiceMigration, type VoiceMigrationInput } from './voice-migration.js';
import {
  clearMigrationStaging, prepareMigrationStaging, readLiveImportAdmission, writeLiveImportAdmission,
  type LiveImportAdmission, type MigrationStagingIdentity,
} from "./migration-staging.js";
import { sourceTransferRsyncArgs } from "./source-transfer-rsync.js";
import { deferredProjectPlaceholderPaths } from "./deferred-project-workspace.js";
import { sourcesForPushMode } from "./source-transfer-plan.js";
import { log as provisionerLog } from "@octogee/core/config";
import { withLogContext, setLogContext, type LogContext } from "@octogee/shared/server/service-logger";


import type { Request, Response, RequestHandler } from "express";
import { findUnsafeCustomerGitMetadataEntry } from "@octogee/core/git-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readPostgresAgentAnchor, queryAgentStore } from "@octogee/core/agent-postgres";
import { CODEX_SNAPSHOT_EXCLUDE_ARG, CODEX_STORE_EXCLUDE_ARGS, CODEX_TEMP_EXCLUDE_ARG, discardCodexStoreSnapshots, installCodexStoreSnapshots, isCodexDatabase, omitRawCodexDatabases, omitStagedCodexTemporaryFiles, prepareCodexStoreSnapshots } from "./codex-store-snapshot.js";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  type NativeAgentContextTransfer,
  type NativeSharedAgentContextArchive,
  type SchedulerMigrationRequestBody,
  type AbortRsyncImportRequestBody,
  type ImportResponse,
  type ActivateImportRequestBody,
  type ActivationManifestExportRequestBody,
  type ActivationManifestExportResponse,
  type ExportPathsRequestBody,
  type ExportPathsResponse,
  type FinishRsyncImportRequestBody,
  type FlushGatewayRequestBody,
  type FlushGatewayResponse,
  type CompleteSurgeHandoffRequestBody,
  type MigrationConfigTransferMode,
  type MigrationLoadStrategy,
  type MigrationRequestBody,
  type MigrationProgressRequestBody,
  type MigrationTransferMode,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PrepareImportRequestBody,
  type PushRsyncStateRequestBody,
  type QuiesceRequestBody,
  type QuiesceResponse,
  type RsyncMigrationRpcPhase,
  type RestoreMigrationRequestBody,
  type RestoreMigrationResponse,
  type UnmountRequestBody,
  type UnmountResponse,
  type VerifyMigrationRequestBody,
  type VerifyMigrationResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  MIGRATION_RSYNC_PORT_DEFAULT,
  SIGNATURE_HEADER,
} from "../../shared/types/fleet-controller.js";
import { isValidUsername, parseAgentId } from "../../shared/types/identity.js";
import {
  findUnreadableStore,
  listSqliteStores,
} from "./agent-store-carry.js";
import {
  type PreparedAgentStores,
  findPortableAgentStores,
  AGENT_STORE_BASENAME,
  AGENT_IMPORT_DIRNAME,
  exportAgentStoreSnapshots,
  findStagedAgentSnapshots,
  findStagedLiveAgentStores,
  installPreparedAgentStores,
  isAgentSnapshotArtifact,
  prepareAgentStoreSnapshots,
} from "./agent-store-snapshot.js";
import {
  isMigrationCertificatePem,
  openMigrationTlsEndpoint,
  reserveLoopbackPort,
  rsyncTlsConnectProgram,
  type MigrationTlsEndpoint,
  type OpenMigrationTlsEndpoint,
} from "./migration-rsync-tls.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { reattachBuilderAgents } from "./reattach-builder-agents.js";
import { activeAgentProjectIds } from "./openclaw-config-builders.js";
import { PROC_ROOT } from "./held-files.js";
import { pickPlanInputs } from "../../shared/types/billing.js";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
import { rejectMisaddressedGateway } from "./fleet-gateway-path.js";
import type { CustomerLifecycleAdapter, RemoveCustomerResult } from "./customer-lifecycle.js";
import {
  cloneMissingProjects,
  removeCustomerFromGateway,
  restoreCustomerRuntimeFromSnapshot,
  type RestoreCustomerRuntimeResult,
  type UserSnapshot,
} from "./customer-lifecycle.js";
import { withCustomerRemoval } from "./customer-removal-exclusion.js";
import {
  MIGRATION_ACTIVATION_DIR,
  writeActivationManifest,
  readActivationManifest,
} from "./migration-activation-manifest.js";
import {
  disableSystemConfigWatch,
  enableSystemConfigWatch,
  isConfiguredGatewayBuilder,
  readSystemConfigWatchFenceGeneration,
} from "./system-config-watch-state.js";
import { dlog, OPENCLAW_DIR } from "./config.js";
import { openClawConfigPath } from "./openclaw-config-path.js";
import {
  assertConfiguredBuilderPortableStatePlanOnDisk,
  configuredBuilderPortableStatePlan,
  configuredBuilderStatePlanAllowsEntry,
  isSafeConfiguredAgentId,
  type ConfiguredBuilderPortableStatePlan,
} from "./local-coach-wired.js";
import {
  isSafeDefaultAgentPortableStatePath,
  SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS,
} from "./openclaw-config-builders.js";
import { OpenclawWireError } from "./gateway-rpc.js";
import type { SurgeOpenClawProcessGateState } from "./surge-openclaw-process-gate.js";
import { pendingCloneAppliedFingerprint } from "./pending-clone-fingerprint.js";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
const BUILDER_SYSTEM_CONFIG_TRANSFER = "configured-builder-system-config" as const;
const ACTIVATION_MANIFEST_TRANSFER = "activation-manifest" as const;
const RESTORE_SHARED_AGENT_CONTEXT = "restore-shared" as const;

export interface MigrationHandlerDeps {
  voiceMigration?: (input: VoiceMigrationInput) => Promise<{ activeCalls: number }>;
  publicKey: string;
  gatewayId: string;
  adapter: CustomerLifecycleAdapter;

  log?: (msg: string, fields?: LogContext) => void;

  now?: () => number;

getMountedCustomers?: () => readonly string[];

customerAttachPending?: (slug: string) => Promise<boolean>;

fetch?: typeof globalThis.fetch;

pushStateTimeoutMs?: number;

migrationRsyncPort?: number;

waitForRsyncReady?: (port: number) => Promise<void>;

flushLocalState?: (input: {
  slug: string;
  reason: string;
  expectedSystemConfigCommit?: string;
}) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
prepareSurgeTarget?: (input: { migrationId: string; slug: string; targetPodUid: string }, signal?: AbortSignal) => Promise<void>;
releaseSurgeReadiness?: (input: { migrationId: string; targetPodUid: string }) => Promise<void>;
reserveSurgeTarget?: (input: { migrationId: string; slug: string }) => Promise<void>;
surgeTargetOpenClawHeld?: (input: {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}) => Promise<boolean>;
surgeSourceOpenClawHeld?: (input: { migrationId: string; slug: string }) => Promise<boolean>;
surgeTargetLive?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<boolean>;
admitLiveSurgeTarget?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<void>;
liveSurgeTargetAssigned?: (input: { migrationId: string; slug: string; targetPodUid: string }) => Promise<boolean>;
unreserveSurgeTarget?: (input: {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}, cleanup?: (assertCurrent: () => Promise<void>) => Promise<void>) => Promise<SurgeOpenClawProcessGateState>;
pauseSystemConfigWatch?: (slug: string) => Promise<string | void>;
readSystemConfigWatchFence?: (slug: string) => Promise<string | null>;
resumeSystemConfigWatch?: (
  slug: string,
  expectedGeneration?: string | null,
) => Promise<boolean | void>;
runOpenClaw?: OpenClawCommand;
openMigrationTlsEndpoint?: OpenMigrationTlsEndpoint;
reserveLoopbackPort?: () => Promise<number>;
procRoot?: string;
}


async function releaseAgentForImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredBuilderActivation | null,
  agentId: string,
  log: (message: string, fields?: LogContext) => void,
): Promise<void> {
  if (activation && !activation.live) {
    if (!deps.surgeTargetOpenClawHeld) {
      throw new Error(`cannot replace agent ${agentId}'s database: Builder target has no process gate status`);
    }
    if (await deps.surgeTargetOpenClawHeld(activation.request)) {
      log(`[migration-rsync] OpenClaw is held for this boot; replacing ${agentId}'s database offline`);
      return;
    }
  }
  if (!deps.adapter.releaseAgent) {
    throw new Error(`cannot replace agent ${agentId}'s database: this gateway cannot release agents`);
  }
  if (!activation?.live) {
    await deps.adapter.releaseAgent(agentId);
    return;
  }
  try {
    await deps.adapter.releaseAgent(agentId);
  } catch (error) {
    if (!(error instanceof Error) || !NATIVE_CLEANUP_INCOMPLETE.test(error.message)) throw error;
    log(`[migration-rsync] releasing ${agentId} left its native cleanup pending; resuming the deletion before replacing its database`);
    await deps.adapter.releaseAgent(agentId);
  }
}

const NATIVE_CLEANUP_INCOMPLETE = /native cleanup incomplete/;

async function pauseSystemConfigWatchForBuilder(
  deps: MigrationHandlerDeps,
  slug: string,
): Promise<string | undefined> {
  if (deps.pauseSystemConfigWatch) {
    return (await deps.pauseSystemConfigWatch(slug)) ?? undefined;
  }
  const configuredBuilder = builderClaimSlug();
  if (!configuredBuilder) return undefined;
  if (!isConfiguredGatewayBuilder(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration builder ${slug}`,
    );
  }
  return disableSystemConfigWatch(OPENCLAW_DIR, slug);
}

async function readSystemConfigWatchFenceForBuilder(
  deps: MigrationHandlerDeps,
  slug: string,
): Promise<string | null | undefined> {
  if (deps.readSystemConfigWatchFence) {
    return deps.readSystemConfigWatchFence(slug);
  }
  const configuredBuilder = builderClaimSlug();
  if (!configuredBuilder) return undefined;
  if (!isConfiguredGatewayBuilder(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration builder ${slug}`,
    );
  }
  return readSystemConfigWatchFenceGeneration(OPENCLAW_DIR, slug);
}

async function resumeSystemConfigWatchForBuilder(
  deps: MigrationHandlerDeps,
  slug: string,
  expectedGeneration?: string | null,
): Promise<void> {
  if (deps.resumeSystemConfigWatch) {
    if (expectedGeneration === undefined) {
      await deps.resumeSystemConfigWatch(slug);
    } else {
      await deps.resumeSystemConfigWatch(slug, expectedGeneration);
    }
    return;
  }
  const configuredBuilder = builderClaimSlug();
  if (!configuredBuilder) return;
  if (!isConfiguredGatewayBuilder(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration builder ${slug}`,
    );
  }
  await enableSystemConfigWatch(OPENCLAW_DIR, slug, expectedGeneration);
}

function importedActivationOptions(signal?: AbortSignal, migrationId?: string): { signal?: AbortSignal; migrationId?: string } | undefined {
  return signal || migrationId ? { ...(signal ? { signal } : {}), ...(migrationId ? { migrationId } : {}) } : undefined;
}

async function activateImportedCustomerForMigration(input: {
  deps: MigrationHandlerDeps;
  slug: string;
  mode: MigrationImportMode;
  migrationId?: string;
  loadStrategy?: MigrationLoadStrategy;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { deps, slug, mode, signal, loadStrategy = "standard" } = input;
  await ensureMigrationGiteaKey(deps, slug, "target-activation");
  const fenceGeneration = await pauseSystemConfigWatchForBuilder(deps, slug);
  let deferredCheckouts: string[] = [];
  if (
    loadStrategy === "standard" &&
    deps.adapter.projectCheckoutScope?.(slug) !== "workspace-only"
  ) {
    const { pending, deferred } = await cloneMissingProjects(deps.adapter, slug, { githubCheckouts: "defer" });
    deferredCheckouts = deferred;
    if (deferred.length > 0) {
      deps.log?.(
        `[migration-http] GitHub checkouts for ${slug} hydrate after cutover, once this gateway holds the assignment: ${deferred.join(", ")}`,
      );
    }
    if (pending.length > 0) {
      throw new Error(
        `[migration-http] project checkout hydration incomplete for ${slug}: ${pending.join(", ")}`,
      );
    }
  }
  const options = importedActivationOptions(signal, input.migrationId);
  const activation = options ? await deps.adapter.activateImportedCustomer(slug, options) : await deps.adapter.activateImportedCustomer(slug);
  if (loadStrategy === "standard") {
    deps.adapter.recordAppliedFingerprint?.(
      slug,
      deferredCheckouts.length > 0
        ? pendingCloneAppliedFingerprint(activation.appliedFingerprint)
        : activation.appliedFingerprint,
    );
  } else {
    deps.log?.(`[migration-http] expedited activation defers project hydration slug=${slug}`);
  }
  if (mode === "default") {
    await resumeSystemConfigWatchForBuilder(deps, slug, fenceGeneration);
  }
  return activation.verificationPending;
}

async function ensureMigrationGiteaKey(
  deps: MigrationHandlerDeps,
  slug: string,
  phase: "source-flush" | "target-activation",
): Promise<void> {
  const pubKey = deps.adapter.readLocalCustomerPubKey(slug);
  if (pubKey === null) {
    throw new Error(`[migration-http] local SSH public key is missing for ${slug}`);
  }
  await deps.adapter.createGiteaUser(slug, pubKey);
  deps.log?.(`[migration-http] Gitea SSH key claimed slug=${slug} phase=${phase}`);
}

async function ensureMigrationSourceGiteaKey(
  deps: MigrationHandlerDeps,
  slug: string,
  reason: string,
): Promise<void> {
  if (reason !== "migration-final") return;
  await ensureMigrationGiteaKey(deps, slug, "source-flush");
}

async function removeCustomerWithSystemConfigWatchPaused<T extends { wasMounted: boolean }>(input: {
  deps: MigrationHandlerDeps;
  slug: string;
  remove: () => Promise<T>;
}): Promise<T> {
  await pauseSystemConfigWatchForBuilder(input.deps, input.slug);
  return withCustomerRemoval(input.slug, input.remove);
}

async function resumeSystemConfigWatchAfterConvergence(
  deps: MigrationHandlerDeps,
  slug: string,
  reason: string,
  flushSucceeded: boolean,
  expectedGeneration?: string | null,
): Promise<void> {
  if (reason !== "migration-converge" || !flushSucceeded) return;
  await resumeSystemConfigWatchForBuilder(deps, slug, expectedGeneration);
}

function rejectInvalidSlug(slug: string, res: Response): boolean {
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid slug" });
    return true;
  }
  return false;
}

function parseAndVerifyJsonBody<T extends MigrationRequestBody>(
  req: Request,
  res: Response,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
  log: (msg: string, fields?: LogContext) => void,
): T | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (!body?.migrationId || !body?.slug) {
    res.status(400).json({ error: "missing migrationId/slug" });
    return null;
  }
  if (rejectInvalidSlug(body.slug, res)) return null;

  const sigHeader = req.header(SIGNATURE_HEADER);

const sigValid = verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(body.migrationId, deps.gatewayId),
    rawBody,
    sigHeader ?? undefined,
  );
  if (!sigValid) {
    log(`[migration-http] 🔴 bad signature migrationId=${body.migrationId} slug=${body.slug}`, { status: "failed" });
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  setLogContext({ builderSlug: body.slug, operationId: body.migrationId, category: "migration", gatewayId: deps.gatewayId });
  return body;
}

function parseAndVerifySurgeBody(
  req: Request,
  res: Response,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
  log: (msg: string, fields?: LogContext) => void,
): CompleteSurgeHandoffRequestBody | null {
  const rawBody: string = (req as unknown as { rawBody?: string }).rawBody ?? "";
  let body: CompleteSurgeHandoffRequestBody;
  try {
    body = JSON.parse(rawBody) as CompleteSurgeHandoffRequestBody;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return null;
  }
  if (
    typeof body.migrationId !== "string" ||
    body.migrationId.length === 0 ||
    typeof body.targetPodUid !== "string" ||
    body.targetPodUid.length === 0 ||
    body.targetPodUid.length > 128
  ) {
    res.status(400).json({ error: "missing or invalid migrationId/targetPodUid" });
    return null;
  }
  const signature = req.header(SIGNATURE_HEADER);
  if (!verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(body.migrationId, deps.gatewayId),
    rawBody,
    signature ?? undefined,
  )) {
    log(`[surge-handoff] bad signature migrationId=${body.migrationId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  return body;
}

export function createCompleteSurgeHandoffHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifySurgeBody(req, res, deps, log);
    if (!body) return;
    if (!deps.releaseSurgeReadiness) {
      res.status(500).json({ error: "surge readiness is not configured" });
      return;
    }
    try {
      await deps.releaseSurgeReadiness({
        migrationId: body.migrationId,
        targetPodUid: body.targetPodUid,
      });
      log(`🟢 [surge-handoff] readiness released targetPodUid=${body.targetPodUid}`);
      res.status(200).json({ released: true, targetPodUid: body.targetPodUid });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`🔴 [surge-handoff] readiness release failed: ${message}`, { status: "failed" });
      res.status(500).json({
        error: "surge readiness release failed",
        message,
      });
    }
  });
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createMigrationProgressHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationProgressRequestBody>(req, res, deps, log);
    if (!body) return;
    const icons = { pending: "🟡", running: "🟡", done: "🟢", failed: "🔴", skipped: "🟡" };
    if (
      typeof body.phase !== "string" || !/^[a-zA-Z0-9:-]{1,80}$/.test(body.phase) ||
      typeof body.source !== "string" || !/^[a-zA-Z0-9.-]{1,253}$/.test(body.source) ||
      !Object.hasOwn(icons, body.status) ||
      (body.elapsedMs !== undefined && (!Number.isSafeInteger(body.elapsedMs) || body.elapsedMs < 0)) ||
      typeof body.migrationId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(body.migrationId)
    ) {
      res.status(400).json({ error: "invalid migration progress" });
      return;
    }
    log(`Migration ${body.phase}`, {
      category: "migration", builderSlug: body.slug, operationId: body.migrationId,
      sourceGateway: body.source, gatewayId: deps.gatewayId, phase: body.phase,
      status: body.status, ...(body.elapsedMs === undefined ? {} : { durationMs: body.elapsedMs }),
    });
    res.status(200).json({ ok: true });
  });
}

const SCHEDULER_MIGRATION_PHASES = ["hold", "export", "stage", "activate", "resume", "retire", "abort"];
const SCHEDULER_RETAINING_PHASES = ["hold", "export", "stage"];

function isSchedulerMigrationRequest(body: SchedulerMigrationRequestBody): boolean {
  const agentIdsValid = body.agentIds === undefined ||
    (Array.isArray(body.agentIds) && body.agentIds.length > 0 && body.agentIds.every((id) => typeof id === "string" && id));
  const stageValid = body.phase !== "stage" || (body.agentIds !== undefined && body.snapshot !== undefined);
  const retainValid = body.retainNonportable === undefined ||
    (typeof body.retainNonportable === "boolean" && SCHEDULER_RETAINING_PHASES.includes(body.phase));
  return SCHEDULER_MIGRATION_PHASES.includes(body.phase) && agentIdsValid && stageValid && retainValid;
}

export function createSchedulerMigrationHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<SchedulerMigrationRequestBody>(req, res, deps, log);
    if (!body) return;
    if (!isSchedulerMigrationRequest(body)) {
      res.status(400).json({ error: "invalid scheduler migration request" });
      return;
    }
    try {
      const result = await deps.adapter.schedulerMigration(body.slug, {
        operationId: body.migrationId, phase: body.phase,
        ...(body.agentIds ? { agentIds: body.agentIds } : {}),
        ...(body.snapshot === undefined ? {} : { snapshot: body.snapshot }),
        ...(body.retainNonportable === undefined ? {} : { retainNonportable: body.retainNonportable }),
      });
      res.status(result.drained ? 200 : 409).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] scheduler ${body.phase} failed slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "scheduler migration failed", message });
    }
  });
}

export function createSchedulerReadyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps, log);
    if (!body) return;
    try {
      await deps.adapter.schedulerReady();
      res.status(200).json({ ready: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] scheduler readiness failed migrationId=${body.migrationId}: ${message}`);
      res.status(500).json({ error: "scheduler readiness failed", message });
    }
  });
}

export function createResumeHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps, log);
    if (!body) return;
    try {
      await deps.adapter.resumeCustomer(body.slug);
      await (deps.voiceMigration ?? updateVoiceMigration)({ slug: body.slug, operationId: body.migrationId, phase: "resume" });
      res.status(200).json({ migrationId: body.migrationId, slug: body.slug, resumed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[migration-http] resume failed slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "resume failed", message });
    }
  });
}

export function createQuiesceHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<QuiesceRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      const voice = await (deps.voiceMigration ?? updateVoiceMigration)({ slug: body.slug, operationId: body.migrationId, phase: "hold" });
      if (voice.activeCalls > 0) {
        log(`[migration-http] deferring quiesce slug=${body.slug}: ${voice.activeCalls} active voice call(s)`);
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, drained: false, runningCount: voice.activeCalls });
        return;
      }
      let options: { stopMattermost: boolean; schedulerMigrationId?: string; retainNonportable?: boolean } | undefined;
      if (body.stopMattermost === false) options = { stopMattermost: false };
      else if (body.schedulerHandoff === true) {
        options = {
          stopMattermost: true,
          schedulerMigrationId: body.schedulerMigrationId ?? body.migrationId,
          ...(body.retainNonportable === true ? { retainNonportable: true } : {}),
        };
      }
      const result = options
        ? await deps.adapter.quiesceCustomer(body.slug, body.timeoutMs ?? 60_000, options)
        : await deps.adapter.quiesceCustomer(body.slug, body.timeoutMs ?? 60_000);
      const response: QuiesceResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        drained: result.drained,
        runningCount: result.runningCount,
      };
      (result.drained ? dlog : log)(
        `${result.drained ? "🟢" : "🟡"} [migration-http] quiesce migrationId=${body.migrationId} slug=${body.slug} → drained=${result.drained} runningCount=${result.runningCount}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 quiesce migrationId=${body.migrationId} slug=${body.slug} failed: ${message}`, { status: "failed" });
      res.status(500).json({ error: "quiesce failed", message });
    }
  });
}

function logFlushResult(ok: boolean, log: (message: string, fields?: LogContext) => void, message: string): void {
  (ok ? dlog : log)(`${ok ? "🟢" : "🔴"} [migration-http] flush ${message}`);
}

export function createFlushHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<FlushGatewayRequestBody>(req, res, deps, log);
    if (!body) return;

    if (!deps.flushLocalState) {
      res.status(501).json({ error: "flush not configured" });
      return;
    }

    const reason = typeof body.reason === "string" && body.reason
      ? body.reason
      : "controller";
    const expectedSystemConfigCommit = body.expectedSystemConfigCommit;
    if (
      reason === "migration-converge" &&
      (typeof expectedSystemConfigCommit !== "string" ||
        !SYSTEM_CONFIG_COMMIT.test(expectedSystemConfigCommit))
    ) {
      res.status(400).json({ error: "invalid expectedSystemConfigCommit" });
      return;
    }
    if (reason !== "migration-converge" && expectedSystemConfigCommit !== undefined) {
      res.status(400).json({ error: "unexpected expectedSystemConfigCommit" });
      return;
    }

    try {
      const fenceGeneration = reason === "migration-converge"
        ? await readSystemConfigWatchFenceForBuilder(deps, body.slug)
        : undefined;
      await ensureMigrationSourceGiteaKey(deps, body.slug, reason);
      const result = await deps.flushLocalState({
        slug: body.slug,
        reason,
        ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
      });
      await resumeSystemConfigWatchAfterConvergence(
        deps,
        body.slug,
        reason,
        result.ok,
        fenceGeneration,
      );
      const response: FlushGatewayResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        ...result,
      };
      logFlushResult(result.ok, log,
        `migrationId=${body.migrationId} slug=${body.slug} ok=${result.ok} durationMs=${result.durationMs}`,
      );
      res.status(result.ok ? 200 : 500).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 flush migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "flush failed", message });
    }
  });
}

function restoreProjectCheckoutScope(value: unknown): UserSnapshot["projectCheckoutScope"] {
  return value === "workspace-and-projects" || value === "workspace-only" ? value : undefined;
}

function snapshotFromRestoreBody(body: RestoreMigrationRequestBody): UserSnapshot | null {
  const snapshot: unknown = body.snapshot;
  if (!isRecord(snapshot)) return null;
  if (snapshot.uid !== body.uid || snapshot.slug !== body.slug) return null;
  return {
    uid: snapshot.uid as string,
    slug: snapshot.slug as string,
    tier: snapshot.tier as string,
    gatewayId: snapshot.gatewayId as string,
    status: snapshot.status as UserSnapshot["status"],
    agentIds: Array.isArray(snapshot.agentIds)
      ? snapshot.agentIds.filter((id): id is string => typeof id === "string")
      : [],
    repoUrl: typeof snapshot.repoUrl === "string" ? snapshot.repoUrl : "",
    mattermostUserId:
      typeof snapshot.mattermostUserId === "string" ? snapshot.mattermostUserId : null,
    channels: Array.isArray(snapshot.channels) ? snapshot.channels as UserSnapshot["channels"] : [],
    ownerName: typeof snapshot.ownerName === "string" ? snapshot.ownerName : body.slug,
    projects: Array.isArray(snapshot.projects) ? snapshot.projects as UserSnapshot["projects"] : [],
    projectAgents: Array.isArray(snapshot.projectAgents) ? snapshot.projectAgents as UserSnapshot["projectAgents"] : [],
    projectCheckoutScope: restoreProjectCheckoutScope(snapshot.projectCheckoutScope),
    ...pickPlanInputs(snapshot),
    freeTierModelRef:
      typeof snapshot.freeTierModelRef === "string" ? snapshot.freeTierModelRef : undefined,
    builderAgentDefault: isRecord(snapshot.builderAgentDefault)
      ? (snapshot.builderAgentDefault as UserSnapshot["builderAgentDefault"])
      : undefined,
    byotActive: snapshot.byotActive === true,
    systemConfig: isRecord(snapshot.systemConfig)
      ? (snapshot.systemConfig as UserSnapshot["systemConfig"])
      : undefined,
  };
}

export function createRestoreHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  const active = new Map<string, { identity: string; result: Promise<RestoreMigrationResponse> }>();
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<RestoreMigrationRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    if (typeof body.uid !== "string" || body.uid.length === 0) {
      res.status(400).json({ error: "missing uid" });
      return;
    }
    const snapshot = snapshotFromRestoreBody(body);
    if (!snapshot) {
      res.status(400).json({ error: "snapshot mismatch" });
      return;
    }

    try {
      const identity = JSON.stringify(body);
      let entry = active.get(body.uid);
      if (entry && entry.identity !== identity) throw new Error("customer restore is still settling under a different request");
      if (!entry) {
        const result = Promise.resolve().then(async () => {
          await pauseSystemConfigWatchForBuilder(deps, body.slug);
          deps.adapter.markCustomerMigratingIn?.(body.slug);
          deps.adapter.seedUserSnapshotForMigration?.(body.snapshot);
          const adapter: CustomerLifecycleAdapter = {
            ...deps.adapter,
            loadUserSnapshot: async (uid) => {
              const fresh = await deps.adapter.loadUserSnapshot(uid);
              return uid === snapshot.uid ? fresh ?? snapshot : fresh;
            },
            uidForSlug: async (slug) => slug === snapshot.slug ? snapshot.uid : deps.adapter.uidForSlug(slug),
          };
          const restored = await restoreCustomerRuntimeFromSnapshot(adapter, snapshot);
          recordRestoredConvergence(deps, body.slug, restored);
          return { migrationId: body.migrationId, slug: body.slug, restored: restored.restored, steps: restored.steps };
        });
        entry = { identity, result };
        active.set(body.uid, entry);
        const owned = entry;
        const release = () => {
          if (active.get(body.uid) === owned) active.delete(body.uid);
        };
        void result.then(release, release);
      }
      const response = await entry.result;
      log(
        `[migration-http] 🟢 restore migrationId=${body.migrationId} slug=${body.slug} steps=${response.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 restore migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "restore failed", message });
    }
  });
}

export function createExportPathsHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ExportPathsRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      const allSources = await migrationAgentContextExportSources(deps, body, mode);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res.status(404).json({
          error: "no export paths",
          message: `nothing to export for slug=${body.slug} mode=${mode}`,
        });
        return;
      }
      const response: ExportPathsResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        sources,
      };
      dlog(
        `[migration-http] export-paths mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 export-paths migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "export-paths failed", message });
    }
  });
}

export function createActivationManifestExportHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ActivationManifestExportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;

    try {
      if (!deps.adapter.exportOpenClawActivationManifest) {
        throw new Error("source gateway cannot export an OpenClaw activation manifest");
      }
      const manifest = await deps.adapter.exportOpenClawActivationManifest(body.slug);
      const response: ActivationManifestExportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        manifest: manifest as unknown as Record<string, unknown>,
      };
      dlog(
        `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} exported`,
      );
      res.status(200).json(response);
    } catch (err) {
      if (deps.adapter.isBuilderGateway?.() === true) {
        const response: ActivationManifestExportResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          manifest: null,
        };
        const message = err instanceof Error ? err.message : String(err);
        log(
          `[migration-http] activation-manifest migrationId=${body.migrationId} slug=${body.slug} unavailable on Builder source: ${message}`,
        );
        res.status(200).json(response);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 activation-manifest migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "activation-manifest failed", message });
    }
  });
}

export function createPrepareImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<PrepareImportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;

    try {
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(body.slug)
        : await deps.adapter.prepareImportDir(body.slug, mode);
      if (mode !== "keys") deps.adapter.markCustomerMigratingIn?.(body.slug);
      log(
        `[migration-http] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} dir=${importDir}`,
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "prepare-import failed", message });
    }
  });
}

export function createActivateImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<ActivateImportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;

    try {
      deps.adapter.markCustomerMigratingIn?.(body.slug);
      const verificationPending = await activateImportedCustomerForMigration({
        deps,
        slug: body.slug,
        migrationId: body.migrationId,
        mode: "default",
      });
      deps.adapter.writeMountMarker?.(body.slug);
      deps.adapter.onMounted?.(body.slug);
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        ...(verificationPending ? { verificationPending } : {}),
      };
      log(
        `${verificationPending ? "🟡" : "🟢"} [migration-http] activate-import migrationId=${body.migrationId} slug=${body.slug}` +
        (verificationPending ? ` (verification pending: ${verificationPending})` : ""),
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-http] 🔴 activate-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "activate-import failed", message });
    }
  });
}

async function maybeMaterializeActivationManifest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody & { includeActivationManifest?: boolean },
  options: { signal: AbortSignal; timeoutMs: number; preserveForRollback?: boolean },
): Promise<{ source: { cwd: string; path: string } | null; cleanup: () => Promise<void> }> {
  if (body.includeActivationManifest !== true && !options.preserveForRollback) {
    return { source: null, cleanup: async () => undefined };
  }
  if (!deps.adapter.exportOpenClawActivationManifest) {
    throw new Error("source gateway cannot export an OpenClaw activation manifest");
  }
  let manifest;
  if (options.preserveForRollback) {
    manifest = await readActivationManifest(OPENCLAW_DIR, body.slug).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  manifest ??= await deps.adapter.exportOpenClawActivationManifest(body.slug, options);
  if (options.preserveForRollback) await writeActivationManifest(OPENCLAW_DIR, manifest);
  if (body.includeActivationManifest !== true) return { source: null, cleanup: async () => undefined };
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-activation-${body.migrationId}-`));
  try {
    const source = await writeActivationManifest(tmpDir, manifest);
    return {
      source,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

type MigrationImportMode = "keys" | "pre" | "final" | "default";


const RSYNC_IMPORT_MODULE = "state";
const RSYNC_READY_TIMEOUT_MS = 5_000;
const RSYNC_DAEMON_STOP_TIMEOUT_MS = 5_000;
const RSYNC_BIN = "/usr/bin/rsync";

interface RSyncImportSession {
  agentContext?: NativeAgentContextTransfer;
  key: string;
  migrationId: string;
  slug: string;
  mode: MigrationTransferMode;
  configTransferMode: MigrationConfigTransferMode;
  stageDir: string;
  importDir: string;
  configPath: string;
  secretsPath: string;
  child: ReturnType<typeof spawn>;
  transport: MigrationTlsEndpoint;
  baselineEntries?: string[];
}

const rsyncImportSessions = new Map<string, RSyncImportSession>();
let preparingRsyncImport = false;
const finishingRsyncImports = new Set<string>();

function rsyncSessionKey(
  migrationId: string,
  slug: string,
  mode: MigrationTransferMode,
): string {
  return `${migrationId}:${slug}:${mode}`;
}

function isMigrationTransferMode(value: unknown): value is MigrationTransferMode {
  return value === "keys" || value === "pre" || value === "final";
}

function isMigrationConfigTransferMode(value: unknown): value is MigrationConfigTransferMode {
  return value === ACTIVATION_MANIFEST_TRANSFER || value === BUILDER_SYSTEM_CONFIG_TRANSFER;
}

function validateTransferMode(
  mode: unknown,
  res: Response,
): MigrationTransferMode | null {
  if (isMigrationTransferMode(mode)) return mode;
  res.status(400).json({ error: "invalid migration mode" });
  return null;
}

function validateRsyncConfigTransferMode(
  value: unknown,
  mode: MigrationTransferMode,
  res: Response,
): MigrationConfigTransferMode | null {
  if (mode !== "final") {
    if (value === undefined) return ACTIVATION_MANIFEST_TRANSFER;
    res.status(400).json({ error: "configTransferMode is valid only for final imports" });
    return null;
  }
  if (value === undefined || value === ACTIVATION_MANIFEST_TRANSFER) return ACTIVATION_MANIFEST_TRANSFER;
  if (isMigrationConfigTransferMode(value)) return value;
  res.status(400).json({ error: "invalid configTransferMode" });
  return null;
}

function requireConfiguredBuilderSystemConfigTransfer(
  slug: string,
  configTransferMode: MigrationConfigTransferMode,
  res: Response,
): boolean {
  if (
    configTransferMode !== BUILDER_SYSTEM_CONFIG_TRANSFER ||
    isConfiguredGatewayBuilder(slug)
  ) {
    return true;
  }
  res.status(409).json({
    error: "configured Builder system config transfer requires the matching Builder gateway",
  });
  return false;
}

function validateMigrationLoadStrategy(
  value: unknown,
  res: Response,
): MigrationLoadStrategy | null {
  if (value === undefined || value === "standard") return "standard";
  if (value === "expedited") return value;
  res.status(400).json({ error: "invalid loadStrategy" });
  return null;
}

function validateRsyncRpcPhase(
  value: unknown,
  expected: RsyncMigrationRpcPhase,
  res: Response,
): boolean {
  if (value === expected) return true;
  res.status(400).json({ error: "invalid rsync RPC phase" });
  return false;
}

function validateRsyncCredential(value: unknown, name: string, res: Response): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    res.status(400).json({ error: `invalid ${name}` });
    return null;
  }
  return value;
}

function validateRsyncTargetHost(value: unknown, res: Response): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    (!net.isIP(value) && !/^[A-Za-z0-9.-]+$/.test(value))
  ) {
    res.status(400).json({ error: "invalid targetHost" });
    return null;
  }
  return value;
}

function validateRsyncPort(value: unknown, res: Response): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    res.status(400).json({ error: "invalid targetPort" });
    return null;
  }
  return value;
}

function normalizeLocalAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  if (normalized === "0.0.0.0" || normalized === "::") return null;
  return net.isIP(normalized) ? normalized : null;
}

function requestLocalAddress(req: Request): string {
  const socket = (req as Request & {
    socket?: {
      localAddress?: string;
      address?: () => string | net.AddressInfo;
    };
  }).socket;
  const direct = normalizeLocalAddress(socket?.localAddress);
  if (direct) return direct;
  const address = socket?.address?.() as unknown;
  const fromAddress = typeof address === "object" && address && "address" in address
    ? normalizeLocalAddress(address.address)
    : normalizeLocalAddress(address);
  return fromAddress ?? "127.0.0.1";
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}



function rsyncPortFromDeps(deps: MigrationHandlerDeps): number {
  if (deps.migrationRsyncPort) return deps.migrationRsyncPort;
  const fromEnv = Number.parseInt(process.env.MIGRATION_RSYNC_PORT ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : MIGRATION_RSYNC_PORT_DEFAULT;
}

async function waitForTcpPort(port: number): Promise<void> {
  const deadline = Date.now() + RSYNC_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy(new Error(`rsync port ${port} connect timeout`));
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`rsync port ${port} did not become ready`);
}

function rsyncDaemonExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function signalRsyncDaemonAndWait(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (rsyncDaemonExited(child)) return true;
  return new Promise<boolean>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (timeout) clearTimeout(timeout);
    };
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (rsyncDaemonExited(child)) {
      onExit();
      return;
    }
    timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, RSYNC_DAEMON_STOP_TIMEOUT_MS);
    try {
      if (child.kill(signal)) return;
      if (rsyncDaemonExited(child)) {
        onExit();
        return;
      }
    } catch (err) {
      if (rsyncDaemonExited(child)) {
        onExit();
        return;
      }
      cleanup();
      reject(err);
      return;
    }
    cleanup();
    reject(new Error(`rsync daemon did not accept ${signal}`));
  });
}

async function stopRsyncDaemon(child: ReturnType<typeof spawn>): Promise<void> {
  if (await signalRsyncDaemonAndWait(child, "SIGTERM")) return;
  if (await signalRsyncDaemonAndWait(child, "SIGKILL")) return;
  throw new Error("rsync daemon did not exit after SIGTERM and SIGKILL");
}

async function stopRsyncTransfer(session: RSyncImportSession): Promise<void> {
  await session.transport.close();
  await stopRsyncDaemon(session.child);
}

async function stopRsyncSession(session: RSyncImportSession | undefined, preserveStage = false): Promise<void> {
  if (!session) return;
  await stopRsyncTransfer(session);
  rsyncImportSessions.delete(session.key);
  if (!preserveStage) await fs.rm(session.mode === "keys" ? session.stageDir : path.dirname(session.stageDir), { recursive: true, force: true });
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true }).catch(() => undefined);
}

async function stopConflictingRsyncSession(migrationId: string, port: number): Promise<void> {
  const sessions = [...rsyncImportSessions.values()];
  const conflictingSession = sessions.find((session) => session.migrationId !== migrationId);
  if (conflictingSession) {
    throw new Error(
      `rsync import port ${port} is already serving migrationId=${conflictingSession.migrationId} slug=${conflictingSession.slug}`,
    );
  }
  for (const session of sessions) {
    await stopRsyncSession(session, true);
  }
}

function stagingIdentity(deps: MigrationHandlerDeps, body: MigrationRequestBody, configTransferMode: MigrationConfigTransferMode): MigrationStagingIdentity {
  return { gatewayId: deps.gatewayId, instanceId: process.env.POD_UID?.trim() || `process-${process.pid}`, migrationId: body.migrationId, slug: body.slug, configTransferMode };
}

const GIT_METADATA_DIR = "git-metadata";

async function retainCheckoutStaging(stageDir: string): Promise<void> {
  for (const entry of await fs.readdir(stageDir)) {
    if (entry !== "customers" && entry !== GIT_METADATA_DIR) await fs.rm(path.join(stageDir, entry), { recursive: true, force: true });
  }
}

interface CheckedSpawnOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  label: string;
}

function checkedChildCloseError(code: number | null, signal: NodeJS.Signals | null, label: string, output: string): Error | undefined {
  if (signal != null) return new Error(`${label} terminated by ${signal}: ${output}`);
  return code === 0 ? undefined : new Error(`${label} failed (code=${code ?? 1}): ${output}`);
}

async function runSpawnChecked(command: string, args: string[], opts: CheckedSpawnOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const child = spawn(command, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForCheckedChildClose(child, opts);
}

function waitForCheckedChildClose(child: ChildProcess, opts: CheckedSpawnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = "", stderr = "";
    let settled = false;
    let pendingFailure: { error: unknown } | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(escalation);
      opts.signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const signalChild = (signal: NodeJS.Signals) => {
      if (settled) return;
      try { child.kill(signal); }
      catch (error) { provisionerLog(`[migration-rsync] ${opts.label} ${signal} failed: ${String(error)}`); }
    };
    const stop = (error: unknown) => {
      if (settled || pendingFailure) return;
      pendingFailure = { error };
      escalation = setTimeout(() => signalChild("SIGKILL"), RSYNC_DAEMON_STOP_TIMEOUT_MS);
      signalChild("SIGTERM");
    };
    const abort = () => stop(opts.signal?.reason ?? new Error(`${opts.label} cancelled`));
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (child.pid === undefined) settle(error);
      else stop(error);
    });
    child.on("close", (code, signal) => settle(pendingFailure
      ? pendingFailure.error
      : checkedChildCloseError(code, signal, opts.label, stderr.trim() || stdout.trim())));
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (opts.timeoutMs) timeout = setTimeout(() => stop(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });
}

async function writeRsyncDaemonConfig(params: {
  dir: string;
  stageDir: string;
  transferUser: string;
  transferKey: string;
}): Promise<{ configPath: string; secretsPath: string }> {
  const secretsPath = path.join(params.dir, "rsyncd.secrets");
  await fs.writeFile(secretsPath, `${params.transferUser}:${params.transferKey}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const configPath = path.join(params.dir, "rsyncd.conf");
  const pidPath = path.join(params.dir, "rsyncd.pid");
  const lockPath = path.join(params.dir, "rsyncd.lock");
  await fs.writeFile(
    configPath,
    [
      "use chroot = no",
      RSYNC_DAEMON_SYMLINK_POLICY,
      "address = 127.0.0.1",
      "max connections = 1",
      "log file = /dev/stdout",
      `pid file = ${pidPath}`,
      `lock file = ${lockPath}`,
      `[${RSYNC_IMPORT_MODULE}]`,
      `  path = ${params.stageDir}`,
      "  read only = false",
      "  write only = true",
      "  list = false",
      `  auth users = ${params.transferUser}`,
      `  secrets file = ${secretsPath}`,
      "  hosts allow = 127.0.0.1",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { configPath, secretsPath };
}

async function listRelativeEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relDir ? path.posix.join(relDir, dirent.name) : dirent.name;
      entries.push(dirent.isDirectory() ? `${rel}/` : rel);
      if (dirent.isDirectory()) {
        await walk(path.join(absDir, dirent.name), rel);
      }
    }
  }
  await walk(root, "");
  return entries;
}

async function copyStageToOpenClaw(
  stageDir: string,
  importDir: string,
  slug: string,
  options: { baselineEntries?: readonly string[]; deferAgentState: boolean },
): Promise<void> {
  const { baselineEntries, deferAgentState } = options;
  if (baselineEntries) {
    const current = new Set(await listRelativeEntries(stageDir));
    for (const relative of baselineEntries) {
      if (!current.has(relative)) await fs.rm(path.join(importDir, relative), { recursive: true, force: true });
    }
  }
  await runSpawnChecked(
    RSYNC_BIN,
    [...STAGED_RSYNC_COPY_OPTIONS, ...CODEX_STORE_EXCLUDE_ARGS, CODEX_SNAPSHOT_EXCLUDE_ARG, CODEX_TEMP_EXCLUDE_ARG, ...(deferAgentState ? ["--exclude=/agents/"] : []), `${trimTrailingSlash(stageDir)}/`, `${trimTrailingSlash(importDir)}/`],
    { label: "rsync import copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS },
  );
  if (baselineEntries) return;
  for (const directory of ["customers", GIT_METADATA_DIR]) {
    const relative = path.join(directory, slug);
    if (!await hasRealStageAncestors(stageDir, path.join(relative, ".entry"))) continue;
    await runSpawnChecked(RSYNC_BIN, [
      ...STAGED_RSYNC_COPY_OPTIONS, "--delete", `${path.join(stageDir, relative)}/`, `${path.join(importDir, relative)}/`,
    ], { label: "rsync customer state copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS });
  }
}

async function hasRealStageAncestors(stageDir: string, relativePath: string): Promise<boolean> {
  const root = await fs.lstat(stageDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("rsync stage root is not a real directory");
  }
  let parent = stageDir;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`rsync staged path has a non-directory ancestor: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function omitSafeDefaultAgentStateFromStage(stageDir: string): Promise<string[]> {
  const omitted: string[] = [];
  for (const { relativePath } of SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS) {
    if (!await hasRealStageAncestors(stageDir, relativePath)) continue;
    const absolutePath = path.join(stageDir, relativePath);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fs.rm(absolutePath, { recursive: true, force: true });
    } else {
      await fs.unlink(absolutePath);
    }
    omitted.push(relativePath);
  }
  if (!await hasRealStageAncestors(stageDir, "workspaces/.placeholder")) return omitted;
  try {
    await fs.rmdir(path.join(stageDir, "workspaces"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
  return omitted;
}

interface RsyncPhaseRequest<T extends MigrationRequestBody> {
  body: T;
  mode: MigrationTransferMode;
  configTransferMode: MigrationConfigTransferMode;
}

function parseRsyncPhaseRequest<
  T extends MigrationRequestBody & {
    rpcPhase?: unknown;
    mode?: unknown;
    configTransferMode?: unknown;
  },
>(
  req: Request,
  res: Response,
  deps: MigrationHandlerDeps,
  phase: RsyncMigrationRpcPhase,
  log: (msg: string, fields?: LogContext) => void,
): RsyncPhaseRequest<T> | null {
  const body = parseAndVerifyJsonBody<T>(req, res, deps, log);
  if (!body) return null;
  if (!validateRsyncRpcPhase(body.rpcPhase, phase, res)) return null;
  const mode = validateTransferMode(body.mode, res);
  if (!mode) return null;
  const configTransferMode = validateRsyncConfigTransferMode(body.configTransferMode, mode, res);
  if (!configTransferMode) return null;
  if (!requireConfiguredBuilderSystemConfigTransfer(body.slug, configTransferMode, res)) return null;
  return { body, mode, configTransferMode };
}

function validateRsyncTransferCredentials(
  body: { transferUser?: unknown; transferKey?: unknown },
  res: Response,
): { transferUser: string; transferKey: string } | null {
  const transferUser = validateRsyncCredential(body.transferUser, "transferUser", res);
  if (!transferUser) return null;
  const transferKey = validateRsyncCredential(body.transferKey, "transferKey", res);
  if (!transferKey) return null;
  return { transferUser, transferKey };
}

async function startRsyncTransport(input: {
  deps: MigrationHandlerDeps;
  tmpDir: string;
  configPath: string;
  publicPort: number;
  sourcePodIp?: string;
  log: (msg: string, fields?: LogContext) => void;
}): Promise<{ child: ReturnType<typeof spawn>; transport: MigrationTlsEndpoint }> {
  const { deps } = input;
  const daemonPort = await (deps.reserveLoopbackPort ?? reserveLoopbackPort)();
  const child = spawn(
    RSYNC_BIN,
    ["--daemon", "--no-detach", `--config=${input.configPath}`, `--port=${daemonPort}`],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    await (deps.waitForRsyncReady ?? waitForTcpPort)(daemonPort);
    const transport = await (deps.openMigrationTlsEndpoint ?? openMigrationTlsEndpoint)({
      dir: input.tmpDir,
      publicPort: input.publicPort,
      upstreamPort: daemonPort,
      sourceIp: input.sourcePodIp,
      log: input.log,
    });
    return { child, transport };
  } catch (error) {
    await stopRsyncDaemon(child).catch(() => undefined);
    await fs.rm(input.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStagedSourceEntries(stageDir: string, slug: string): Promise<string[] | undefined> {
  const entries: unknown = await fs.readFile(path.join(path.dirname(stageDir), "source-entries.json"), "utf8")
    .then((value) => JSON.parse(value))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" ||
    (!entry.startsWith(`customers/${slug}/`) && !entry.startsWith(`${GIT_METADATA_DIR}/${slug}/`)) || entry.split("/").includes(".."))) {
    throw new Error("migration preparation contains unsafe source paths");
  }
  return entries;
}

async function prepareRsyncImportDirectories(
  deps: MigrationHandlerDeps,
  body: PrepareRsyncImportRequestBody,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
): Promise<{ tmpDir: string; stageDir: string; importDir: string; baselineEntries: string[] | undefined }> {
  const importDir = mode === "keys"
    ? await deps.adapter.prepareKeyImportDir(body.slug)
    : await deps.adapter.prepareImportDir(body.slug, mode);
  if (mode !== "keys") deps.adapter.markCustomerMigratingIn?.(body.slug);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-${body.migrationId}-`));
  try {
    const stageDir = mode === "keys"
      ? path.join(tmpDir, "stage")
      : await prepareMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, configTransferMode));
    await fs.mkdir(stageDir, { recursive: true });
    if (mode !== "keys") await retainCheckoutStaging(stageDir);
    const baselineEntries = mode === "final" ? await readStagedSourceEntries(stageDir, body.slug) : undefined;
    return { tmpDir, stageDir, importDir, baselineEntries };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function migrationImportBusy(): boolean {
  return preparingRsyncImport || finishingRsyncImports.size > 0;
}

async function validateAgentContextTransfer(
  deps: MigrationHandlerDeps, body: MigrationRequestBody & { agentContext?: unknown }, side: "source" | "target", mode: MigrationTransferMode, privateStaging = false,
): Promise<NativeAgentContextTransfer | undefined> {
  if (body.agentContext === undefined) return undefined;
  const context = body.agentContext as NativeAgentContextTransfer;
  const uid = privateStaging && side === "target" && context.mode === RESTORE_SHARED_AGENT_CONTEXT
    ? context.archive?.uid : await deps.adapter.uidForSlug(body.slug);
  if (!uid) throw new Error("native agent context owner is missing");
  return assertNativeAgentContextTransfer(body.agentContext, {
    uid, slug: body.slug, runtimeKind: process.env.GATEWAY_RUNTIME_KIND ?? "cluster",
    gatewayId: deps.gatewayId, podUid: process.env.POD_UID ?? "", configuredBuilder: deps.adapter.isBuilderGateway?.() === true,
  }, side, mode);
}

export function createPrepareRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<PrepareRsyncImportRequestBody>(
      req,
      res,
      deps,
      "prepare-rsync-import",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    const credentials = validateRsyncTransferCredentials(body, res);
    if (!credentials) return;
    const { transferUser, transferKey } = credentials;
    if (body.sourcePodIp !== undefined && !net.isIP(body.sourcePodIp)) {
      res.status(400).json({ error: "invalid sourcePodIp" });
      return;
    }

    if (migrationImportBusy()) {
      res.status(409).json({ error: "migration import preparation is already in progress" });
      return;
    }
    preparingRsyncImport = true;
    const port = rsyncPortFromDeps(deps);
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    let activation: ConfiguredBuilderActivation | null = null;
    try {
      const agentContext = await validateAgentContextTransfer(deps, body, "target", mode, true);
      activation = await configuredBuilderActivationRequest(deps, body, mode, configTransferMode);
      if (activation?.live) {
        await admitLiveConfiguredBuilderImport(deps, activation);
      } else if (activation) {
        await deps.reserveSurgeTarget!(activation.request);
      } else if (configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER) {
        await deps.reserveSurgeTarget?.({ migrationId: body.migrationId, slug: body.slug });
      }
      await stopConflictingRsyncSession(body.migrationId, port);
      const { tmpDir, stageDir, importDir, baselineEntries } = await prepareRsyncImportDirectories(deps, body, mode, configTransferMode);
      const { configPath, secretsPath } = await writeRsyncDaemonConfig({
        dir: tmpDir,
        stageDir,
        transferUser,
        transferKey,
      });
      const { child, transport } = await startRsyncTransport({
        deps,
        tmpDir,
        configPath,
        publicPort: port,
        sourcePodIp: body.sourcePodIp,
        log,
      });
      const session: RSyncImportSession = {
        agentContext,
        key,
        migrationId: body.migrationId,
        slug: body.slug,
        mode,
        configTransferMode,
        stageDir,
        importDir,
        configPath,
        secretsPath,
        child,
        transport,
        baselineEntries,
      };
      rsyncImportSessions.set(key, session);
      child.on("exit", () => {
        if (rsyncImportSessions.get(key) === session) rsyncImportSessions.delete(key);
      });
      child.on("error", (err) => {
        log(
          `[migration-rsync] 🔴 rsync daemon error migrationId=${body.migrationId} slug=${body.slug}: ${err.message}`, { status: "failed" },
        );
      });
      const response: PrepareRsyncImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: requestLocalAddress(req),
        port,
        module: RSYNC_IMPORT_MODULE,
        certificatePem: transport.certificatePem,
      };
      log(
        `🟡 [migration-rsync] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} port=${port}`,
      );
      res.status(200).json(response);
    } catch (err) {
      await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
      if (activation && !activation.live) {
        await deps.unreserveSurgeTarget!(activation.request).catch((error: unknown) => {
          log(`[migration-rsync] failed to cancel Builder preparation migrationId=${body.migrationId} slug=${body.slug}: ${String(error)}`);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-rsync] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" },
      );
      res.status(500).json({ error: "prepare-rsync-import failed", message });
    } finally {
      preparingRsyncImport = false;
    }
  });
}

function validateRsyncPushTarget(body: PushRsyncStateRequestBody, res: Response): {
  targetHost: string;
  targetPort: number;
  targetCertificatePem: string;
  transferUser: string;
  transferKey: string;
} | null {
  const targetHost = validateRsyncTargetHost(body.targetHost, res);
  if (!targetHost) return null;
  const targetPort = validateRsyncPort(body.targetPort, res);
  if (targetPort === null) return null;
  if (!isMigrationCertificatePem(body.targetCertificatePem)) {
    res.status(400).json({ error: "invalid targetCertificatePem" });
    return null;
  }
  const credentials = validateRsyncTransferCredentials(body, res);
  if (!credentials) return null;
  return { targetHost, targetPort, targetCertificatePem: body.targetCertificatePem, ...credentials };
}

async function migrationAgentContextExportSources(deps: MigrationHandlerDeps, body: MigrationRequestBody & { agentContext?: unknown }, mode: MigrationTransferMode): Promise<Array<{ cwd: string; path: string }>> {
  const agentContext = await validateAgentContextTransfer(deps, body, "source", mode);
  if (agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) return deps.adapter.listExportPaths(body.slug);
  const archived = await archivedSharedAgentExportPaths({ stateDir: resolveOpenClawStateDir(), archive: agentContext.archive });
  const customerFiles = (await deps.adapter.listExportPaths(body.slug)).filter(source =>
    ["customers", "git-metadata", "customer-keys"].some(directory => source.path === path.join(directory, body.slug)));
  return [...archived, ...customerFiles];
}

export function createPushRsyncStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<PushRsyncStateRequestBody>(
      req,
      res,
      deps,
      "push-rsync-state",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    if (
      configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER &&
      body.includeActivationManifest === true
    ) {
      res.status(400).json({ error: "configured Builder system config transfer cannot include activation manifest" });
      return;
    }
    const target = validateRsyncPushTarget(body, res);
    if (!target) return;
    const { targetHost, targetPort, targetCertificatePem, transferUser, transferKey } = target;
    const deadline = Date.now() + timeoutMs;

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-push-${body.migrationId}-`));
    const { controller, detach } = attachImportDisconnectHandlers(res, body.migrationId, body.slug, log, "export");
    const transferTimer = setTimeout(() => controller.abort(new Error("rsync push-state transfer deadline exceeded")), Math.max(0, deadline - Date.now()));
    try {
      const allSources = await migrationAgentContextExportSources(deps, body, mode);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      const postgresHandoff = mode === "final" && (await findPortableAgentStores(sources)).some(store =>
        readPostgresAgentAnchor(path.join(store.sourceAgentDir, AGENT_STORE_BASENAME)) !== null);
      const manifestRequest = configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER ? { ...body, includeActivationManifest: false } : body;
      const activationManifest = mode === "keys"
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, manifestRequest, {
            signal: controller.signal,
            timeoutMs: remainingTransferTimeout(deadline, controller.signal),
            preserveForRollback: postgresHandoff,
          });
      cleanupActivationManifest = activationManifest.cleanup;
      if (mode === "final") {
        const sourceHeld = await deps.surgeSourceOpenClawHeld?.({ migrationId: body.migrationId, slug: body.slug }) === true;
        sources.push(...await exportAgentStoreSnapshots({
          sources,
          exportRoot: path.join(tmpDir, "snapshots"),
          signal: controller.signal,
          log,
          detachAgent: async (agentId) => {
            if (sourceHeld) {
              log(`[migration-rsync] OpenClaw is held for migration ${body.migrationId}; carrying ${agentId}'s closed anchor without detach`);
              return;
            }
            if (!deps.adapter.releaseAgent) throw new Error("Gateway cannot detach PostgreSQL agents");
            await deps.adapter.releaseAgent(agentId);
          },
        }));
      }

      if (activationManifest.source) sources.push(activationManifest.source);

      const passwordFile = path.join(tmpDir, "rsync.pass");
      await fs.writeFile(passwordFile, `${transferKey}\n`, { encoding: "utf-8", mode: 0o600 });
      const certificatePath = path.join(tmpDir, "target.crt");
      await fs.writeFile(certificatePath, targetCertificatePem, { encoding: "utf-8", mode: 0o600 });
      const destination = `rsync://${transferUser}@${targetHost}/${RSYNC_IMPORT_MODULE}/`;
      dlog(
        `[migration-rsync] push-state mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length} target=${targetHost}:${targetPort}`,
      );
      await runSpawnChecked(
        RSYNC_BIN,
        sourceTransferRsyncArgs(sources, passwordFile, destination, mode),
        {
          timeoutMs: remainingTransferTimeout(deadline, controller.signal),
          signal: controller.signal,
          label: "rsync push-state",
          env: {
            ...process.env,
            RSYNC_CONNECT_PROG: rsyncTlsConnectProgram({ certificatePath, host: targetHost, port: targetPort }),
          },
        },
      );
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
      };
      dlog(
        `[migration-rsync] 🟢 push-state migrationId=${body.migrationId} slug=${body.slug} target=${targetHost}:${targetPort} done`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] 🔴 push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "push-rsync-state failed", message });
    } finally {
      clearTimeout(transferTimer);
      detach();
      await cleanupActivationManifest();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function remainingTransferTimeout(deadline: number, signal: AbortSignal): number {
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("rsync push-state preparation exhausted its transfer deadline");
  return remaining;
}

async function validateStagedGitMetadata(stageDir: string, slug: string): Promise<string | null> {
  const metadataPath = path.join(GIT_METADATA_DIR, slug);
  for (const relative of ["", GIT_METADATA_DIR, metadataPath]) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(path.join(stageDir, relative));
    } catch (error) {
      if (relative && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return `unsafe Git metadata: ${relative || "."} is not a real directory`;
    }
  }
  const unsafeEntry = findUnsafeCustomerGitMetadataEntry(path.join(stageDir, metadataPath));
  return unsafeEntry === null ? null : `unsafe Git metadata: ${path.join(metadataPath, unsafeEntry)}`;
}

async function discardPreCopyAgentSnapshots(
  stageDir: string,
  log: (message: string, fields?: LogContext) => void,
): Promise<void> {
  const snapshots = await findStagedAgentSnapshots(stageDir);
  if (snapshots.length === 0) return;
  for (const snapshot of snapshots) await fs.rm(path.dirname(snapshot.snapshotDir), { recursive: true, force: true });
  log(`[migration-rsync] discarded agent snapshots an older source carried in its pre-copy: ${snapshots.map((snapshot) => snapshot.agentId).join(", ")}`);
}

async function validateStagedRsyncImport(
  session: RSyncImportSession,
  slug: string,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
  log: (message: string, fields?: LogContext) => void,
): Promise<string | null> {
  const unsafeGitMetadata = await validateStagedGitMetadata(session.stageDir, slug);
  if (unsafeGitMetadata !== null) return unsafeGitMetadata;
  if (mode !== "keys") {
    const omitted = await omitSafeDefaultAgentStateFromStage(session.stageDir);
    if (omitted.length > 0) {
      log(`[migration-rsync] omitted system fallback state from staged import: ${omitted.join(",")}`);
    }
  }
  const entries = await listRelativeEntries(session.stageDir);
  const configuredBuilderStateDir = resolveOpenClawStateDir();
  const configuredBuilderStatePlan = configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER
    ? configuredBuilderPortableStatePlan(openClawConfigPath(), configuredBuilderStateDir)
    : undefined;
  const violation = findPathTraversalViolation(entries, slug, mode, [], configuredBuilderStatePlan);
  if (violation !== null) return violation;
  await omitStagedCodexTemporaryFiles(session.stageDir, log);
  await assertSafeStagedSymlinks(session.stageDir, session.importDir, slug);
  const liveStores = await findStagedLiveAgentStores(session.stageDir);
  if (liveStores.length > 0) {
    return `carried live agent database files instead of snapshots: ${liveStores.join(", ")}`;
  }
  if (mode === "pre") await discardPreCopyAgentSnapshots(session.stageDir, log);
  await omitRawCodexDatabases(session.stageDir, log);
  const staged = (await listSqliteStores(session.stageDir)).filter((store) => !isAgentSnapshotArtifact(store) &&
    !isCodexDatabase(path.relative(session.stageDir, store).split(path.sep).join("/")));
  const unreadable = await findUnreadableStore({ storePaths: staged, relativeTo: session.stageDir });
  if (unreadable) {
    return `carried agent store ${unreadable.path} does not open: ${unreadable.message}`;
  }
  if (configuredBuilderStatePlan) {
    if (path.resolve(configuredBuilderStateDir) !== path.resolve(session.importDir)) {
      throw new Error("configured Builder state root does not match the import root");
    }
    assertConfiguredBuilderPortableStatePlanOnDisk(session.stageDir, configuredBuilderStatePlan);
    assertConfiguredBuilderPortableStatePlanOnDisk(session.importDir, configuredBuilderStatePlan);
  }
  return null;
}

interface ConfiguredBuilderActivation {
  request: { migrationId: string; slug: string; targetPodUid: string };
  live: boolean;
}

async function configuredBuilderActivationRequest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
): Promise<ConfiguredBuilderActivation | null> {
  if (mode === "keys" || configTransferMode !== ACTIVATION_MANIFEST_TRANSFER ||
    deps.adapter.isBuilderGateway?.() !== true) return null;
  if (deps.adapter.isConfiguredBuilderCustomer?.(body.slug) !== true) {
    throw new Error("import does not match the configured Builder");
  }
  const targetPodUid = process.env.POD_UID?.trim();
  if (!targetPodUid || !deps.reserveSurgeTarget || !deps.releaseSurgeReadiness || !deps.unreserveSurgeTarget ||
    !deps.surgeTargetLive || !deps.admitLiveSurgeTarget || !deps.liveSurgeTargetAssigned) {
    throw new Error("configured Builder activation requires its pod-bound process gate");
  }
  const request = { migrationId: body.migrationId, slug: body.slug, targetPodUid };
  return { request, live: await deps.surgeTargetLive(request) };
}

function liveImportAdmission(deps: MigrationHandlerDeps, activation: ConfiguredBuilderActivation): Promise<LiveImportAdmission | null> {
  return readLiveImportAdmission(os.tmpdir(), stagingIdentity(deps, activation.request, ACTIVATION_MANIFEST_TRANSFER));
}

function recordLiveImportAdmission(
  deps: MigrationHandlerDeps,
  activation: ConfiguredBuilderActivation,
  decision: LiveImportAdmission,
): Promise<void> {
  return writeLiveImportAdmission(os.tmpdir(), stagingIdentity(deps, activation.request, ACTIVATION_MANIFEST_TRANSFER), decision);
}

async function admitLiveConfiguredBuilderImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredBuilderActivation,
): Promise<void> {
  try {
    if (deps.adapter.customerMountMarked?.(activation.request.slug) !== false) {
      throw new Error("live Builder import requires the configured customer to be unmounted");
    }
    await deps.admitLiveSurgeTarget!(activation.request);
  } catch (error) {
    if (await liveImportAdmission(deps, activation) !== "admitted") await recordLiveImportAdmission(deps, activation, "refused");
    throw error;
  }
  await recordLiveImportAdmission(deps, activation, "admitted");
  (deps.log ?? provisionerLog)(
    `[migration-rsync] importing into live Builder OpenClaw migrationId=${activation.request.migrationId} slug=${activation.request.slug}`,
  );
}

async function activateBuilderCoach(
  deps: MigrationHandlerDeps,
  slug: string,
  signal: AbortSignal,
  loadStrategy: MigrationLoadStrategy,
): Promise<void> {
  const verificationPending = await activateImportedCustomerForMigration({
    deps,
    slug,
    mode: "final",
    loadStrategy,
    signal,
  });
  signal.throwIfAborted();
  if (verificationPending) {
    throw new Error(`Builder Coach activation verification failed: ${verificationPending}`);
  }
}

async function activateConfiguredBuilderImport(
  deps: MigrationHandlerDeps,
  activation: ConfiguredBuilderActivation,
  signal: AbortSignal,
  loadStrategy: MigrationLoadStrategy,
): Promise<void> {
  if (activation.live) {
    signal.throwIfAborted();
    await activateBuilderCoach(deps, activation.request.slug, signal, loadStrategy);
    return;
  }
  const { request } = activation;
  let cancellation: Promise<void> | null = null;
  let cancellationFailure: Error | null = null;
  const cancel = (): void => {
    cancellation ??= Promise.resolve().then(() => deps.unreserveSurgeTarget!(request)).then(
      () => undefined,
      (error: unknown) => { cancellationFailure = error instanceof Error ? error : new Error(String(error)); },
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await deps.releaseSurgeReadiness!({
      migrationId: request.migrationId,
      targetPodUid: request.targetPodUid,
    });
    signal.throwIfAborted();
    await activateBuilderCoach(deps, request.slug, signal, loadStrategy);
  } catch (error) {
    (deps.log ?? provisionerLog)(
      `[migration-rsync] Builder activation failed migrationId=${request.migrationId} slug=${request.slug}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    cancel();
    await cancellation;
    if (cancellationFailure) {
      throw new AggregateError([error, cancellationFailure], "Builder activation failed and could not be cancelled");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function sharedRestoreHoldMatches(snapshot: UserSnapshot | null, deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody): snapshot is UserSnapshot {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT || !snapshot) return false;
  const archive = body.agentContext.archive, hold = snapshot.nativeSharedContextRestore;
  if (!hold || ![hold.operationId, hold.fromGatewayId].every(value => typeof value === "string" && value.length > 0)) return false;
  return snapshot.uid === archive.uid && snapshot.slug === body.slug && snapshot.gatewayId === deps.gatewayId &&
    isDeepStrictEqual(hold, { operationId: hold.operationId, fromGatewayId: hold.fromGatewayId, uid: archive.uid, slug: body.slug,
      toGatewayId: deps.gatewayId, migrationId: body.migrationId, archiveId: archive.archiveId, contextSha256: archive.contextSha256 });
}

async function sharedRestoreSnapshot(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, requireUnadmitted: boolean): Promise<UserSnapshot> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) throw new Error("Shared restore policy is missing");
  const snapshot = await deps.adapter.loadUserSnapshot(body.agentContext.archive.uid, { refresh: true });
  if (!sharedRestoreHoldMatches(snapshot, deps, body)) throw new Error("Shared context restoration admission hold does not match assigned owner");
  if (requireUnadmitted && (deps.adapter.hasCustomerAgentRuntime?.(body.slug) !== false || deps.adapter.customerCoachWiredInOpenclawConfig?.(body.slug) !== false)) {
    throw new Error("Shared context restoration requires an unadmitted customer runtime");
  }
  return snapshot;
}

function withSharedRestoreCustody<T>(body: FinishRsyncImportRequestBody, run: () => Promise<T>): Promise<T> {
  return body.agentContext?.mode === RESTORE_SHARED_AGENT_CONTEXT ? withCustomerRemoval(body.slug, run) : run();
}

async function markSharedRestoreInstalled(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, stateDir: string): Promise<void> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) return;
  await writeSharedAgentContextRestoreReceipt({ stateDir, gatewayId: deps.gatewayId, podUid: process.env.POD_UID ?? "", request: body,
    response: completedImportResponse(body, undefined, body.agentContext.archive), phase: "installed" });
}

function recordRestoredConvergence(
  deps: MigrationHandlerDeps,
  slug: string,
  restored: RestoreCustomerRuntimeResult,
): void {
  if (!deps.adapter.recordAppliedFingerprint) return;
  const log = deps.log ?? provisionerLog;
  if (!restored.convergedState) {
    log(
      `⚠ [migration-http] restore of ${slug} left its re-assert incomplete; no fingerprint recorded so the reconcile re-ensures it`,
    );
    return;
  }
  if (restored.appliedFingerprint === undefined) {
    log(
      `⚠ [migration-http] restore of ${slug} reported no applied fingerprint; the reconcile re-ensures it as content-stale`,
    );
    return;
  }
  deps.adapter.recordAppliedFingerprint(
    slug,
    restored.pendingProjectClones.length > 0
      ? pendingCloneAppliedFingerprint(restored.appliedFingerprint)
      : restored.appliedFingerprint,
  );
}

async function activateFinishedRsyncImport(input: {
  deps: MigrationHandlerDeps;
  body: FinishRsyncImportRequestBody;
  configTransferMode: MigrationConfigTransferMode;
  loadStrategy: MigrationLoadStrategy;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { deps, body, configTransferMode, loadStrategy, signal } = input;
  deps.adapter.markCustomerMigratingIn?.(body.slug);
  if (body.agentContext?.mode === RESTORE_SHARED_AGENT_CONTEXT) {
    const snapshot = await sharedRestoreSnapshot(deps, body, false);
    const restored = await restoreCustomerRuntimeFromSnapshot(deps.adapter, snapshot, { signal });
    recordRestoredConvergence(deps, body.slug, restored);
    deps.adapter.onMounted?.(body.slug);
    return undefined;
  }
  if (configTransferMode === ACTIVATION_MANIFEST_TRANSFER) {
    const activation = await configuredBuilderActivationRequest(deps, body, "final", configTransferMode);
    let verificationPending: string | undefined;
    if (activation) {
      await activateConfiguredBuilderImport(deps, activation, signal, loadStrategy);
    } else {
      verificationPending = await activateImportedCustomerForMigration({
        deps,
        slug: body.slug,
        migrationId: body.migrationId,
        mode: "final",
        loadStrategy,
        signal,
      });
    }
    deps.adapter.writeMountMarker?.(body.slug);
    deps.adapter.onMounted?.(body.slug);
    return verificationPending;
  }
  return undefined;
}

async function removeObsoletePreparedProjects(deps: MigrationHandlerDeps, session: RSyncImportSession, slug: string): Promise<void> {
  if (!session.baselineEntries) return;
  const projectsDir = path.join(session.importDir, "customers", slug, "projects");
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length === 0) return;
  const uid = await deps.adapter.uidForSlug(slug);
  if (!uid) throw new Error("prepared Builder no longer has an owner");
  const snapshot = await deps.adapter.loadUserSnapshot(uid, { refresh: true });
  if (!snapshot || snapshot.slug !== slug) throw new Error("prepared Builder ownership changed");
  const desired = new Set((snapshot.projects ?? []).filter(project => projectCheckoutEnabled(project.checkoutEnabled) &&
    (project.provisioningState === undefined || project.provisioningState === "active")).map(project => project.projectSlug));
  for (const entry of entries) {
    if (desired.has(entry.name)) continue;
    const relative = path.join("customers", slug, "projects", entry.name);
    const sourcePresent = await fs.lstat(path.join(session.stageDir, relative)).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (sourcePresent) continue;
    await fs.rm(path.join(session.importDir, relative), { recursive: true, force: true });
    await fs.rm(path.join(session.importDir, GIT_METADATA_DIR, slug, "projects", `${entry.name}.git`), { recursive: true, force: true });
  }
}

interface StagedImportInput {
  deps: MigrationHandlerDeps;
  session: RSyncImportSession;
  slug: string;
  mode: MigrationTransferMode;
  activation: ConfiguredBuilderActivation | null;
  signal: AbortSignal;
  log: (msg: string, fields?: LogContext) => void;
}

type RetainedAgentContextTransfer = Extract<NativeAgentContextTransfer, { mode: "retain-native" }>;

async function retainedImportPolicy(input: StagedImportInput): Promise<RetainedAgentContextTransfer | undefined> {
  const retained = input.session.agentContext?.mode === "retain-native" ? input.session.agentContext : undefined;
  if (!retained) return undefined;
  if (!input.activation || !input.activation.live && !await input.deps.surgeTargetOpenClawHeld?.(input.activation.request)) {
    throw new Error("retained native import requires its held or live Builder OpenClaw process gate");
  }
  await assertRetainedNativeAgentContext(input.session.importDir, input.slug);
  return retained;
}

function deferImportedAgentState(input: StagedImportInput, retained: RetainedAgentContextTransfer | undefined): boolean {
  return !!retained || input.mode === "pre" && (!input.activation || input.activation.live);
}

async function archiveRetainedImport(input: StagedImportInput, prepared: PreparedAgentStores, retained: RetainedAgentContextTransfer): Promise<NativeSharedAgentContextArchive> {
  const { session, log } = input;
  const receipt = await archiveNativeSharedAgentContext({ stateDir: session.importDir, stageDir: session.stageDir, prepared,
    procRoot: input.deps.procRoot ?? PROC_ROOT, transfer: retained, signal: input.signal });
  log(`[migration-rsync] preserved native context and archived Shared agents slug=${receipt.slug} archiveId=${receipt.archiveId} digest=${receipt.contextSha256} agents=${receipt.agentIds.join(",")}`);
  return receipt;
}

async function carriedProjectWorkspace(input: StagedImportInput, agentId: string): Promise<string | null> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind !== "project" || parsed.username !== input.slug) return null;
  const uid = await input.deps.adapter.uidForSlug(input.slug);
  if (!uid) throw new Error("Carried Builder project has no current owner");
  const snapshot = await input.deps.adapter.loadUserSnapshot(uid, { refresh: true });
  if (!snapshot || snapshot.uid !== uid || snapshot.slug !== input.slug) throw new Error("Carried Builder project ownership changed");
  if (!activeAgentProjectIds(snapshot.projectAgents ?? []).has(parsed.project)) return null;
  return path.join(input.session.importDir, "customers", input.slug, "projects", parsed.project);
}

async function heldBuilderActivation(input: StagedImportInput): Promise<ConfiguredBuilderActivation | null> {
  const activation = input.activation;
  if (!activation || activation.live) return null;
  return await input.deps.surgeTargetOpenClawHeld?.(activation.request) === true ? activation : null;
}

async function deliverStagedImport(input: StagedImportInput): Promise<NativeSharedAgentContextArchive | undefined> {
  const { deps, session, log } = input;
  const retained = await retainedImportPolicy(input);
  const deferAgentState = deferImportedAgentState(input, retained);
  const copyOptions = { baselineEntries: session.baselineEntries, deferAgentState };
  if (input.mode !== "final") {
    if (input.activation) await removeObsoletePreparedProjects(deps, session, input.slug);
    await copyStageToOpenClaw(session.stageDir, session.importDir, input.slug, copyOptions);
    if (retained) log(`[migration-rsync] preserved retained native agent context during pre-copy slug=${input.slug}`);
    return;
  }
  const prepared = await prepareAgentStoreSnapshots({
    stageDir: session.stageDir,
    importDir: session.importDir,
    migrationId: session.migrationId,
    signal: input.signal,
    log,
  });
  if (input.activation) await removeObsoletePreparedProjects(deps, session, input.slug);
  const codex = deferAgentState ? null : await prepareCodexStoreSnapshots(session.stageDir, log);
  try {
    const offlineActivation = await heldBuilderActivation(input);
    if (!offlineActivation || retained) await copyStageToOpenClaw(session.stageDir, session.importDir, input.slug, copyOptions);
    if (retained) return archiveRetainedImport(input, prepared, retained);
    await installPreparedAgentStores({
      prepared,
      releaseAgent: (agentId) => releaseAgentForImport(deps, input.activation, agentId, log),
      procRoot: deps.procRoot ?? PROC_ROOT,
      log,
    });
    if (offlineActivation) {
      await reattachBuilderAgents({
        stores: prepared.stores,
        env: { ...process.env, OPENCLAW_STATE_DIR: session.importDir, OPENCLAW_DIR: session.importDir, OPENCLAW_CONFIG_PATH: openClawConfigPath() },
        run: deps.runOpenClaw,
        resolveCarriedProjectWorkspace: agentId => carriedProjectWorkspace(input, agentId),
        signal: input.signal,
        log,
        assertHeld: async () => {
          if (await deps.surgeTargetOpenClawHeld?.(offlineActivation.request) !== true) {
            throw new Error("Native Builder restoration requires the migration target to remain held");
          }
        },
      });
      await copyStageToOpenClaw(session.stageDir, session.importDir, input.slug, copyOptions);
    }
    await installCodexStoreSnapshots({ prepared: codex, importDir: session.importDir, procRoot: deps.procRoot ?? PROC_ROOT, log, signal: input.signal });
    if (session.agentContext?.mode === RESTORE_SHARED_AGENT_CONTEXT) return session.agentContext.archive;
  } finally {
    await discardCodexStoreSnapshots(codex, log);
  }
}

async function finishTargetPreparation(
  deps: MigrationHandlerDeps,
  session: RSyncImportSession,
  body: FinishRsyncImportRequestBody,
  configTransferMode: MigrationConfigTransferMode,
  signal: AbortSignal,
): Promise<void> {
  const activation = await configuredBuilderActivationRequest(deps, body, "pre", configTransferMode);
  const placeholders = new Set(activation ? deferredProjectPlaceholderPaths(session.stageDir, body.slug) : []);
  const sourceEntries = (await listRelativeEntries(session.stageDir)).filter(entry =>
    (entry.startsWith(`customers/${body.slug}/`) || entry.startsWith(`${GIT_METADATA_DIR}/${body.slug}/`)) &&
    !placeholders.has(entry));
  await fs.writeFile(path.join(path.dirname(session.stageDir), "source-entries.json"), JSON.stringify(sourceEntries), { mode: 0o600 });
  if (!activation || activation.live) return;
  if (!deps.prepareSurgeTarget) throw new Error("Builder target preparation is unavailable");
  await deps.prepareSurgeTarget(activation.request, signal);
}

function validateSharedRestoreCertificate(session: RSyncImportSession, body: FinishRsyncImportRequestBody, res: Response): boolean {
  const expected = session.agentContext?.mode === RESTORE_SHARED_AGENT_CONTEXT
    ? createHash("sha256").update(session.transport.certificatePem).digest("hex") : undefined;
  if (body.targetCertificateSha256 !== expected) {
    res.status(409).json({ error: "Shared context restoration target certificate does not match prepared session" });
    return false;
  }
  return true;
}

function validateRsyncImportSessionPolicy(session: RSyncImportSession, body: FinishRsyncImportRequestBody, configTransferMode: MigrationConfigTransferMode, res: Response): boolean {
  if (!validateSharedRestoreCertificate(session, body, res)) return false;
  if (!isDeepStrictEqual(session.agentContext, body.agentContext)) {
    res.status(409).json({ error: "rsync import agent context custody does not match prepared session" });
    return false;
  }
  if (session.configTransferMode !== configTransferMode) {
    res.status(409).json({ error: "rsync import config transfer mode does not match prepared session" });
    return false;
  }
  return true;
}

function completedImportResponse(body: MigrationRequestBody, verificationPending: string | undefined, sharedAgentContext: NativeSharedAgentContextArchive | undefined): ImportResponse {
  return { migrationId: body.migrationId, slug: body.slug, imported: true,
    ...(verificationPending ? { verificationPending } : {}), ...(sharedAgentContext ? { sharedAgentContext } : {}) };
}

async function replaySharedAgentContextRestore(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, mode: MigrationTransferMode, res: Response): Promise<boolean> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) return false;
  const receipt = await readSharedAgentContextRestoreReceipt({ stateDir: resolveOpenClawStateDir(), gatewayId: deps.gatewayId,
    podUid: process.env.POD_UID ?? "", request: body });
  if (!receipt) return false;
  if (migrationImportBusy()) { res.status(409).json({ error: "migration import completion is already in progress" }); return true; }
  const key = rsyncSessionKey(body.migrationId, body.slug, "final");
  finishingRsyncImports.add(key);
  const log = deps.log ?? provisionerLog, { controller, detach } = attachImportDisconnectHandlers(res, body.migrationId, body.slug, log);
  try {
    await withCustomerRemoval(body.slug, async () => {
      await validateAgentContextTransfer(deps, body, "target", mode);
      await assertInstalledSharedContext(body, receipt.databasePaths);
      if (receipt.phase === "installed") {
        await sharedRestoreSnapshot(deps, body, false);
        await activateFinishedRsyncImport({ deps, body, configTransferMode: ACTIVATION_MANIFEST_TRANSFER, loadStrategy: "standard", signal: controller.signal });
        await writeSharedAgentContextRestoreReceipt({ stateDir: resolveOpenClawStateDir(), gatewayId: deps.gatewayId, podUid: process.env.POD_UID ?? "", request: body, response: receipt.response });
      }
    });
    log(`[migration-rsync] confirmed previously restored Shared context slug=${body.slug} archiveId=${body.agentContext.archive.archiveId}`);
    res.status(200).json(receipt.response);
  } finally { detach(); finishingRsyncImports.delete(key); }
  return true;
}

async function assertInstalledSharedContext(body: FinishRsyncImportRequestBody, databasePaths: readonly string[]): Promise<void> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) throw new Error("Installed Shared context policy is missing");
  const stateDir = await fs.realpath(resolveOpenClawStateDir());
  for (const relative of databasePaths) {
    const file = path.join(stateDir, relative);
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file) throw new Error("Installed Shared agent database is not canonical");
  }
  await assertRetainedNativeAgentContext(stateDir, body.slug);
}

async function sharedRecoverySnapshot(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody): Promise<UserSnapshot> {
  const snapshot = await sharedRestoreSnapshot(deps, body, false);
  if (deps.adapter.customerCoachWiredInOpenclawConfig?.(body.slug) !== false || deps.adapter.customerMountMarked?.(body.slug) !== false) {
    throw new Error("Shared context recovery requires an unwired and unmounted customer runtime");
  }
  return snapshot;
}

async function installRecoveredSharedContext(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, root: string, signal: AbortSignal): Promise<void> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT) throw new Error("Shared recovery archive is missing");
  const archive = body.agentContext.archive, importDir = await fs.realpath(resolveOpenClawStateDir());
  const stores = await findPortableAgentStores(archive.agentIds.map(agentId => ({ cwd: root, path: `agents/${agentId}` })));
  const importRoot = path.join(importDir, AGENT_IMPORT_DIRNAME);
  await fs.mkdir(importRoot, { recursive: true, mode: 0o700 });
  if (await fs.realpath(importRoot) !== path.resolve(importRoot)) throw new Error("Shared recovery landing directory is not canonical");
  const landingRoot = await fs.mkdtemp(path.join(importRoot, "shared-recovered-"));
  try {
    const prepared: PreparedAgentStores = { landingRoot, stores: [] };
    for (const store of stores) {
      signal.throwIfAborted();
      const source = path.join(store.sourceAgentDir, AGENT_STORE_BASENAME);
      const restoredPath = path.join(landingRoot, store.agentDir, AGENT_STORE_BASENAME);
      await fs.mkdir(path.dirname(restoredPath), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, restoredPath);
      await fs.chmod(restoredPath, 0o600);
      prepared.stores.push({ agentId: store.agentId, restoredPath, destinationPath: path.join(importDir, store.agentDir, AGENT_STORE_BASENAME) });
    }
    await upgradeStagedAgentStores(landingRoot, { run: deps.runOpenClaw ?? runOpenClaw, signal, log: deps.log ?? provisionerLog });
    const codex = await prepareCodexStoreSnapshots(root, deps.log ?? provisionerLog);
    try {
      await sharedRecoverySnapshot(deps, body);
      await assertMatchingSharedContextPreparation({ importDir, archiveRoot: root, agentIds: archive.agentIds, signal });
      for (const agentId of archive.agentIds) await fs.cp(path.join(root, "agents", agentId), path.join(importDir, "agents", agentId), {
        recursive: true, dereference: false, verbatimSymlinks: true, filter: source => {
          const relative = path.relative(root, source).split(path.sep).join("/");
          return !path.basename(source).startsWith(AGENT_STORE_BASENAME) && !isCodexDatabase(relative) && !relative.includes(".octogee-codex-snapshots");
        },
      });
      await installPreparedAgentStores({ prepared, releaseAgent: agentId => releaseAgentForImport(deps, null, agentId, deps.log ?? provisionerLog),
        procRoot: deps.procRoot ?? PROC_ROOT, log: deps.log });
      await installCodexStoreSnapshots({ prepared: codex, importDir, procRoot: deps.procRoot ?? PROC_ROOT, log: deps.log ?? provisionerLog, signal });
    } finally { await discardCodexStoreSnapshots(codex, deps.log ?? provisionerLog); }
  } finally { await fs.rm(landingRoot, { recursive: true, force: true }); }
}

async function recoverMissingSharedRestore(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, res: Response): Promise<boolean> {
  if (body.agentContext?.mode !== RESTORE_SHARED_AGENT_CONTEXT || !body.sharedAgentContextRecovery) return false;
  const archive = body.agentContext.archive, recovery = body.sharedAgentContextRecovery;
  const key = rsyncSessionKey(body.migrationId, body.slug, "final");
  if (migrationImportBusy()) { res.status(409).json({ error: "migration import completion is already in progress" }); return true; }
  finishingRsyncImports.add(key);
  const log = deps.log ?? provisionerLog, { controller, detach } = attachImportDisconnectHandlers(res, body.migrationId, body.slug, log);
  try {
    await withCustomerRemoval(body.slug, async () => {
    await validateAgentContextTransfer(deps, body, "target", "final");
    const snapshot = await sharedRecoverySnapshot(deps, body);
    if (!deps.adapter.sharedContextCheckpoint) throw new Error("Shared context checkpoint recovery is unavailable");
    const download = await deps.adapter.sharedContextCheckpoint({ ...snapshot.nativeSharedContextRestore!, checkpoint: recovery.checkpoint }, controller.signal);
    const recovered = await recoverSharedAgentContextCheckpoint({ archive, recovery,
      download, fetch: deps.fetch ?? globalThis.fetch, signal: controller.signal });
    try {
      await sharedRecoverySnapshot(deps, body);
      await assertMatchingSharedContextPreparation({ importDir: resolveOpenClawStateDir(), archiveRoot: recovered.root, agentIds: archive.agentIds, signal: controller.signal });
      await installRecoveredSharedContext(deps, body, recovered.root, controller.signal);
      await markSharedRestoreInstalled(deps, body, resolveOpenClawStateDir());
      await activateFinishedRsyncImport({ deps, body, configTransferMode: ACTIVATION_MANIFEST_TRANSFER, loadStrategy: "standard", signal: controller.signal });
      const response = completedImportResponse(body, undefined, archive);
      await writeSharedAgentContextRestoreReceipt({ stateDir: resolveOpenClawStateDir(), gatewayId: deps.gatewayId, podUid: process.env.POD_UID ?? "", request: body, response });
      log(`[migration-rsync] recovered Shared context from pinned native checkpoint slug=${body.slug} archiveId=${archive.archiveId}`);
      res.status(200).json(response);
    } finally { await recovered.cleanup(); }
    });
  } finally { detach(); finishingRsyncImports.delete(key); }
  return true;
}

async function respondMissingRsyncSession(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, mode: MigrationTransferMode, res: Response): Promise<void> {
  try {
    if (!await replaySharedAgentContextRestore(deps, body, mode, res) && !await recoverMissingSharedRestore(deps, body, res)) res.status(404).json({ error: "rsync import session not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps.log ?? provisionerLog)(`[migration-rsync] Shared restore replay refused migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
    res.status(500).json({ error: "Shared context restoration replay refused", message });
  }
}

async function validateFinishedImportAdmission(deps: MigrationHandlerDeps, body: FinishRsyncImportRequestBody, mode: MigrationTransferMode): Promise<void> {
  await validateAgentContextTransfer(deps, body, "target", mode);
  if (body.agentContext?.mode === RESTORE_SHARED_AGENT_CONTEXT) await sharedRestoreSnapshot(deps, body, true);
}

export function createFinishRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const parsed = parseRsyncPhaseRequest<FinishRsyncImportRequestBody>(
      req,
      res,
      deps,
      "finish-rsync-import",
      log,
    );
    if (!parsed) return;
    const { body, mode, configTransferMode } = parsed;
    const loadStrategy = validateMigrationLoadStrategy(body.loadStrategy, res);
    if (!loadStrategy) return;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    const session = rsyncImportSessions.get(key);
    if (!session) {
      await respondMissingRsyncSession(deps, body, mode, res);
      return;
    }
    if (!validateRsyncImportSessionPolicy(session, body, configTransferMode, res)) return;
    if (migrationImportBusy()) {
      res.status(409).json({ error: "migration import completion is already in progress" });
      return;
    }
    finishingRsyncImports.add(key);
    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      body.migrationId,
      body.slug,
      log,
    );
    let preserveStage = false;
    let sessionReleased = false;
    try {
      const startedAt = Date.now();
      await stopRsyncTransfer(session);
      const rejection = await validateStagedRsyncImport(session, body.slug, mode, configTransferMode, log);
      if (rejection !== null) {
        log(
          `[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug} rejected: ${rejection}`, { status: "failed" },
        );
        res.status(400).json({ error: "rsync import failed validation", message: rejection });
        return;
      }
      await withSharedRestoreCustody(body, async () => {
      await validateFinishedImportAdmission(deps, body, mode);
      const sharedAgentContext = await deliverStagedImport({
        deps,
        session,
        slug: body.slug,
        mode,
        activation: await configuredBuilderActivationRequest(deps, body, mode, configTransferMode),
        signal: controller.signal,
        log,
      });
      await markSharedRestoreInstalled(deps, body, session.importDir);
      const stagedAt = Date.now();
      if (mode === "pre") {
        await finishTargetPreparation(deps, session, body, configTransferMode, controller.signal);
        preserveStage = true;
      }
      const verificationPending = mode === "final"
        ? await activateFinishedRsyncImport({
          deps,
          body,
          configTransferMode,
          loadStrategy,
          signal: controller.signal,
        })
        : undefined;
      const activatedAt = Date.now();
      const response = completedImportResponse(body, verificationPending, sharedAgentContext);
      await writeSharedAgentContextRestoreReceipt({ stateDir: session.importDir, gatewayId: deps.gatewayId, podUid: process.env.POD_UID ?? "", request: body, response });
      await stopRsyncSession(session, preserveStage);
      sessionReleased = true;
      finishingRsyncImports.delete(key);
      controller.signal.throwIfAborted();
      log(
        `${verificationPending ? "🟡" : "🟢"} [migration-rsync] finish-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} ${verificationPending ? "verification-pending" : "done"}` +
        ` stageMs=${stagedAt - startedAt} activateMs=${activatedAt - stagedAt}` +
        (verificationPending ? ` (verification pending: ${verificationPending})` : ""),
      );
      res.status(200).json(response);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();
      if (!sessionReleased) {
        try { await stopRsyncSession(session, preserveStage); } finally { finishingRsyncImports.delete(key); }
      }
    }
  });
}

export function createAbortRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<AbortRsyncImportRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    if (!validateRsyncRpcPhase(body.rpcPhase, "abort-rsync-import", res)) return;
    const mode = validateTransferMode(body.mode, res);
    if (!mode) return;
    const configTransferMode = validateRsyncConfigTransferMode(body.configTransferMode, mode, res);
    if (!configTransferMode) return;
    if (!requireConfiguredBuilderSystemConfigTransfer(body.slug, configTransferMode, res)) return;
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    await stopRsyncSession(rsyncImportSessions.get(key));
    await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, configTransferMode));
    let activation: ConfiguredBuilderActivation | null = null;
    try {
      activation = await configuredBuilderActivationRequest(deps, body, mode, configTransferMode);
      if (activation && !await releaseAbortedBuilderImport(deps, activation)) {
        log(`[migration-rsync] abort-import left the live Builder untouched: import was never admitted migrationId=${body.migrationId} slug=${body.slug}`);
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`🔴 [migration-rsync] abort-import failed migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "abort-import failed", message });
      return;
    }
    if (activation || configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER) {
      deps.adapter.clearMountMarker?.(body.slug);
      deps.adapter.clearCustomerMigratingIn?.(body.slug);
      deps.adapter.onUnmounted?.(body.slug);
    }
    log(`🟢 [migration-rsync] abort-import migrationId=${body.migrationId} slug=${body.slug}`);
    res.status(200).json({ migrationId: body.migrationId, slug: body.slug, imported: false });
  });
}

async function releaseAbortedBuilderImport(deps: MigrationHandlerDeps, activation: ConfiguredBuilderActivation): Promise<boolean> {
  if (!activation.live) {
    let cleaned = false;
    const state = await deps.unreserveSurgeTarget!(activation.request, async assertCurrent => {
      const remove = deps.adapter.removeImportedCustomerBySlug;
      if (!remove) throw new Error("held Builder import cannot be returned without imported-customer removal");
      await removeCustomerWithSystemConfigWatchPaused({ deps, slug: activation.request.slug,
        remove: () => remove(activation.request.slug, undefined, undefined, { ...activation.request, assertCurrent }) });
      cleaned = true;
    });
    if (!cleaned) throw new Error("Builder import cleanup was not executed before unreserve");
    if (state.mode !== "held") throw new Error("cannot clear an import while its Builder process is permitted");
    return true;
  }
  if (await liveImportAdmission(deps, activation) !== "admitted") return false;
  const remove = deps.adapter.removeImportedCustomerBySlug;
  if (!remove) throw new Error("live Builder import cannot be returned without imported-customer removal");
  await assertLiveBuilderUnassigned(deps, activation);
  const { slug } = activation.request;
  await removeCustomerWithSystemConfigWatchPaused({ deps, slug, remove: () => remove(slug) });
  return true;
}

async function assertLiveBuilderUnassigned(deps: MigrationHandlerDeps, activation: ConfiguredBuilderActivation): Promise<void> {
  if (await deps.liveSurgeTargetAssigned!(activation.request)) {
    throw new Error("cannot remove a live Builder customer that its assignment serves");
  }
}

async function releaseUnmountedBuilderTarget(
  deps: MigrationHandlerDeps,
  activation: ConfiguredBuilderActivation | null,
): Promise<boolean> {
  if (!activation) return true;
  if (!activation.live) return true;
  const admission = await liveImportAdmission(deps, activation);
  if (admission === "refused") return false;
  await assertLiveBuilderUnassigned(deps, activation);
  return true;
}

function configuredBuilderVerifyChecks(
  deps: MigrationHandlerDeps,
  slug: string,
): Extract<VerifyMigrationResponse, { configTransferMode: "configured-builder-system-config" }>["checks"] {
  return {
    customerDir: deps.adapter.hasCustomerDir(slug),
    configuredBuilderOverlay:
      deps.adapter.isBuilderGateway?.() === true &&
      deps.adapter.isConfiguredBuilderCustomer?.(slug) === true &&
      deps.adapter.configuredBuilderOverlayPresent?.(slug) === true,
    mountMarked: deps.adapter.customerMountMarked?.(slug) ?? false,
    workspaceGit: deps.adapter.hasWorkspaceGitDir(slug),
    gitRemote: deps.adapter.hasGitRemote(slug),
  };
}

function activationCoachWired(deps: MigrationHandlerDeps, slug: string): boolean {
  return deps.adapter.customerCoachWiredInOpenclawConfig?.(slug)
    ?? deps.getMountedCustomers?.().includes(slug)
    ?? false;
}

async function activationManifestVerifyChecks(
  deps: MigrationHandlerDeps,
  body: VerifyMigrationRequestBody,
  wiring: { coachWired: boolean; mountMarked: boolean },
): Promise<Extract<VerifyMigrationResponse, { configTransferMode?: "activation-manifest" }>["checks"]> {
  return {
    customerDir: deps.adapter.hasCustomerDir(body.slug),
    ...wiring,
    accountHealthy: await deps.adapter.waitForAccountHealthy({
      slug: body.slug,
      timeoutMs: body.timeoutMs ?? MIGRATION_VERIFY_TIMEOUT_MS,
    }),
  };
}

async function verifyMigrationResponse(
  deps: MigrationHandlerDeps,
  body: VerifyMigrationRequestBody,
): Promise<VerifyMigrationResponse> {
  if (body.configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER ||
      (deps.adapter.isBuilderGateway?.() === true &&
       deps.adapter.isConfiguredBuilderCustomer?.(body.slug) === true)) {
    const checks = configuredBuilderVerifyChecks(deps, body.slug);
    return {
      migrationId: body.migrationId,
      slug: body.slug,
      ready: Object.values(checks).every(Boolean),
      configTransferMode: BUILDER_SYSTEM_CONFIG_TRANSFER,
      checks,
    };
  }
  const coachWired = activationCoachWired(deps, body.slug);
  const mountMarked = deps.adapter.customerMountMarked?.(body.slug) ?? coachWired;
  if ((!coachWired || !mountMarked) && await deps.customerAttachPending?.(body.slug) === true) {
    return {
      migrationId: body.migrationId,
      slug: body.slug,
      ready: false,
      code: MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
      checks: {
        customerDir: deps.adapter.hasCustomerDir(body.slug),
        coachWired,
        mountMarked,
        accountHealthy: false,
      },
    };
  }
  const checks = await activationManifestVerifyChecks(deps, body, { coachWired, mountMarked });
  return {
    migrationId: body.migrationId,
    slug: body.slug,
    ready: Object.values(checks).every(Boolean),
    checks,
  };
}

export function createVerifyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<VerifyMigrationRequestBody>(
      req,
      res,
      deps,
      log,
    );
    if (!body) return;
    if (
      body.configTransferMode !== undefined &&
      !isMigrationConfigTransferMode(body.configTransferMode)
    ) {
      res.status(400).json({ error: "invalid configTransferMode" });
      return;
    }
    if (
      body.configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER &&
      !requireConfiguredBuilderSystemConfigTransfer(body.slug, body.configTransferMode, res)
    ) {
      return;
    }
    try {
      const response = await verifyMigrationResponse(deps, body);
      log(
        `${response.ready ? "🟢" : "🔴"} [migration-http] verify migrationId=${body.migrationId} slug=${body.slug} ` +
        `mode=${response.configTransferMode ?? ACTIVATION_MANIFEST_TRANSFER} ` +
        `ready=${response.ready} checks=${JSON.stringify(response.checks)}`, { status: response.ready ? "done" : "failed" },
      );
      res.status(response.ready ? 200 : 409).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 verify migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({ error: "verify failed", message });
    }
  });
}

function attachImportDisconnectHandlers(
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string, fields?: LogContext) => void,
  phase: "import" | "export" = "import",
): { controller: AbortController; detach: () => void } {

const controller = new AbortController();
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] client closed connection before response sent migrationId=${migrationId} slug=${slug} — aborting`,
    );
    controller.abort(new Error(`client disconnected mid-${phase}`));
  };
  res.on("close", onResClose);
  return {
    controller,
    detach: () => {
      res.removeListener("close", onResClose);
    },
  };
}

function respondImportFailure(
  res: Response,
  controllerSignal: AbortSignal,
  err: unknown,
): void {
  if (res.writableEnded) return;
  const message = err instanceof Error ? err.message : String(err);
  if (controllerSignal.aborted && !res.headersSent) {

res.status(499).json({ error: "client disconnected", message });
    return;
  }
  if (!res.headersSent) {
    res.status(500).json({ error: "import failed", message });
    return;
  }
  res.destroy(err instanceof Error ? err : new Error(message));
}

function allowedMigrationPrefixes(slug: string, mode: MigrationImportMode): string[] {
  const durablePrefixes = [
    `customers/${slug}/`,
    `git-metadata/${slug}/`,
    `${MIGRATION_ACTIVATION_DIR}/${slug}/`,
  ];
  if (mode === "keys") return [`customer-keys/${slug}/`];
  if (mode === "pre" || mode === "final") return durablePrefixes;
  return [...durablePrefixes, `customer-keys/${slug}/`];
}

function agentStateEntryAllowed(input: {
  raw: string;
  entry: string;
  slug: string;
  mode: MigrationImportMode;
  configuredAgentIds: readonly string[];
  configuredBuilderStatePlan: ConfiguredBuilderPortableStatePlan | undefined;
}): boolean {
  if (input.mode === "keys") return false;
  return input.configuredBuilderStatePlan
    ? !isSafeDefaultAgentPortableStatePath(input.entry) &&
      configuredBuilderStatePlanAllowsEntry(input.raw, input.configuredBuilderStatePlan)
    : isOwnedAgentStatePath(input.raw, input.entry, input.slug, input.configuredAgentIds);
}

export function findPathTraversalViolation(
  entries: readonly string[],
  slug: string,
  mode: MigrationImportMode = "default",
  configuredAgentIds: readonly string[] = [],
  configuredBuilderStatePlan?: ConfiguredBuilderPortableStatePlan,
): string | null {
  const allowedPrefixes = allowedMigrationPrefixes(slug, mode);
  const stateTransfer = mode === "pre" || mode === "final";
  for (const raw of entries) {
    const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (entry.startsWith("/")) {
      return `absolute path in tarball: ${raw}`;
    }
    if (entry.split("/").includes("..")) {
      return `path traversal '..' in tarball: ${raw}`;
    }
    const allowed =
      agentStateEntryAllowed({ raw, entry, slug, mode, configuredAgentIds, configuredBuilderStatePlan }) ||
      allowedPrefixes.some((p) => matchesAllowedMigrationPath(raw, entry, p)) ||
      (stateTransfer && raw === "customer-keys/");
    if (!allowed) {
      const allowlist = allowedPrefixes.map((prefix) => prefix.replace(/\/$/u, "")).join(", ");
      return `path '${raw}' is outside the per-slug allowlist (${allowlist})`;
    }
  }
  return null;
}

function isOwnedAgentStatePath(
  raw: string,
  entry: string,
  slug: string,
  configuredAgentIds: readonly string[],
): boolean {
  const configured = new Set(configuredAgentIds.filter(isSafeConfiguredAgentId));
  const segments = entry.split("/");
  if (segments[0] === "agents") {
    if (segments.length === 1) return raw.endsWith("/");
    if (configured.has(segments[1]!)) return true;
    const parsed = parseAgentId(segments[1]!);
    return parsed.kind !== "unknown" && parsed.username === slug;
  }
  if (segments[0] !== "memory") return false;
  if (segments.length === 1) return raw.endsWith("/");
  if (segments.length !== 2) return false;
  const suffix = [".sqlite-wal", ".sqlite-shm", ".sqlite"].find((candidate) =>
    segments[1]!.endsWith(candidate),
  );
  if (!suffix) return false;
  const agentId = segments[1]!.slice(0, -suffix.length);
  if (configured.has(agentId)) return true;
  const parsed = parseAgentId(agentId);
  return parsed.kind !== "unknown" && parsed.username === slug;
}

function matchesAllowedMigrationPath(raw: string, entry: string, allowedPrefix: string): boolean {
  const isDirectoryPrefix = allowedPrefix.endsWith("/");
  const exactPrefix = isDirectoryPrefix ? allowedPrefix.slice(0, -1) : allowedPrefix;
  return (
    entry === exactPrefix ||
    entry.startsWith(allowedPrefix) ||
    (raw.endsWith("/") && exactPrefix.startsWith(`${entry}/`))
  );
}

async function removeUnmountedBuilderImport(
  deps: MigrationHandlerDeps,
  slug: string,
  activation: ConfiguredBuilderActivation | null,
): Promise<RemoveCustomerResult> {
  let result: RemoveCustomerResult | undefined;
  const remove = async (assertCurrent?: () => Promise<void>) => {
    result = await removeCustomerWithSystemConfigWatchPaused({
      deps, slug,
      remove: () => assertCurrent && activation
        ? deps.adapter.removeImportedCustomerBySlug!(slug, undefined, undefined, { ...activation.request, assertCurrent })
        : deps.adapter.removeImportedCustomerBySlug!(slug),
    });
  };
  if (activation && !activation.live) await deps.unreserveSurgeTarget!(activation.request, remove);
  else await remove();
  if (!result) throw new Error("Builder import cleanup was not executed before unreserve");
  return result;
}

function validSharedErasureUnmount(deps: MigrationHandlerDeps, body: UnmountRequestBody): boolean {
  const coverage = body.agentStoreErasure;
  return Boolean(coverage && deps.gatewayId.startsWith("shared-") && !deps.adapter.isBuilderGateway?.() &&
    typeof coverage.podUid === "string" && coverage.podUid && coverage.podUid === process.env.POD_UID &&
    Array.isArray(coverage.agentIds) && coverage.agentIds.length <= 512 &&
    coverage.agentIds.every(id => typeof id === "string" && agentIdBelongsToSlug(id, body.slug)) &&
    new Set(coverage.agentIds).size === coverage.agentIds.length);
}

async function completeSharedErasureUnmount(deps: MigrationHandlerDeps, body: UnmountRequestBody, res: Response): Promise<void> {
  if (!validSharedErasureUnmount(deps, body)) {
    res.status(400).json({ error: "invalid Shared customer erasure coverage or pod identity" });
    return;
  }
  const coverage = body.agentStoreErasure!;
  if (!deps.adapter.removeImportedCustomerBySlug) throw new Error("Shared customer erasure requires Native customer cleanup");
  const result = await removeCustomerWithSystemConfigWatchPaused({ deps, slug: body.slug,
    remove: () => deps.adapter.removeImportedCustomerBySlug!(body.slug, undefined, undefined, undefined, coverage.agentIds) });
  if (result.retained || !Array.isArray(result.releasedAgentIds) ||
      !isDeepStrictEqual([...result.releasedAgentIds].sort(), [...coverage.agentIds].sort())) {
    throw new Error("Shared customer erasure did not confirm exact Native agent cleanup");
  }
  deps.adapter.onUnmounted?.(body.slug);
  res.status(200).json({ migrationId: body.migrationId, slug: body.slug, unmounted: result.wasMounted,
    agentStoreErasure: coverage } satisfies UnmountResponse);
}

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? provisionerLog;
  return (req, res) => withLogContext({}, async () => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      if (body.agentStoreErasure !== undefined) {
        await completeSharedErasureUnmount(deps, body, res);
        return;
      }
      const activation = await configuredBuilderActivationRequest(deps, body, "final", ACTIVATION_MANIFEST_TRANSFER);
      if (!await releaseUnmountedBuilderTarget(deps, activation)) {
        log(`[migration-http] unmount left the live Builder untouched: import was never admitted migrationId=${body.migrationId} slug=${body.slug}`);
        res.status(200).json({ migrationId: body.migrationId, slug: body.slug, unmounted: false } satisfies UnmountResponse);
        return;
      }
      await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, ACTIVATION_MANIFEST_TRANSFER));
      await clearMigrationStaging(os.tmpdir(), stagingIdentity(deps, body, BUILDER_SYSTEM_CONFIG_TRANSFER));
      if (activation && !activation.live && !deps.adapter.removeImportedCustomerBySlug) {
        throw new Error("held Builder import cannot be returned without imported-customer removal");
      }
      if (deps.adapter.removeImportedCustomerBySlug) {
        const result = await removeUnmountedBuilderImport(deps, body.slug, activation);
        if (result.wasMounted) deps.adapter.onUnmounted?.(body.slug);
        const response: UnmountResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          unmounted: result.wasMounted,
        };
        dlog(
          `[migration-http] 🟢 unmount migrationId=${body.migrationId} slug=${body.slug} wasMounted=${result.wasMounted} steps=${result.steps.join(",")}`,
        );
        res.status(200).json(response);
        return;
      }

      const uid = await deps.adapter.uidForSlug(body.slug);
      if (!uid) {
        await pauseSystemConfigWatchForBuilder(deps, body.slug);
        const response: UnmountResponse = {
          migrationId: body.migrationId,
          slug: body.slug,
          unmounted: false,
        };
        dlog(
          `[migration-http] unmount migrationId=${body.migrationId} slug=${body.slug} → no user; idempotent no-op`,
        );
        res.status(200).json(response);
        return;
      }
      const result = await removeCustomerWithSystemConfigWatchPaused({
        deps,
        slug: body.slug,
        remove: () => removeCustomerFromGateway(deps.adapter, uid),
      });
      const response: UnmountResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        unmounted: result.wasMounted,
      };
      dlog(
        `[migration-http] 🟢 unmount migrationId=${body.migrationId} slug=${body.slug} wasMounted=${result.wasMounted} steps=${result.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 unmount migrationId=${body.migrationId} slug=${body.slug}: ${message}`, { status: "failed" });
      res.status(500).json({
        error: "unmount failed",
        message,
        ...(err instanceof OpenclawWireError ? { code: err.code } : {}),
      });
    }
  });
}

export function customerCoachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

export function resolveOpenClawStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? "/home/node";
  return path.join(home, ".openclaw");
}

export interface SessionsJson {
  sessions: AgentSessionEntry[];
}

export interface AgentSessionEntry {
  key?: string;
  sessionId?: string;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
}

export async function readAgentSessions(
  stateDir: string,
  agentId: string,
): Promise<SessionsJson["sessions"]> {
  return readAgentSessionsAtPath(
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
  );
}

export async function readAgentSessionsAtPath(
  sessionsPath: string,
): Promise<SessionsJson["sessions"]> {
  const storePath = sessionsPath.endsWith(".sqlite")
    ? sessionsPath
    : path.join(path.dirname(path.dirname(sessionsPath)), "agent", "openclaw-agent.sqlite");
  try {
    await fs.stat(storePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const anchor = readPostgresAgentAnchor(storePath);
  if (anchor) {
    return queryAgentStore<AgentSessionEntry & Record<string, unknown>>(anchor,
      'SELECT session_key AS key, current_session_id AS "sessionId", status FROM $schema.session_nodes');
  }
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT session_key AS key, current_session_id AS sessionId, status FROM session_nodes")
      .all() as AgentSessionEntry[];
  } finally {
    db.close();
  }
}
