

import type { Request, Response, RequestHandler } from "express";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
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
  type PushStateRequestBody,
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
  MIGRATION_VERIFY_TIMEOUT_MS,
  MIGRATION_RSYNC_PORT_DEFAULT,
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_MODE_HEADER,
  MIGRATION_SLUG_HEADER,
} from "../../shared/types/fleet-controller.js";
import { isValidUsername, parseAgentId } from "../../shared/types/identity.js";
import {
  checkpointAgentStoresForCarry,
  clearSqliteSidecars,
  findUnreadableStore,
  isSqliteStorePath,
  listSqliteStores,
  SQLITE_SIDECAR_EXCLUDE_ARGS,
} from "./agent-store-carry.js";
import { pickPlanInputs } from "../../shared/types/billing.js";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
import { rejectMisaddressedGateway } from "./fleet-gateway-path.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import {
  cloneMissingProjects,
  removeCustomerFromGateway,
  restoreCustomerRuntimeFromSnapshot,
  type UserSnapshot,
} from "./customer-lifecycle.js";
import {
  MIGRATION_ACTIVATION_DIR,
  writeActivationManifest,
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
import { upgradeStagedAgentStores } from "./agent-store-upgrade.js";
import type { SurgeOpenClawProcessGateState } from "./surge-openclaw-process-gate.js";

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
const BUILDER_SYSTEM_CONFIG_TRANSFER = "configured-builder-system-config" as const;
const ACTIVATION_MANIFEST_TRANSFER = "activation-manifest" as const;

export interface MigrationHandlerDeps {
  publicKey: string;
  gatewayId: string;
  adapter: CustomerLifecycleAdapter;

  log?: (msg: string) => void;

  now?: () => number;

getMountedCustomers?: () => readonly string[];

fetch?: typeof globalThis.fetch;

pushStateTimeoutMs?: number;

migrationRsyncPort?: number;

waitForRsyncReady?: (port: number) => Promise<void>;

flushLocalState?: (input: {
  slug: string;
  reason: string;
  expectedSystemConfigCommit?: string;
}) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
releaseSurgeReadiness?: (input: { migrationId: string; targetPodUid: string }) => Promise<void>;
reserveSurgeTarget?: (input: { migrationId: string; slug: string }) => Promise<void>;
unreserveSurgeTarget?: (input: {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}) => Promise<SurgeOpenClawProcessGateState>;
pauseSystemConfigWatch?: (slug: string) => Promise<string | void>;
readSystemConfigWatchFence?: (slug: string) => Promise<string | null>;
resumeSystemConfigWatch?: (
  slug: string,
  expectedGeneration?: string | null,
) => Promise<boolean | void>;
}

async function pauseSystemConfigWatchForBuilder(
  deps: MigrationHandlerDeps,
  slug: string,
): Promise<string | undefined> {
  if (deps.pauseSystemConfigWatch) {
    return (await deps.pauseSystemConfigWatch(slug)) ?? undefined;
  }
  const configuredBuilder = process.env.GATEWAY_BUILDER_SLUG?.trim();
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
  const configuredBuilder = process.env.GATEWAY_BUILDER_SLUG?.trim();
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
  const configuredBuilder = process.env.GATEWAY_BUILDER_SLUG?.trim();
  if (!configuredBuilder) return;
  if (!isConfiguredGatewayBuilder(slug)) {
    throw new Error(
      `system config watcher belongs to ${configuredBuilder}, not migration builder ${slug}`,
    );
  }
  await enableSystemConfigWatch(OPENCLAW_DIR, slug, expectedGeneration);
}

async function activateImportedCustomerForMigration(input: {
  deps: MigrationHandlerDeps;
  slug: string;
  mode: MigrationImportMode;
  loadStrategy?: MigrationLoadStrategy;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { deps, slug, mode, signal, loadStrategy = "standard" } = input;
  await ensureMigrationGiteaKey(deps, slug, "target-activation");
  const fenceGeneration = await pauseSystemConfigWatchForBuilder(deps, slug);
  if (
    loadStrategy === "standard" &&
    deps.adapter.projectCheckoutScope?.(slug) !== "workspace-only"
  ) {
    const { pending, deferred } = await cloneMissingProjects(deps.adapter, slug);
    if (deferred.length > 0) {
      deps.log?.(
        `[migration-http] GitHub checkouts for ${slug} hydrate on its Builder runtime, not here: ${deferred.join(", ")}`,
      );
    }
    if (pending.length > 0) {
      throw new Error(
        `[migration-http] project checkout hydration incomplete for ${slug}: ${pending.join(", ")}`,
      );
    }
  }
  const activation = signal
    ? await deps.adapter.activateImportedCustomer(slug, { signal })
    : await deps.adapter.activateImportedCustomer(slug);
  if (loadStrategy === "standard") {
    deps.adapter.recordAppliedFingerprint?.(slug, activation.appliedFingerprint);
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
  return input.remove();
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
  log: (msg: string) => void,
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
    log(`[migration-http] 🔴 bad signature migrationId=${body.migrationId} slug=${body.slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  return body;
}

function parseAndVerifySurgeBody(
  req: Request,
  res: Response,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
  log: (msg: string) => void,
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
  const log = deps.log ?? ((message) => console.log(message));
  return async (req, res) => {
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
      log(`🔴 [surge-handoff] readiness release failed: ${message}`);
      res.status(500).json({
        error: "surge readiness release failed",
        message,
      });
    }
  };
}

function verifyHeaderSignature(
  migrationId: string,
  slug: string,
  sigHeader: string | undefined,
  deps: Pick<MigrationHandlerDeps, "publicKey" | "gatewayId">,
): boolean {
  return verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(migrationId, deps.gatewayId),
    slug,
    sigHeader,
  );
}

function tarArgsForSources(
  sources: Array<{ cwd: string; path: string }>
): string[] {
  return [
    "-cf", "-",
    ...SQLITE_SIDECAR_EXCLUDE_ARGS,
    ...sources.flatMap((s) => ["-C", s.cwd, s.path]),
  ];
}

interface TarStream {
  child: ReturnType<typeof spawn>;
  stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>;
  done: Promise<void>;
}

function markPromiseHandled(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function spawnTarStream(
  sources: Array<{ cwd: string; path: string }>,
): TarStream {
  const child = spawn("tar", tarArgsForSources(sources), { stdio: ["ignore", "pipe", "pipe"] }); // eslint-disable-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error("tar spawned without stdout/stderr pipes");
  }

  let stderrBuf = "";
  stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exit ${code}: ${stderrBuf.trim()}`));
    });
  });
  markPromiseHandled(done);
  return { child, stdout, done };
}

