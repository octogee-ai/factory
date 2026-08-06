import type { AgentModelSelections } from "@octogee/shared/types/agent-models";
import type { CustomerSnapshot } from "@octogee/shared/types/fleet-controller";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectAgent,
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { ProjectRepoSource } from "@octogee/shared/types/project";
import type { MigrationActivationManifest } from "./migration-activation-manifest.js";
import {
  ADD_CUSTOMER_DEADLINE_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "@octogee/shared/types/fleet-controller";
import { pickPlanInputs } from "@octogee/shared/types/billing";

export interface UserSnapshot {
  uid: string;
  slug: string;
  tier: string;
  gatewayId: string;
  status: "" | "provisioning" | "complete";
  agentIds: string[];
  repoUrl: string;
  mattermostUserId: string | null;
  greetingPosted: boolean;
  channels: CustomerSnapshot["channels"];
  ownerName: string;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  projects?: FleetBrokerProjectRestore[];
  projectAgents?: FleetBrokerProjectAgent[];
  byotActive?: boolean;
  // Plan-resolution inputs (TierResolvable): resolveEffectivePlan on the gateway needs
  // these to grant signup-offer/paid access at mount-time reassert.
  selectedTier?: unknown;
  subscription?: unknown;
  builderSubscription?: unknown;
  trialGrant?: unknown;
  signupOfferConvertedAt?: unknown;
  // The operator's free-tier model dial, stamped by the fleet broker; drives
  // the house pin and the BYOK fallback baseline at mount-time reassert.
  freeTierModelRef?: string;
  // The operator's Builder Agent default dial: the {primary, fallbacks} a
  // catalog coach with no explicit pick converges to at mount-time reassert.
  builderAgentDefault?: { primary: string; fallbacks: string[] };
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    agentModels?: AgentModelSelections;
  };
}

export interface ProjectCloneTarget {
  projectSlug: string;
  giteaRepoName: string | null;
  repoSource?: ProjectRepoSource | null;
}

export interface ProjectCloneOptions {
  repoSource?: ProjectRepoSource | null;
}

export interface CustomerContext {
  uid: string;
  slug: string;
  tier: string;
  ownerName: string;
  customerDir: string;
  today: string;
  username: string;
  templateVars: Record<string, string>;
  userData: Record<string, unknown>;
}

export type MmUpdate = Record<string, unknown>;

export interface CustomerLifecycleAdapter {
  log: (msg: string) => void;

  isBuilderGateway?: () => boolean;

  /**
   * Read-only probe of the on-disk openclaw.json: is this customer's
   * coach fully wired (agent registered + MM account configured + at
   * least one binding linking the agent to the MM account)?
   * `applyAddCustomerConfigPatch` writes all three together — so a
   * state where only the agent is present means a prior config.patch
   * crashed mid-flight OR openclaw.json was hand-edited. The operator
   * short-circuit MUST NOT skip the full flow in either case, because
   * the agent will sit inert (no MM auth, no inbound routing) — which
   * is exactly what bender hit on 2026-05-26.
   */
  customerCoachWiredInOpenclawConfig?: (slug: string) => boolean;
  hasCustomerAgentRuntime?: (slug: string) => boolean;

  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;

  /** Locally-present, coach-wired customer slugs — the pod's honest mounted set
   *  read WITHOUT Firestore, served via /health for Cowboy's pull-model poller.
   *  Also the reconcile's heartbeat report + mount-observed basis. */
  listLocalCustomerSlugs?: () => string[];

  /** Raw on-disk customer dirs (no coach-wired filter) — the reconcile's evict-observed set,
   *  so a partial/junk dir from a mount that died before its config patch is still drained
   *  once unassigned. */
  listLocalCustomerDirs?: () => string[];

  /** True iff the slug's mount-completion marker is present — the LAST step a successful
   *  ensure writes, AFTER the customer is fully provisioned (not merely coach-wired). The
   *  reconcile's mount direction keys off this, so a coach-wired-but-incomplete mount
   *  (config patch landed, then greeting / mark-complete failed) is re-ensured rather than
   *  silently treated as done. */
  customerMountMarked?: (slug: string) => boolean;

  /** Stamp the mount-completion marker for the slug — the final step of a successful mount. */
  writeMountMarker?: (slug: string) => void;

  /** True iff the slug has a fresh migrating-in pin — a migration imported + coach-wired it
   *  here, but cutover hasn't yet made it desired-here. The reconcile's evict direction skips
   *  such slugs so it doesn't drain a freshly-imported customer mid-migration. */
  customerMigratingIn?: (slug: string) => boolean;

  /** Stamp the migrating-in pin (import handler, before activation). */
  markCustomerMigratingIn?: (slug: string) => void;

  listMigratingInSlugs?: () => string[];

  loadUserSnapshot: (uid: string) => Promise<UserSnapshot | null>;

  seedUserSnapshotForMigration?: (snapshot: FleetBrokerUserSnapshot) => void;

  setProvisioningStatus: (uid: string, status: "provisioning" | "complete") => Promise<void>;
  setRepoUrl: (uid: string, repoUrl: string) => Promise<void>;
  setMattermostFields: (uid: string, fields: MmUpdate) => Promise<void>;
  setGreetingResult: (
    uid: string,
    result: { ok: true; jobId: string } | { ok: false; error: string },
  ) => Promise<void>;
  setAgentIds: (uid: string, agentIds: string[]) => Promise<void>;

