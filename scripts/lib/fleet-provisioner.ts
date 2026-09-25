import express from "express";
import { workspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import * as path from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { readAssignedSlugsForGateway, slugFromAssignedUser } from "./assigned-roster.js";
import { agentIdsFromConfig } from "./byosub-restore.js";
import { readOpenClawConfig } from "./config.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
  type BrokerProfileSweepOptions,
} from "./agent-model-token-materializer.js";
import { createBrokerTokenRefreshScheduler } from "./broker-token-refresh.js";
import { openClawRuntimeUpdateGuard } from "./openclaw-runtime-update-guard.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  FLEET_STATE_PATH,
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  type FleetHealthResponse,
  type FleetStateResponse,
  type FlushGatewayResponse,
} from "../../shared/types/fleet-controller.js";
import { createFleetStateHandler } from "./fleet-state-http.js";
import {
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createMigrationProgressHandler,
  createQuiesceHandler,
  createSchedulerMigrationHandler,
  createSchedulerReadyHandler,
  createResumeHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
  createCompleteSurgeHandoffHandler,
  type MigrationHandlerDeps,
} from "./fleet-http-migration.js";
import {
  createSurgeReadinessGate,
  type SurgeReadinessGate,
} from "./surge-readiness.js";
import {
  createSurgeOpenClawProcessSupervisorClient,
  type SurgeOpenClawProcessGateState,
  type SurgeOpenClawProcessSupervisorClient,
} from "./surge-openclaw-process-gate.js";
import {
  createHoldSurgeOpenClawHandler,
  createResumeSurgeOpenClawHandler,
  createUnreserveSurgeOpenClawHandler,
  type SurgeOpenClawProcessHandlerDeps,
} from "./surge-openclaw-process-http.js";
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
import {
  addCustomerToGateway,
  cloneMissingProjects,
  removeCustomerFromGateway,
} from "./customer-lifecycle.js";
import type { AddCustomerOptions } from "./customer-lifecycle.js";
import type { AddCustomerResult, CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { isPermanentConfigPatchFailure } from "@octogee/core/apply-config-patch";
import {
  customerAttachPending,
  startReconcileLoop,
  type EnsureOutcome,
  type UnmountOutcome,
} from "./reconcile-loop.js";
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
import {
  observeDashboardControl,
  probeOpenClawHealth,
} from "./system-config-runtime-health.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import {
  resetRecoveredCustomerRuntime,
  type RecoveredCustomerRuntimeResetResult,
} from "./recovered-customer-runtime-reset.js";

const RECONCILE_LOOP_INTERVAL_MS = 2 * 1000;
export const MOUNT_CONCURRENCY = 4;
const BUILDER_POST_START_ACCOUNT_TIMEOUT_MS = 120_000;
const BUILDER_POST_START_HEALTH_TIMEOUT_MS = 600_000;

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

// The mount lane is serial, so a checkout that cannot land must back off instead of
// consuming every tick and starving the pod's other cold mounts.
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

export interface CustomerEnsureRetryInput {
  cloneRetry: CloneRetryState | undefined;
  desiredFingerprint: string | undefined;
  now: number;
  permanentConfigPatchRetry: PermanentConfigPatchRetryState | undefined;
  desiredEnsureFingerprint: string | undefined;
}

export function customerEnsureRetryReady(input: CustomerEnsureRetryInput): boolean {
  return permanentConfigPatchRetryReady(
    input.permanentConfigPatchRetry,
    input.desiredEnsureFingerprint,
  ) && cloneRetryReady(input.cloneRetry, input.desiredFingerprint, input.now);
}

export interface ConvergenceHooks {
  recordApplied: (slug: string, fingerprint: string | undefined) => void;
  rememberRetry: (slug: string, state: CloneRetryState) => void;
  forgetRetry: (slug: string) => void;
}

// A pending optional project checkout must not hold the whole customer stale: re-running
// the full attach re-patches config and restarts the coach on every retry (observed live
// 2026-08-14 on shared-a: 205 consecutive ~50s re-attaches, two agent restarts each). The
// applied store instead records this marker — unequal to every real fingerprint, so the
// level-triggered loop keeps selecting the slug — and ensureSlug recognizes it and retries
// ONLY the checkout. Restart-safe on durable disks because the marker persists with the
// applied-fingerprint store.
export { pendingCloneAppliedFingerprint, pendingCloneOnlyStale } from "./pending-clone-fingerprint.js";
import { pendingCloneAppliedFingerprint, pendingCloneOnlyStale } from "./pending-clone-fingerprint.js";

export interface SettleConvergenceInput {
  now: number;
  slug: string;
  desiredFingerprint: string | undefined;
  prior: CloneRetryState | undefined;
  result: Pick<AddCustomerResult, "pendingProjectClones" | "appliedFingerprint">;
}

// A converge that left a project checkout absent has NOT reached desired state, so its real
// fingerprint must not be recorded — that would mark the customer clean and strand the
// checkout until unrelated drift. It records the pending-clone MARKER instead: still stale
// against every real fingerprint, so the loop keeps converging, but recognizably so — the
// retry re-runs only the checkout, never the full attach with its config write and coach
// restart.
//
// It THROWS rather than returning, and that is load-bearing. reconcile-loop fires
// onEnsureSuccess on a normal return, which clears gateways/{id}.lastError — erasing the very
// error an operator needs to see. Throwing routes it to onEnsureError instead, where it
// persists until a later converge lands the clone and clears it naturally.
export function settleConvergence(input: SettleConvergenceInput, hooks: ConvergenceHooks): void {
  const { now, slug, desiredFingerprint, prior, result } = input;
  const settledFingerprint = result.appliedFingerprint ?? desiredFingerprint;
  if (result.pendingProjectClones.length === 0) {
    hooks.forgetRetry(slug);
    hooks.recordApplied(slug, settledFingerprint);
    return;
  }
  const attempts = (prior?.attempts ?? 0) + 1;
  hooks.recordApplied(slug, pendingCloneAppliedFingerprint(settledFingerprint));
  hooks.rememberRetry(slug, {
    attempts,
    nextAt: now + cloneRetryDelayMs(attempts),
    fingerprint: desiredFingerprint ?? "",
  });
  throw new Error(
    `project checkout still absent after ${attempts} converge(s): ${result.pendingProjectClones.join(", ")}`,
  );
}

export interface FinalizeConvergedMountInput extends SettleConvergenceInput {
  uid: string;
  hooks: ConvergenceHooks;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  writeMountMarker?: (slug: string) => void;
}

// The mount itself is complete once the attach returns — the coach is wired and verified —
// so it is stamped and marked BEFORE settleConvergence's pending-clone throw. Leaving the
// customer unmounted over an absent optional checkout would re-run the full attach on every
// retry instead of the checkout-only converge the pending-clone marker selects.
export async function finalizeConvergedMount(input: FinalizeConvergedMountInput): Promise<void> {
  const {
    uid,
    hooks,
    stampMounted,
    writeMountMarker,
    ...convergence
  } = input;
  await stampMounted(uid, true);
  writeMountMarker?.(input.slug);
  settleConvergence(convergence, hooks);
}

export const NEEDS_FULL_ATTACH_FINGERPRINT = "";

function requireFullAttachNextConverge(slug: string, hooks: ConvergenceHooks): void {
  hooks.forgetRetry(slug);
  hooks.recordApplied(slug, NEEDS_FULL_ATTACH_FINGERPRINT);
}