export function createMigrationProgressHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? console.log;
  return async (req, res) => {
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
    const elapsed = body.elapsedMs === undefined ? "" : " elapsedMs=" + body.elapsedMs;
    log(`${icons[body.status]} [migration] migrationId=${body.migrationId} builder=${body.slug} source=${body.source} target=${deps.gatewayId} phase=${body.phase} status=${body.status}${elapsed}`);
    res.status(200).json({ ok: true });
  };
}

export function createQuiesceHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<QuiesceRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      const result = await deps.adapter.quiesceCustomer(body.slug, body.timeoutMs ?? 60_000);
      const response: QuiesceResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        drained: result.drained,
        runningCount: result.runningCount,
      };
      (result.drained ? dlog : log)(
        `${result.drained ? "🟢" : "🔴"} [migration-http] quiesce migrationId=${body.migrationId} slug=${body.slug} → drained=${result.drained} runningCount=${result.runningCount}`,
      );
      res.status(result.drained ? 200 : 408).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 quiesce migrationId=${body.migrationId} slug=${body.slug} failed: ${message}`);
      res.status(500).json({ error: "quiesce failed", message });
    }
  };
}

function logFlushResult(ok: boolean, log: (message: string) => void, message: string): void {
  (ok ? dlog : log)(`${ok ? "🟢" : "🔴"} [migration-http] flush ${message}`);
}

export function createFlushHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
      log(`[migration-http] 🔴 flush migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "flush failed", message });
    }
  };
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
    greetingPosted: snapshot.greetingPosted === true,
    channels: Array.isArray(snapshot.channels) ? snapshot.channels as UserSnapshot["channels"] : [],
    ownerName: typeof snapshot.ownerName === "string" ? snapshot.ownerName : body.slug,
    projects: Array.isArray(snapshot.projects) ? snapshot.projects as UserSnapshot["projects"] : [],
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
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
      await pauseSystemConfigWatchForBuilder(deps, body.slug);
      deps.adapter.markCustomerMigratingIn?.(body.slug);
      deps.adapter.seedUserSnapshotForMigration?.(body.snapshot);
      const adapter: CustomerLifecycleAdapter = {
        ...deps.adapter,
        loadUserSnapshot: async (uid) => {
          const fresh = await deps.adapter.loadUserSnapshot(uid);
          return uid === snapshot.uid ? fresh ?? snapshot : fresh;
        },
        uidForSlug: async (slug) =>
          slug === snapshot.slug ? snapshot.uid : deps.adapter.uidForSlug(slug),
      };
      const result = await restoreCustomerRuntimeFromSnapshot(adapter, snapshot);
      const response: RestoreMigrationResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        restored: result.restored,
        steps: result.steps,
      };
      log(
        `[migration-http] 🟢 restore migrationId=${body.migrationId} slug=${body.slug} steps=${result.steps.join(",")}`,
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 restore migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "restore failed", message });
    }
  };
}

export function createExportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<MigrationRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      const sources = await deps.adapter.listExportPaths(body.slug);
      if (sources.length === 0) {

res.status(404).json({ error: "no export paths", message: `nothing to export for slug=${body.slug}` });
        return;
      }
      await checkpointAgentStoresForCarry({ sources, log: dlog });
      dlog(
        `[migration-http] export migrationId=${body.migrationId} slug=${body.slug} streaming ${sources.length} path(s)`,
      );

      const tar = spawnTarStream(sources);
      tar.done
        .then(() => {
          dlog(`[migration-http] 🟢 export migrationId=${body.migrationId} slug=${body.slug} done`);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log(
            `[migration-http] 🔴 export migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
          );
          if (!res.headersSent) {
            res.status(500).json({ error: "tar failed", message });
            return;
          }
          res.destroy(err instanceof Error ? err : new Error(message));
        });

      res.status(200);
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${body.slug}.tar"`,
      );
      tar.stdout.pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 export setup migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      
      if (!res.headersSent) {
        res.status(500).json({ error: "export setup failed", message });
      } else {
        res.destroy(err instanceof Error ? err : new Error(message));
      }
    }
  };
}