  hasCustomerDir: (slug: string) => boolean;
  hasWorkspaceGitDir: (slug: string) => boolean;
  hasGitRemote: (slug: string) => boolean;
  ensureCustomerDirectories: (slug: string) => void;
  writeCustomerTemplateFiles: (ctx: CustomerContext) => Promise<void>;
  deleteCustomerDir: (slug: string) => Promise<void>;

  cloneWorkspaceRepo: (slug: string, repoUrl: string) => Promise<boolean>;
  initWorkspaceRepoFromExistingDir: (ctx: CustomerContext) => Promise<string | null>;

  hasCustomerSshKey: (slug: string) => boolean;
  generateCustomerSshKey: (slug: string) => string;
  createGiteaUser: (slug: string, pubKey: string) => Promise<void>;

ensureGiteaOrg: (slug: string) => Promise<void>;

readLocalCustomerPubKey: (slug: string) => string | null;

readGiteaCustomerPubKeys: (slug: string) => Promise<string[]>;

deleteCustomerSshKey: (slug: string) => Promise<void>;

  blobSyncForSlug: (slug: string) => Promise<void>;

restoreByosubForAgent: (slug: string) => Promise<{ restored: boolean; present: boolean }>;

  // Re-assert the customer's byot/broker model auth (the Anthropic broker token, BYOT
  // key refs) into the openclaw config. Idempotent; runs at provision AND on fresh-pod
  // re-mount, so a cattle/emptyDir pod self-heals its LLM auth after a roll/preemption.
  // userData must carry byotActive + systemConfig.byot (hydrated into the mount snapshot).
  reassertByotForCustomer: (userData: Record<string, unknown>) => Promise<void>;

  // Re-assert the platform-managed context files (AGENTS.md/TOOLS.md) for house_only
  // plans — the same convergence semantics as reassertByotForCustomer: idempotent,
  // only-on-drift, runs at provision AND on fresh-pod re-mount. A no-op for any plan
  // with catalog model access (paid, or a live Signup Offer), including a customer who
  // WAS house_only and has since upgraded — that's how ownership returns to them.
  reassertConvergedContextFilesForCustomer: (userData: Record<string, unknown>) => Promise<void>;

  listProjectsNeedingClone: (slug: string) => Promise<ProjectCloneTarget[]>;
  cloneProjectRepo: (
    customerSlug: string,
    projectSlug: string,
    giteaRepoName: string | null,
    opts?: ProjectCloneOptions,
  ) => Promise<boolean>;

  provisionMattermostUser: (ctx: CustomerContext) => Promise<MmUpdate>;

  /**
   * Idempotently ensure this Builder is a member of the shared Octogee Community
   * team + chat channels. Optional — adapters that don't own Mattermost community
   * reconciliation (migration/local tooling) may omit it. Runs at provision AND on
   * every re-mount (gateway restart), so an existing Builder self-heals without a
   * fresh MM-provisioning event.
   */
  reconcileCommunityMembership?: (ctx: CustomerContext) => Promise<void>;
  scheduleBootGreetingCron: (params: {
    slug: string;
    agentId: string;
    accountId: string;
  }) => Promise<{ jobId: string }>;

  /**
   * Detached, non-blocking, non-fatal safety net for the boot greeting.
   * After the agent-greeting cron is scheduled, this waits a grace delay,
   * re-checks the coach DM channel, and posts a static greeting AS THE COACH
   * if the agent turn failed to land one (so the onboarding `agentPosted`
   * gate flips true). Optional so test/other adapters don't have to implement
   * it. Implementations MUST be fire-and-forget (resolve immediately, do the
   * work in the background) and MUST NOT throw — the orchestrator does not
   * await it. The prod adapter resolves coachUserId, channelId, and the coach
   * PAT from Firestore internally; the orchestrator only knows {slug, uid}.
   */
  ensureBootGreetingFallback?: (params: { slug: string; uid: string }) => void;

  applyAddCustomerConfigPatch: (
    snapshot: UserSnapshot,
    mmUpdate: MmUpdate | null,

opts?: {
  signal?: AbortSignal;
  byosActive?: boolean;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;
},
  ) => Promise<{ elapsedMs: number; appliedFingerprint?: string }>;
  applyRemoveCustomerConfigPatch: (
    slug: string,
    agentId: string,
    evictionBatch?: readonly string[],
    currentEvictionBatch?: () => Promise<readonly string[]>,
  ) => Promise<readonly string[] | void>;
  cancelPendingEviction?: (slug: string) => boolean | void;
  clearMountMarker?: (slug: string) => void;

  waitForAccountHealthy: (params: { slug: string; timeoutMs: number }) => Promise<boolean>;

  notifyOpsOfSignup: (ctx: CustomerContext) => Promise<void>;

  onMounted?: (slug: string) => void;
  onUnmounted?: (slug: string) => void;

uidForSlug: (slug: string) => Promise<string | null>;

quiesceCustomer: (
    slug: string,
    timeoutMs: number,
  ) => Promise<{ drained: boolean; runningCount: number }>;

listExportPaths: (slug: string) => Promise<Array<{ cwd: string; path: string }>>;

prepareImportDir: (slug: string, mode: CustomerStateImportMode) => Promise<string>;
prepareKeyImportDir: (slug: string) => Promise<string>;

  activateImportedCustomer: (
    slug: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ appliedFingerprint: string }>;
  recordAppliedFingerprint?: (slug: string, fingerprint: string) => void;

  exportOpenClawActivationManifest?: (slug: string) => Promise<MigrationActivationManifest>;

