import express from "express";
import * as path from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { readAssignedSlugsForGateway, slugFromAssignedUser } from "./assigned-roster.js";
import { agentIdsFromConfig } from "./byosub-restore.js";
import { readOpenClawConfig } from "./config.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "./agent-model-token-materializer.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  type FlushGatewayResponse,
} from "../../shared/types/fleet-controller.js";
import {
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createExportHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createPushStateHandler,
  createQuiesceHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
  createCompleteSurgeHandoffHandler,
} from "./fleet-http-migration.js";
import {
  createSurgeReadinessGate,
  type SurgeReadinessGate,
} from "./surge-readiness.js";
import {
  observeReadySibling,
  startAfterSurgeReadiness,
  startSurgeReadinessSelfRelease,
} from "./surge-reconcile-gate.js";
import {
  writeGatewayHeartbeat,
  type FleetStateDeps,
  type FleetStateFirestore,
  type HeartbeatSnapshot,
} from "./fleet-state.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { buildProductionLifecycleAdapter } from "./customer-lifecycle-prod-adapter.js";
import { addCustomerToGateway, removeCustomerFromGateway } from "./customer-lifecycle.js";
import type { AddCustomerOptions } from "./customer-lifecycle.js";
import type { AddCustomerResult, CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { isPermanentConfigPatchFailure } from "@octogee/core/apply-config-patch";
import { startReconcileLoop, type UnmountOutcome } from "./reconcile-loop.js";
import { loadAppliedFingerprints, saveAppliedFingerprints } from "./applied-fingerprint-store.js";
import { createDeviceAuthManager } from "./byosub-device-auth.js";
import { realDeviceAuthDeps } from "./byosub-device-auth-io.js";
import { mountByosubDeviceAuth } from "./byosub-device-auth-http.js";
import { createClaudeSsoManager } from "./claude-sso-auth.js";
import { realClaudeSsoDeps } from "./claude-sso-auth-io.js";
import { mountClaudeSsoAuth } from "./claude-sso-auth-http.js";
import {
  createAgentImportDoctorHandler,
  runAgentImportDoctor,
  type AgentImportDoctorResult,
} from "./agent-import-doctor.js";
import { probeOpenClawHealth } from "./system-config-runtime-health.js";

const RECONCILE_LOOP_INTERVAL_MS = 15 * 1000;

export const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

export interface CloneRetryState {
  attempts: number;
  nextAt: number;
  fingerprint: string;
}

export interface PermanentConfigPatchRetryState {
  fingerprint: string;
}

export function permanentConfigPatchRetryReady(
  prior: PermanentConfigPatchRetryState | undefined,
  desiredFingerprint: string | undefined,
): boolean {
  return !prior || (desiredFingerprint ?? "") !== prior.fingerprint;
}

export function desiredEnsureLaneFingerprint(fingerprints: ReadonlyMap<string, string>): string {
  return JSON.stringify([...fingerprints].sort(([a], [b]) => a.localeCompare(b)));
}

export function selectStableContentStale(
  mounted: readonly string[],
  desired: ReadonlyMap<string, string>,
  applied: ReadonlyMap<string, string>,
  pending: Map<string, string>,
): string[] {
  const mountedSet = new Set(mounted);
  const stable: string[] = [];
  for (const slug of [...pending.keys()]) {
    if (!mountedSet.has(slug) || desired.get(slug) === applied.get(slug)) {
      pending.delete(slug);
    }
  }
  for (const slug of mounted) {
    const fingerprint = desired.get(slug);
    if (fingerprint === undefined || fingerprint === applied.get(slug)) continue;
    if (pending.get(slug) === fingerprint) {
      stable.push(slug);
    } else {
      pending.set(slug, fingerprint);
    }
  }
  return stable;
}

function desiredEnsureLaneRosterFingerprint(slugs: readonly string[]): string {
  return JSON.stringify([...new Set(slugs)].sort((a, b) => a.localeCompare(b)));
}

// Backoff for a project checkout that has not landed. It never abandons — a Gitea repo
// restored an hour later is still picked up — but it must not retry on the hot path either:
// selectStale re-flags a stale customer every tick, reconcile-loop has no backoff of its own,
// and mounts are serial (maxConcurrent: 1). Retrying a checkout that can never land (repo gone
// upstream, key missing) would re-run that customer's whole converge — blob sync,
// config-patch RPC, channel verify — every 15s and starve every other customer on the pod.
// Capped at 15m: ~4 converges/hour instead of 240.
export const CLONE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 300_000, 900_000];

export function cloneRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), CLONE_RETRY_DELAYS_MS.length) - 1;
  return CLONE_RETRY_DELAYS_MS[index]!;
}

export function cloneRetryReady(
  prior: CloneRetryState | undefined,
  desiredFingerprint: string | undefined,
  now: number,
): boolean {
  if (!prior) return true;
  // A genuine desired change converges immediately: a new project must never wait out a
  // backoff earned by an unrelated stranded one.
  if ((desiredFingerprint ?? "") !== prior.fingerprint) return true;
  return now >= prior.nextAt;
}

export interface ConvergenceHooks {
  recordApplied: (slug: string, fingerprint: string | undefined) => void;
  rememberRetry: (slug: string, state: CloneRetryState) => void;
  forgetRetry: (slug: string) => void;
}

export interface SettleConvergenceInput {
  now: number;
  slug: string;
  desiredFingerprint: string | undefined;
  prior: CloneRetryState | undefined;
  result: Pick<AddCustomerResult, "pendingProjectClones" | "appliedFingerprint">;
}