export function createExportPathsHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
      const allSources = await deps.adapter.listExportPaths(body.slug);
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
        `[migration-http] 🔴 export-paths migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "export-paths failed", message });
    }
  };
}

export function createActivationManifestExportHandler(
  deps: MigrationHandlerDeps,
): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
        `[migration-http] 🔴 activation-manifest migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "activation-manifest failed", message });
    }
  };
}

export function createPrepareImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
        `[migration-http] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "prepare-import failed", message });
    }
  };
}

async function mountImportedCustomer(input: {
  deps: MigrationHandlerDeps;
  slug: string;
  mode: MigrationImportMode | "keys";
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { deps, slug, mode, signal } = input;
  if (mode !== "final" && mode !== "default") return undefined;
  const verificationPending = await activateImportedCustomerForMigration({
    deps,
    slug,
    mode,
    signal,
  });
  deps.adapter.writeMountMarker?.(slug);
  deps.adapter.onMounted?.(slug);
  return verificationPending;
}

export function createActivateImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
        `[migration-http] 🔴 activate-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "activate-import failed", message });
    }
  };
}

function isValidGatewayRouteId(gatewayId: string): boolean {
  if (gatewayId.length === 0 || gatewayId.length > 128) return false;
  for (let i = 0; i < gatewayId.length; i++) {
    const code = gatewayId.charCodeAt(i);
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    const routePunctuation = code === 45 || code === 46 || code === 95;
    if (!(alpha || digit || (i > 0 && routePunctuation))) return false;
  }
  return true;
}

function resolveTargetImportUrl(targetUrl: string, targetGatewayId: string): string {
  const url = new URL(targetUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`targetUrl must use http or https`);
  }
  let basePath = url.pathname;
  while (basePath.endsWith("/")) {
    basePath = basePath.slice(0, -1);
  }
  url.pathname = `${basePath}/import/${encodeURIComponent(targetGatewayId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validatePushStateBody(
  body: PushStateRequestBody,
  res: Response,
): { targetGatewayId: string; importUrl: string; targetImportSignature: string } | null {
  if (typeof body.targetGatewayId !== "string" || body.targetGatewayId.length === 0) {
    res.status(400).json({ error: "missing targetGatewayId" });
    return null;
  }
  if (!isValidGatewayRouteId(body.targetGatewayId)) {
    res.status(400).json({ error: "invalid targetGatewayId" });
    return null;
  }
  if (typeof body.targetUrl !== "string" || body.targetUrl.length === 0) {
    res.status(400).json({ error: "missing targetUrl" });
    return null;
  }
  if (typeof body.targetImportSignature !== "string" || body.targetImportSignature.length === 0) {
    res.status(400).json({ error: "missing targetImportSignature" });
    return null;
  }
  try {
    return {
      targetGatewayId: body.targetGatewayId,
      importUrl: resolveTargetImportUrl(body.targetUrl, body.targetGatewayId),
      targetImportSignature: body.targetImportSignature,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: "invalid targetUrl", message });
    return null;
  }
}

async function maybeMaterializeActivationManifest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody & { includeActivationManifest?: boolean },
): Promise<{ source: { cwd: string; path: string } | null; cleanup: () => Promise<void> }> {
  if (body.includeActivationManifest !== true) {
    return { source: null, cleanup: async () => undefined };
  }
  if (!deps.adapter.exportOpenClawActivationManifest) {
    throw new Error("source gateway cannot export an OpenClaw activation manifest");
  }
  const manifest = await deps.adapter.exportOpenClawActivationManifest(body.slug);
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

function attachPushStateAbortHandlers(
  res: Response,
  params: { migrationId: string; slug: string; timeoutMs: number },
  log: (msg: string) => void,
): {
  controller: AbortController;
  didTimeout: () => boolean;
  detach: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`push-state timed out after ${params.timeoutMs}ms`));
  }, params.timeoutMs);
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] controller closed push-state connection migrationId=${params.migrationId} slug=${params.slug} — aborting target import`,
    );
    controller.abort(new Error("controller disconnected mid-push-state"));
  };
  res.on("close", onResClose);
  return {
    controller,
    didTimeout: () => timedOut,
    detach: () => {
      clearTimeout(timeout);
      res.removeListener("close", onResClose);
    },
  };
}

function pushStateFailureStatus(
  didTimeout: boolean,
  signal: AbortSignal,
): { status: number; error: string } {
  if (didTimeout) return { status: 504, error: "push-state timed out" };
  if (signal.aborted) return { status: 499, error: "controller disconnected" };
  return { status: 500, error: "push-state failed" };
}