  removeImportedCustomerBySlug?: (
    slug: string,
    evictionBatch?: readonly string[],
    currentEvictionBatch?: () => Promise<readonly string[]>,
  ) => Promise<RemoveCustomerResult>;
}

export type CustomerStateImportMode = "pre" | "final" | "default";

export type AddCustomerStep =
  | "claim-slot"
  | "ensure-dir"
  | "write-templates"
  | "clone-workspace-repo"
  | "init-workspace-repo"
  | "ssh-key"
  | "ssh-key-resync"
  | "blob-sync"
  | "byosub-restore"
  | "byot-reassert"
  | "context-files-reassert"
  | "project-clone"
  | "mattermost-provision"
  | "community-membership"
  | "config-patch"
  | "verify-channel-ready"
  | "schedule-greeting-cron"
  | "mark-complete"
  | "notify-ops";

export interface AddCustomerResult {
  newCustomer: boolean;
  steps: AddCustomerStep[];
  appliedFingerprint?: string;
  // Active projects whose pod checkout is STILL absent after this converge. Non-empty means
  // the converge did not reach desired state, so the caller must not record its fingerprint
  // as applied: doing so marks the customer clean and strands the checkout — and with it the
  // project agent's whole workspace — until unrelated drift moves the fingerprint again.
  pendingProjectClones: string[];
}

export interface RestoreCustomerRuntimeResult {
  restored: boolean;
  steps: AddCustomerStep[];
}

export type RemoveCustomerStep =
  | "config-patch-remove"
  | "delete-dir";

export interface RemoveCustomerResult {
  wasMounted: boolean;
  steps: RemoveCustomerStep[];
  retained?: boolean;
}

const inFlightUids = new Set<string>();

export class ConcurrentMountError extends Error {
  override readonly name = "ConcurrentMountError";
  constructor(uid: string) {
    super(`[add:${uid}] another mount is already in-flight for this uid in this process`);
  }
}

export function _resetInFlightUidsForTests(): void {
  inFlightUids.clear();
}

export function _inFlightUidsHasForTests(uid: string): boolean {
  return inFlightUids.has(uid);
}

export interface AddCustomerOptions {
  verifyTimeoutMs?: number;
  customersDir?: string;
  mountDeadlineMs?: number;
  convergeContent?: boolean;
  evictionBatch?: readonly string[];
  currentEvictionBatch?: () => Promise<readonly string[]>;

signal?: AbortSignal;

onSignalCreated?: (signal: AbortSignal) => void;
}

export async function addCustomerToGateway(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  opts: AddCustomerOptions = {},
): Promise<AddCustomerResult> {
  return runUidMountExclusive(uid, opts, (signal) =>
    addCustomerToGatewayInner(adapter, uid, { ...opts, signal }),
  );
}

export async function restoreCustomerRuntimeFromSnapshot(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
  opts: AddCustomerOptions = {},
): Promise<RestoreCustomerRuntimeResult> {
  return runUidMountExclusive(snapshot.uid, opts, (signal) =>
    restoreCustomerRuntimeFromSnapshotInner(adapter, snapshot, { ...opts, signal }),
  );
}