export async function ensureCustomerCheckoutsOnly(
  adapter: CustomerLifecycleAdapter,
  input: Omit<SettleConvergenceInput, "result">,
  hooks: ConvergenceHooks,
): Promise<EnsureOutcome> {
  const { pending } = await cloneMissingProjects(adapter, input.slug);
  if (pending.length === 0) {
    requireFullAttachNextConverge(input.slug, hooks);
    return "noop";
  }
  settleConvergence(
    { ...input, result: { pendingProjectClones: pending } },
    hooks,
  );
  return "noop";
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
  subscribeDesiredChanges?: (wake: () => void) => () => void;
  /** Content-convergence source: slug → fingerprint of the config-affecting snapshot
   *  slice (see snapshot-fingerprint.ts). When provided, it BOTH drives the desired
   *  roster (its keys) and lets the reconcile re-ensure an already-mounted customer whose
   *  fingerprint drifted — the level-triggered path a project-agent toggle rides. Takes
   *  precedence over readDesiredSlugs. */
  readDesiredFingerprints?: () => Promise<Map<string, string>>;
  /** Trusted-side mounted mirror writer used when the pod has no Firestore. */
  stampMounted?: (uid: string, mounted: boolean) => Promise<void>;
  readUserSnapshotForRuntimeReset?: (
    uid: string,
  ) => Promise<FleetBrokerUserSnapshot | null>;
  acknowledgeRuntimeReset?: (
    uid: string,
    operationId: string,
    generation: number,
  ) => Promise<void>;
  /** Trusted-side reconcile error mirror used when the pod has no Firestore. */
  recordReconcileError?: (slug: string, message: string) => Promise<void>;
  clearReconcileError?: (slug: string) => Promise<void>;
  openclawDir?: string;
  surgeOpenClawProcessGate?: SurgeOpenClawProcessSupervisorClient;
  internalServiceKey?: string;
  agentImportDoctorToken?: string;
  runAgentImportDoctor?: (candidate: unknown) => Promise<AgentImportDoctorResult>;
  flushLocalState?: (input: {
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
}

export async function consumeRecoveredCustomerRuntimeReset(input: {
  gatewayId: string;
  uid: string;
  slug: string;
  openclawDir: string;
  readSnapshot: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;
  acknowledge: (uid: string, operationId: string, generation: number) => Promise<void>;
  reset?: typeof resetRecoveredCustomerRuntime;
  log?: (message: string) => void;
}): Promise<RecoveredCustomerRuntimeResetResult | null> {
  const snapshot = await input.readSnapshot(input.uid);
  if (!snapshot) throw new Error(`[runtime-reset:${input.slug}] assigned user snapshot unavailable`);
  const marker = snapshot.runtimeReset;
  if (!marker) return null;
  const exact = [
    snapshot.uid === input.uid,
    snapshot.slug === input.slug,
    snapshot.gatewayId === input.gatewayId,
    marker.uid === input.uid,
    marker.slug === input.slug,
    marker.targetGatewayId === input.gatewayId,
  ].every(Boolean);
  if (!exact) throw new Error(`[runtime-reset:${input.slug}] recovery marker identity fence changed`);
  const result = (input.reset ?? resetRecoveredCustomerRuntime)({
    openclawDir: input.openclawDir,
    uid: input.uid,
    slug: input.slug,
    agentIds: snapshot.agentIds,
    log: input.log,
  });
  await input.acknowledge(input.uid, marker.operationId, marker.generation);
  input.log?.(
    `[runtime-reset:${input.slug}] acknowledged ${marker.operationId} generation ${marker.generation}`,
  );
  return result;
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
    | "isBuilderGateway"
    | "isConfiguredBuilderCustomer"
    | "configuredBuilderOverlayPresent"
    | "customerMountMarked"
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
    if (slug && assignedCustomerLooksMounted(adapter, slug)) mounted.add(slug);
  }
  return [...mounted].sort((a, b) => a.localeCompare(b));
}

type MountObservationAdapter = Parameters<typeof readMountedCustomersFromAssignedState>[2];

function configuredBuilderLooksMounted(adapter: MountObservationAdapter, slug: string): boolean {
  return adapter.isConfiguredBuilderCustomer?.(slug) === true
    && adapter.configuredBuilderOverlayPresent?.(slug) === true
    && adapter.customerMountMarked?.(slug) === true;
}

function sharedCoachLooksWired(adapter: MountObservationAdapter, slug: string): boolean {
  return !adapter.customerCoachWiredInOpenclawConfig
    || adapter.customerCoachWiredInOpenclawConfig(slug);
}

function assignedCustomerLooksMounted(adapter: MountObservationAdapter, slug: string): boolean {
  if (!adapter.hasCustomerDir(slug)) return false;
  const classGate = adapter.isBuilderGateway?.()
    ? configuredBuilderLooksMounted(adapter, slug)
    : sharedCoachLooksWired(adapter, slug);
  return classGate && hasMountedRuntimeAndWorkspace(adapter, slug);
}

function hasMountedRuntimeAndWorkspace(
  adapter: Pick<
    CustomerLifecycleAdapter,
    | "isBuilderGateway"
    | "isConfiguredBuilderCustomer"
    | "configuredBuilderOverlayPresent"
    | "hasCustomerAgentRuntime"
    | "hasWorkspaceGitDir"
    | "hasGitRemote"
  >,
  slug: string,
): boolean {
  if (adapter.isBuilderGateway?.()) {
    return adapter.isConfiguredBuilderCustomer?.(slug) === true
      && adapter.configuredBuilderOverlayPresent?.(slug) === true
      && adapter.hasWorkspaceGitDir(slug)
      && adapter.hasGitRemote(slug);
  }
  return (
    (!adapter.hasCustomerAgentRuntime || adapter.hasCustomerAgentRuntime(slug))
    && adapter.hasWorkspaceGitDir(slug)
    && adapter.hasGitRemote(slug)
  );
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

// The kubelet probes this and cannot sign, and the fleet ingress policy admits
// every gateway pod on this port, so the probe body stays tenant-free: mounted
// slugs and the gatewayId (which names its Builder) belong to the signed
// buildFleetStateResponse below.
export function buildFleetHealthResponse(input: {
  status: FleetRuntime["status"];
  podUid: string | null;
  startedAt: number;
}): FleetHealthResponse {
  return {
    status: input.status,
    podUid: input.podUid,
    startedAt: input.startedAt,
  };
}

export function buildFleetStateResponse(input: {
  status: FleetRuntime["status"];
  gatewayId: string;
  podUid: string | null;
  version: string;
  openclawVersion: string;
  startedAt: number;
  customers: string[];
  migratingIn: string[];
}): FleetStateResponse {
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

interface ProvisioningCounter {
  beginProvisioning: () => void;
  finishProvisioning: () => void;
}

interface ProvisioningWorkLease {
  onWorkSettled: (settled: Promise<void>) => void;
  finishNow: () => void;
  finishAfterWorkSettles: () => Promise<void>;
}

function beginProvisioningWork(runtime: ProvisioningCounter): ProvisioningWorkLease {
  runtime.beginProvisioning();
  let released = false;
  let workSettled: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    runtime.finishProvisioning();
  };
  return {
    onWorkSettled: (settled) => {
      workSettled = settled.then(
        () => undefined,
        () => undefined,
      );
    },
    finishNow: release,
    finishAfterWorkSettles: () => {
      if (releasePromise) return releasePromise;
      releasePromise = workSettled
        ? workSettled.then(release, release)
        : Promise.resolve().then(release);
      return releasePromise;
    },
  };
}

export async function runProvisioningWork<T>(input: {
  provisioning: ProvisioningCounter;
  work: (onWorkSettled: (settled: Promise<void>) => void) => Promise<T>;
  onDeferredReleaseError?: (error: unknown) => void;
}): Promise<T> {
  const lease = beginProvisioningWork(input.provisioning);
  try {
    const result = await input.work(lease.onWorkSettled);
    lease.finishNow();
    return result;
  } catch (error) {
    const release = lease.finishAfterWorkSettles();
    void release.catch((releaseError) => input.onDeferredReleaseError?.(releaseError));
    throw error;
  }
}

interface FleetRuntime extends ProvisioningCounter {
  activeProvisioning: number;
  mountedCustomers: string[];
  status: "booting" | "ready";
  waitForProvisioningDrain: () => Promise<void>;
}

function createFleetRuntime(): FleetRuntime {
  const drainWaiters = new Set<() => void>();
  const runtime: FleetRuntime = {
    activeProvisioning: 0,
    mountedCustomers: [],
    status: "booting",
    beginProvisioning: () => {
      runtime.activeProvisioning += 1;
    },
    finishProvisioning: () => {
      runtime.activeProvisioning -= 1;
      if (runtime.activeProvisioning !== 0) return;
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    },
    waitForProvisioningDrain: () => {
      if (runtime.activeProvisioning === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
  };
  return runtime;
}

// Only openclaw writes an agent's auth-profile store, and it can refuse the
// apply at both of the one-shot moments — the gateway-ready sweep and the
// mount's own retry — leaving the catalog in place but the broker profile
// unwritten, so the agent's first turn fails on credentials instead of on an
// unknown model. So this is level-triggered: retried on a timer until every
// rostered coach has its profile, rather than fired at two hopeful moments.
const BROKER_PROFILE_RETRY_INTERVAL_MS = 20 * 1000;

/** Last deferral set reported, so a steady state stays quiet — this runs on a
 *  timer and must not reprint the same warning forever. */
let lastDeferredSignature: string | null = null;
let brokerProfileSnapshotReloadPending = false;
let lastBrokerProfileSnapshotReloadError: string | null = null;
let brokerProfileSweepInFlight: Promise<BrokerProfileReadiness> | null = null;

/** Test seam only — the memo above is module state, so a spec exercising the
 *  quiet-once-settled behaviour must be able to start from a known point. */
export function _resetBrokerProfileLogStateForTests(): void {
  lastDeferredSignature = null;
  brokerProfileSnapshotReloadPending = false;
  lastBrokerProfileSnapshotReloadError = null;
  brokerProfileSweepInFlight = null;
}

type BrokerProfileSweep = Awaited<ReturnType<typeof materializeBrokerProfilesForAgents>>;

export interface BrokerProfileReadiness {
  settled: boolean;
  deferred: string[];
  reason?: string;
  skipped?: boolean;
}

function readBrokerProfileAgentIds(
  log: (msg: string) => void,
  readConfig: () => unknown,
): string[] | null {
  try {
    return agentIdsFromConfig(readConfig());
  } catch (error) {
    log(`⚠ [agent-model-token] post-boot sweep skipped — config unreadable: ${String(error)}`);
    return null;
  }
}

function brokerProfileSweepOptions(
  deps: {
    agentsDir?: string;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
  },
  log: (msg: string) => void,
): BrokerProfileSweepOptions {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const openAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  return {
    logFn: log,
    ...(deps.agentsDir ? { agentsDir: deps.agentsDir } : {}),
    ...(deps.secretsApply ? { secretsApply: deps.secretsApply } : {}),
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(openAiBaseUrl ? { openAi: openAiCatalogInputForBaseUrl(openAiBaseUrl) } : {}),
  };
}

async function reloadBrokerProfileSnapshot(
  log: (msg: string) => void,
  secretsReload: Pick<GatewayRpcClient, "secretsReload"> | undefined,
): Promise<void> {
  if (!brokerProfileSnapshotReloadPending || !secretsReload) return;
  try {
    const result = await secretsReload.secretsReload();
    const warningCount = result.warningCount ?? 0;
    if (result.ok !== true || warningCount > 0) {
      throw new Error(`secrets.reload returned ok=${String(result.ok)} warnings=${warningCount}`);
    }
    brokerProfileSnapshotReloadPending = false;
    lastBrokerProfileSnapshotReloadError = null;
    log("[agent-model-token] active secret snapshot reloaded after broker profile materialization");
  } catch (error) {
    const message = String(error);
    if (message === lastBrokerProfileSnapshotReloadError) return;
    log(
      `[agent-model-token] ⚠ active secret snapshot reload deferred — ${message}; retrying every ${
        BROKER_PROFILE_RETRY_INTERVAL_MS / 1000
      }s`,
    );
    lastBrokerProfileSnapshotReloadError = message;
  }
}

function reportBrokerProfileSweep(log: (msg: string) => void, sweep: BrokerProfileSweep): void {
  const signature = sweep.deferred.join(",");
  if (signature === lastDeferredSignature) return;
  if (sweep.deferred.length > 0) {
    log(
      `[agent-model-token] broker profile still deferred for ${sweep.deferred.join(", ")}` +
        ` — ${sweep.deferralReason ?? "openclaw refused the secrets apply"}; retrying every ${
          BROKER_PROFILE_RETRY_INTERVAL_MS / 1000
        }s`,
    );
  } else if (lastDeferredSignature !== null) {
    log("[agent-model-token] broker profiles settled — every rostered coach has its profile");
  }
  lastDeferredSignature = signature;
}

/** Hand openclaw the broker profiles earlier passes could only defer. Idempotent
 *  — a profile already applied spawns nothing, so this is safe on every tick. */
async function runDeferredBrokerProfileSweep(
  log: (msg: string) => void,
  deps: {
    agentsDir?: string;
    readConfig?: () => unknown;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
    secretsReload?: Pick<GatewayRpcClient, "secretsReload">;
  } = {},
): Promise<BrokerProfileReadiness> {
  const agentIds = readBrokerProfileAgentIds(log, deps.readConfig ?? readOpenClawConfig);
  if (!agentIds) {
    return { settled: false, deferred: [], reason: "config unreadable" };
  }
  const sweep = await materializeBrokerProfilesForAgents(
    agentIds,
    brokerProfileSweepOptions(deps, log),
  );
  if (sweep.materialized > 0) {
    log(`[agent-model-token] post-boot sweep materialized ${sweep.materialized} agent(s)`);
    if (deps.secretsReload) brokerProfileSnapshotReloadPending = true;
  }
  await reloadBrokerProfileSnapshot(log, deps.secretsReload);
  reportBrokerProfileSweep(log, sweep);
  const reloadSettled = !brokerProfileSnapshotReloadPending;
  let reason: string | undefined;
  if (sweep.deferralReason) reason = sweep.deferralReason;
  else if (!reloadSettled) reason = "active secret snapshot reload deferred";
  return {
    settled: sweep.deferred.length === 0 && reloadSettled,
    deferred: sweep.deferred,
    ...(reason ? { reason } : {}),
  };
}

export function materializeDeferredBrokerProfiles(
  log: (msg: string) => void,
  deps: {
    agentsDir?: string;
    readConfig?: () => unknown;
    secretsApply?: BrokerProfileSweepOptions["secretsApply"];
    secretsReload?: Pick<GatewayRpcClient, "secretsReload">;
  } = {},
): Promise<BrokerProfileReadiness> {
  if (brokerProfileSweepInFlight) return brokerProfileSweepInFlight;
  const sweep = openClawRuntimeUpdateGuard.tryRun(() => runDeferredBrokerProfileSweep(log, deps));
  if (!sweep) return Promise.resolve({
    settled: false, deferred: [], skipped: true, reason: "account import is updating the runtime",
  });
  const shared = sweep.finally(() => {
    if (brokerProfileSweepInFlight === shared) brokerProfileSweepInFlight = null;
  });
  brokerProfileSweepInFlight = shared;
  return shared;
}

export async function waitForBrokerProfilesSettled(input: {
  sweep: () => Promise<BrokerProfileReadiness>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (true) {
    if ((await input.sweep()).settled) return;
    await sleep(1_000);
  }
}

/** The level-triggered half of broker-profile materialization: retried until
 *  openclaw has accepted every rostered coach's profiles. Null on gateways that
 *  do not provision — they mount no customers, so there is nothing to converge. */
function startBrokerProfileRetry(
  provisions: boolean,
  log: (msg: string) => void,
  secretsReload: Pick<GatewayRpcClient, "secretsReload">,
  onReadiness?: (readiness: BrokerProfileReadiness) => void,
): NodeJS.Timeout | null {
  if (!provisions) return null;
  let sweepInFlight = false;
  const sweep = () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void materializeDeferredBrokerProfiles(log, { secretsReload })
      .then((readiness) => { if (!readiness.skipped) onReadiness?.(readiness); })
      .catch((error) => {
        const reason = String(error);
        onReadiness?.({ settled: false, deferred: [], reason });
        log(`⚠ [agent-model-token] sweep failed: ${reason}`);
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };
  sweep();
  return setInterval(sweep, BROKER_PROFILE_RETRY_INTERVAL_MS);
}

function startBrokerTokenRefreshAfterGatewayReady(
  rpc: Pick<GatewayRpcClient, "secretsReload">,
  openclawDir: string,
  whenReady: Promise<void>,
  log: (message: string) => void,
): () => void {
  const scheduler = createBrokerTokenRefreshScheduler({ rpc, openclawDir, log });
  void whenReady
    .then(() => scheduler.start())
    .catch((error) => log(`[agent-model-token] ⚠ refresh scheduler did not start: ${String(error)}`));
  return () => scheduler.stop();
}

export async function probeOpenClawRuntimeReady(
  probeHealthz: () => Promise<boolean>,
  identitiesReady: () => boolean = workspaceIdentityReady,
): Promise<boolean> {
  return await probeHealthz() && identitiesReady();
}

export async function waitForOpenClawHealthz(input: {
  probeHealthz: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}): Promise<void> {
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = input.timeoutMs === undefined ? null : now() + input.timeoutMs;
  while (true) {
    if (await input.probeHealthz()) return;
    if (deadline !== null && now() >= deadline) {
      throw new Error(`OpenClaw healthz did not answer within ${input.timeoutMs}ms`);
    }
    await sleep(1_000);
  }
}

export function dashboardBridgeReady(input: {
  required: boolean;
  openclawDir: string;
  gatewayId: string;
  now?: () => number;
}): { ready: boolean; state: "ready" | "missing" | "stale" | "invalid" | "not-required" } {
  if (!input.required) return { ready: true, state: "not-required" };
  const dashboard = observeDashboardControl(
    input.openclawDir,
    input.gatewayId,
    (input.now ?? Date.now)(),
  );
  const state = dashboard.dashboardControlState ?? "invalid";
  return {
    ready: state === "ready",
    state,
  };
}

export async function waitForDashboardBridgeReady(input: {
  required: boolean;
  openclawDir: string;
  gatewayId: string;
  log: (message: string) => void;
  probe?: () => { ready: boolean; state: string };
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.required) return;
  const sleep = input.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probe = input.probe ?? (() => dashboardBridgeReady(input));
  let lastState: string | null = null;
  while (true) {
    const result = probe();
    if (result.ready) return;
    if (result.state !== lastState) {
      lastState = result.state;
      input.log(`[fleet] waiting for Dashboard bridge capability handshake (state=${result.state})`);
    }
    await sleep(500);
  }
}

export async function probeSurgeReadiness(input: {
  runtimeStatus: FleetRuntime["status"];
  handoffReleased: boolean;
  provisioning?: boolean;
  processSettled?: boolean;
  probeHealthz: () => Promise<boolean>;
  brokerProfilesSettled?: boolean;
  dashboardBridgeReady?: boolean;
}): Promise<{
  ready: boolean;
  openclawUp: boolean;
  brokerProfilesSettled: boolean;
  dashboardBridgeReady: boolean;
}> {
  const brokerProfilesSettled = input.brokerProfilesSettled ?? true;
  const dashboardBridgeReady = input.dashboardBridgeReady ?? true;
  if (input.processSettled === false) {
    return { ready: false, openclawUp: false, brokerProfilesSettled, dashboardBridgeReady };
  }
  const openclawUp = input.runtimeStatus === "ready" && input.provisioning !== true
    ? await input.probeHealthz()
    : input.runtimeStatus === "ready";
  return {
    ready: input.handoffReleased && openclawUp && brokerProfilesSettled && dashboardBridgeReady,
    openclawUp,
    brokerProfilesSettled,
    dashboardBridgeReady,
  };
}

interface FleetReadinessInput {
  runtime: FleetRuntime;
  probeHealthz: () => Promise<boolean>;
  brokerProfilesSettled: () => boolean;
  dashboardBridgeReady: () => boolean;
}

async function probeFleetReadiness(
  input: FleetReadinessInput,
  handoffReleased: boolean,
  processSettled: boolean,
) {
  return probeSurgeReadiness({
    runtimeStatus: input.runtime.status,
    handoffReleased,
    provisioning: input.runtime.activeProvisioning > 0,
    processSettled,
    probeHealthz: input.probeHealthz,
    brokerProfilesSettled: input.brokerProfilesSettled(),
    dashboardBridgeReady: input.dashboardBridgeReady(),
  });
}

function createSurgeReadinessHandler(input: {
  surgeReadiness: SurgeReadinessGate;
  readiness: FleetReadinessInput;
  prelaunchState?: () => Promise<BuilderPrelaunchState>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const handoffReleased = await input.surgeReadiness.released();
      const prelaunchState = input.prelaunchState
        ? await input.prelaunchState()
        : "none";
      const processSettled = prelaunchState === "none" || prelaunchState === "serving";
      const readiness = await probeFleetReadiness(input.readiness, handoffReleased, processSettled);
      res.status(readiness.ready ? 200 : 503).json({
        ...readiness,
        runtimeStatus: input.readiness.runtime.status,
        handoffReleased,
        prelaunchState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[surge-handoff] readiness probe failed: ${message}`);
      res.status(500).json({ ready: false, error: message });
    }
  };
}

function createStartupReadinessHandler(input: {
  readiness: FleetReadinessInput;
  prelaunchState?: () => Promise<BuilderPrelaunchState>;
  log: (message: string) => void;
}): express.RequestHandler {
  return async (_req, res) => {
    try {
      const prelaunchState = input.prelaunchState
        ? await input.prelaunchState()
        : "none";
      const processSettled = prelaunchState === "none" || prelaunchState === "serving";
      const readiness = await probeFleetReadiness(input.readiness, true, processSettled);
      res.status(readiness.ready ? 200 : 503).json({
        ...readiness,
        runtimeStatus: input.readiness.runtime.status,
        prelaunchState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[fleet] startup readiness probe failed: ${message}`);
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
  return dirs
    .filter((slug) => {
      if (migratingIn?.(slug)) return false;
      return !(
        adapter.isBuilderGateway?.() &&
        adapter.isConfiguredBuilderCustomer?.(slug)
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

export function getMountObservedSlugs(adapter: CustomerLifecycleAdapter): string[] {
  const locallyAdmitted = adapter.listLocalCustomerSlugs?.() ?? [];
  const marked = adapter.customerMountMarked;
  return locallyAdmitted
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

function configuredBuilderOverlayIsOwned(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): boolean {
  return adapter.isBuilderGateway?.() === true &&
    adapter.isConfiguredBuilderCustomer?.(slug) === true;
}

function retainConfiguredBuilderOverlay(input: EvictLocalCustomerInput): UnmountOutcome {
  const { adapter, slug } = input;
  if (!adapter.configuredBuilderOverlayPresent?.(slug)) {
    throw new Error(`[evict:${slug}] configured Builder system-config overlay is unavailable`);
  }
  adapter.clearMountMarker?.(slug);
  adapter.clearCustomerMigratingIn?.(slug);
  adapter.onUnmounted?.(slug);
  return retainLocalCustomer(input);
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
  if (configuredBuilderOverlayIsOwned(input.adapter, input.slug)) {
    return retainConfiguredBuilderOverlay(input);
  }
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

function createReconcileUnmountSlug(input: {
  runtime: FleetRuntime;
  canReconcile?: () => Promise<boolean>;
  readDesired: () => Promise<string[]>;
  cancelPendingEviction: (slug: string) => void;
  wrappedAdapter: CustomerLifecycleAdapter;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  invalidateConfigRemovedSlug: (slug: string) => void;
  onLocalStateRemoved: (slug: string) => void;
}): (slug: string, evictionBatch: readonly string[]) => Promise<UnmountOutcome> {
  return async (slug, evictionBatch) => {
    input.runtime.beginProvisioning();
    try {
      if (input.canReconcile && !(await input.canReconcile())) return "noop";
      return await evictLocalCustomerIfStillUndesired({
        slug,
        evictionBatch,
        readDesired: input.readDesired,
        cancelPendingEviction: input.cancelPendingEviction,
        evict: (currentEvictionBatch, readCurrentEvictionBatch) => evictLocalCustomer({
          adapter: input.wrappedAdapter,
          slug,
          evictionBatch: currentEvictionBatch,
          currentEvictionBatch: readCurrentEvictionBatch,
          onRetainedAfterConfigRemoval: input.invalidateConfigRemovedSlug,
          stampMounted: input.stampMounted,
          onLocalStateRemoved: input.onLocalStateRemoved,
        }),
      });
    } finally {
      input.runtime.finishProvisioning();
    }
  };
}

function createReconcileConvergenceHooks(input: {
  fingerprintSource: StartFleetOptions["readDesiredFingerprints"];
  appliedFp: Map<string, string>;
  cloneRetry: Map<string, CloneRetryState>;
  persistAppliedFp: () => void;
}): ConvergenceHooks {
  const recordApplied = (slug: string, fingerprint: string | undefined): void => {
    if (!input.fingerprintSource || fingerprint === undefined) return;
    input.appliedFp.set(slug, fingerprint);
    input.persistAppliedFp();
  };
  const rememberRetry = (slug: string, state: CloneRetryState): void => {
    input.cloneRetry.set(slug, state);
  };
  const forgetRetry = (slug: string): void => {
    input.cloneRetry.delete(slug);
  };
  return { recordApplied, rememberRetry, forgetRetry };
}

function assignedRosterReader(
  opts: Pick<StartFleetOptions, "gatewayId" | "readDesiredFingerprints" | "readDesiredSlugs" | "db">,
): (() => Promise<string[]>) | null {
  const fingerprints = opts.readDesiredFingerprints;
  if (fingerprints) return async () => [...(await fingerprints()).keys()];
  if (opts.readDesiredSlugs) return opts.readDesiredSlugs;
  const db = opts.db;
  return db ? () => readAssignedSlugsForGateway(db, opts.gatewayId) : null;
}

export function createVerifyAttachPending(input: {
  provision: boolean;
  opts: Pick<StartFleetOptions, "gatewayId" | "readDesiredFingerprints" | "readDesiredSlugs" | "db">;
}): ((slug: string) => Promise<boolean>) | undefined {
  const readAssigned = input.provision ? assignedRosterReader(input.opts) : null;
  if (!readAssigned) return undefined;
  return (slug) => customerAttachPending(slug, async () => (await readAssigned()).includes(slug));
}

function createDesiredRosterReader(input: {
  opts: StartFleetOptions;
  fingerprintSource: StartFleetOptions["readDesiredFingerprints"];
  desiredFingerprints: Map<string, string>;
  setEnsureFingerprint: (fingerprint: string) => void;
}): (() => Promise<string[]>) | null {
  const fingerprintSource = input.fingerprintSource;
  if (fingerprintSource) {
    return async () => {
      const next = await fingerprintSource();
      input.desiredFingerprints.clear();
      for (const [slug, fingerprint] of next) {
        input.desiredFingerprints.set(slug, fingerprint);
      }
      input.setEnsureFingerprint(desiredEnsureLaneFingerprint(next));
      return [...next.keys()];
    };
  }
  const readDesiredSlugs = input.opts.readDesiredSlugs;
  if (readDesiredSlugs) {
    return async () => {
      const slugs = await readDesiredSlugs();
      input.setEnsureFingerprint(desiredEnsureLaneRosterFingerprint(slugs));
      return slugs;
    };
  }
  const db = input.opts.db;
  if (!db) return null;
  return async () => {
    const slugs = await readAssignedSlugsForGateway(db, input.opts.gatewayId);
    input.setEnsureFingerprint(desiredEnsureLaneRosterFingerprint(slugs));
    return slugs;
  };
}

function startMaybeReconcileLoop(params: {
  provision: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
  surgeReadiness: SurgeReadinessGate;
  canReconcile?: () => Promise<boolean>;
}): () => void {
  const {
    provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted,
    surgeReadiness,
    canReconcile,
  } = params;

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

  const readDesired = createDesiredRosterReader({
    opts,
    fingerprintSource,
    desiredFingerprints: desiredFp,
    setEnsureFingerprint: (fingerprint) => {
      desiredEnsureFingerprint = fingerprint;
    },
  });
  if (!provision || !readDesired) return () => undefined;

  const getContentStale = fingerprintSource
    ? (): string[] =>
        selectStableContentStale(
          getMountObservedSlugs(wrappedAdapter),
          desiredFp,
          appliedFp,
          pendingContentFp,
        )
    : undefined;
  const convergenceHooks = createReconcileConvergenceHooks(
    { fingerprintSource, appliedFp, cloneRetry, persistAppliedFp },
  );
  const start = () => startReconcileLoop({
    gatewayId: opts.gatewayId,
    intervalMs: opts.subscribeDesiredChanges ? 60_000 : RECONCILE_LOOP_INTERVAL_MS,
    subscribe: opts.subscribeDesiredChanges,
    maxConcurrent: MOUNT_CONCURRENCY,
    log: opts.log,
    getMountObserved: () => {
      const mounted = getMountObservedSlugs(wrappedAdapter);
      runtime.mountedCustomers = mounted;
      return mounted;
    },
    getEvictObserved: () => getEvictObservedSlugs(wrappedAdapter),
    ...(getContentStale ? { getContentStale } : {}),
    ...(canReconcile ? { canReconcile } : {}),
    readDesired,
    shouldEnsureSlug: (slug) => customerEnsureRetryReady({
      cloneRetry: cloneRetry.get(slug),
      desiredFingerprint: desiredFp.get(slug),
      now: Date.now(),
      permanentConfigPatchRetry,
      desiredEnsureFingerprint,
    }),
    shouldDeferRemainingMounts: isPermanentConfigPatchFailure,
    onPendingEvictionCancelled: cancelPendingEviction,
    ensureSlug: async (
      slug: string,
      evictionBatch: readonly string[],
      pendingEvictions: () => readonly string[],
    ) => runProvisioningWork({
      provisioning: runtime,
      onDeferredReleaseError: (error) => {
        opts.log(
          `[reconcile] provisioning lease release failed for ${slug}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      },
      work: async (onWorkSettled) => {
        if (canReconcile && !(await canReconcile())) return "noop";
        wrappedAdapter.cancelPendingEviction?.(slug);
        const uid = await wrappedAdapter.uidForSlug(slug);
        if (!uid) throw new Error(`no user doc for assigned slug ${slug}`);
        if (opts.readUserSnapshotForRuntimeReset || opts.acknowledgeRuntimeReset) {
          if (!opts.readUserSnapshotForRuntimeReset || !opts.acknowledgeRuntimeReset) {
            throw new Error("recovered runtime reset requires both snapshot read and acknowledgement");
          }
          await consumeRecoveredCustomerRuntimeReset({
            gatewayId: opts.gatewayId,
            uid,
            slug,
            openclawDir: opts.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw"),
            readSnapshot: opts.readUserSnapshotForRuntimeReset,
            acknowledge: opts.acknowledgeRuntimeReset,
            log: opts.log,
          });
        }
        if (pendingCloneOnlyStale(appliedFp.get(slug), desiredFp.get(slug))) {
          return ensureCustomerCheckoutsOnly(
            wrappedAdapter,
            {
              now: Date.now(),
              slug,
              desiredFingerprint: desiredFp.get(slug),
              prior: cloneRetry.get(slug),
            },
            convergenceHooks,
          );
        }
        const readCurrentEvictionBatch = createCurrentEvictionBatchReader({
          readDesired,
          pendingEvictions,
          cancelPendingEviction,
        });
        const result = await addCustomerToGateway(
          wrappedAdapter,
          uid,
          {
            ...reconcileAddCustomerOptions(
              fingerprintSource !== undefined,
              evictionBatch,
              readCurrentEvictionBatch,
            ),
            onWorkSettled,
          },
        );
        await finalizeConvergedMount({
          now: Date.now(),
          slug,
          uid,
          desiredFingerprint: desiredFp.get(slug),
          prior: cloneRetry.get(slug),
          result,
          hooks: convergenceHooks,
          stampMounted,
          writeMountMarker: wrappedAdapter.writeMountMarker,
        });
        return result.newCustomer ? "mounted" : "noop";
      },
    }),
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
    unmountSlug: createReconcileUnmountSlug({
      runtime, canReconcile, readDesired, cancelPendingEviction, wrappedAdapter, stampMounted,
      invalidateConfigRemovedSlug, onLocalStateRemoved,
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
    deleteField: () => FieldValue.delete(),
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
  released?: () => Promise<boolean>;
  release?: (targetPodUid: string) => Promise<void>;
  reserved?: () => Promise<boolean>;
  log: (message: string) => void;
}): () => void {
  const ownPodUid = process.env.POD_UID?.trim() || null;
  if (!ownPodUid) {
    input.log("[surge-handoff] POD_UID is unset; pod-side readiness recovery is disabled");
    return () => undefined;
  }
  return startSurgeReadinessSelfRelease({
    released: input.released ?? input.surgeReadiness.released,
    observe: () => observeReadySibling({
      healthUrl: `http://${input.serviceName}.${input.namespace}.svc.cluster.local:${input.port}/health`,
      ownPodUid,
    }),
    release: () => input.release?.(ownPodUid) ?? input.surgeReadiness.release({ targetPodUid: ownPodUid }),
    ...(input.reserved ? { reserved: input.reserved } : {}),
    log: input.log,
  });
}

function configuredBuilderSlug(adapter: CustomerLifecycleAdapter): string | null {
  const slug = process.env.GATEWAY_BUILDER_SLUG?.trim();
  if (!slug || adapter.isBuilderGateway?.() !== true) return null;
  return adapter.isConfiguredBuilderCustomer?.(slug) === true &&
      adapter.configuredBuilderOverlayPresent?.(slug) === true
    ? slug
    : null;
}

export function createConfiguredBuilderAssignmentMatcher(
  opts: Pick<
    StartFleetOptions,
    "readDesiredFingerprints" | "readDesiredSlugs"
  >,
): (slug: string) => Promise<boolean> {
  const readDesiredFingerprints = opts.readDesiredFingerprints;
  if (readDesiredFingerprints) {
    return async (slug) => (await readDesiredFingerprints()).has(slug);
  }
  const readDesiredSlugs = opts.readDesiredSlugs;
  if (readDesiredSlugs) {
    return async (slug) => (await readDesiredSlugs()).includes(slug);
  }
  return async () => false;
}

export function createConfiguredBuilderReconcileAdmission(input: {
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null;
  hasServingAssignment: () => Promise<boolean>;
  log: (message: string) => void;
}): () => Promise<boolean> {
  let lastBlocked: string | null = null;
  return async () => {
    if (!input.processGate) return true;
    try {
      const state = await input.processGate.status();
      let blocked = `${state.role}/${state.mode}`;
      if (state.mode === "permitted") {
        if (await input.hasServingAssignment()) {
          lastBlocked = null;
          return true;
        }
        blocked = "awaiting canonical Builder assignment";
      }
      if (lastBlocked !== blocked) {
        input.log(`[surge-handoff] reconcile paused while configured Builder process gate is ${blocked}`);
        lastBlocked = blocked;
      }
      return false;
    } catch (error) {
      const blocked = `status error: ${error instanceof Error ? error.message : String(error)}`;
      if (lastBlocked !== blocked) {
        input.log(`[surge-handoff] reconcile paused while configured Builder process gate has ${blocked}`);
        lastBlocked = blocked;
      }
      return false;
    }
  };
}

function configuredBuilderMountProven(adapter: CustomerLifecycleAdapter): boolean {
  const slug = configuredBuilderSlug(adapter);
  return slug !== null && getMountObservedSlugs(adapter).includes(slug);
}

type BuilderPrelaunchState = "none" | "held" | "hydrated" | "starting" | "serving";

async function builderPrelaunchState(
  adapter: CustomerLifecycleAdapter,
  processGate: Pick<SurgeOpenClawProcessSupervisorClient, "status"> | null,
): Promise<BuilderPrelaunchState> {
  if (!processGate || configuredBuilderSlug(adapter) === null) return "none";
  const state = await processGate.status();
  if (state.mode === "held") {
    return state.role === "target" && configuredBuilderMountProven(adapter)
      ? "hydrated"
      : "held";
  }
  return state.phase === "running" ? "serving" : "starting";
}

// Pending project checkouts never block the mount (see finalizeConvergedMount):
// OpenClaw starts with the workspace and the reconcile loop converges the rest.
async function attachConfiguredBuilderBeforeOpenClaw(input: {
  adapter: CustomerLifecycleAdapter;
  log?: (message: string) => void;
  onWorkSettled?: (settled: Promise<void>) => void;
}): Promise<string> {
  const slug = configuredBuilderSlug(input.adapter);
  if (!slug) throw new Error("configured Builder overlay is unavailable for prelaunch attach");
  const uid = await input.adapter.uidForSlug(slug);
  if (!uid) throw new Error(`configured Builder user is unavailable for prelaunch attach: ${slug}`);
  const result = await addCustomerToGateway(input.adapter, uid, {
    convergeContent: true,
    deferRuntimeVerification: true,
    reclaimExistingSshKey: true,
    onWorkSettled: input.onWorkSettled,
  });
  if (result.pendingProjectClones.length > 0) {
    input.log?.(
      `[surge-handoff] configured Builder project checkouts still pending for ${slug}; ` +
      `the reconcile loop converges them: ${result.pendingProjectClones.join(", ")}`,
    );
  }
  input.adapter.writeMountMarker?.(slug);
  if (!input.adapter.customerMountMarked?.(slug) || !configuredBuilderMountProven(input.adapter)) {
    throw new Error(`configured Builder prelaunch mount proof failed for ${slug}`);
  }
  return slug;
}

// A healthy OpenClaw is what readiness proves; the coach's Mattermost account is
// observed and reported, but a slow or down chat backend never holds the
// Builder's own gateway hostage — the reconcile loop keeps verifying the channel.
async function verifyConfiguredBuilderAfterOpenClaw(input: {
  adapter: CustomerLifecycleAdapter;
  waitForGatewayReady: () => Promise<void>;
  log: (message: string) => void;
}): Promise<string> {
  const slug = configuredBuilderSlug(input.adapter);
  if (!slug || !configuredBuilderMountProven(input.adapter)) {
    throw new Error("configured Builder is not durably mounted after OpenClaw start");
  }
  await input.waitForGatewayReady();
  if (input.adapter.customerCoachWiredInOpenclawConfig?.(slug)) {
    const healthy = await input.adapter.waitForAccountHealthy({
      slug,
      timeoutMs: BUILDER_POST_START_ACCOUNT_TIMEOUT_MS,
    });
    if (!healthy) {
      input.log(
        `[surge-handoff] ⚠ configured Builder Mattermost coach is not healthy yet ` +
        `after OpenClaw start; the reconcile loop keeps verifying it: ${slug}`,
      );
    }
  }
  return slug;
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

// Every handler below proves a fleet-controller signature before it looks at the
// path's gatewayId (rejectMisaddressedGateway), so an unsigned caller cannot use
// the rejection to learn which gateway answers here.
function registerMigrationRoutes(
  app: express.Express,
  migrationDeps: MigrationHandlerDeps,
  processControlDeps: SurgeOpenClawProcessHandlerDeps,
): void {
  app.post("/restore/:gatewayId", createRestoreHandler(migrationDeps));
  app.post("/migration-progress/:gatewayId", createMigrationProgressHandler(migrationDeps));
  app.post("/resume/:gatewayId", createResumeHandler(migrationDeps));
  app.post("/scheduler/:gatewayId", createSchedulerMigrationHandler(migrationDeps));
  app.post("/scheduler-ready/:gatewayId", createSchedulerReadyHandler(migrationDeps));
  app.post("/quiesce/:gatewayId", createQuiesceHandler(migrationDeps));
  app.post("/flush/:gatewayId", createFlushHandler(migrationDeps));
  app.post("/verify/:gatewayId", createVerifyHandler(migrationDeps));
  app.post("/export-paths/:gatewayId", createExportPathsHandler(migrationDeps));
  app.post(
    "/export-activation-manifest/:gatewayId",
    createActivationManifestExportHandler(migrationDeps),
  );
  app.post("/prepare-import/:gatewayId", createPrepareImportHandler(migrationDeps));
  app.post("/activate-import/:gatewayId", createActivateImportHandler(migrationDeps));
  app.post("/prepare-rsync-import/:gatewayId", createPrepareRsyncImportHandler(migrationDeps));
  app.post("/push-rsync-state/:gatewayId", createPushRsyncStateHandler(migrationDeps));
  app.post("/finish-rsync-import/:gatewayId", createFinishRsyncImportHandler(migrationDeps));
  app.post("/abort-rsync-import/:gatewayId", createAbortRsyncImportHandler(migrationDeps));
  app.post(
    "/hold-surge-openclaw/:gatewayId",
    createHoldSurgeOpenClawHandler(processControlDeps),
  );
  app.post(
    "/resume-surge-openclaw/:gatewayId",
    createResumeSurgeOpenClawHandler(processControlDeps),
  );
  app.post(
    "/unreserve-surge-openclaw/:gatewayId",
    createUnreserveSurgeOpenClawHandler(processControlDeps),
  );
  app.post("/complete-surge-handoff/:gatewayId", createCompleteSurgeHandoffHandler(migrationDeps));
  app.post("/unmount/:gatewayId", createUnmountHandler(migrationDeps));
}

interface BuilderSurgeGateWiring {
  reserveSurgeTarget: (input: { migrationId: string; slug: string }) => Promise<void>;
  unreserveSurgeTarget: (input: {
    migrationId: string;
    slug: string;
    targetPodUid: string;
  }) => Promise<SurgeOpenClawProcessGateState>;
  selfReleaseReserved: () => Promise<boolean>;
  releaseSurgeReadiness: (input: { migrationId: string; targetPodUid: string }) => Promise<void>;
  selfRelease: (targetPodUid: string) => Promise<void>;
  selfReleaseLoopSettled: () => Promise<boolean>;
}

interface ActiveBuilderSurgeRelease {
  migrationId: string;
  targetPodUid: string;
  cancelled: boolean;
  promise: Promise<void> | null;
}

interface BuilderSurgeTargetRequest {
  migrationId: string;
  slug: string;
  targetPodUid: string;
}

type ConfiguredBuilderAttach = (input: {
  adapter: CustomerLifecycleAdapter;
  log?: (message: string) => void;
  onWorkSettled?: (settled: Promise<void>) => void;
}) => Promise<string>;

function requireOwnPodUid(purpose: string): string {
  const currentPodUid = process.env.POD_UID?.trim();
  if (!currentPodUid) throw new Error(`POD_UID is required to ${purpose}`);
  return currentPodUid;
}

async function returnToHoldAfterFailure(
  error: unknown,
  hold: () => Promise<unknown>,
  message: string,
): Promise<never> {
  try {
    await hold();
  } catch (holdError) {
    throw new AggregateError([error, holdError], message);
  }
  throw error;
}

function attachConfiguredBuilderWithProvisioning(input: {
  adapter: CustomerLifecycleAdapter;
  attachConfigured: ConfiguredBuilderAttach;
  log: (message: string) => void;
  provisioning: ProvisioningCounter;
}): Promise<string> {
  return runProvisioningWork({
    provisioning: input.provisioning,
    onDeferredReleaseError: (error) => {
      input.log(
        `[surge-handoff] configured Builder provisioning lease release failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    },
    work: (onWorkSettled) => input.attachConfigured({
      adapter: input.adapter,
      log: input.log,
      onWorkSettled,
    }),
  });
}

function throwIfBuilderSurgeReleaseCancelled(release: ActiveBuilderSurgeRelease): void {
  if (release.cancelled) throw new Error("configured Builder target release was cancelled");
}

function scheduleBuilderTargetHoldFinalization(input: {
  log: (message: string) => void;
  processGate: SurgeOpenClawProcessSupervisorClient;
  release: ActiveBuilderSurgeRelease;
  request: BuilderSurgeTargetRequest;
  runCancellation: <T>(work: () => Promise<T>) => Promise<T>;
  waitForActiveProvisioningDrain: () => Promise<void>;
}): void {
  void input.runCancellation(async () => {
    await input.waitForActiveProvisioningDrain();
    if (input.release.cancelled) return;
    await input.processGate.finalizeTargetCancellation(input.request);
  }).catch((error) => {
    input.log(
      `[surge-handoff] configured Builder target cancellation could not be finalized: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function releasedBuilderTargetMatches(
  state: SurgeOpenClawProcessGateState,
  request: BuilderSurgeTargetRequest,
): boolean {
  const terminal = state.terminalTarget;
  return terminal?.migrationId === request.migrationId && terminal.slug === request.slug &&
    terminal.targetPodUid === request.targetPodUid;
}

async function unreserveConfiguredBuilderTarget(input: {
  activeRelease: ActiveBuilderSurgeRelease | null;
  configuredBuilderAssigned: (slug: string) => Promise<boolean>;
  processGate: SurgeOpenClawProcessSupervisorClient;
  request: BuilderSurgeTargetRequest;
  waitForActiveProvisioningDrain: () => Promise<void>;
}): Promise<SurgeOpenClawProcessGateState> {
  const { activeRelease, processGate, request, waitForActiveProvisioningDrain } = input;
  const release = activeRelease?.migrationId === request.migrationId &&
    activeRelease.targetPodUid === request.targetPodUid
    ? activeRelease
    : null;
  if (release) release.cancelled = true;
  const state = await processGate.status();
  if (state.role === "normal") {
    if (!releasedBuilderTargetMatches(state, request)) return processGate.unreserve(request);
    if (await input.configuredBuilderAssigned(request.slug)) {
      throw new Error("cannot cancel a released Builder with a serving assignment");
    }
    await processGate.reholdReleasedTarget(request);
    await waitForActiveProvisioningDrain();
    return processGate.finalizeTargetCancellation(request);
  }
  if (
    state.role !== "target" ||
    state.migrationId !== request.migrationId ||
    state.slug !== request.slug ||
    state.targetPodUid !== request.targetPodUid
  ) {
    return processGate.unreserve(request);
  }
  const reheld = await processGate.rehold(request);
  await waitForActiveProvisioningDrain();
  if (reheld.phase !== "cancelling") return processGate.unreserve(request);
  return processGate.finalizeTargetCancellation(request);
}

async function selfReleaseConfiguredBuilder(input: {
  adapter: CustomerLifecycleAdapter;
  attachConfigured: ConfiguredBuilderAttach;
  configuredBuilderAssigned: (slug: string) => Promise<boolean>;
  log: (message: string) => void;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
  provisioning: ProvisioningCounter;
  surgeReadiness: SurgeReadinessGate;
  targetPodUid: string;
  waitForActiveProvisioningDrain: () => Promise<void>;
  waitForGatewayReady: () => Promise<void>;
}): Promise<void> {
  const {
    adapter,
    attachConfigured,
    configuredBuilderAssigned,
    log,
    processGate,
    provisioning,
    surgeReadiness,
    targetPodUid,
    waitForActiveProvisioningDrain,
    waitForGatewayReady,
  } = input;
  if (!processGate) {
    await surgeReadiness.release({ targetPodUid });
    return;
  }
  if (requireOwnPodUid("self-release the configured Builder") !== targetPodUid) {
    throw new Error("configured Builder self-release target pod UID mismatch");
  }
  const reservation = await processGate.status();
  if (reservation.role !== "normal") {
    throw new Error(
      `configured Builder pod is reserved by migration ${reservation.migrationId}; ` +
      "refusing self-release until its controller completes or rolls back",
    );
  }
  const slug = configuredBuilderSlug(adapter);
  if (!slug || !(await configuredBuilderAssigned(slug))) {
    throw new Error(
      `configured Builder assignment does not match this gateway: ${slug ?? "unknown"}`,
    );
  }
  await waitForActiveProvisioningDrain();
  try {
    await attachConfiguredBuilderWithProvisioning({ adapter, attachConfigured, log, provisioning });
    await waitForActiveProvisioningDrain();
    await processGate.permitNormal();
    await verifyConfiguredBuilderAfterOpenClaw({ adapter, waitForGatewayReady, log });
    await surgeReadiness.release({ targetPodUid });
  } catch (error) {
    await returnToHoldAfterFailure(
      error,
      () => processGate.holdNormal(),
      "configured Builder self-release failed and could not be returned to hold",
    );
  }
}

async function configuredBuilderSelfReleaseReserved(input: {
  adapter: CustomerLifecycleAdapter;
  configuredBuilderAssigned: (slug: string) => Promise<boolean>;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
}): Promise<boolean> {
  if (!input.processGate) return false;
  const state = await input.processGate.status();
  if (state.role !== "normal") return true;
  const slug = configuredBuilderSlug(input.adapter);
  return !slug || !(await input.configuredBuilderAssigned(slug));
}

interface BuilderSurgeGateWiringOptions {
  adapter: CustomerLifecycleAdapter;
  processGate: SurgeOpenClawProcessSupervisorClient | null;
  surgeReadiness: SurgeReadinessGate;
  waitForGatewayReady: () => Promise<void>;
  log: (message: string) => void;
  provisioning: ProvisioningCounter;
  waitForActiveProvisioningDrain?: () => Promise<void>;
  attachConfiguredBuilderBeforeOpenClaw?: ConfiguredBuilderAttach;
  configuredBuilderAssigned?: (slug: string) => Promise<boolean>;
}

export function createBuilderSurgeGateWiring(input: BuilderSurgeGateWiringOptions): BuilderSurgeGateWiring {
  const {
    adapter,
    processGate,
    surgeReadiness,
    waitForGatewayReady,
    log,
    provisioning,
    waitForActiveProvisioningDrain = async () => undefined,
    attachConfiguredBuilderBeforeOpenClaw: attachConfigured = attachConfiguredBuilderBeforeOpenClaw,
    configuredBuilderAssigned = async () => false,
  } = input;
  let activeRelease: ActiveBuilderSurgeRelease | null = null;
  let cancellationQueue = Promise.resolve();
  const runCancellation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = cancellationQueue.then(work, work);
    cancellationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const reholdAfterReleaseFailure = (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveBuilderSurgeRelease,
  ): Promise<void> => runCancellation(async () => {
    if (release.cancelled) return;
    const state = await processGate!.rehold(request);
    if (state.phase === "cancelling" && !release.cancelled) {
      scheduleBuilderTargetHoldFinalization({
        log,
        processGate: processGate!,
        release,
        request,
        runCancellation,
        waitForActiveProvisioningDrain,
      });
    }
  });
  const attachClaimedTargetWithProvisioning = (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveBuilderSurgeRelease,
  ): Promise<void> => runProvisioningWork({
    provisioning,
    onDeferredReleaseError: (error) => {
      log(
        `[surge-handoff] configured Builder completion lease release failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    },
    work: async (onWorkSettled) => {
      throwIfBuilderSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      throwIfBuilderSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      throwIfBuilderSurgeReleaseCancelled(release);
      await processGate!.claimTargetCompletion(request);
      const attachedSlug = await attachConfigured({ adapter, log, onWorkSettled });
      if (attachedSlug !== request.slug) {
        throw new Error(
          `configured Builder prelaunch attach returned ${attachedSlug}, expected ${request.slug}`,
        );
      }
    },
  });
  const releasePermittedTarget = async (
    request: { migrationId: string; slug: string; targetPodUid: string },
    release: ActiveBuilderSurgeRelease,
  ): Promise<void> => {
    throwIfBuilderSurgeReleaseCancelled(release);
    await verifyConfiguredBuilderAfterOpenClaw({ adapter, waitForGatewayReady, log });
    throwIfBuilderSurgeReleaseCancelled(release);
    await processGate!.releaseTarget(request);
  };
  const releaseSurgeReadinessOnce = async ({
    migrationId,
    targetPodUid,
    release,
  }: {
    migrationId: string;
    targetPodUid: string;
    release: ActiveBuilderSurgeRelease;
  }): Promise<void> => {
    const ownPodUid = process.env.POD_UID?.trim();
    if (ownPodUid && ownPodUid !== targetPodUid) {
      throw new Error(`target pod UID mismatch: expected ${ownPodUid}, received ${targetPodUid}`);
    }
    if (!processGate) {
      await surgeReadiness.release({ targetPodUid });
      return;
    }
    if (!ownPodUid) throw new Error("POD_UID is required to permit configured Builder OpenClaw");
    const slug = configuredBuilderSlug(adapter);
    if (!slug) throw new Error("configured Builder overlay is unavailable for surge release");
    const reservation = await processGate.status();
    if (
      reservation.role !== "target" ||
      reservation.migrationId !== migrationId ||
      reservation.slug !== slug ||
      reservation.targetPodUid !== targetPodUid
    ) {
      throw new Error("configured Builder target is not reserved by this migration");
    }
    const request = { migrationId, slug, targetPodUid };
    if (reservation.mode === "held") {
      await waitForActiveProvisioningDrain();
      try {
        await attachClaimedTargetWithProvisioning(request, release);
        await processGate.permit(request);
        await releasePermittedTarget(request, release);
      } catch (error) {
        await returnToHoldAfterFailure(
          error,
          () => reholdAfterReleaseFailure(request, release),
          "configured Builder target failed prelaunch attach and could not be returned to hold",
        );
      }
    } else if (reservation.mode !== "permitted") {
      throw new Error("configured Builder target has an invalid surge reservation mode");
    } else {
      try {
        await releasePermittedTarget(request, release);
      } catch (error) {
        await returnToHoldAfterFailure(
          error,
          () => reholdAfterReleaseFailure(request, release),
          "configured Builder target failed to release and could not be returned to hold",
        );
      }
    }
  };
  return {
    async reserveSurgeTarget({ migrationId, slug }) {
      if (!processGate || configuredBuilderSlug(adapter) !== slug) return;
      await processGate.hydrate({
        migrationId,
        slug,
        targetPodUid: requireOwnPodUid("reserve the configured Builder migration target"),
      });
      await waitForActiveProvisioningDrain();
    },
    async unreserveSurgeTarget(request) {
      if (!processGate) throw new Error("configured Builder OpenClaw process gate is unavailable");
      return runCancellation(() => unreserveConfiguredBuilderTarget({
        activeRelease, configuredBuilderAssigned,
        processGate,
        request,
        waitForActiveProvisioningDrain,
      }));
    },
    releaseSurgeReadiness(input) {
      if (activeRelease) {
        if (
          activeRelease.migrationId === input.migrationId &&
          activeRelease.targetPodUid === input.targetPodUid
        ) {
          return activeRelease.promise!;
        }
        return Promise.reject(new Error("configured Builder target already has a release in progress"));
      }
      const release: ActiveBuilderSurgeRelease = { ...input, cancelled: false, promise: null };
      activeRelease = release;
      const promise = releaseSurgeReadinessOnce({ ...input, release });
      release.promise = promise;
      void promise.then(
        () => {
          if (activeRelease === release) activeRelease = null;
        },
        () => {
          if (activeRelease === release) activeRelease = null;
        },
      );
      return promise;
    },
    async selfRelease(targetPodUid) {
      return selfReleaseConfiguredBuilder({
        adapter,
        attachConfigured,
        configuredBuilderAssigned,
        log,
        processGate,
        provisioning,
        surgeReadiness,
        targetPodUid,
        waitForActiveProvisioningDrain,
        waitForGatewayReady,
      });
    },
    async selfReleaseLoopSettled() {
      if (!(await surgeReadiness.released())) return false;
      if (!processGate) return true;
      return (await processGate.status()).mode === "permitted";
    },
    selfReleaseReserved: () => configuredBuilderSelfReleaseReserved({
      adapter, configuredBuilderAssigned, processGate,
    }),
  };
}

function createHeartbeatEmitter(input: {
  stateDeps: FleetStateDeps | null;
  opts: StartFleetOptions;
  runtime: FleetRuntime;
  internalUrl: string;
}): (status: HeartbeatSnapshot["status"]) => Promise<void> {
  const { stateDeps, opts, runtime, internalUrl } = input;
  return async (status) => {
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
}

// eslint-disable-next-line max-lines-per-function -- controller startup owns one ordered lifecycle for listeners, reconciliation, health, and shutdown.
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

  const runtime = createFleetRuntime();
  const openclawDir = opts.openclawDir ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  const surgeReadiness = createSurgeReadinessGate(openclawDir, process.env.POD_UID?.trim() || undefined);
  const wrappedAdapter = wrapAdapterWithRuntime(adapter, runtime);
  const builderProcessGate = adapter.isBuilderGateway?.() === true
    ? opts.surgeOpenClawProcessGate ?? createSurgeOpenClawProcessSupervisorClient(openclawDir)
    : null;
  const configuredBuilderAssigned = createConfiguredBuilderAssignmentMatcher(opts);
  const canReconcile = createConfiguredBuilderReconcileAdmission({
    processGate: builderProcessGate,
    hasServingAssignment: async () => {
      const slug = configuredBuilderSlug(wrappedAdapter);
      return slug !== null && await configuredBuilderAssigned(slug);
    },
    log: opts.log,
  });

  const namespace = resolveK8sNamespace();
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";
  const dashboardBridgeRequired = process.env.OPENCLAW_DASHBOARD_BRIDGE_REQUIRED === "true";
  let brokerProfilesSettled = !caps.provision;

const serviceName = gatewayServiceName({ gatewayId: opts.gatewayId });
  const internalUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${gatewayPort}`;

  const emitHeartbeat = createHeartbeatEmitter({ stateDeps, opts, runtime, internalUrl });

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

  const probeHealthz = () => probeOpenClawRuntimeReady(
    () => probeOpenClawHealth(`http://127.0.0.1:${gatewayPort}/healthz`),
  );
  const probeDashboardBridge = () => dashboardBridgeReady({
    required: dashboardBridgeRequired,
    openclawDir,
    gatewayId: opts.gatewayId,
  });
  const readiness: FleetReadinessInput = {
    runtime,
    probeHealthz,
    brokerProfilesSettled: () => brokerProfilesSettled,
    dashboardBridgeReady: () => probeDashboardBridge().ready,
  };
  const waitForOpenClawUp = async (timeoutMs?: number): Promise<void> => {
    await waitForOpenClawHealthz({ probeHealthz, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (caps.provision) {
      let lastSweepError: string | null = null;
      await waitForBrokerProfilesSettled({
        sweep: async () => {
          try {
            const profileReadiness = await materializeDeferredBrokerProfiles(opts.log, {
              secretsReload: opts.rpc,
            });
            brokerProfilesSettled = profileReadiness.settled;
            lastSweepError = null;
            return profileReadiness;
          } catch (error) {
            const reason = String(error);
            brokerProfilesSettled = false;
            if (reason !== lastSweepError) {
              opts.log(`⚠ [agent-model-token] startup sweep failed: ${reason}`);
              lastSweepError = reason;
            }
            return { settled: false, deferred: [], reason };
          }
        },
      });
    }
    await waitForDashboardBridgeReady({
      required: dashboardBridgeRequired,
      openclawDir,
      gatewayId: opts.gatewayId,
      log: opts.log,
      probe: probeDashboardBridge,
    });
    if (runtime.status === "ready") return;
    runtime.status = "ready";
    opts.log(
      `[fleet] OpenClaw healthz, workspace identities, broker profiles, and Dashboard bridge ready; ` +
        `transitioning gateways/${opts.gatewayId} to status=ready`,
    );
    await emitHeartbeat("ready");
  };
  const waitForGatewayReady = async (): Promise<void> => {
    if (runtime.status === "ready") return;
    await waitForOpenClawUp();
  };

  const app = express();
  app.disable("x-powered-by");
  app.use("/scheduler", express.json({
    limit: "9mb",
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }));
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
      podUid: process.env.POD_UID ?? null,
      startedAt: PROCESS_STARTED_AT_MS,
    }));
  });

  app.post(`${FLEET_STATE_PATH}/:gatewayId`, createFleetStateHandler({
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    log: opts.log,
    readState: () => buildFleetStateResponse({
      status: runtime.status,
      gatewayId: opts.gatewayId,
      podUid: process.env.POD_UID ?? null,
      version: opts.version,
      openclawVersion: opts.openclawVersion,
      startedAt: PROCESS_STARTED_AT_MS,
      customers: getMountObservedSlugs(adapter),
      migratingIn: adapter.listMigratingInSlugs?.() ?? [],
    }),
  }));

  app.get("/startup-ready", createStartupReadinessHandler({
    readiness,
    prelaunchState: () => builderPrelaunchState(wrappedAdapter, builderProcessGate),
    log: opts.log,
  }));

  app.get("/surge-ready", createSurgeReadinessHandler({
    surgeReadiness,
    readiness,
    prelaunchState: () => builderPrelaunchState(wrappedAdapter, builderProcessGate),
    log: opts.log,
  }));

  await seedRuntimeMountedCustomers({ opts, reportMounted: caps.reportMounted, wrappedAdapter, runtime });

  await emitHeartbeat("booting");

  const heartbeatTimer = caps.reportMounted
    ? setInterval(() => {
        void emitHeartbeat(runtime.status);
      }, GATEWAY_HEARTBEAT_INTERVAL_MS)
    : null;

  const brokerProfileTimer = startBrokerProfileRetry(
    caps.provision,
    opts.log,
    opts.rpc,
    (profileReadiness) => {
      brokerProfilesSettled = profileReadiness.settled;
    },
  );

  const surgeGate = createBuilderSurgeGateWiring({
    adapter: wrappedAdapter,
    processGate: builderProcessGate,
    surgeReadiness,
    waitForGatewayReady: () => waitForOpenClawUp(BUILDER_POST_START_HEALTH_TIMEOUT_MS),
    log: opts.log,
    provisioning: runtime,
    waitForActiveProvisioningDrain: runtime.waitForProvisioningDrain,
    configuredBuilderAssigned,
  });
  const migrationDeps = {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
    getMountedCustomers: () => runtime.mountedCustomers,
    customerAttachPending: createVerifyAttachPending({ provision: caps.provision, opts }),
    flushLocalState: opts.flushLocalState,
    reserveSurgeTarget: surgeGate.reserveSurgeTarget,
    releaseSurgeReadiness: surgeGate.releaseSurgeReadiness,
    unreserveSurgeTarget: surgeGate.unreserveSurgeTarget,
  };
  registerMigrationRoutes(app, migrationDeps, {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    configuredBuilder: (slug) => configuredBuilderSlug(wrappedAdapter) === slug,
    processGate: builderProcessGate ?? undefined,
    unreserveConfiguredBuilderTarget: surgeGate.unreserveSurgeTarget,
    waitForActiveProvisioningDrain: runtime.waitForProvisioningDrain,
    log: opts.log,
  });

  registerByosubDeviceAuth(app, opts);
  registerAgentImportDoctor(app, opts);

  const stopReconcileLoop = startMaybeReconcileLoop({
    provision: caps.provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted,
    surgeReadiness,
    canReconcile,
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
    released: surgeGate.selfReleaseLoopSettled,
    release: surgeGate.selfRelease,
    reserved: surgeGate.selfReleaseReserved,
    log: opts.log,
  });
  const whenReady = waitForGatewayReady();
  const stopBrokerTokenRefresh = startBrokerTokenRefreshAfterGatewayReady(
    opts.rpc,
    openclawDir,
    whenReady,
    opts.log,
  );
  let reconcileLoopStatus = "disabled";
  if (caps.provision) {
    reconcileLoopStatus = opts.subscribeDesiredChanges ? "push; repair=60000ms" : `${RECONCILE_LOOP_INTERVAL_MS}ms`;
  }
  opts.log(
    `[fleet] listening on 0.0.0.0:${boundPort}; gatewayId=${opts.gatewayId}; platformState=${platformState}; reportState=${reportState}; reconcile-loop=${reconcileLoopStatus}`,
  );

return {
    port: boundPort,
    whenReady,
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (brokerProfileTimer) clearInterval(brokerProfileTimer);
      stopBrokerTokenRefresh();
      stopSurgeSelfRelease();
      stopReconcileLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