// A converge that left a project checkout absent has NOT reached desired state, so its
// fingerprint must not be recorded: that marks the customer clean and strands the checkout —
// and with it the project agent's whole workspace, which is rooted in it — until unrelated
// drift moves the fingerprint again.
//
// It THROWS rather than returning, and that is load-bearing. reconcile-loop fires
// onEnsureSuccess on a normal return, which clears gateways/{id}.lastError — erasing the very
// error an operator needs to see. Throwing routes it to onEnsureError instead, where it
// persists until a later converge lands the clone and clears it naturally.
export function settleConvergence(input: SettleConvergenceInput, hooks: ConvergenceHooks): void {
  const { now, slug, desiredFingerprint, prior, result } = input;
  if (result.pendingProjectClones.length === 0) {
    hooks.forgetRetry(slug);
    hooks.recordApplied(slug, result.appliedFingerprint ?? desiredFingerprint);
    return;
  }
  const attempts = (prior?.attempts ?? 0) + 1;
  hooks.rememberRetry(slug, {
    attempts,
    nextAt: now + cloneRetryDelayMs(attempts),
    fingerprint: desiredFingerprint ?? "",
  });
  throw new Error(
    `project checkout still absent after ${attempts} converge(s): ${result.pendingProjectClones.join(", ")}`,
  );
}