async function runUidMountExclusive<T>(
  uid: string,
  opts: AddCustomerOptions,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (inFlightUids.has(uid)) {
    throw new ConcurrentMountError(uid);
  }
  inFlightUids.add(uid);
  const deadlineMs = opts.mountDeadlineMs ?? ADD_CUSTOMER_DEADLINE_MS;
  const controller = new AbortController();
  const deadlineErr = new Error(
    `[add:${uid}] mountDeadlineMs=${deadlineMs}ms exceeded — a step is hung; releasing in-flight lock so the next retry can run`,
  );

  const externalAbortListener = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) {
    controller.abort(opts.signal.reason);
  } else if (opts.signal) {
    opts.signal.addEventListener("abort", externalAbortListener, { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  if (!controller.signal.aborted && Number.isFinite(deadlineMs) && deadlineMs > 0) {
    timer = setTimeout(() => controller.abort(deadlineErr), deadlineMs);
  }
  opts.onSignalCreated?.(controller.signal);
  try {
    return await raceWithSignal(work(controller.signal), controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", externalAbortListener);
    inFlightUids.delete(uid);
  }
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function restoreCustomerRuntimeFromSnapshotInner(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
  opts: AddCustomerOptions,
): Promise<RestoreCustomerRuntimeResult> {
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
  const customersDir = opts.customersDir ?? "/home/node/.openclaw/customers";
  const ctx = buildCustomerContext(snapshot, customersDir);
  const steps: AddCustomerStep[] = [];
  const { signal } = opts;
  const { slug, uid } = snapshot;
  const startedAt = Date.now();

  adapter.log(
    `[restore:${slug}] starting durable restore for migration (repoUrl=${snapshot.repoUrl ? "set" : "empty"}, projects=${snapshot.projects?.length ?? 0})`,
  );

  throwIfAborted(signal, uid);
  steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
  throwIfAborted(signal, uid);

  const workspaceSteps = snapshot.repoUrl
    ? await convergeWorkspaceCheckout(adapter, uid, snapshot, ctx)
    : [];
  steps.push(...workspaceSteps);
  if (!workspaceSteps.includes("write-templates")) {
    adapter.ensureCustomerDirectories(slug);
    await adapter.writeCustomerTemplateFiles(ctx);
    steps.push("write-templates");
  }
  throwIfAborted(signal, uid);

  const byos = await restoreByos(adapter, slug);
  steps.push(...byos.steps);
  throwIfAborted(signal, uid);

  await applyConfigPatchAndMount(adapter, snapshot, null, {
    byosActive: byos.present,
    signal,
  });
  steps.push("config-patch");
  throwIfAborted(signal, uid);

  steps.push(...(await reassertConvergedState(adapter, snapshot)));
  throwIfAborted(signal, uid);

  steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
  throwIfAborted(signal, uid);

  await verifyChannelReady(adapter, slug, verifyTimeoutMs);
  steps.push("verify-channel-ready");
  throwIfAborted(signal, uid);

  if (rehydratesProjectCheckouts(adapter, snapshot)) {
    steps.push(...(await cloneProjectsFromSnapshot(adapter, snapshot)));
  }
  throwIfAborted(signal, uid);
  adapter.writeMountMarker?.(slug);
  adapter.log(
    `[restore:${slug}] durable restore complete in ${Date.now() - startedAt}ms`,
  );
  return { restored: true, steps };
}

function githubRepoSourceOf(target: ProjectCloneTarget): ProjectRepoSource | null {
  return target.repoSource?.provider === "github" ? target.repoSource : null;
}

function projectCloneOptions(target: ProjectCloneTarget): ProjectCloneOptions | undefined {
  const repoSource = githubRepoSourceOf(target);
  return repoSource ? { repoSource } : undefined;
}

function projectCloneSourceLabel(target: ProjectCloneTarget): string {
  const repoSource = githubRepoSourceOf(target);
  return repoSource ? `github:${repoSource.owner}/${repoSource.repo}` : "Gitea";
}

function hasProjectCloneSource(target: ProjectCloneTarget): boolean {
  return githubRepoSourceOf(target) !== null || Boolean(target.giteaRepoName);
}

async function cloneProjectsFromSnapshot(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<AddCustomerStep[]> {
  const steps: AddCustomerStep[] = [];
  for (const p of snapshot.projects ?? []) {
    if (p.provisioningState !== undefined && p.provisioningState !== "active") continue;
    if (!hasProjectCloneSource(p)) {
      adapter.log(
        `[restore:${snapshot.slug}/${p.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`,
      );
      continue;
    }
    try {
      const ok = await adapter.cloneProjectRepo(
        snapshot.slug,
        p.projectSlug,
        p.giteaRepoName,
        projectCloneOptions(p),
      );
      if (ok) steps.push("project-clone");
    } catch (err) {
      adapter.log(
        `[restore:${snapshot.slug}/${p.projectSlug}] ⚠ project clone failed (non-fatal): ${String(err)}`,
      );
    }
  }
  return steps;
}

function rehydratesProjectCheckouts(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
): boolean {
  const scope = snapshot.projectCheckoutScope ?? adapter.projectCheckoutScope?.(snapshot.slug);
  return scope === "workspace-and-projects";
}

function throwIfAborted(signal: AbortSignal | undefined, uid: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(`[add:${uid}] aborted: ${String(reason ?? "operation cancelled")}`);
}

function builderGatewayIsReadyForFastAttach(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
  convergeContent: boolean | undefined,
): boolean {
  const { slug } = snapshot;
  return snapshot.status === "complete"
    && !convergeContent
    && Boolean(adapter.isBuilderGateway?.())
    && Boolean(adapter.customerCoachWiredInOpenclawConfig?.(slug))
    && Boolean(adapter.hasCustomerAgentRuntime?.(slug))
    && adapter.hasWorkspaceGitDir(slug)
    && adapter.hasGitRemote(slug);
}

async function addCustomerToGatewayInner(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  opts: {
    verifyTimeoutMs?: number;
    customersDir?: string;
    signal?: AbortSignal;
    convergeContent?: boolean;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
  } = {},
): Promise<AddCustomerResult> {
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_ACCOUNT_TIMEOUT_MS;
  const customersDir = opts.customersDir ?? "/home/node/.openclaw/customers";
  const { signal } = opts;
  const steps: AddCustomerStep[] = [];
  const attachStartedAt = Date.now();

  throwIfAborted(signal, uid);
  const prepared = await loadAndPrepareForMount(adapter, uid, customersDir);
  let snapshot = prepared.snapshot;
  const { ctx, newCustomer } = prepared;
  const { slug } = snapshot;

  if (builderGatewayIsReadyForFastAttach(adapter, snapshot, opts.convergeContent)) {
    steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
    throwIfAborted(signal, uid);
    adapter.log(
      `[add:${slug}] builder gateway, status=complete, coach and durable workspace ready — verifying MM coach only`,
    );
    throwIfAborted(signal, uid);
    await verifyChannelReady(adapter, slug, verifyTimeoutMs);
    // Fleet heartbeat must include this customer as mounted — same as
    // the non-short-circuit path which calls onMounted after config.patch.
    if (adapter.onMounted) adapter.onMounted(slug);
    steps.push("verify-channel-ready");
    // This short-circuit never reaches cloneMissingProjects, so it makes no claim about
    // project checkouts — reporting them pending here would re-ensure forever.
    return { newCustomer: false, steps, pendingProjectClones: [] };
  }

  if (snapshot.status !== "complete") {
    await adapter.setProvisioningStatus(uid, "provisioning");
    steps.push("claim-slot");
  }

  steps.push(...(await ensureSshKeyAndGitea(adapter, slug)));
  throwIfAborted(signal, uid);

  steps.push(...(await ensureWorkspaceRepo(adapter, uid, snapshot, ctx)));
  throwIfAborted(signal, uid);

  const byos = await restoreByos(adapter, slug);
  steps.push(...byos.steps);
  throwIfAborted(signal, uid);

  const mm = await provisionMattermostIfMissing(adapter, uid, snapshot, ctx);
  snapshot = mm.snapshot;
  steps.push(...mm.steps);
  throwIfAborted(signal, uid);

  const appliedFingerprint = await applyConfigPatchAndMount(
    adapter,
    snapshot,
    mm.mmUpdate,
    {
      byosActive: byos.present,
      signal,
      evictionBatch: opts.evictionBatch,
      currentEvictionBatch: opts.currentEvictionBatch,
    },
  );
  steps.push("config-patch");
  throwIfAborted(signal, uid);

  steps.push(...(await reassertConvergedState(adapter, snapshot)));
  throwIfAborted(signal, uid);

  steps.push(...(await reconcileCommunityMembershipIfSupported(adapter, ctx)));
  throwIfAborted(signal, uid);

  await verifyChannelReady(adapter, slug, verifyTimeoutMs);
  steps.push("verify-channel-ready");
  throwIfAborted(signal, uid);

  steps.push(...(await runBlobSync(adapter, slug)));
  throwIfAborted(signal, uid);

  const projectClones = rehydratesProjectCheckouts(adapter, snapshot)
    ? await cloneMissingProjects(adapter, slug)
    : { steps: [], pending: [] };
  steps.push(...projectClones.steps);
  throwIfAborted(signal, uid);

  adapter.log(
    `✅ [add:${slug}] coach attach complete in ${Date.now() - attachStartedAt}ms — scheduling greeting next`,
  );
  steps.push(...(await scheduleGreetingIfNeeded(adapter, uid, snapshot)));
  steps.push(...(await markCompleteIfNeeded(adapter, uid, snapshot, newCustomer)));
  steps.push(...(await notifyOpsIfNew(adapter, ctx, newCustomer)));

  return {
    newCustomer,
    steps,
    pendingProjectClones: projectClones.pending,
    ...(appliedFingerprint ? { appliedFingerprint } : {}),
  };
}

async function loadAndPrepareForMount(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  customersDir: string,
): Promise<{ snapshot: UserSnapshot; ctx: CustomerContext; newCustomer: boolean }> {
  const snapshot = await adapter.loadUserSnapshot(uid);
  if (!snapshot) {
    throw new Error(`[add:${uid}] user doc not found in Firestore`);
  }
  const newCustomer = snapshot.status !== "complete";
  const ctx = buildCustomerContext(snapshot, customersDir);
  adapter.log(
    `🟢 [add:${snapshot.slug}] starting (status=${snapshot.status || "<empty>"}, repoUrl=${snapshot.repoUrl ? "set" : "empty"}, mmUserId=${snapshot.mattermostUserId ? "set" : "empty"})`,
  );
  return { snapshot, ctx, newCustomer };
}

async function ensureSshKeyAndGitea(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<AddCustomerStep[]> {
  if (!adapter.hasCustomerSshKey(slug)) {
    await registerFirstTimeSshKey(adapter, slug);
    return ["ssh-key"];
  }
  return resyncSshKeyIfDrifted(adapter, slug);
}

async function registerFirstTimeSshKey(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<void> {
  const pubKey = adapter.generateCustomerSshKey(slug);
  try {
    await adapter.createGiteaUser(slug, pubKey);
    const giteaPubKeys = await adapter.readGiteaCustomerPubKeys(slug);
    if (!giteaPubKeys.some((candidate) => pubKeysMatch(candidate, pubKey))) {
      throw new Error(
        `Gitea did not register the new SSH key (giteaPub=${giteaPubKeys.length === 0 ? "absent" : "mismatch"})`,
      );
    }
  } catch (err) {
    await adapter.deleteCustomerSshKey(slug).catch(() => {});
    throw new Error(`[add:${slug}] SSH key registration failed: ${String(err)}`);
  }
  adapter.log(`[add:${slug}] SSH key + Gitea user registered`);
}

async function resyncSshKeyIfDrifted(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<AddCustomerStep[]> {
  const localPub = adapter.readLocalCustomerPubKey(slug);
  if (localPub === null) {
    await adapter.deleteCustomerSshKey(slug).catch(() => {});
    throw new Error(
      `[add:${slug}] SSH key dir exists but pubkey is unreadable; cleared, retry will regenerate`,
    );
  }
  const giteaPubKeys = await adapter.readGiteaCustomerPubKeys(slug);
  if (giteaPubKeys.some((candidate) => pubKeysMatch(candidate, localPub))) return [];

  const driftDetail = giteaPubKeys.length === 0 ? "absent" : "mismatch";
  adapter.log(`[add:${slug}] resync triggered: SSH key drift (giteaPub=${driftDetail})`);
  await adapter.createGiteaUser(slug, localPub);
  const recheck = await adapter.readGiteaCustomerPubKeys(slug);
  if (!recheck.some((candidate) => pubKeysMatch(candidate, localPub))) {
    throw new Error(`[add:${slug}] SSH key resync did not persist in Gitea`);
  }
  return ["ssh-key-resync"];
}

async function ensureWorkspaceRepo(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  await adapter.ensureGiteaOrg(snapshot.slug);
  return convergeWorkspaceCheckout(adapter, uid, snapshot, ctx);
}

async function convergeWorkspaceCheckout(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  const { slug } = snapshot;
  if (adapter.hasWorkspaceGitDir(slug)) {
    if (adapter.hasGitRemote(slug)) return [];
    if (snapshot.repoUrl) {
      adapter.log(`[add:${slug}] workspace has no origin; restoring canonical Gitea checkout`);
      await adapter.deleteCustomerDir(slug);
      return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
    }
    return recoverMissingWorkspaceRemote(adapter, uid, ctx);
  }
  if (snapshot.repoUrl) {
    return cloneExistingWorkspaceRepo(adapter, snapshot, ctx);
  }
  return initNewWorkspaceRepo(adapter, uid, ctx);
}

async function recoverMissingWorkspaceRemote(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx);
  if (!repoUrl) {
    throw new Error(`[add:${ctx.slug}] recovery workspace repo creation failed`);
  }
  await adapter.setRepoUrl(uid, repoUrl);
  adapter.ensureCustomerDirectories(ctx.slug);
  adapter.log(`[add:${ctx.slug}] workspace remote recovered + Firestore updated (${repoUrl})`);
  return ["init-workspace-repo"];
}

async function cloneExistingWorkspaceRepo(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  const { slug, repoUrl } = snapshot;
  if (adapter.hasCustomerDir(slug) && !adapter.hasWorkspaceGitDir(slug)) {
    adapter.log(`[add:${slug}] removing partial workspace dir before clone`);
    await adapter.deleteCustomerDir(slug);
  }
  const cloned = await adapter.cloneWorkspaceRepo(slug, repoUrl);
  if (!cloned) {
    throw new Error(`[add:${slug}] workspace clone from ${repoUrl} failed`);
  }
  adapter.ensureCustomerDirectories(slug);
  await adapter.writeCustomerTemplateFiles(ctx);
  adapter.log(
    `[add:${slug}] workspace cloned from Gitea; template files ensured`,
  );
  return ["clone-workspace-repo", "write-templates"];
}

async function initNewWorkspaceRepo(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  adapter.ensureCustomerDirectories(ctx.slug);
  await adapter.writeCustomerTemplateFiles(ctx);
  const repoUrl = await adapter.initWorkspaceRepoFromExistingDir(ctx);
  if (!repoUrl) {
    throw new Error(`[add:${ctx.slug}] initial workspace repo creation failed`);
  }
  await adapter.setRepoUrl(uid, repoUrl);
  adapter.log(`[add:${ctx.slug}] workspace repo initialized + pushed (${repoUrl})`);
  return ["write-templates", "init-workspace-repo"];
}

async function runBlobSync(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<AddCustomerStep[]> {
  try {
    await adapter.blobSyncForSlug(slug);
    return ["blob-sync"];
  } catch (err) {
    adapter.log(`[add:${slug}] ⚠ blob sync failed (non-fatal): ${String(err)}`);
    return [];
  }
}

async function restoreByos(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<{ restored: boolean; present: boolean; steps: AddCustomerStep[] }> {
  const result = await adapter.restoreByosubForAgent(slug);
  if (!result.restored) {
    return { ...result, steps: [] };
  }
  adapter.log(`[add:${slug}] BYOS oauth activated from user integration broker`);
  return { ...result, steps: ["byosub-restore"] };
}

// The byot userData that syncByotForCustomer (via deriveDesiredByotState) needs to make a
// NON-destructive decision. deriveDesiredByotState gates BYOT derivation on
// provisioning.openclaw.status === "complete"; below that it returns input=null, and on a
// shared GW a null state runs applyByotState(slug, null), which REMOVES a non-anthropic
// customer's models.json. reassertByot is called ONLY after applyConfigPatchAndMount has
// registered + mounted the agent, so the runtime IS complete here — but the in-memory
// snapshot.status is the PRE-mount Firestore value, still "" / "provisioning" on a
// first-time provision (loadAndPrepareForMount never advances it). Forwarding that stale
// status would derive input=null and skip writing a first-time BYOK customer's model files
// (and clear them on a retry that already has managed files). So pin status to "complete":
// it reflects the just-mounted runtime, not the stale doc. byotActive + systemConfig.byot
// drive the provider; tier drives the free-tier coach model.
function byotUserDataFromSnapshot(snapshot: UserSnapshot): Record<string, unknown> {
  return {
    username: snapshot.slug,
    byotActive: snapshot.byotActive,
    systemConfig: snapshot.systemConfig,
    tier: snapshot.tier,
    freeTierModelRef: snapshot.freeTierModelRef,
    builderAgentDefault: snapshot.builderAgentDefault,
    // Full plan-input set: the reassert's resolveBillingProfile must see the same
    // plan the trusted side resolved, or a trial/builder user's agent-model picks
    // defer to house_only on every mount/roll.
    ...pickPlanInputs(snapshot as unknown as Record<string, unknown>),
    provisioning: { openclaw: { status: "complete" } },
  };
}

// Re-assert the customer's broker-routed model auth into the openclaw config. The
// Anthropic provider key on a shared GW is a broker token set via config.patch, not a
// file — so a fresh emptyDir pod (roll / Spot preemption) loses it and boot-sync's
// restoreByos (BYOS oauth) alone does not restore it. Runs here so it's re-applied on
// every provision AND re-mount. Idempotent; non-fatal so a transient broker hiccup
// doesn't strand the whole mount — the change-trigger and next re-mount re-run it.
async function refreshSnapshotForReassert(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<UserSnapshot> {
  try {
    return (await adapter.loadUserSnapshot(snapshot.uid)) ?? snapshot;
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ refresh before byot re-assert failed; using mount snapshot: ${String(err)}`,
    );
    return snapshot;
  }
}

// Re-asserts BYOT model auth and the platform-converged context files
// (AGENTS.md/TOOLS.md for house_only plans) off ONE fresh snapshot fetch —
// both are idempotent/non-fatal convergence steps that must run on every
// provision AND re-mount, but they are independent failure domains: one
// failing must never skip the other, and neither should cost a customer a
// second Firestore read.
async function reassertConvergedState(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
): Promise<AddCustomerStep[]> {
  const refreshed = await refreshSnapshotForReassert(adapter, snapshot);
  const userData = byotUserDataFromSnapshot(refreshed);
  const steps: AddCustomerStep[] = [];

  try {
    await adapter.reassertByotForCustomer(userData);
    steps.push("byot-reassert");
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ byot re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`,
    );
  }

  try {
    await adapter.reassertConvergedContextFilesForCustomer(userData);
    steps.push("context-files-reassert");
  } catch (err) {
    adapter.log(
      `[add:${snapshot.slug}] ⚠ context-file re-assert failed (non-fatal; retry on next sync/re-mount): ${String(err)}`,
    );
  }

  return steps;
}

async function reconcileCommunityMembershipIfSupported(
  adapter: CustomerLifecycleAdapter,
  ctx: CustomerContext,
): Promise<AddCustomerStep[]> {
  if (!adapter.reconcileCommunityMembership) return [];
  try {
    await adapter.reconcileCommunityMembership(ctx);
    return ["community-membership"];
  } catch (err) {
    adapter.log(
      `[add:${ctx.slug}] ⚠ community membership reconcile failed (non-fatal; retry on next sync/re-mount): ${String(err)}`,
    );
    return [];
  }
}

async function cloneMissingProjects(
  adapter: CustomerLifecycleAdapter,
  slug: string,
): Promise<{ steps: AddCustomerStep[]; pending: string[] }> {
  const toClone = await adapter.listProjectsNeedingClone(slug);
  const steps: AddCustomerStep[] = [];
  for (const p of toClone) {
    if (!hasProjectCloneSource(p)) {
      adapter.log(
        `[add:${slug}/${p.projectSlug}] ✖ project checkout skipped — no Gitea repo and no GitHub repoSource`,
      );
      continue;
    }
    try {
      const ok = await adapter.cloneProjectRepo(
        slug,
        p.projectSlug,
        p.giteaRepoName,
        projectCloneOptions(p),
      );
      if (ok) {
        steps.push("project-clone");
        adapter.log(`[add:${slug}/${p.projectSlug}] cloned from ${projectCloneSourceLabel(p)}`);
      }
    } catch (err) {
      adapter.log(`[add:${slug}/${p.projectSlug}] ✖ project clone failed: ${String(err)}`);
    }
  }

  // On-disk truth, not cloneProjectRepo's boolean: it returns false for several non-error
  // reasons (repo absent upstream, no SSH key), so only a re-probe can say whether the
  // checkout actually landed.
  const remaining = await adapter.listProjectsNeedingClone(slug);
  const pending = remaining.map((p) => p.projectSlug).sort();
  if (pending.length > 0) {
    adapter.log(
      `[add:${slug}] ✖ project checkout still absent after converge: ${pending.join(", ")} — leaving this customer stale so the next reconcile retries`,
    );
  }
  return { steps, pending };
}

async function provisionMattermostIfMissing(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  ctx: CustomerContext,
): Promise<{ snapshot: UserSnapshot; mmUpdate: MmUpdate | null; steps: AddCustomerStep[] }> {
  if (snapshot.mattermostUserId) {
    return { snapshot, mmUpdate: null, steps: [] };
  }
  const mmUpdate = await adapter.provisionMattermostUser(ctx);
  await adapter.setMattermostFields(uid, mmUpdate);
  const refreshed = await adapter.loadUserSnapshot(uid);
  return {
    snapshot: refreshed ?? snapshot,
    mmUpdate,
    steps: ["mattermost-provision"],
  };
}

async function applyConfigPatchAndMount(
  adapter: CustomerLifecycleAdapter,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  options: {
    byosActive: boolean;
    signal?: AbortSignal;
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
  },
): Promise<string | undefined> {
  const patchResult = await adapter.applyAddCustomerConfigPatch(snapshot, mmUpdate, {
    signal: options.signal,
    byosActive: options.byosActive,
    evictionBatch: options.evictionBatch,
    currentEvictionBatch: options.currentEvictionBatch,
  });
  adapter.log(`[add:${snapshot.slug}] config patch in ${patchResult.elapsedMs}ms`);
  if (adapter.onMounted) adapter.onMounted(snapshot.slug);
  return patchResult.appliedFingerprint;
}

async function verifyChannelReady(
  adapter: CustomerLifecycleAdapter,
  slug: string,
  verifyTimeoutMs: number,
): Promise<void> {
  adapter.log(
    `[add:${slug}] verify: waiting for coach MM account to report running+connected (timeoutMs=${verifyTimeoutMs})`,
  );
  const startedAt = Date.now();
  const healthy = await adapter.waitForAccountHealthy({ slug, timeoutMs: verifyTimeoutMs });
  const elapsed = Date.now() - startedAt;
  if (!healthy) {
    throw new Error(
      `[add:${slug}] channel didn't reach running+connected within ${verifyTimeoutMs}ms (waited ${elapsed}ms) — failing the mount; fleet will retry`,
    );
  }
  adapter.log(`[add:${slug}] ✅ verify: channel ready (running+connected) in ${elapsed}ms`);
}

async function scheduleGreetingIfNeeded(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
): Promise<AddCustomerStep[]> {
  if (snapshot.greetingPosted) return [];
  const { slug } = snapshot;
  const accountId = `${slug}-coach`;
  const agentId = `octogee-${slug}-coach`;
  adapter.log(
    `[add:${slug}] greeting-cron: scheduling boot-greeting via cron.add (agentId=${agentId} accountId=${accountId})`,
  );
  const startedAt = Date.now();
  try {
    const result = await adapter.scheduleBootGreetingCron({ slug, agentId, accountId });
    const elapsed = Date.now() - startedAt;
    await adapter.setGreetingResult(uid, { ok: true, jobId: result.jobId });
    adapter.log(
      `[add:${slug}] ✅ greeting-cron: scheduled (jobId=${result.jobId} elapsedMs=${elapsed}) — agent turn will fire shortly; check gateway logs for 'cron: job created' and the eventual announce delivery`,
    );
    try {
      adapter.ensureBootGreetingFallback?.({ slug, uid });
    } catch (fallbackError) {
      adapter.log(
        `[add:${slug}] ⚠ greeting fallback failed (non-fatal): ${String(fallbackError)}`,
      );
    }
    return ["schedule-greeting-cron"];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    adapter.log(
      `[add:${slug}] ❌ greeting-cron: scheduleBootGreetingCron FAILED (fatal — mount will retry; provisioning stays incomplete): ${message}`,
    );
    await adapter.setGreetingResult(uid, { ok: false, error: message });
    throw err;
  }
}

async function markCompleteIfNeeded(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  snapshot: UserSnapshot,
  newCustomer: boolean,
): Promise<AddCustomerStep[]> {
  if (!newCustomer && snapshot.agentIds.length > 0) return [];
  const coachAgentId = `octogee-${snapshot.slug}-coach`;
  await adapter.setAgentIds(uid, [coachAgentId]);
  await adapter.setProvisioningStatus(uid, "complete");
  return ["mark-complete"];
}

async function notifyOpsIfNew(
  adapter: CustomerLifecycleAdapter,
  ctx: CustomerContext,
  newCustomer: boolean,
): Promise<AddCustomerStep[]> {
  if (!newCustomer) return [];
  try {
    await adapter.notifyOpsOfSignup(ctx);
    return ["notify-ops"];
  } catch (err) {
    adapter.log(`[add:${ctx.slug}] ⚠ ops notification failed (non-fatal): ${String(err)}`);
    return [];
  }
}

export async function removeCustomerFromGateway(
  adapter: CustomerLifecycleAdapter,
  uid: string,
  opts: {
    evictionBatch?: readonly string[];
    currentEvictionBatch?: () => Promise<readonly string[]>;
  } = {},
): Promise<RemoveCustomerResult> {
  const steps: RemoveCustomerStep[] = [];
  const snapshot = await adapter.loadUserSnapshot(uid);
  if (!snapshot) {
    throw new Error(`[remove:${uid}] user doc not found in Firestore`);
  }
  const { slug } = snapshot;
  const wasMounted =
    adapter.hasCustomerDir(slug) || snapshot.status === "complete";
  if (!wasMounted) {
    adapter.log(`[remove:${slug}] nothing to do (no dir, status=${snapshot.status})`);
    return { wasMounted: false, steps };
  }

  const coachAgentId = `octogee-${slug}-coach`;
  const remaining = opts.evictionBatch
    ? await adapter.applyRemoveCustomerConfigPatch(
        slug,
        coachAgentId,
        opts.evictionBatch,
        opts.currentEvictionBatch,
      )
    : await adapter.applyRemoveCustomerConfigPatch(
        slug,
        coachAgentId,
        undefined,
        opts.currentEvictionBatch,
      );
  steps.push("config-patch-remove");
  adapter.log(`[remove:${slug}] removed from openclaw config`);

  if (remaining && !remaining.includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return { wasMounted: true, steps, retained: true };
  }

  if (opts.currentEvictionBatch && !(await opts.currentEvictionBatch()).includes(slug)) {
    adapter.cancelPendingEviction?.(slug);
    return { wasMounted: true, steps, retained: true };
  }

  if (adapter.hasCustomerDir(slug)) {
    await adapter.deleteCustomerDir(slug);
    steps.push("delete-dir");
    adapter.log(`[remove:${slug}] customer dir deleted`);
  }

  if (adapter.onUnmounted) adapter.onUnmounted(slug);
  return { wasMounted: true, steps };
}

export function pubKeysMatch(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const parts = s.trim().split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : s.trim();
  };
  return norm(a) === norm(b);
}

function buildCustomerContext(snapshot: UserSnapshot, customersDir: string): CustomerContext {
  const today = new Date().toISOString().slice(0, 10);
  const username = snapshot.slug;
  return {
    uid: snapshot.uid,
    slug: snapshot.slug,
    tier: snapshot.tier,
    ownerName: snapshot.ownerName,
    customerDir: `${customersDir}/${snapshot.slug}`,
    today,
    username,
    templateVars: {
      uid: snapshot.uid,
      ownerName: snapshot.ownerName,
      username,
      tier: snapshot.tier,
      createdAt: today,
      slug: snapshot.slug,
    },
    userData: {},
  };
}