function respondPushStateFailure(input: {
  res: Response;
  body: PushStateRequestBody;
  abort: ReturnType<typeof attachPushStateAbortHandlers>;
  sourceTarError: unknown;
  cause: unknown;
  log: (msg: string) => void;
}): void {
  const { res, body, abort, sourceTarError, cause, log } = input;
  const message = cause instanceof Error ? cause.message : String(cause);
  log(`[migration-http] 🔴 push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
  if (res.headersSent) {
    res.destroy(cause instanceof Error ? cause : new Error(message));
    return;
  }
  const failure = sourceTarError
    ? { status: 500, error: "source tar failed" }
    : pushStateFailureStatus(abort.didTimeout(), abort.controller.signal);
  res.status(failure.status).json({ error: failure.error, message });
}

type MigrationImportMode = "keys" | "pre" | "final" | "default";

function parseMigrationImportMode(value: string | undefined): MigrationImportMode {
  if (value === "keys" || value === "pre" || value === "final") return value;
  return "default";
}

function sourcesForPushMode(
  sources: Array<{ cwd: string; path: string }>,
  slug: string,
  mode: PushStateRequestBody["mode"],
): Array<{ cwd: string; path: string }> {
  const keyPath = path.join("customer-keys", slug);
  if (mode === "keys") return sources.filter((source) => source.path === keyPath);
  if (mode === "pre" || mode === "final") {
    return sources.filter((source) => source.path !== keyPath);
  }
  return sources;
}

async function finishPushStateAlreadyMounted(
  res: Response,
  parsed: ImportResponse,
  targetGatewayId: string,
): Promise<void> {
  dlog(
    `[migration-http] 🟢 push-state migrationId=${parsed.migrationId} slug=${parsed.slug} target=${targetGatewayId} already mounted`,
  );
  res.status(200).json(parsed);
}

export async function sendPushStateImportResponse(
  importRes: globalThis.Response,
  params: { migrationId: string; slug: string; targetGatewayId: string },
  res: Response,
  log: (msg: string) => void,
): Promise<void> {
  if (!importRes.ok) {
    const text = await importRes.text().catch(() => "<no body>");
    log(
      `[migration-http] 🔴 push-state migrationId=${params.migrationId} slug=${params.slug} target import failed status=${importRes.status}: ${text}`,
    );
    res
      .status(502)
      .json({ error: "target import failed", status: importRes.status, message: text });
    return;
  }

  const parsed = (await importRes.json()) as ImportResponse;
  if (parsed.alreadyMounted) {
    await finishPushStateAlreadyMounted(res, parsed, params.targetGatewayId);
    return;
  }

  dlog(
    `[migration-http] 🟢 push-state migrationId=${params.migrationId} slug=${params.slug} target=${params.targetGatewayId} done`,
  );
  res.status(200).json(parsed);
}

const RSYNC_IMPORT_MODULE = "state";
const RSYNC_READY_TIMEOUT_MS = 5_000;
const RSYNC_DAEMON_STOP_TIMEOUT_MS = 5_000;
const RSYNC_BIN = "/usr/bin/rsync";

interface RSyncImportSession {
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
}

const rsyncImportSessions = new Map<string, RSyncImportSession>();

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

function posixRel(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start).split("\\").join("/");
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

async function stopRsyncSession(session: RSyncImportSession | undefined): Promise<void> {
  if (!session) return;
  await stopRsyncDaemon(session.child);
  rsyncImportSessions.delete(session.key);
  await fs.rm(session.stageDir, { recursive: true, force: true }).catch(() => undefined);
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
    await stopRsyncSession(session);
  }
}

function rsyncSourceArg(source: { cwd: string; path: string }): string {
  return `${trimTrailingSlash(source.cwd)}/./${posixRel(source.path)}`;
}

async function runSpawnChecked(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; label: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      action();
    };
    if (opts.timeoutMs) {
      timeout = setTimeout(() => {
        stderr += `\n${opts.label} timed out after ${opts.timeoutMs}ms`;
        child.kill("SIGTERM");
        settle(() =>
          reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)),
        );
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code, signal) => {
      if (signal != null) {
        settle(() => reject(new Error(`${opts.label} terminated by ${signal}: ${stderr.trim()}`)));
        return;
      }
      if (code === 0) {
        settle(() => resolve());
        return;
      }
      settle(() =>
        reject(new Error(`${opts.label} failed (code=${code ?? 1}): ${stderr.trim() || stdout.trim()}`)),
      );
    });
  });
}

async function writeRsyncDaemonConfig(params: {
  dir: string;
  stageDir: string;
  transferUser: string;
  transferKey: string;
  sourcePodIp?: string;
}): Promise<{ configPath: string; secretsPath: string }> {
  const secretsPath = path.join(params.dir, "rsyncd.secrets");
  await fs.writeFile(secretsPath, `${params.transferUser}:${params.transferKey}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const hostsAllow = params.sourcePodIp
    ? [`  hosts allow = ${params.sourcePodIp}`]
    : [];
  const configPath = path.join(params.dir, "rsyncd.conf");
  const pidPath = path.join(params.dir, "rsyncd.pid");
  const lockPath = path.join(params.dir, "rsyncd.lock");
  await fs.writeFile(
    configPath,
    [
      "use chroot = no",
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
      ...hostsAllow,
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

async function copyStageToOpenClaw(stageDir: string, importDir: string, slug: string): Promise<void> {
  await runSpawnChecked(
    RSYNC_BIN,
    ["-a", `${trimTrailingSlash(stageDir)}/`, `${trimTrailingSlash(importDir)}/`],
    { label: "rsync import copy", timeoutMs: MIGRATION_TRANSFER_TIMEOUT_MS },
  );
  for (const directory of ["customers", "git-metadata"]) {
    const relative = path.join(directory, slug);
    if (!await hasRealStageAncestors(stageDir, path.join(relative, ".entry"))) continue;
    await runSpawnChecked(RSYNC_BIN, [
      "-a", "--delete", `${path.join(stageDir, relative)}/`, `${path.join(importDir, relative)}/`,
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
  log: (msg: string) => void,
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

export function createPrepareRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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

    const port = rsyncPortFromDeps(deps);
    const key = rsyncSessionKey(body.migrationId, body.slug, mode);
    let activation: ReturnType<typeof configuredBuilderActivationRequest> = null;
    try {
      activation = configuredBuilderActivationRequest(deps, body, mode, configTransferMode);
      if (activation) {
        await deps.reserveSurgeTarget!(activation);
      } else if (configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER) {
        await deps.reserveSurgeTarget?.({ migrationId: body.migrationId, slug: body.slug });
      }
      await stopConflictingRsyncSession(body.migrationId, port);
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(body.slug)
        : await deps.adapter.prepareImportDir(body.slug, mode);
      if (mode !== "keys") deps.adapter.markCustomerMigratingIn?.(body.slug);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-${body.migrationId}-`));
      const stageDir = path.join(tmpDir, "stage");
      await fs.mkdir(stageDir, { recursive: true });
      const { configPath, secretsPath } = await writeRsyncDaemonConfig({
        dir: tmpDir,
        stageDir,
        transferUser,
        transferKey,
        sourcePodIp: body.sourcePodIp,
      });
      const child = spawn(
        RSYNC_BIN,
        ["--daemon", "--no-detach", `--config=${configPath}`, `--port=${port}`],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      const session: RSyncImportSession = {
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
      };
      rsyncImportSessions.set(key, session);
      child.on("exit", () => {
        if (rsyncImportSessions.get(key) === session) rsyncImportSessions.delete(key);
      });
      child.on("error", (err) => {
        log(
          `[migration-rsync] 🔴 rsync daemon error migrationId=${body.migrationId} slug=${body.slug}: ${err.message}`,
        );
      });
      await (deps.waitForRsyncReady ?? waitForTcpPort)(port);
      const response: PrepareRsyncImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: requestLocalAddress(req),
        port,
        module: RSYNC_IMPORT_MODULE,
      };
      log(
        `🟡 [migration-rsync] prepare-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} port=${port}`,
      );
      res.status(200).json(response);
    } catch (err) {
      await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
      if (activation) {
        await deps.unreserveSurgeTarget!(activation).catch((error: unknown) => {
          log(`[migration-rsync] failed to cancel Builder preparation migrationId=${body.migrationId} slug=${body.slug}: ${String(error)}`);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[migration-rsync] 🔴 prepare-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`,
      );
      res.status(500).json({ error: "prepare-rsync-import failed", message });
    }
  };
}

export function createPushRsyncStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return async (req, res) => {
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
    const targetHost = validateRsyncTargetHost(body.targetHost, res);
    if (!targetHost) return;
    const targetPort = validateRsyncPort(body.targetPort, res);
    if (targetPort === null) return;
    const credentials = validateRsyncTransferCredentials(body, res);
    if (!credentials) return;
    const { transferUser, transferKey } = credentials;

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-rsync-push-${body.migrationId}-`));
    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, mode);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      await checkpointAgentStoresForCarry({ sources, log: dlog });

      const activationManifest = mode !== "final" || configTransferMode === BUILDER_SYSTEM_CONFIG_TRANSFER
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, body);
      cleanupActivationManifest = activationManifest.cleanup;
      if (activationManifest.source) sources.push(activationManifest.source);

      const passwordFile = path.join(tmpDir, "rsync.pass");
      await fs.writeFile(passwordFile, `${transferKey}\n`, { encoding: "utf-8", mode: 0o600 });
      const destination = `rsync://${transferUser}@${targetHost}:${targetPort}/${RSYNC_IMPORT_MODULE}/`;
      dlog(
        `[migration-rsync] push-state mode=${mode} migrationId=${body.migrationId} slug=${body.slug} paths=${sources.length} target=${targetHost}:${targetPort}`,
      );
      await runSpawnChecked(
        RSYNC_BIN,
        [
          "-a",
          "--relative",
          ...(mode === "final" ? ["--delete-delay"] : []),
          "--ignore-missing-args",
          ...SQLITE_SIDECAR_EXCLUDE_ARGS,
          "--password-file",
          passwordFile,
          ...sources.map((source) => rsyncSourceArg(source)),
          destination,
        ],
        { timeoutMs, label: "rsync push-state" },
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
      log(`[migration-rsync] 🔴 push-state migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "push-rsync-state failed", message });
    } finally {
      await cleanupActivationManifest();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

async function validateStagedRsyncImport(
  session: RSyncImportSession,
  slug: string,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
  log: (message: string) => void,
): Promise<string | null> {
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
  const staged = await listSqliteStores(session.stageDir);
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

function configuredBuilderActivationRequest(
  deps: MigrationHandlerDeps,
  body: MigrationRequestBody,
  mode: MigrationTransferMode,
  configTransferMode: MigrationConfigTransferMode,
): { migrationId: string; slug: string; targetPodUid: string } | null {
  if (mode !== "final" || configTransferMode !== ACTIVATION_MANIFEST_TRANSFER ||
    deps.adapter.isBuilderGateway?.() !== true) return null;
  if (deps.adapter.isConfiguredBuilderCustomer?.(body.slug) !== true) {
    throw new Error("import does not match the configured Builder");
  }
  const targetPodUid = process.env.POD_UID?.trim();
  if (!targetPodUid || !deps.reserveSurgeTarget || !deps.releaseSurgeReadiness || !deps.unreserveSurgeTarget) {
    throw new Error("configured Builder activation requires its pod-bound process gate");
  }
  return { migrationId: body.migrationId, slug: body.slug, targetPodUid };
}

async function activateConfiguredBuilderImport(
  deps: MigrationHandlerDeps,
  request: NonNullable<ReturnType<typeof configuredBuilderActivationRequest>>,
  signal: AbortSignal,
  loadStrategy: MigrationLoadStrategy,
): Promise<void> {
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
    const verificationPending = await activateImportedCustomerForMigration({
      deps,
      slug: request.slug,
      mode: "final",
      loadStrategy,
      signal,
    });
    signal.throwIfAborted();
    if (verificationPending) {
      throw new Error(`Builder Coach activation verification failed: ${verificationPending}`);
    }
  } catch (error) {
    (deps.log ?? console.log)(
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

async function activateFinishedRsyncImport(input: {
  deps: MigrationHandlerDeps;
  body: FinishRsyncImportRequestBody;
  configTransferMode: MigrationConfigTransferMode;
  loadStrategy: MigrationLoadStrategy;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { deps, body, configTransferMode, loadStrategy, signal } = input;
  deps.adapter.markCustomerMigratingIn?.(body.slug);
  if (configTransferMode === ACTIVATION_MANIFEST_TRANSFER) {
    const activation = configuredBuilderActivationRequest(deps, body, "final", configTransferMode);
    let verificationPending: string | undefined;
    if (activation) {
      await activateConfiguredBuilderImport(deps, activation, signal, loadStrategy);
    } else {
      verificationPending = await activateImportedCustomerForMigration({
        deps,
        slug: body.slug,
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

export function createFinishRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
      res.status(404).json({ error: "rsync import session not found" });
      return;
    }
    if (session.configTransferMode !== configTransferMode) {
      res.status(409).json({ error: "rsync import config transfer mode does not match prepared session" });
      return;
    }
    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      body.migrationId,
      body.slug,
      log,
    );
    try {
      await stopRsyncDaemon(session.child);
      const rejection = await validateStagedRsyncImport(session, body.slug, mode, configTransferMode, log);
      if (rejection !== null) {
        log(
          `[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug} rejected: ${rejection}`,
        );
        res.status(400).json({ error: "rsync import failed validation", message: rejection });
        return;
      }
      if (mode !== "keys") {
        await upgradeStagedAgentStores(session.stageDir, { signal: controller.signal, log });
      }
      await clearSqliteSidecars(
        (await listSqliteStores(session.stageDir)).map((store) =>
          path.join(session.importDir, path.relative(session.stageDir, store))),
      );
      await copyStageToOpenClaw(session.stageDir, session.importDir, body.slug);
      const verificationPending = mode === "final"
        ? await activateFinishedRsyncImport({
          deps,
          body,
          configTransferMode,
          loadStrategy,
          signal: controller.signal,
        })
        : undefined;
      const response: ImportResponse = {
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        ...(verificationPending ? { verificationPending } : {}),
      };
      log(
        `${verificationPending ? "🟡" : "🟢"} [migration-rsync] finish-import mode=${mode} migrationId=${body.migrationId} slug=${body.slug} ${verificationPending ? "verification-pending" : "done"}` +
        (verificationPending ? ` (verification pending: ${verificationPending})` : ""),
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-rsync] 🔴 finish-import migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();
      await stopRsyncSession(session).catch(() => undefined);
    }
  };
}

export function createAbortRsyncImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
    await stopRsyncSession(rsyncImportSessions.get(key)).catch(() => undefined);
    let activation: ReturnType<typeof configuredBuilderActivationRequest> = null;
    try {
      activation = configuredBuilderActivationRequest(deps, body, mode, configTransferMode);
      if (activation) {
        const state = await deps.unreserveSurgeTarget!(activation);
        if (state.mode !== "held") throw new Error("cannot clear an import while its Builder process is permitted");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`🔴 [migration-rsync] abort-import failed migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
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
  };
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

async function activationManifestVerifyChecks(
  deps: MigrationHandlerDeps,
  body: VerifyMigrationRequestBody,
): Promise<Extract<VerifyMigrationResponse, { configTransferMode?: "activation-manifest" }>["checks"]> {
  const coachWired =
    deps.adapter.customerCoachWiredInOpenclawConfig?.(body.slug)
    ?? deps.getMountedCustomers?.().includes(body.slug)
    ?? false;
  return {
    customerDir: deps.adapter.hasCustomerDir(body.slug),
    coachWired,
    mountMarked: deps.adapter.customerMountMarked?.(body.slug) ?? coachWired,
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
  const checks = await activationManifestVerifyChecks(deps, body);
  return {
    migrationId: body.migrationId,
    slug: body.slug,
    ready: Object.values(checks).every(Boolean),
    checks,
  };
}

export function createVerifyHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
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
        `ready=${response.ready} checks=${JSON.stringify(response.checks)}`,
      );
      res.status(response.ready ? 200 : 409).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 verify migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({ error: "verify failed", message });
    }
  };
}

export function createPushStateHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.pushStateTimeoutMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<PushStateRequestBody>(req, res, deps, log);
    if (!body) return;
    const target = validatePushStateBody(body, res);
    if (!target) return;

    const abort = attachPushStateAbortHandlers(
      res,
      { migrationId: body.migrationId, slug: body.slug, timeoutMs },
      log,
    );

    let cleanupActivationManifest: () => Promise<void> = async () => {};
    let sourceTarError: unknown;
    try {
      const allSources = await deps.adapter.listExportPaths(body.slug);
      const sources = sourcesForPushMode(allSources, body.slug, body.mode);
      if (sources.length === 0) {
        res
          .status(404)
          .json({ error: "no export paths", message: `nothing to push for slug=${body.slug}` });
        return;
      }
      await checkpointAgentStoresForCarry({ sources, log: dlog });

      const activationManifest = body.mode !== "final" && body.mode !== undefined
        ? { source: null, cleanup: async () => {} }
        : await maybeMaterializeActivationManifest(deps, body);
      cleanupActivationManifest = activationManifest.cleanup;
      if (activationManifest.source) {
        sources.push(activationManifest.source);
      }
      dlog(
        `[migration-http] push-state mode=${body.mode ?? "default"} migrationId=${body.migrationId} slug=${body.slug} streaming ${sources.length} path(s) to ${target.targetGatewayId}`,
      );

      const tar = spawnTarStream(sources);
      const tarDone = tar.done.catch((err: unknown) => {
        sourceTarError = err;
        abort.controller.abort(err);
        throw err;
      });
      let importRes: globalThis.Response;
      try {
        importRes = await fetchImpl(
        target.importUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-tar",
            [SIGNATURE_HEADER]: target.targetImportSignature,
            [MIGRATION_ID_HEADER]: body.migrationId,
            [MIGRATION_SLUG_HEADER]: body.slug,
            [MIGRATION_MODE_HEADER]: body.mode ?? "default",
          },
          body: tar.stdout,
          duplex: "half",
          signal: abort.controller.signal,
        } as unknown as RequestInit & { duplex: "half" },
        );
        await tarDone;
      } catch (err) {
        tar.child.kill();
        await tar.done.catch(() => undefined);
        throw sourceTarError ?? err;
      }

      await sendPushStateImportResponse(
        importRes,
        {
          migrationId: body.migrationId,
          slug: body.slug,
          targetGatewayId: target.targetGatewayId,
        },
        res,
        log,
      );
    } catch (err) {
      respondPushStateFailure({
        res,
        body,
        abort,
        sourceTarError,
        cause: err,
        log,
      });
    } finally {
      abort.detach();
      await cleanupActivationManifest();
    }
  };
}