export function registerByosubDeviceAuth(
  app: express.Express,
  opts: StartFleetOptions,
): void {
  const internalServiceKey = opts.internalServiceKey ?? "";
  const openclawDir =
    opts.openclawDir ??
    (process.env.HOME
      ? `${process.env.HOME}/.openclaw`
      : "/home/node/.openclaw");
  const manager = createDeviceAuthManager(
    realDeviceAuthDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  const claudeSsoManager = createClaudeSsoManager(
    realClaudeSsoDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  mountByosubDeviceAuth(app, { manager, internalServiceKey, log: opts.log });
  mountClaudeSsoAuth(app, {
    manager: claudeSsoManager,
    internalServiceKey,
    log: opts.log,
  });
}

export interface BuildAdapterOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId: string | undefined;
}

export function buildProductionAdapter(opts: BuildAdapterOptions): CustomerLifecycleAdapter {
  return buildProductionLifecycleAdapter(opts);
}

export interface StartFleetOptions {
  db?: Firestore;
  rpc: GatewayRpcClient;
  adapter?: CustomerLifecycleAdapter;
  gatewayId: string;
  log: (msg: string) => void;
  port: number;
  publicKey: string;
  version: string;
  openclawVersion: string;
  adminMmUserId?: string;
  platformState?: boolean;
  // Read-only observability (seed + report mounted customers, write this
  // gateway's own liveness heartbeat) — independent of local reconcile.
  // Defaults true; db-less gateways leave it false and trusted Cowboy writes
  // the heartbeat from /health.
  reportState?: boolean;
  /** Run the local assigned-roster reconcile without Firestore state ownership.
   *  Used by db-less gateway pods; desired roster and state mirrors are brokered
   *  through octogee-api. */
  localReconcile?: boolean;
  /** Credential-less local mount reconcile: trusted octogee-api returns the
   * assigned roster for this gateway identity. */
  readDesiredSlugs?: () => Promise<string[]>;
  /** Content-convergence source: slug → fingerprint of the config-affecting snapshot
   *  slice (see snapshot-fingerprint.ts). When provided, it BOTH drives the desired
   *  roster (its keys) and lets the reconcile re-ensure an already-mounted customer whose
   *  fingerprint drifted — the level-triggered path a project-agent toggle rides. Takes
   *  precedence over readDesiredSlugs. */
  readDesiredFingerprints?: () => Promise<Map<string, string>>;
  /** Trusted-side mounted mirror writer used when the pod has no Firestore. */
  stampMounted?: (uid: string, mounted: boolean) => Promise<void>;
  /** Trusted-side reconcile error mirror used when the pod has no Firestore. */
  recordReconcileError?: (slug: string, message: string) => Promise<void>;
  clearReconcileError?: (slug: string) => Promise<void>;
  openclawDir?: string;
  internalServiceKey?: string;
  agentImportDoctorToken?: string;
  runAgentImportDoctor?: (candidate: unknown) => Promise<AgentImportDoctorResult>;
  flushLocalState?: (input: {
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
}

export function registerAgentImportDoctor(
  app: express.Express,
  opts: Pick<StartFleetOptions, "agentImportDoctorToken" | "runAgentImportDoctor" | "log">,
): void {
  const token = opts.agentImportDoctorToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!token) {
    app.post("/agent-import/doctor", (_req, res) => {
      res.status(503).json({ error: "agent import doctor is not configured" });
    });
    opts.log?.("[agent-import] doctor endpoint disabled: OPENCLAW_GATEWAY_TOKEN is unavailable");
    return;
  }
  app.post("/agent-import/doctor", createAgentImportDoctorHandler({
    token,
    runDoctor: opts.runAgentImportDoctor ?? runAgentImportDoctor,
  }));
}

export function reconcileAddCustomerOptions(
  contentConvergenceEnabled: boolean,
  evictionBatch: readonly string[] = [],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): AddCustomerOptions {
  return {
    ...(contentConvergenceEnabled ? { convergeContent: true } : {}),
    ...(evictionBatch.length > 0 ? { evictionBatch } : {}),
    ...(currentEvictionBatch ? { currentEvictionBatch } : {}),
  };
}

export function cancelRemovedEviction(
  adapter: CustomerLifecycleAdapter,
  slug: string,
  invalidate: (slug: string) => void,
): boolean {
  if (adapter.cancelPendingEviction?.(slug) !== true) return false;
  invalidate(slug);
  return true;
}

export interface StartedFleetController {
  stop: () => Promise<void>;

whenReady: Promise<void>;
  port: number;
}

export interface FleetCapabilities {
  /** Read the assigned roster + write this gateway's own liveness/mounted
   *  heartbeat (observability). Independent of provisioning. */
  reportMounted: boolean;
  /** Run the local reconcile loop (ensure/evict). Firestore-backed platform
   *  provisioning requires platformState+db; db-less pods use localReconcile
   *  with a brokered roster. */
  provision: boolean;
  /** At least one capability needs Firestore write deps (own heartbeat +
   *  glmGateways mirror). Brokered local reconcile can provision without it. */
  needsStateDeps: boolean;
}

// Operator gateways report local state but do not receive platform mutation authority:
// operator gateways can run brokered local reconcile without platformState.
// Firestore-backed reporting still gates on hasDb; brokered local reconcile does not.
export function resolveFleetCapabilities(opts: {
  platformState: boolean;
  reportState: boolean;
  localReconcile?: boolean;
  hasDb: boolean;
  hasBrokeredRoster?: boolean;
}): FleetCapabilities {
  const reportMounted = opts.reportState && opts.hasDb;
  const provision =
    (opts.platformState && opts.hasDb) ||
    (opts.localReconcile === true && opts.hasBrokeredRoster === true);
  return {
    reportMounted,
    provision,
    needsStateDeps: reportMounted,
  };
}

export async function readMountedCustomersFromAssignedState(
  db: Firestore,
  gatewayId: string,
  adapter: Pick<
    CustomerLifecycleAdapter,
    | "hasCustomerDir"
    | "customerCoachWiredInOpenclawConfig"
    | "hasCustomerAgentRuntime"
    | "hasWorkspaceGitDir"
    | "hasGitRemote"
  >,
): Promise<string[]> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.gatewayId", "==", gatewayId)
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  const mounted = new Set<string>();
  for (const doc of snap.docs) {
    const slug = slugFromAssignedUser(doc.data() as Record<string, unknown> | undefined);
    if (!slug) continue;
    if (!adapter.hasCustomerDir(slug)) continue;
    if (
      adapter.customerCoachWiredInOpenclawConfig
      && !adapter.customerCoachWiredInOpenclawConfig(slug)
    ) {
      continue;
    }
    if (!hasMountedRuntimeAndWorkspace(adapter, slug)) continue;
    mounted.add(slug);
  }
  return [...mounted].sort((a, b) => a.localeCompare(b));
}

function hasMountedRuntimeAndWorkspace(
  adapter: Pick<
    CustomerLifecycleAdapter,
    "hasCustomerAgentRuntime" | "hasWorkspaceGitDir" | "hasGitRemote"
  >,
  slug: string,
): boolean {
  return (
    (!adapter.hasCustomerAgentRuntime || adapter.hasCustomerAgentRuntime(slug))
    && adapter.hasWorkspaceGitDir(slug)
    && adapter.hasGitRemote(slug)
  );
}

// In-pod migration RPC path guard (GATEWAY-RELEASES-SPEC transport/tenant
// split): the path carries the BARE tenant gatewayId and must equal the pod's
// GATEWAY_ID. A revision id ({gw}-r{n}) in the path is REJECTED — transport is
// addressed by the K8s Service (revision), never smuggled into the tenant path.
export function pathGatewayIdMatchesPod(
  pathGatewayId: string | string[] | undefined,
  podGatewayId: string,
): boolean {
  return pathGatewayId === podGatewayId;
}

// The K8s Service name this pod publishes as its heartbeat internalUrl — the
// chart's stable bare-id Service (GATEWAY-SIMPLE-ROLL-SPEC).
export function gatewayServiceName(input: { gatewayId: string }): string {
  if (!input.gatewayId) throw new Error("gatewayId is required for gateway service addressing");
  return `octogee-gateway-${input.gatewayId}`;
}

// Build the heartbeat snapshot for a fleet tick.
export function buildFleetHeartbeatSnapshot(input: {
  gatewayId: string;
  status: HeartbeatSnapshot["status"];
  version: string;
  openclawVersion: string;
  mountedCustomers: string[];
  internalUrl: string;
  startedAt: number;
}): HeartbeatSnapshot {
  if (!input.gatewayId) {
    throw new Error("gatewayId is required for a gateway heartbeat");
  }
  return {
    gatewayId: input.gatewayId,
    status: input.status,
    version: input.version,
    openclawVersion: input.openclawVersion,
    mountedCustomers: input.mountedCustomers,
    internalUrl: input.internalUrl,
    startedAt: input.startedAt,
  };
}

export function buildFleetHealthResponse(input: {
  status: FleetRuntime["status"];
  gatewayId: string;
  podUid: string | null;
  version: string;
  openclawVersion: string;
  startedAt: number;
  customers: string[];
  migratingIn: string[];
}): Record<string, unknown> {
  return {
    status: input.status,
    gatewayId: input.gatewayId,
    podUid: input.podUid,
    version: input.version,
    openclawVersion: input.openclawVersion,
    startedAt: input.startedAt,
    customers: input.customers,
    migratingIn: input.migratingIn,
  };
}

interface FleetRuntime {
  mountedCustomers: string[];
  status: "booting" | "ready";
}

/** Write the broker profiles pre-boot could only defer: openclaw has created
 *  every rostered agent's store by the time healthz passes. Idempotent — a
 *  profile already present is a no-op. */
export function materializeDeferredBrokerProfiles(log: (msg: string) => void): void {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const openAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  let agentIds: string[];
  try {
    agentIds = agentIdsFromConfig(readOpenClawConfig());
  } catch (error) {
    log(`⚠ [agent-model-token] post-boot sweep skipped — config unreadable: ${String(error)}`);
    return;
  }
  const sweep = materializeBrokerProfilesForAgents(agentIds, {
    logFn: log,
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(openAiBaseUrl ? { openAi: openAiCatalogInputForBaseUrl(openAiBaseUrl) } : {}),
  });
  if (sweep.materialized > 0) {
    log(`[agent-model-token] post-boot sweep materialized ${sweep.materialized} agent(s)`);
  }
  if (sweep.deferred.length > 0) {
    log(
      `⚠ [agent-model-token] post-boot sweep still deferred for ${sweep.deferred.join(", ")}` +
        ` — those agents have no store even though openclaw is up`,
    );
  }
}

export async function waitForOpenClawHealthz(input: {
  probeHealthz: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (true) {
    if (await input.probeHealthz()) return;
    await sleep(1_000);
  }
}

export async function probeSurgeReadiness(input: {
  runtimeStatus: FleetRuntime["status"];
  handoffReleased: boolean;
  probeHealthz: () => Promise<boolean>;
}): Promise<{ ready: boolean; openclawUp: boolean }> {
  const openclawUp = input.runtimeStatus === "ready"
    ? await input.probeHealthz()
    : false;
  return {
    ready: input.handoffReleased && openclawUp,
    openclawUp,
  };
}

function createSurgeReadinessHandler(input: {
  runtime: FleetRuntime;
  surgeReadiness: SurgeReadinessGate;
  probeHealthz: () => Promise<boolean>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const handoffReleased = await input.surgeReadiness.released();
      const { ready, openclawUp } = await probeSurgeReadiness({
        runtimeStatus: input.runtime.status,
        handoffReleased,
        probeHealthz: input.probeHealthz,
      });
      res.status(ready ? 200 : 503).json({
        ready,
        runtimeStatus: input.runtime.status,
        handoffReleased,
        openclawUp,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[surge-handoff] readiness probe failed: ${message}`);
      res.status(500).json({ ready: false, error: message });
    }
  };
}

// Evict-observed: RAW on-disk dir presence (NOT coach-wired), minus migrating-in. Drives the
// reconcile's evict direction only. Raw — so a partial/junk dir left by a mount that died
// before its config patch is still drained once it's unassigned (a coach-wired-only view
// would never see it). Minus migrating-in — so a freshly-imported customer (present before
// cutover makes it desired-here) isn't drained mid-migration. This is the ONLY consumer of
// the migrating-in pin: the heartbeat report and mount-observed are deliberately pin-blind,
// so a successfully-migrated customer is reported + considered mounted the moment it's
// coach-wired, not suppressed for the pin's TTL.
export function getEvictObservedSlugs(adapter: CustomerLifecycleAdapter): string[] {
  const dirs = adapter.listLocalCustomerDirs?.() ?? adapter.listLocalCustomerSlugs?.() ?? [];
  const migratingIn = adapter.customerMigratingIn;
  return dirs.filter((s) => !migratingIn || !migratingIn(s)).sort((a, b) => a.localeCompare(b));
}

// Mount-observed: coach-wired, runtime-present, durable-workspace-ready, and marked complete.
// Drives both reconciliation and mounted reporting so any lost runtime, checkout, or origin
// re-enters desired−observed and is repaired instead of being reported as mounted forever.
export function getMountObservedSlugs(adapter: CustomerLifecycleAdapter): string[] {
  const coachWired = adapter.listLocalCustomerSlugs?.() ?? [];
  const marked = adapter.customerMountMarked;
  return coachWired
    .filter(
      (slug) =>
        hasMountedRuntimeAndWorkspace(adapter, slug)
        && (!marked || marked(slug)),
    )
    .sort((a, b) => a.localeCompare(b));
}

// Bounded, derived lastError mirror (the restoreJobs writer is gone — this is the only
// writer of gateways/{id}.lastError now). Strictly best-effort: every path swallows its
// own error so a Firestore blip can never crash the reconcile tick. lastError holds only
// the MOST RECENT ensure failure; the full history is in the [reconcile] logs.
function recordReconcileError(opts: StartFleetOptions, slug: string, message: string): void {
  if (opts.recordReconcileError) {
    opts
      .recordReconcileError(slug, message)
      .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError write failed: ${String(err)}`));
    return;
  }
  if (!opts.db) return;
  opts.db
    .collection("gateways")
    .doc(opts.gatewayId)
    .set(
      { lastError: { slug, message, at: FieldValue.serverTimestamp() } },
      { merge: true },
    )
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ lastError write failed: ${String(err)}`));
}

// Clear only when the standing lastError is for THIS slug — a success for one slug must
// not wipe another slug's still-live error (which would otherwise flicker back next tick).
function clearReconcileError(opts: StartFleetOptions, slug: string): void {
  if (opts.clearReconcileError) {
    opts
      .clearReconcileError(slug)
      .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError clear failed: ${String(err)}`));
    return;
  }
  const db = opts.db;
  if (!db) return;
  const ref = db.collection("gateways").doc(opts.gatewayId);
  db
    .runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const current = snap.data()?.lastError as { slug?: string } | null | undefined;
      if (current && current.slug === slug) {
        txn.set(ref, { lastError: null }, { merge: true });
      }
    })
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ lastError clear failed: ${String(err)}`));
}

interface EvictLocalCustomerInput {
  adapter: CustomerLifecycleAdapter;
  slug: string;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;
  onRetainedAfterConfigRemoval?: (slug: string) => void;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  onLocalStateRemoved: (slug: string) => void;
}

function retainLocalCustomer(input: EvictLocalCustomerInput): UnmountOutcome {
  input.onRetainedAfterConfigRemoval?.(input.slug);
  return "noop";
}

async function evictKnownCustomer(
  input: EvictLocalCustomerInput,
  uid: string,
): Promise<UnmountOutcome> {
  const result = await removeCustomerFromGateway(input.adapter, uid, {
    evictionBatch: input.evictionBatch,
    currentEvictionBatch: input.currentEvictionBatch,
  });
  if (result.retained) return retainLocalCustomer(input);
  await input.stampMounted(uid, false);
  input.onLocalStateRemoved(input.slug);
  return result.wasMounted ? "drained" : "noop";
}

async function evictImportedCustomer(
  input: EvictLocalCustomerInput,
  removeImported: NonNullable<CustomerLifecycleAdapter["removeImportedCustomerBySlug"]>,
): Promise<UnmountOutcome> {
  const result = await removeImported(
    input.slug,
    input.evictionBatch,
    input.currentEvictionBatch,
  );
  if (result.retained) return retainLocalCustomer(input);
  if (!result.wasMounted) input.adapter.cancelPendingEviction?.(input.slug);
  input.adapter.onUnmounted?.(input.slug);
  input.onLocalStateRemoved(input.slug);
  return result.wasMounted ? "deleted-user" : "noop";
}

async function evictSlugOnlyCustomer(
  input: EvictLocalCustomerInput,
): Promise<UnmountOutcome> {
  const { adapter, slug, evictionBatch, currentEvictionBatch } = input;
  const agentId = `octogee-${slug}-coach`;
  const remaining = await adapter.applyRemoveCustomerConfigPatch(
    slug,
    agentId,
    evictionBatch,
    currentEvictionBatch,
  );
  if (remaining && !remaining.includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return retainLocalCustomer(input);
  }
  if (currentEvictionBatch && !(await currentEvictionBatch()).includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return retainLocalCustomer(input);
  }
  if (adapter.hasCustomerDir(slug)) await adapter.deleteCustomerDir(slug);
  adapter.onUnmounted?.(slug);
  input.onLocalStateRemoved(slug);
  return "deleted-user";
}

export async function evictLocalCustomer(
  input: EvictLocalCustomerInput,
): Promise<UnmountOutcome> {
  const uid = await input.adapter.uidForSlug(input.slug);
  if (uid) return evictKnownCustomer(input, uid);
  try {
    const removeImported = input.adapter.removeImportedCustomerBySlug;
    return removeImported
      ? evictImportedCustomer(input, removeImported)
      : evictSlugOnlyCustomer(input);
  } catch (err) {
    throw new Error(
      `slug-only cleanup failed for ${input.slug} (no user doc): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function evictLocalCustomerIfStillUndesired(input: {
  slug: string;
  evictionBatch: readonly string[];
  readDesired: () => Promise<string[]>;
  cancelPendingEviction?: (slug: string) => void;
  evict: (
    currentEvictionBatch: readonly string[],
    readCurrentEvictionBatch: () => Promise<readonly string[]>,
  ) => Promise<UnmountOutcome>;
}): Promise<UnmountOutcome> {
  const desired = new Set(await input.readDesired());
  for (const slug of input.evictionBatch) {
    if (desired.has(slug)) input.cancelPendingEviction?.(slug);
  }
  if (desired.has(input.slug)) return "noop";
  const currentEvictionBatch = input.evictionBatch.filter((slug) => !desired.has(slug));
  return input.evict(currentEvictionBatch, async () => {
    const latest = new Set(await input.readDesired());
    for (const slug of input.evictionBatch) {
      if (latest.has(slug)) input.cancelPendingEviction?.(slug);
    }
    return input.evictionBatch.filter((slug) => !latest.has(slug));
  });
}

function createCurrentEvictionBatchReader(input: {
  readDesired: () => Promise<string[]>;
  pendingEvictions: () => readonly string[];
  cancelPendingEviction: (slug: string) => void;
}): () => Promise<readonly string[]> {
  return async () => {
    const desired = new Set(await input.readDesired());
    const current = input.pendingEvictions();
    for (const staleSlug of current) {
      if (desired.has(staleSlug)) input.cancelPendingEviction(staleSlug);
    }
    return current.filter((staleSlug) => !desired.has(staleSlug));
  };
}

function startMaybeReconcileLoop(params: {
  provision: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  surgeReadiness: SurgeReadinessGate;
}): () => void {
  const { provision, opts, wrappedAdapter, runtime, stampMounted, surgeReadiness } = params;

  // Content-convergence bookkeeping (only when a fingerprint source is wired). desiredFp
  // is refreshed every tick by readDesired; appliedFp records the fingerprint that was
  // live at each customer's last successful ensure. getContentStale reports mounted
  // customers where the two diverge — the signal that makes a snapshot-only change (e.g.
  // a project-agent toggle) reconverge without a remount. appliedFp mirrors to disk
  // (when openclawDir is known) so a container restart with the emptyDir intact does not
  // re-ensure an unchanged fleet; a MISSING entry is stale by definition — see
  // content-convergence.ts and applied-fingerprint-store.ts.
  const fingerprintSource = opts.readDesiredFingerprints;
  const desiredFp = new Map<string, string>();
  const appliedFpFile =
    fingerprintSource && opts.openclawDir
      ? path.join(opts.openclawDir, "applied-fingerprints.json")
      : null;
  const appliedFp = appliedFpFile ? loadAppliedFingerprints(appliedFpFile) : new Map<string, string>();
  const pendingContentFp = new Map<string, string>();
  // Backoff state for slugs whose project checkout has not landed. Process-local on purpose:
  // a pod restart is itself a fresh chance for the clone to land.
  const cloneRetry = new Map<string, CloneRetryState>();
  let permanentConfigPatchRetry: PermanentConfigPatchRetryState | undefined;
  let desiredEnsureFingerprint = "";
  const persistAppliedFp = (): void => {
    if (!appliedFpFile) return;
    try {
      saveAppliedFingerprints(appliedFpFile, appliedFp);
    } catch (err) {
      opts.log(`[reconcile] ⚠ applied-fingerprint persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const invalidateConfigRemovedSlug = (slug: string): void => {
    wrappedAdapter.clearMountMarker?.(slug);
    appliedFp.delete(slug);
    const current = desiredFp.get(slug);
    if (current !== undefined) pendingContentFp.set(slug, current);
    persistAppliedFp();
  };
  const cancelPendingEviction = (slug: string): void => {
    cancelRemovedEviction(wrappedAdapter, slug, invalidateConfigRemovedSlug);
  };
  const onLocalStateRemoved = (slug: string): void => {
    cloneRetry.delete(slug);
    pendingContentFp.delete(slug);
    permanentConfigPatchRetry = undefined;
    if (appliedFp.delete(slug)) persistAppliedFp();
  };
  if (fingerprintSource) {
    wrappedAdapter.recordAppliedFingerprint = (slug, fingerprint) => {
      appliedFp.set(slug, fingerprint);
      persistAppliedFp();
    };
  }

  let readDesired: (() => Promise<string[]>) | null = null;
  if (fingerprintSource) {
    readDesired = async () => {
      const next = await fingerprintSource();
      desiredFp.clear();
      for (const [slug, fp] of next) desiredFp.set(slug, fp);
      desiredEnsureFingerprint = desiredEnsureLaneFingerprint(next);
      return [...next.keys()];
    };
  } else if (opts.readDesiredSlugs) {
    readDesired = async () => {
      const slugs = await opts.readDesiredSlugs!();
      desiredEnsureFingerprint = desiredEnsureLaneRosterFingerprint(slugs);
      return slugs;
    };
  } else if (opts.db) {
    readDesired = async () => {
      const slugs = await readAssignedSlugsForGateway(opts.db!, opts.gatewayId);
      desiredEnsureFingerprint = desiredEnsureLaneRosterFingerprint(slugs);
      return slugs;
    };
  }
  if (!provision || !readDesired) return () => undefined;

  const getContentStale = fingerprintSource
    ? (): string[] => {
        const now = Date.now();
        return selectStableContentStale(
          getMountObservedSlugs(wrappedAdapter),
          desiredFp,
          appliedFp,
          pendingContentFp,
        ).filter(
          (slug) => cloneRetryReady(cloneRetry.get(slug), desiredFp.get(slug), now),
        );
      }
    : undefined;
  const start = () => startReconcileLoop({
    gatewayId: opts.gatewayId,
    intervalMs: RECONCILE_LOOP_INTERVAL_MS,
    // SERIAL (not the default cap): the production lifecycle adapter shares one mutable
    // `cachedUserData.current` across addCustomerToGateway calls (loadUserSnapshot →
    // toProvisioningContext → applyConfigPatch), so two concurrent mounts could provision
    // customer A using customer B's cached user doc / MM identity — tenant-corrupting. Keep
    // mounts serial until the adapter is request-scoped. See FLEET-RECONCILE-SPEC.
    maxConcurrent: 1,
    log: opts.log,
    getMountObserved: () => {
      const mounted = getMountObservedSlugs(wrappedAdapter);
      runtime.mountedCustomers = mounted;
      return mounted;
    },
    getEvictObserved: () => getEvictObservedSlugs(wrappedAdapter),
    ...(getContentStale ? { getContentStale } : {}),
    readDesired,
    shouldEnsureSlug: () =>
      permanentConfigPatchRetryReady(permanentConfigPatchRetry, desiredEnsureFingerprint),
    shouldDeferRemainingMounts: isPermanentConfigPatchFailure,
    onPendingEvictionCancelled: cancelPendingEviction,
    ensureSlug: async (
      slug: string,
      evictionBatch: readonly string[],
      pendingEvictions: () => readonly string[],
    ) => {
      wrappedAdapter.cancelPendingEviction?.(slug);
      const uid = await wrappedAdapter.uidForSlug(slug);
      if (!uid) throw new Error(`no user doc for assigned slug ${slug}`);
      const readCurrentEvictionBatch = createCurrentEvictionBatchReader({
        readDesired,
        pendingEvictions,
        cancelPendingEviction,
      });
      const result = await addCustomerToGateway(
        wrappedAdapter,
        uid,
        reconcileAddCustomerOptions(
          fingerprintSource !== undefined,
          evictionBatch,
          readCurrentEvictionBatch,
        ),
      );
      await stampMounted(uid, true);
      // LAST step (after add succeeds AND the mounted mirror is stamped): write the on-disk
      // completion marker so mount-observed now includes this slug. Until it lands, a
      // coach-wired-but-incomplete mount stays in toMount and is re-ensured.
      wrappedAdapter.writeMountMarker?.(slug);
      // Records the fingerprint that is now applied on disk, so this customer is no longer
      // reported stale until its desired fingerprint next changes — and THROWS instead when a
      // project checkout is still absent, so the loop's own onEnsureError surfaces it. A
      // normal return would fire onEnsureSuccess, which clears that very error.
      settleConvergence({
        now: Date.now(),
        slug,
        desiredFingerprint: desiredFp.get(slug),
        prior: cloneRetry.get(slug),
        result,
      }, {
        recordApplied: (s, fp) => {
          if (!fingerprintSource) return;
          if (fp !== undefined) {
            appliedFp.set(s, fp);
            persistAppliedFp();
          }
        },
        rememberRetry: (s, state) => cloneRetry.set(s, state),
        forgetRetry: (s) => cloneRetry.delete(s),
      });

      return result.newCustomer ? "mounted" : "noop";
    },
    onEnsureError: (slug, message, error) => {
      if (isPermanentConfigPatchFailure(error)) {
        permanentConfigPatchRetry = { fingerprint: desiredEnsureFingerprint };
      }
      recordReconcileError(opts, slug, message);
    },
    onEnsureSuccess: (slug) => {
      permanentConfigPatchRetry = undefined;
      clearReconcileError(opts, slug);
    },
    unmountSlug: (slug: string, evictionBatch: readonly string[]) =>
      evictLocalCustomerIfStillUndesired({
        slug,
        evictionBatch,
        readDesired,
        cancelPendingEviction,
        evict: (currentEvictionBatch, readCurrentEvictionBatch) => evictLocalCustomer({
          adapter: wrappedAdapter,
          slug,
          evictionBatch: currentEvictionBatch,
          currentEvictionBatch: readCurrentEvictionBatch,
          onRetainedAfterConfigRemoval: invalidateConfigRemovedSlug,
          stampMounted,
          onLocalStateRemoved,
        }),
      }),
  });
  return startAfterSurgeReadiness({
    released: surgeReadiness.released,
    start,
    log: opts.log,
  });
}

function createStateDeps(opts: StartFleetOptions, needsState: boolean): FleetStateDeps | null {
  if (!needsState) return null;
  if (!opts.db) {
    throw new Error("[fleet] db is required when reportState is enabled");
  }
  return {
    db: opts.db as unknown as FleetStateFirestore,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    log: opts.log,
  };
}

function buildFleetAdapter(opts: StartFleetOptions): CustomerLifecycleAdapter {
  if (opts.adapter) return opts.adapter;
  if (!opts.db) {
    throw new Error("[fleet] db is required when no explicit lifecycle adapter is provided");
  }
  return buildProductionAdapter({
    db: opts.db!,
    rpc: opts.rpc,
    log: opts.log,
    adminMmUserId: opts.adminMmUserId,
  });
}

function resolveK8sNamespace(): string {
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) {
    throw new Error(
      "[fleet] K8S_NAMESPACE env var is not set. The gateway deployment must " +
        "expose it via downward API (valueFrom.fieldRef.fieldPath=metadata.namespace) " +
        "or heartbeats will publish internalUrl with a null namespace.",
    );
  }
  return namespace;
}

function startPodSurgeReadinessRecovery(input: {
  surgeReadiness: SurgeReadinessGate;
  serviceName: string;
  namespace: string;
  port: number;
  log: (message: string) => void;
}): () => void {
  const ownPodUid = process.env.POD_UID?.trim() || null;
  if (!ownPodUid) {
    input.log("[surge-handoff] POD_UID is unset; pod-side readiness recovery is disabled");
    return () => undefined;
  }
  return startSurgeReadinessSelfRelease({
    released: input.surgeReadiness.released,
    observe: () => observeReadySibling({
      healthUrl: `http://${input.serviceName}.${input.namespace}.svc.cluster.local:${input.port}/health`,
      ownPodUid,
    }),
    release: () => input.surgeReadiness.release({ targetPodUid: ownPodUid }),
    log: input.log,
  });
}