function attachImportDisconnectHandlers(
  res: Response,
  migrationId: string,
  slug: string,
  log: (msg: string) => void,
): { controller: AbortController; detach: () => void } {

const controller = new AbortController();
  const onResClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    log(
      `[migration-http] client closed connection before response sent migrationId=${migrationId} slug=${slug} — aborting`,
    );
    controller.abort(new Error(`client disconnected mid-import`));
  };
  res.on("close", onResClose);
  return {
    controller,
    detach: () => {
      res.removeListener("close", onResClose);
    },
  };
}

function validateImportRequest(
  deps: MigrationHandlerDeps,
  req: Request,
  res: Response,
  log: (msg: string) => void,
): { migrationId: string; slug: string; mode: MigrationImportMode } | null {
  const migrationId = req.header(MIGRATION_ID_HEADER);
  const slug = req.header(MIGRATION_SLUG_HEADER);
  if (!migrationId || !slug) {
    res.status(400).json({
      error: "missing migration headers",
      required: [MIGRATION_ID_HEADER, MIGRATION_SLUG_HEADER],
    });
    return null;
  }
  if (rejectInvalidSlug(slug, res)) return null;
  const sigHeader = req.header(SIGNATURE_HEADER);
  if (!verifyHeaderSignature(migrationId, slug, sigHeader, deps)) {
    log(`[migration-http] 🔴 bad signature on import migrationId=${migrationId} slug=${slug}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, log)) return null;
  const mode = parseMigrationImportMode(req.header(MIGRATION_MODE_HEADER));
  return { migrationId, slug, mode };
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

async function extractValidatedImport(input: {
  tarPath: string;
  importDir: string;
  slug: string;
  mode: MigrationImportMode;
  signal: AbortSignal;
  log: (message: string) => void;
}): Promise<string | null> {
  const entries = await listTarEntries(input.tarPath);
  const traversal = findPathTraversalViolation(entries, input.slug, input.mode);
  if (traversal !== null) return traversal;

  const stageDir = path.join(path.dirname(input.tarPath), "stage");
  await fs.mkdir(stageDir, { recursive: true });
  await extractTarToDir(input.tarPath, stageDir);
  const delivered = entries
    .filter((entry) => isSqliteStorePath(entry))
    .map((entry) => path.join(stageDir, entry));
  const unreadable = await findUnreadableStore({ storePaths: delivered, relativeTo: stageDir });
  if (unreadable) return `carried agent store ${unreadable.path} does not open: ${unreadable.message}`;
  if (input.mode !== "keys") {
    await upgradeStagedAgentStores(stageDir, { signal: input.signal, log: input.log });
  }
  await clearSqliteSidecars(delivered.map((store) => path.join(input.importDir, path.relative(stageDir, store))));
  await copyStageToOpenClaw(stageDir, input.importDir, input.slug);
  return null;
}

export function createImportHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const validated = validateImportRequest(deps, req, res, log);
    if (!validated) return;
    const { migrationId, slug, mode } = validated;

    const { controller, detach } = attachImportDisconnectHandlers(
      res,
      migrationId,
      slug,
      log,
    );

    let tmpDir: string | null = null;
    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
      const importDir = mode === "keys"
        ? await deps.adapter.prepareKeyImportDir(slug)
        : await deps.adapter.prepareImportDir(slug, mode);
      log(
        `🟡 [migration-http] import mode=${mode} migrationId=${migrationId} slug=${slug} unpacking → ${importDir}`,
      );

      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `migration-${migrationId}-`));
      const tarPath = path.join(tmpDir, "import.tar");

      await streamRequestToFile(req, tarPath);

      const violation = await extractValidatedImport({ tarPath, importDir, slug, mode, signal: controller.signal, log });
      if (violation !== null) {
        log(
          `[migration-http] 🔴 import migrationId=${migrationId} slug=${slug} rejected: ${violation}`,
        );
        res.status(400).json({
          error: "tarball failed validation",
          message: violation,
        });
        return;
      }

      if (mode === "keys") {
        const response: ImportResponse = { migrationId, slug, imported: true };
        log(`[migration-http] 🟢 import mode=keys migrationId=${migrationId} slug=${slug} done`);
        res.status(200).json(response);
        return;
      }

      // Pin BEFORE activation: activation coach-wires the customer here, but cutover hasn't
      // yet made it desired-on-this-gateway. The pin keeps the reconcile evict direction
      // from draining the fresh import during that window. Self-expiring (see the pin's TTL).
      deps.adapter.markCustomerMigratingIn?.(slug);
      const verificationPending = await mountImportedCustomer({
        deps,
        slug,
        mode,
        signal: controller.signal,
      });

      const response: ImportResponse = {
        migrationId,
        slug,
        imported: true,
        ...(verificationPending ? { verificationPending } : {}),
      };
      log(
        `${verificationPending ? "🟡" : "🟢"} [migration-http] import migrationId=${migrationId} slug=${slug} ${verificationPending ? "verification-pending" : "done"}` +
        (verificationPending ? ` (verification pending: ${verificationPending})` : ""),
      );
      res.status(200).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[migration-http] 🔴 import migrationId=${migrationId} slug=${slug}: ${message}`);
      respondImportFailure(res, controller.signal, err);
    } finally {
      detach();

if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

async function streamRequestToFile(req: Request, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const writeStream = createWriteStream(dest);
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    req.on("error", (err) => settle(() => reject(err)));
    writeStream.on("error", (err) => settle(() => reject(err)));
    writeStream.on("finish", () => settle(() => resolve()));
    req.pipe(writeStream);
  });
}