function wrapAdapterWithRuntime(
  adapter: CustomerLifecycleAdapter,
  runtime: FleetRuntime,
): CustomerLifecycleAdapter {
  return {
    ...adapter,
    onMounted: (slug: string) => {
      if (!runtime.mountedCustomers.includes(slug)) {
        runtime.mountedCustomers = [...runtime.mountedCustomers, slug];
      }
    },
    onUnmounted: (slug: string) => {
      runtime.mountedCustomers = runtime.mountedCustomers.filter((s) => s !== slug);
    },
  };
}

async function seedRuntimeMountedCustomers(params: {
  opts: StartFleetOptions;
  reportMounted: boolean;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
}): Promise<void> {
  const { opts, reportMounted, wrappedAdapter, runtime } = params;
  try {
    if (!reportMounted || !opts.db) return;
    runtime.mountedCustomers = await readMountedCustomersFromAssignedState(
      opts.db,
      opts.gatewayId,
      wrappedAdapter,
    );
    if (runtime.mountedCustomers.length > 0) {
      opts.log(
        `[fleet] seeded mounted customers from assigned local state: ${runtime.mountedCustomers.join(",")}`,
      );
    }
  } catch (err) {
    opts.log(
      `[fleet] ⚠ mounted-customer seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const platformState = opts.platformState !== false;
  const reportState = opts.reportState !== false;
  const caps = resolveFleetCapabilities({
    platformState,
    reportState,
    localReconcile: opts.localReconcile === true,
    hasDb: !!opts.db,
    hasBrokeredRoster: !!opts.readDesiredSlugs || !!opts.readDesiredFingerprints,
  });
  const stateDeps = createStateDeps(opts, caps.needsStateDeps);
  const adapter = buildFleetAdapter(opts);

  const runtime: FleetRuntime = {
    mountedCustomers: [],
    status: "booting",
  };
  const openclawDir = opts.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  const surgeReadiness = createSurgeReadinessGate(openclawDir);

  const namespace = resolveK8sNamespace();
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";

const serviceName = gatewayServiceName({ gatewayId: opts.gatewayId });
  const internalUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${gatewayPort}`;

  const emitHeartbeat = async (status: HeartbeatSnapshot["status"]) => {
    if (!stateDeps) return;
    try {
      await writeGatewayHeartbeat(
        stateDeps,
        buildFleetHeartbeatSnapshot({
          gatewayId: opts.gatewayId,
          status,
          version: opts.version,
          openclawVersion: opts.openclawVersion,
          mountedCustomers: runtime.mountedCustomers,
          internalUrl,
          startedAt: PROCESS_STARTED_AT_MS,
        }),
      );
    } catch (err) {
      opts.log(
        `[fleet] ⚠ heartbeat write failed: ${String(err)} — will retry next tick`,
      );
    }
  };

  // Derived readiness mirror (D5): stamp on-disk presence onto the user doc for cheap
  // PWA queries. Nothing branches on it — it mirrors observed, never drives mounting.
  const stampMounted = async (uid: string, mounted: boolean): Promise<void> => {
    if (opts.stampMounted) {
      await opts.stampMounted(uid, mounted);
      return;
    }
    if (!opts.db) return;
    try {
      await opts.db
        .collection("users")
        .doc(uid)
        .update({ "provisioning.openclaw.mounted": mounted });
    } catch (err) {
      opts.log(`[reconcile] ⚠ mounted-mirror stamp failed for ${uid}: ${String(err)}`);
    }
  };

  const waitForGatewayReady = async (): Promise<void> => {
    if (runtime.status === "ready") return;
    await waitForOpenClawHealthz({
      probeHealthz: () => probeOpenClawHealth(
        `http://127.0.0.1:${gatewayPort}/healthz`,
      ),
    });
    runtime.status = "ready";
    opts.log(
      `[fleet] OpenClaw healthz ready; transitioning gateways/${opts.gatewayId} to status=ready`,
    );
    // Pre-boot could only write the catalogs — the auth-profile stores did not
    // exist yet. openclaw has now created them for every rostered agent, so the
    // deferred profiles land here, before any agent turn needs its broker token.
    materializeDeferredBrokerProfiles(opts.log);
    await emitHeartbeat("ready");
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json(buildFleetHealthResponse({
      status: runtime.status,
      gatewayId: opts.gatewayId,
      podUid: process.env.POD_UID ?? null,
      version: opts.version,
      openclawVersion: opts.openclawVersion,
      startedAt: PROCESS_STARTED_AT_MS,
      customers: getMountObservedSlugs(adapter),
      // Slugs mid-migration-import — Cowboy's operator poller skips these as eviction
      // candidates until cutover moves their assignment (the operator path has no in-pod
      // reconcile to honor the pin).
      migratingIn: adapter.listMigratingInSlugs?.() ?? [],
    }));
  });

  app.get("/surge-ready", createSurgeReadinessHandler({
    runtime,
    surgeReadiness,
    probeHealthz: () => probeOpenClawHealth(
      `http://127.0.0.1:${gatewayPort}/healthz`,
    ),
    log: opts.log,
  }));

  const wrappedAdapter = wrapAdapterWithRuntime(adapter, runtime);

  await seedRuntimeMountedCustomers({ opts, reportMounted: caps.reportMounted, wrappedAdapter, runtime });

  await emitHeartbeat("booting");

  const heartbeatTimer = caps.reportMounted
    ? setInterval(() => {
        void emitHeartbeat(runtime.status);
      }, GATEWAY_HEARTBEAT_INTERVAL_MS)
    : null;

  const gatewayIdGuard: express.RequestHandler = (req, res, next) => {
    if (!pathGatewayIdMatchesPod(req.params.gatewayId, opts.gatewayId)) {
      opts.log(
        `[fleet-http] ⚠ path gatewayId=${req.params.gatewayId} does not match this pod's gatewayId=${opts.gatewayId} — rejecting`,
      );
      res.status(400).json({
        error: "path gatewayId does not match this gateway",
        pathGatewayId: req.params.gatewayId,
        podGatewayId: opts.gatewayId,
      });
      return;
    }
    next();
  };

  const migrationDeps = {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
    getMountedCustomers: () => runtime.mountedCustomers,
    flushLocalState: opts.flushLocalState,
    releaseSurgeReadiness: async ({ targetPodUid }: { targetPodUid: string }) => {
      const ownPodUid = process.env.POD_UID;
      if (ownPodUid && ownPodUid !== targetPodUid) {
        throw new Error(`target pod UID mismatch: expected ${ownPodUid}, received ${targetPodUid}`);
      }
      await surgeReadiness.release({ targetPodUid });
    },
  };
  app.post("/restore/:gatewayId", gatewayIdGuard, createRestoreHandler(migrationDeps));
  app.post("/quiesce/:gatewayId", gatewayIdGuard, createQuiesceHandler(migrationDeps));
  app.post("/flush/:gatewayId", gatewayIdGuard, createFlushHandler(migrationDeps));
  app.post("/verify/:gatewayId", gatewayIdGuard, createVerifyHandler(migrationDeps));
  app.post("/export/:gatewayId", gatewayIdGuard, createExportHandler(migrationDeps));
  app.post("/export-paths/:gatewayId", gatewayIdGuard, createExportPathsHandler(migrationDeps));
  app.post(
    "/export-activation-manifest/:gatewayId",
    gatewayIdGuard,
    createActivationManifestExportHandler(migrationDeps),
  );
  app.post("/prepare-import/:gatewayId", gatewayIdGuard, createPrepareImportHandler(migrationDeps));
  app.post("/activate-import/:gatewayId", gatewayIdGuard, createActivateImportHandler(migrationDeps));
  app.post("/prepare-rsync-import/:gatewayId", gatewayIdGuard, createPrepareRsyncImportHandler(migrationDeps));
  app.post("/push-rsync-state/:gatewayId", gatewayIdGuard, createPushRsyncStateHandler(migrationDeps));
  app.post("/finish-rsync-import/:gatewayId", gatewayIdGuard, createFinishRsyncImportHandler(migrationDeps));
  app.post("/abort-rsync-import/:gatewayId", gatewayIdGuard, createAbortRsyncImportHandler(migrationDeps));
  app.post("/complete-surge-handoff/:gatewayId", gatewayIdGuard, createCompleteSurgeHandoffHandler(migrationDeps));
  app.post("/push-state/:gatewayId", gatewayIdGuard, createPushStateHandler(migrationDeps));
  app.post("/import/:gatewayId", gatewayIdGuard, createImportHandler(migrationDeps));
  app.post("/unmount/:gatewayId", gatewayIdGuard, createUnmountHandler(migrationDeps));

  registerByosubDeviceAuth(app, opts);
  registerAgentImportDoctor(app, opts);

  const stopReconcileLoop = startMaybeReconcileLoop({
    provision: caps.provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted,
    surgeReadiness,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  const boundPort = (server.address() as AddressInfo).port;
  const stopSurgeSelfRelease = startPodSurgeReadinessRecovery({
    surgeReadiness,
    serviceName,
    namespace,
    port: boundPort,
    log: opts.log,
  });
  const reconcileLoopStatus = caps.provision ? `${RECONCILE_LOOP_INTERVAL_MS}ms` : "disabled";
  opts.log(
    `[fleet] listening on 0.0.0.0:${boundPort}; gatewayId=${opts.gatewayId}; platformState=${platformState}; reportState=${reportState}; reconcile-loop=${reconcileLoopStatus}`,
  );

return {
    port: boundPort,
    whenReady: waitForGatewayReady(),
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopSurgeSelfRelease();
      stopReconcileLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