async function listTarEntries(tarPath: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
    const child = spawn("tar", ["-tf", tarPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.split("\n").filter((s) => s.length > 0));
      else reject(new Error(`tar -tf exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractTarToDir(tarPath: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- gateway image, PATH controlled
    const child = spawn("tar", ["-xf", tarPath, "-C", dest], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar -xf exit ${code}: ${stderr.trim()}`));
    });
  });
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

export function createUnmountHandler(deps: MigrationHandlerDeps): RequestHandler {
  const log = deps.log ?? ((msg) => console.log(msg));
  return async (req, res) => {
    const body = parseAndVerifyJsonBody<UnmountRequestBody>(req, res, deps, log);
    if (!body) return;

    try {
      const activation = configuredBuilderActivationRequest(deps, body, "final", ACTIVATION_MANIFEST_TRANSFER);
      if (activation) await deps.unreserveSurgeTarget!(activation);
      if (deps.adapter.removeImportedCustomerBySlug) {
        const result = await removeCustomerWithSystemConfigWatchPaused({
          deps,
          slug: body.slug,
          remove: () => deps.adapter.removeImportedCustomerBySlug!(body.slug),
        });
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
      log(`[migration-http] 🔴 unmount migrationId=${body.migrationId} slug=${body.slug}: ${message}`);
      res.status(500).json({
        error: "unmount failed",
        message,
        ...(err instanceof OpenclawWireError ? { code: err.code } : {}),
      });
    }
  };
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
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT current_session_id AS sessionId, status FROM session_nodes")
      .all() as AgentSessionEntry[];
  } finally {
    db.close();
  }
}
