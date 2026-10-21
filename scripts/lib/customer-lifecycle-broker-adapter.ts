import { readProjectRestoreReady } from "@octogee/core/project-asset-state";
import { prepareBuilderProjectAssets } from "./builder-project-assets.js";
import { createBrokeredProjectBlobHydrator } from "./project-blob-materialization.js";
import { sharedMigrationAgentIds, sharedMigrationExportPaths } from "./source-transfer-plan.js";
import { assertCustomerHasNoScheduledJobs, migrateCustomerScheduler, setCustomerChannelsRunning } from "./customer-channel-quiesce.js";
import { quiesceCustomerSessionsBounded, sessionStoreForPath } from "./customer-session-quiesce.js";
import { customerFileStatePaths, removeDepartedCustomerFileState } from "./customer-file-state.js";
import { openClawRuntimeUpdateGuard } from "./openclaw-runtime-update-guard.js";
import {
  builderOwnerCommandsPatch,
  configuredBuilderManagedProjectIds,
  configuredBuilderProjectAgentPatch,
  configuredBuilderWorkspacePatch,
  validOwnerMmUserId,
} from "./configured-builder-project-agents.js";
import { projectAgentsRuntimeReady, reportProjectAgentReadiness } from "./project-agent-readiness.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";
import {
  DEFAULT_BUILDER_AGENT_MODEL_REF,
  DEFAULT_FREE_TIER_MODEL_REF,
  parseBuilderAgentModelDefault,
  type BuilderAgentModelDefault,
} from "../../shared/types/platform-config.js";
import {
  BUILDER_IMPORT_STARTUP_TIMEOUT_MS,
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "../../shared/types/fleet-controller.js";
import {
  MIGRATION_QUIESCE_GRACE_MS,
  MIGRATION_QUIESCE_STOP_RECHECK_MS,
} from "../../shared/types/workspace-migration.js";
import { catalogEntryForModelRef } from "../../shared/types/agent-models.js";
import { projectCheckoutEnabled, projectRepoSourceFromDoc } from "../../shared/types/project.js";
import { mattermostAccountEndpointsForTarget } from "../../shared/types/openclaw-mattermost-accounts.js";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  customerConfigReplacePaths,
  mergeCustomerBindings,
  orderBuilderGatewayRoster,
  preserveMountedAgentModels,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  type ConfigCache,
} from "./apply-config-patch.js";
import {
  customerAgentIdsInRoster,
  deleteRosterAgents,
} from "./agent-roster-deletion.js";
import {
  createRosterAgents,
  rosterAgentSpecsFromEntries,
} from "./agent-roster-creation.js";
import {
  type CustomerContext,
  type CustomerLifecycleAdapter,
  type CustomerStateImportMode,
  type MmUpdate,
  type ProjectCloneOptions,
  type ProjectCloneTarget,
  type RemoveCustomerResult,
  type UserSnapshot,
} from "./customer-lifecycle.js";

import {
  dlog,
  logLevel,
  AGENTS_DIR,
  CUSTOMER_KEYS_DIR,
  CUSTOMERS_DIR,
  OPENCLAW_CONFIG,
  OPENCLAW_DIR,
  readOpenClawConfig,
} from "./config.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import {
  customerCoachAgentId,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import { OpenclawWireError, provisionCoachAutomation, type ConfigGetResult, type GatewayRpcClient } from "./gateway-rpc.js";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import {
  cloneProjectRepo,
  cloneWorkspaceRepo,
  createGiteaUser,
  customerRepositoryHasCanonicalRemote,
  customerSshKeyPath,
  deleteCustomerSshKey,
  generateCustomerSshKey,
  initWorkspaceRepo,
  projectCheckoutMatchesSource,
  readGiteaCustomerPubKeys,
  readLocalCustomerPubKey,
  removePartialWorkspace,
  setRepoSshCommand,
} from "./git.js";
import { seedDeferredProjectWorkspace } from "./deferred-project-workspace.js";
import {
  ensureGiteaOrgForWorkspace,
  ensureSystemConfigRepo,
  releaseGiteaUserKey,
} from "./gitea-admin-broker-client.js";
import {
  hasMountedMarker,
  clearMountedMarker,
  clearMigratingInPin,
  assertConfiguredBuilderPortableStatePlanOnDisk,
  configuredBuilderPortableStatePlan,
  isMigratingInPinned,
  customerCoachWiredInOpenclawConfig,
  listLocalCoachWiredSlugs,
  listLocalCustomerDirs,
  listMigratingInSlugs,
  writeMigratingInPin,
  writeMountedMarker,
} from "./local-coach-wired.js";
import {
  SAFE_DEFAULT_AGENT_ID,
  activeAgentProjectIds,
  buildSafeDefaultAgent,
  buildCustomerAgent,
  buildCustomerBindings,
  buildMattermostAccounts,
  buildProjectAgentAccounts,
  buildProjectAgents,
  gatewayAgentRoster,
  isSafeDefaultAgentPortableStatePath,
  mattermostAccountBindingsNeedingActivation,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  rebindPlatformEmbeddingRefs,
  resolveCoachIdentity,
} from "./openclaw-config-builders.js";
import { createSurgeOpenClawProcessSupervisorClient } from "./surge-openclaw-process-gate.js";
import {
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  customerMountConfigPatch,
  customerSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  refreshModelCredentialRuntimeSessions,
  restoreModelCredentialOauthStoreForSlug,
  syncModelCredentialsForCustomer,
} from "./model-credential-sync-runtime.js";
import { MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS } from "./model-credential-materializer.js";
import {
  byosCoachConfigPatch,
  convergedCoachToolsValue,
  isPlatformProviderRef,
  platformCoachModelInputForUser,
} from "./byot-sync.js";
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "./agent-model-token-materializer.js";
import { blobSyncForSlug } from "./blob-sync.js";
import { createBrokeredBlobStore } from "./blob-sync-broker.js";
import {
  activationManifestAgentIds,
  applyOpenClawActivationManifest,
  MIGRATION_ACTIVATION_DIR,
  readActivationManifest,
  removeActivationManifest,
} from "./migration-activation-manifest.js";
import { assertNotHeld, type HeldPathOptions, matchUnder, PROC_ROOT } from "./held-files.js";
import {
  exportActivationManifestWithSecret,
  materializeActivationManifestSecret,
} from "./migration-activation-secrets.js";
import {
  configSecretMaterialChangeReasons,
  createSecretMaterialLedger,
  type SecretMaterialLedger,
} from "./secret-material-change.js";
import { isConfiguredGatewayBuilder } from "./system-config-watch-state.js";
import { customerAgentRuntimePresent } from "./customer-agent-runtime.js";
import { writeTierTemplateFiles } from "./tier-template-files.js";
import { reassertConvergedContextFilesForSlug } from "./context-file-convergence.js";
import {
  mattermostProjectAccountSecretChange,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import { quarantineMalformedCoachMattermostAccount } from "./mattermost-coach-quarantine.js";
import {
  activateMattermostRoutingAfterConfigPatch,
  activatePendingMattermostRouting,
  captureMattermostRoutingActivationBaseline,
  discardMattermostRoutingActivationForCustomers,
  markMattermostRoutingActivationPending,
  mattermostRoutingActivationPending,
  stopStaleMattermostRoutingAccounts,
} from "./mattermost-routing-activation.js";
import { snapshotConfigFingerprint } from "./snapshot-fingerprint.js";
import { builderClaimOverlaySlug, builderClaimSlug } from "@octogee/shared/server/builder-claim";

const WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE: FleetBrokerProjectCheckoutScope = "workspace-only";

const DEFAULT_COACH = {
  name: "Octo",
  emoji: "",
  model: DEFAULT_BUILDER_AGENT_MODEL_REF,
};

type AddCustomerConfigPatchOptions = Parameters<
  CustomerLifecycleAdapter["applyAddCustomerConfigPatch"]
>[2];

function evictionSlugsExcept(
  mountedSlug: string,
  batch: readonly string[] | undefined,
): string[] {
  return [...new Set(batch ?? [])].filter((slug) => slug !== mountedSlug);
}

async function currentEvictionSlugs(
  mountedSlug: string,
  fallback: readonly string[],
  readCurrent: (() => Promise<readonly string[]>) | undefined,
): Promise<string[]> {
  const batch = readCurrent ? await readCurrent() : fallback;
  return evictionSlugsExcept(mountedSlug, batch);
}

function brokerProjectAgents(
  brokerSnapshot: FleetBrokerUserSnapshot | null,
  snapshot: UserSnapshot,
  withoutProjectIds?: readonly string[],
): NonNullable<UserSnapshot["projectAgents"]> {
  const agents = brokerSnapshot?.projectAgents ?? snapshot.projectAgents ?? [];
  if (!withoutProjectIds?.length) return agents;
  const excluded = new Set(withoutProjectIds);
  return agents.filter((p) => !excluded.has(p.projectId));
}

function brokerCustomerMattermostUserId(
  brokerSnapshot: FleetBrokerUserSnapshot | null,
  snapshot: UserSnapshot,
): string | null | undefined {
  return brokerSnapshot ? brokerSnapshot.customerMmUserId : snapshot.mattermostUserId;
}

interface BuildBrokeredLifecycleAdapterOptions {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  isBuilderGateway?: () => boolean;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
  procRoot?: string;
}

interface BrokerCtx {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  isBuilderGateway: () => boolean;
  configCache: ConfigCache;
  snapshotsByUid: Map<string, FleetBrokerUserSnapshot>;
  snapshotsBySlug: Map<string, FleetBrokerUserSnapshot>;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
  configRemovedForEviction: Set<string>;
  pendingRuntimeSecrets: Map<string, SecretMaterialLedger>;
  procRoot: string;
}

// The roster and the departing agents' bindings are `agents.delete`'s job —
// 2026.7.2 rejects any config write that drops roster entries without the
// allowance only that RPC carries. What is left for the patch is the Mattermost
// accounts openclaw's agent deletion does not touch.
function buildRemoveCustomerAccountsPatch(
  current: unknown,
  slugs: readonly string[],
): { channels: { mattermost: { accounts: Record<string, null> } } } {
  const currentAccounts =
    (current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } })
      ?.channels?.mattermost?.accounts ?? {};
  const accounts: Record<string, null> = {};
  for (const slug of slugs) {
    accounts[`${slug}-coach`] = null;
    for (const accountId of Object.keys(currentAccounts)) {
      if (accountId.startsWith(`${slug}-proj-`)) accounts[accountId] = null;
    }
  }
  return { channels: { mattermost: { accounts } } };
}

async function freshRosterConfig(ctx: BrokerCtx): Promise<unknown> {
  const fetched = await ctx.rpc.configGet();
  ctx.configCache.current = fetched.config;
  ctx.configCache.hash = fetched.hash;
  return fetched.config;
}

function invalidateConfigCache(ctx: BrokerCtx): void {
  ctx.configCache.current = undefined;
  ctx.configCache.hash = "";
}

async function releaseAgentsAndInvalidateCache(
  ctx: BrokerCtx,
  agentIds: readonly string[],
  logPrefix: string,
  options: { purgeStore?: boolean } = {},
): Promise<void> {
  if (agentIds.length === 0) return;
  const database = fs.existsSync(OPENCLAW_CONFIG)
    ? (readOpenClawConfig() as { database?: { engine?: string; families?: { agent?: { engine?: string } } } }).database : undefined;
  const postgres = (database?.families?.agent?.engine ?? database?.engine) === "postgres";
  const failures: unknown[] = [];
  try {
    for (const agentId of agentIds) {
      try {
        const file = path.join(resolveOpenClawStateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
        await deleteRosterAgents([agentId], {
          rpc: ctx.rpc, log: ctx.log, logPrefix,
          preserveStore: !options.purgeStore && (postgres || readPostgresAgentAnchor(file) !== null),
        });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("; "));
  } finally {
    // Each delete rewrites the roster and prunes bindings, so any cached
    // snapshot — and its base hash — is stale the moment the first one lands.
    invalidateConfigCache(ctx);
  }
}

function agentStateRelease(ctx: BrokerCtx, logPrefix: string): AgentStateRelease {
  return {
    releaseAgents: (agentIds) => releaseAgentsAndInvalidateCache(ctx, agentIds, logPrefix),
    procRoot: ctx.procRoot,
  };
}

async function deleteDepartingCustomerAgents(
  ctx: BrokerCtx,
  slugs: readonly string[],
  logPrefix: string,
): Promise<void> {
  if (slugs.length === 0) return;
  const current = await freshRosterConfig(ctx);
  await releaseAgentsAndInvalidateCache(
    ctx,
    slugs.flatMap((slug) => customerAgentIdsInRoster(current, slug)),
    logPrefix,
  );
}

async function deleteSupersededCustomerAgents(
  ctx: BrokerCtx,
  input: {
    slug: string;
    evictionSlugs: readonly string[];
    keepAgentIds: readonly string[];
    logPrefix: string;
    purpose: "reconcile" | "import";
  },
): Promise<void> {
  const current = await freshRosterConfig(ctx);
  const keep = new Set(input.keepAgentIds);
  await releaseAgentsAndInvalidateCache(
    ctx,
    input.evictionSlugs.flatMap((slug) => customerAgentIdsInRoster(current, slug)),
    input.logPrefix,
  );
  await releaseAgentsAndInvalidateCache(
    ctx,
    customerAgentIdsInRoster(current, input.slug).filter((agentId) => !keep.has(agentId)),
    input.logPrefix,
    { purgeStore: input.purpose === "reconcile" },
  );
}

async function ensureCustomerRosterAgents(
  ctx: BrokerCtx,
  agentEntries: readonly unknown[],
  logPrefix: string,
  opts: { signal?: AbortSignal; waitForAppliedRevision?: boolean } = {},
): Promise<void> {
  const specs = rosterAgentSpecsFromEntries(agentEntries);
  if (specs.length === 0) return;
  await Promise.all(specs.map((spec) => fsp.mkdir(spec.workspace, { recursive: true })));
  try {
    for (const spec of specs) {
      throwIfConfigApplicationWaitAborted(opts.signal);
      const [created] = await createRosterAgents([spec], { rpc: ctx.rpc, log: ctx.log, logPrefix });
      if (created.status === "created" && opts.waitForAppliedRevision !== false) {
        await waitForAppliedConfigRevision(ctx.rpc, spec.agentId, {
          timeoutMs: 60_000,
          logPrefix,
          signal: opts.signal,
          acceptSupersedingRevision: true,
        });
      }
    }
  } finally {
    invalidateConfigCache(ctx);
  }
}

async function reconcileCustomerRosterAgents(
  ctx: BrokerCtx,
  slug: string,
  evictionSlugs: readonly string[],
  keepAgentIds: readonly string[],
  agentEntries: readonly unknown[],
): Promise<void> {
  const logPrefix = `[add:${slug}]`;
  await deleteSupersededCustomerAgents(ctx, {
    slug,
    evictionSlugs,
    keepAgentIds,
    logPrefix,
    purpose: "reconcile",
  });
  await ensureCustomerRosterAgents(ctx, agentEntries, logPrefix);
}

function cacheSnapshot(ctx: BrokerCtx, snapshot: FleetBrokerUserSnapshot): void {
  const runtimeScope = ctx.projectCheckoutScope?.(snapshot.slug)
    ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
  const projectCheckoutScope =
    runtimeScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE ||
      snapshot.projectCheckoutScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE
      ? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE
      : snapshot.projectCheckoutScope
        ?? runtimeScope
        ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
  const projected = {
    ...snapshot,
    projectCheckoutScope,
    projects: projectCheckoutScope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE ? [] : snapshot.projects,
  };
  ctx.snapshotsByUid.set(projected.uid, projected);
  ctx.snapshotsBySlug.set(projected.slug, projected);
}

function invalidateSnapshot(ctx: BrokerCtx, uid: string): void {
  const cached = ctx.snapshotsByUid.get(uid);
  if (cached) ctx.snapshotsBySlug.delete(cached.slug);
  ctx.snapshotsByUid.delete(uid);
}

async function snapshotForUid(ctx: BrokerCtx, uid: string): Promise<FleetBrokerUserSnapshot | null> {
  const cached = ctx.snapshotsByUid.get(uid);
  if (cached) return cached;
  const snapshot = await ctx.client.userSnapshot(uid);
  if (snapshot) cacheSnapshot(ctx, snapshot);
  return snapshot;
}

async function snapshotForUidWithProjectMembershipIsolation(
  ctx: BrokerCtx,
  uid: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const snapshot = await snapshotForUid(ctx, uid);
  await ctx.client.reconcileProjectCoachMembership(uid);
  return snapshot;
}

async function snapshotForSlug(ctx: BrokerCtx, slug: string): Promise<FleetBrokerUserSnapshot | null> {
  const cached = ctx.snapshotsBySlug.get(slug);
  if (cached) return cached;
  const uid = await ctx.client.uidForSlug(slug);
  return uid ? snapshotForUid(ctx, uid) : null;
}

async function customerContextRestoreHeld(ctx: BrokerCtx, slug: string): Promise<boolean> {
  const uid = await ctx.client.uidForSlug(slug);
  if (!uid) return false;
  const snapshot = await ctx.client.userSnapshot(uid);
  if (!snapshot) throw new Error("Shared restore eviction owner snapshot is missing");
  const hold = snapshot.nativeSharedContextRestore;
  if (hold === undefined) return false;
  const gatewayId = process.env.GATEWAY_ID;
  if (!hold || !gatewayId || snapshot.uid !== uid || snapshot.slug !== slug ||
      hold.uid !== uid || hold.slug !== slug || snapshot.gatewayId !== hold.toGatewayId ||
      ![hold.operationId, hold.fromGatewayId, hold.toGatewayId, hold.migrationId, hold.archiveId].every(value => typeof value === "string" && value.length > 0) ||
      !/^[a-f0-9]{64}$/u.test(hold.contextSha256)) throw new Error("Shared restore eviction hold is malformed");
  return hold.toGatewayId === gatewayId;
}

function toUserSnapshot(snapshot: FleetBrokerUserSnapshot): UserSnapshot {
  return {
    uid: snapshot.uid,
    slug: snapshot.slug,
    tier: snapshot.tier,
    gatewayId: snapshot.gatewayId,
    status: snapshot.status,
    agentIds: snapshot.agentIds,
    nativeSharedContextRestore: snapshot.nativeSharedContextRestore,
    repoUrl: snapshot.repoUrl,
    mattermostUserId: snapshot.mattermostUserId,
    channels: snapshot.channels,
    ownerName: snapshot.ownerName,
    timeZone: snapshot.timeZone ?? null,
    projectCheckoutScope: snapshot.projectCheckoutScope,
    projects: snapshot.projects,
    projectAgents: snapshot.projectAgents,
    byotActive: snapshot.byotActive,
    selectedTier: snapshot.selectedTier,
    subscription: snapshot.subscription,
    builderSubscription: snapshot.builderSubscription,
    trialGrant: snapshot.trialGrant,
    signupOfferConvertedAt: snapshot.signupOfferConvertedAt,
    freeTierModelRef: snapshot.freeTierModelRef,
    builderAgentDefault: snapshot.builderAgentDefault,
    systemConfig: snapshot.systemConfig,
  };
}

function ensureCustomerDirectories(slug: string): void {
  const dir = path.join(CUSTOMERS_DIR, slug);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".system"), { recursive: true });
}

async function writeCustomerTemplateFiles(ctx: CustomerContext): Promise<void> {
  fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
  writeTierTemplateFiles(ctx.customerDir, ctx.tier, ctx.templateVars);
}

async function listProjectsNeedingClone(
  ctx: BrokerCtx,
  slug: string,
): Promise<ProjectCloneTarget[]> {
  const snapshot = await snapshotForSlug(ctx, slug);
  if (!snapshot) return [];
  return (await Promise.all(snapshot.projects.map(async (p) => {
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return [];
    if (!projectCheckoutEnabled(p.checkoutEnabled)) {
      ctx.log(`[add:${slug}/${p.projectSlug}] project checkout is turned off by its owner`);
      return [];
    }
    const repoSource = projectRepoSourceFromDoc(p.repoSource);
    const target = {
      projectSlug: p.projectSlug,
      giteaRepoName: p.giteaRepoName,
      ...(repoSource ? { repoSource } : {}),
    };
    if (!repoSource && !p.giteaRepoName) {
      ctx.log(
        `[add:${slug}/${p.projectSlug}] ✖ no checkout source — the project has no Gitea repo and no GitHub repoSource`,
      );
      return [target];
    }
    if (
      projectCheckoutMatchesSource(
        slug,
        p.projectSlug,
        p.giteaRepoName ?? "",
        repoSource,
      )
      && customerRepositoryHasCanonicalRemote(
        path.join(CUSTOMERS_DIR, slug, "projects", p.projectSlug),
      )
    ) {
      await restoreBuilderProjectAssets(ctx, slug, p.projectSlug);
      return [];
    }
    return [target];
  }))).flat();
}

async function restoreBuilderProjectAssets(ctx: BrokerCtx, slug: string, project: string): Promise<void> {
  if (!ctx.isBuilderGateway() || !process.env.OCTOGEE_PROJECTS_MOUNT) return;
  const projects = path.join(CUSTOMERS_DIR, slug, "projects");
  if (await readProjectRestoreReady(path.join(projects, project), slug, project)) return;
  await prepareBuilderProjectAssets({ projects, slug, project, hydrate: createBrokeredProjectBlobHydrator(ctx.client), log: ctx.log });
}

async function cloneProjectRepoForTarget(
  ctx: BrokerCtx,
  customerSlug: string,
  projectSlug: string,
  giteaRepoName: string | null,
  opts?: ProjectCloneOptions,
): Promise<boolean> {
  const cloned = await cloneProjectRepo(customerSlug, projectSlug, giteaRepoName ?? "", opts);
  if (cloned) await restoreBuilderProjectAssets(ctx, customerSlug, projectSlug);
  return cloned;
}

function coachToken(
  mmUpdate: MmUpdate | null,
  brokerSnapshot: Awaited<ReturnType<typeof snapshotForUid>>,
): string | null {
  if (typeof mmUpdate?._coachPersonalToken === "string") {
    return mmUpdate._coachPersonalToken;
  }
  return brokerSnapshot?.coachToken ?? null;
}

async function materializeCustomerBrokerProfiles(
  agentIds: string[],
  slug: string,
  logFn: (message: string) => void,
  secretMaterial: SecretMaterialLedger,
  logPrefix = `[add:${slug}]`,
): Promise<void> {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const platformOpenAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  const materialized = await materializeBrokerProfilesForAgents(agentIds, {
    logFn,
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(platformOpenAiBaseUrl
      ? { openAi: openAiCatalogInputForBaseUrl(platformOpenAiBaseUrl) }
      : {}),
  });
  if (materialized.materialized > 0) {
    secretMaterial.note(brokerProfileMaterializationReason(materialized.materialized));
    logFn(`${logPrefix} broker model profiles materialized before config hot-reload`);
  }
  if (materialized.deferred.length > 0) {
    logFn(
      `${logPrefix} broker profile deferred for ${materialized.deferred.join(", ")}` +
        ` — ${materialized.deferralReason ?? "openclaw refused the secrets apply"};` +
        ` the post-boot sweep retries it`,
    );
  }
  if (materialized.deferred.length > 0) {
    throw new Error(`Agent model profiles are not ready: ${materialized.deferred.join(", ")}`);
  }
}

async function writeMountAccountSecrets(
  slug: string,
  accountId: string,
  coachPat: string,
  projectAgents: Parameters<typeof mattermostProjectAccountSecretChange>[1],
  evictionSlugs: readonly string[],
): Promise<{ changed: boolean }> {
  const projectSecretChange = mattermostProjectAccountSecretChange(slug, projectAgents);
  return updateMattermostAccountSecrets(OPENCLAW_DIR, {
    set: { [accountId]: coachPat, ...projectSecretChange.set },
    remove: [...projectSecretChange.remove, ...evictionSlugs.map((evicted) => `${evicted}-coach`)],
    removePrefixes: evictionSlugs.map((evicted) => `${evicted}-proj-`),
  });
}

function brokerProfileMaterializationReason(materialized: number): string | null {
  if (materialized === 0) return null;
  return `broker model profiles materialized for ${materialized} agent(s)`;
}

async function mountPatchSecretMaterialReasons(
  ctx: BrokerCtx,
  before: unknown,
  noop: boolean,
): Promise<string[]> {
  if (noop) return [];
  return configSecretMaterialChangeReasons(before, (await ctx.rpc.configGet()).config);
}

function agentIdsFromEntries(entries: ReadonlyArray<Record<string, unknown>>): string[] {
  return entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
}

function initialHouseCoachPatch(snapshot: UserSnapshot) {
  return byosCoachConfigPatch(platformCoachModelInputForUser(snapshot.slug, {
    ...snapshot,
    selectedTier: typeof snapshot.selectedTier === "string" ? snapshot.selectedTier : undefined,
  }));
}

function sharedByosubSuppressed(snapshot: UserSnapshot): boolean {
  if (snapshot.byotActive !== true || isConfiguredGatewayBuilder(snapshot.slug)) return false;
  const provider = snapshot.systemConfig?.byot?.provider;
  return provider !== undefined &&
    MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS[provider as keyof typeof MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS]?.mode === "oauth";
}

function customerModelCredentialsActive(snapshot: UserSnapshot): boolean {
  return snapshot.byotActive === true && !sharedByosubSuppressed(snapshot);
}

function initialCoachModelSelection(snapshot: UserSnapshot): BuilderAgentModelDefault | null {
  if (customerModelCredentialsActive(snapshot)) return null;
  const housePatch = initialHouseCoachPatch(snapshot);
  if (housePatch) return housePatch.agents.list[0].model as BuilderAgentModelDefault;
  const agentId = `octogee-${snapshot.slug}-coach`;
  return snapshot.systemConfig?.agentModels?.[agentId]
    ?? parseBuilderAgentModelDefault(snapshot.builderAgentDefault);
}

function initialCoachTools(snapshot: UserSnapshot, current: unknown) {
  if (customerModelCredentialsActive(snapshot)) return current;
  const tools = initialHouseCoachPatch(snapshot)?.agents.list[0].tools;
  return tools ? convergedCoachToolsValue(current, tools) : current;
}

function platformModelDefaults(
  selection: BuilderAgentModelDefault | null,
): Record<string, object> | null {
  if (!selection) return null;
  const refs = [selection.primary, ...selection.fallbacks].filter(isPlatformProviderRef);
  return refs.length > 0 ? Object.fromEntries(refs.map((ref) => [ref, {}])) : null;
}

function customerAgentDefaults(
  current: unknown,
  coachModelDefaults: Record<string, object> | null,
  builderGateway: boolean,
): Record<string, unknown> {
  if (builderGateway) {
    return {
      ...(coachModelDefaults ? { models: coachModelDefaults } : {}),
      authInheritance: { agentId: SAFE_DEFAULT_AGENT_ID },
    };
  }
  const platform = platformModelAllowlistPatch(current, false).agents.defaults;
  const models = { ...platform.models };
  for (const [ref, definition] of Object.entries(coachModelDefaults ?? {})) {
    if (models[ref] === undefined) models[ref] = definition;
  }
  return { models, modelPolicy: platform.modelPolicy };
}

function customerGatewayAgentRoster(
  current: unknown,
  slug: string,
  customerAgentEntries: readonly unknown[],
  builderGateway: boolean,
): unknown[] {
  const nextAgents = replaceCustomerAgentsInFullAgentList(
    current,
    slug,
    preserveMountedAgentModels(current, customerAgentEntries),
  );
  const roster = gatewayAgentRoster(nextAgents, builderGateway ? slug : "");
  return builderGateway
    ? orderBuilderGatewayRoster(
      [...roster, buildSafeDefaultAgent()],
      `octogee-${slug}-coach`,
      SAFE_DEFAULT_AGENT_ID,
    )
    : roster;
}

function convergedConfigRpc(ctx: BrokerCtx): BrokerCtx["rpc"] {
  return {
    ...ctx.rpc,
    configPatch: (
      patch: object,
      baseHash: string,
      options?: { replacePaths?: readonly string[] },
    ) => ctx.rpc.configPatchAndWaitForChange(patch, baseHash, options),
  };
}

async function captureRoutingActivationBaseline(
  ctx: BrokerCtx,
  accountId: string,
  projectAccounts: Readonly<Record<string, unknown>>,
): Promise<{ accountIds: string[]; baseline: Record<string, number> }> {
  const accountIds = [accountId, ...Object.keys(projectAccounts)];
  return {
    accountIds,
    baseline: await captureMattermostRoutingActivationBaseline(ctx.rpc, accountIds),
  };
}

async function reloadRuntimeSecretsIfChanged(
  ctx: BrokerCtx,
  logPrefix: string,
  ledger: SecretMaterialLedger,
  signal?: AbortSignal,
): Promise<void> {
  if (!ledger.changed) {
    ctx.log(`${logPrefix} secrets.reload skipped — no secret material changed`);
    return;
  }
  const precedingWrites = ledger.reasons.join("; ");
  ctx.log(`${logPrefix} secrets.reload — ${precedingWrites}`);
  await reloadRuntimeSecrets(ctx, logPrefix, { precedingWrites, signal });
}

function isSecretsReloadUnavailable(error: unknown): boolean {
  if (!(error instanceof OpenclawWireError) || error.code !== "rpc-error") return false;
  const details = error.details as { serverCode?: unknown } | undefined;
  return details?.serverCode === "UNAVAILABLE";
}

async function secretsReloadAfterSupersession(
  ctx: BrokerCtx,
  logPrefix: string,
  opts: { precedingWrites?: string; signal?: AbortSignal },
): Promise<Awaited<ReturnType<GatewayRpcClient["secretsReload"]>>> {
  try {
    return await ctx.rpc.secretsReload();
  } catch (error) {
    if (!isSecretsReloadUnavailable(error)) throw error;
    ctx.log(
      `${logPrefix} ⚠ secrets.reload refused (${String(error)}); waiting for the newer config write to apply, then reloading once more`,
    );
  }
  await waitForAppliedConfigRevision(ctx.rpc, "", {
    signal: opts.signal,
    logPrefix,
    acceptSupersedingRevision: true,
  });
  try {
    return await ctx.rpc.secretsReload();
  } catch (error) {
    if (!isSecretsReloadUnavailable(error)) throw error;
    throw new Error(
      `${logPrefix} secrets.reload was refused twice after: ${opts.precedingWrites ?? "an unrecorded config write"} ` +
        `(${String(error)}; the gateway log names the superseding write)`,
      { cause: error },
    );
  }
}

async function reloadRuntimeSecrets(
  ctx: BrokerCtx,
  logPrefix: string,
  opts: { precedingWrites?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const result = await secretsReloadAfterSupersession(ctx, logPrefix, opts);
  const warningCount = result.warningCount ?? 0;
  if (result.ok !== true) {
    throw new Error(`${logPrefix} secrets.reload did not acknowledge success`);
  }
  if (warningCount === 0) {
    ctx.log(`${logPrefix} secrets.reload complete`);
    return;
  }
  const warningLabel = warningCount === 1 ? "warning" : "warnings";
  ctx.log(`${logPrefix} secrets.reload complete with ${warningCount} ${warningLabel}`);
}

function throwIfConfigApplicationWaitAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("config application wait aborted");
}

export async function waitForAppliedConfigRevision(
  rpc: Pick<GatewayRpcClient, "configGet">,
  slug: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    logPrefix?: string;
    /** Settle once the runtime has applied whatever revision is current, instead of
     *  the exact revision observed first. Revisions are cumulative, so an additive
     *  write from a concurrent lane never fails this wait. */
    acceptSupersedingRevision?: boolean;
  } = {},
): Promise<void> {
  const logPrefix = opts.logPrefix ?? `[import:${slug}]`;
  const timeoutMs = opts.timeoutMs ?? CONFIG_PATCH_DEADLINE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastReadError: string | null = null;
  let targetRevisionHash: string | null = null;
  let appliedConfigHash: string | null = null;
  const idle = (): Promise<void> => new Promise<void>((resolve) =>
    setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now()))));
  // The patch this waits on is what makes the runtime reload, and a reloading
  // runtime refuses the socket every poll opens. A read that fails is therefore
  // the expected shape of "not applied yet", not a failed import.
  const readSnapshot = async (): Promise<ConfigGetResult | null> => {
    throwIfConfigApplicationWaitAborted(opts.signal);
    try {
      const snapshot = await rpc.configGet();
      throwIfConfigApplicationWaitAborted(opts.signal);
      return snapshot;
    } catch (error) {
      throwIfConfigApplicationWaitAborted(opts.signal);
      if (!(error instanceof OpenclawWireError &&
          (error.code === "connect-failed" || error.code === "timeout"))) throw error;
      lastReadError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const observe = (snapshot: ConfigGetResult): boolean => {
    if (opts.acceptSupersedingRevision) {
      targetRevisionHash = snapshot.configRevisionHash;
    } else {
      targetRevisionHash ??= snapshot.configRevisionHash;
      if (snapshot.configRevisionHash !== targetRevisionHash) {
        throw new Error(
          `${logPrefix} config revision changed while waiting ` +
            `(expected=${targetRevisionHash}, observed=${snapshot.configRevisionHash})`,
        );
      }
    }
    appliedConfigHash = snapshot.appliedConfigHash;
    return targetRevisionHash === appliedConfigHash;
  };
  for (;;) {
    const snapshot = await readSnapshot();
    if (snapshot !== null && observe(snapshot)) return;
    if (Date.now() >= deadline) break;
    await idle();
  }
  if (targetRevisionHash === null) {
    throw new Error(
      `${logPrefix} config revision was unreadable for ${timeoutMs}ms: ${lastReadError}`,
    );
  }
  throw new Error(
    `${logPrefix} active config did not reach revision ${targetRevisionHash} ` +
      `within ${timeoutMs}ms (applied=${appliedConfigHash ?? lastReadError ?? "none"})`,
  );
}

async function requiredCoachMattermostAccount(
  ctx: BrokerCtx,
  slug: string,
  account: ReturnType<typeof buildMattermostAccounts>[string] | undefined,
) {
  if (account) return account;
  await quarantineMalformedCoachMattermostAccount(slug, convergedConfigRpc(ctx), ctx.configCache, ctx.log);
  throw new Error(`[add:${slug}] fleet broker account fragment was empty`);
}

function projectMountPolicy(
  current: unknown,
  patch: Record<string, unknown>,
  snapshot: UserSnapshot,
  builderGateway: boolean,
): Record<string, unknown> {
  if (builderGateway || customerModelCredentialsActive(snapshot)) return patch;
  return customerMountConfigPatch(current, patch, snapshot.slug, mountSafeModelRef(snapshot), {
    gatewayEnv: process.env,
    forceSafeAll: sharedByosubSuppressed(snapshot),
  });
}

function mountSafeModelRef(snapshot: UserSnapshot): string {
  const selected = initialCoachModelSelection(snapshot)?.primary;
  if (selected && catalogEntryForModelRef(selected)) return selected;
  return parseBuilderAgentModelDefault(snapshot.builderAgentDefault)?.primary
    ?? DEFAULT_FREE_TIER_MODEL_REF;
}

function buildCustomerProjectAgents(
  snapshot: UserSnapshot,
  projectAgents: NonNullable<UserSnapshot["projectAgents"]>,
  identity: ReturnType<typeof resolveCoachIdentity>,
  ownerMmUserId: string | null | undefined,
  builderGateway: boolean,
): Array<Record<string, unknown>> {
  return buildProjectAgents({
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentsDir: AGENTS_DIR,
    coach: { name: identity.name, emoji: identity.emoji, model: DEFAULT_COACH.model },
    projectAgents,
    ownerMmUserId,
    hostCode: builderGateway ? "builder-full" : "customer-restricted",
  });
}

function pendingProjectActivationAccountIds(slug: string, projectAgents: NonNullable<UserSnapshot["projectAgents"]>): string[] {
  return projectAgents.filter((agent) => agent.enabled && agent.status === "provisioning" && agent.activationId && agent.token)
    .map((agent) => `${slug}-proj-${agent.projectId}`);
}

function markPendingProjectActivations(reason: string, accountIds: string[], baseline: Record<string, number>): boolean {
  if (accountIds.length === 0) return false;
  markMattermostRoutingActivationPending(OPENCLAW_DIR, reason, accountIds, baseline);
  return true;
}

function mountMattermostAccountsPatch(
  current: unknown,
  slug: string,
  evictionSlugs: string[],
  customerAccounts: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...customerAccounts,
    ...staleProjectAgentAccountNulls(current, slug, Object.keys(customerAccounts)),
    ...(evictionSlugs.length > 0
      ? buildRemoveCustomerAccountsPatch(current, evictionSlugs).channels.mattermost.accounts
      : {}),
  };
}

function buildCoachAgentEntry(
  snapshot: UserSnapshot,
  coach: {
    agentId: string;
    identity: ReturnType<typeof resolveCoachIdentity>;
    customerMmUserId: string | null | undefined;
    builderGateway: boolean;
    modelSelection: BuilderAgentModelDefault | null;
  },
): ReturnType<typeof buildCustomerAgent> {
  const agentEntry = buildCustomerAgent({
    uid: snapshot.uid,
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentDir: path.join(AGENTS_DIR, coach.agentId, "agent"),
    coach: { name: coach.identity.name, emoji: coach.identity.emoji, model: DEFAULT_COACH.model },
    customerMmUserId: coach.customerMmUserId,
    default: coach.builderGateway,
    hostCode: coach.builderGateway ? "builder-full" : "customer-restricted",
    ...(platformOpenAiEmbeddingsEnabled()
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(coach.agentId) }
      : {}),
  });
  if (coach.modelSelection) agentEntry.model = coach.modelSelection;
  agentEntry.tools = initialCoachTools(snapshot, agentEntry.tools);
  return agentEntry;
}

async function applyAddCustomerConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: AddCustomerConfigPatchOptions,
): Promise<{ elapsedMs: number; appliedFingerprint?: string }> {
  let evictionSlugs = evictionSlugsExcept(snapshot.slug, callOpts?.evictionBatch);
  const builderGateway = isConfiguredGatewayBuilder(snapshot.slug);
  const brokerSnapshot = await snapshotForUidWithProjectMembershipIsolation(ctx, snapshot.uid);
  const coachPat = coachToken(mmUpdate, brokerSnapshot);
  if (!coachPat) {
    throw new Error(`[add:${snapshot.slug}] coach PAT unavailable from fleet broker`);
  }
  const identity = resolveCoachIdentity(brokerSnapshot?.coachIdentity, DEFAULT_COACH);
  const projectAgents = brokerProjectAgents(brokerSnapshot, snapshot, callOpts?.withoutProjectIds);
  const accountsMap = buildMattermostAccounts(
    [
      {
        uid: snapshot.uid,
        slug: snapshot.slug,
        customerMmUserId: brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
        channels: snapshot.channels,
        agentProjects: activeAgentProjectIds(projectAgents),
      },
    ],
    new Map([[snapshot.uid, coachPat]]),
    (m) => ctx.log(m),
  );
  const accountId = `${snapshot.slug}-coach`;
  const accountEntry = await requiredCoachMattermostAccount(ctx, snapshot.slug, accountsMap[accountId]);
  const agentId = `octogee-${snapshot.slug}-coach`;
  const coachModelSelection = initialCoachModelSelection(snapshot);
  const coachModelDefaults = platformModelDefaults(coachModelSelection);
  const agentEntry = buildCoachAgentEntry(snapshot, {
    agentId,
    identity,
    customerMmUserId: brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
    builderGateway,
    modelSelection: coachModelSelection,
  });
  const projectAgentEntries = buildCustomerProjectAgents(snapshot, projectAgents, identity,
    brokerCustomerMattermostUserId(brokerSnapshot, snapshot), builderGateway);
  const brokerAgentIds = [agentId, ...agentIdsFromEntries(projectAgentEntries)];
  await Promise.all(
    brokerAgentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })),
  );
  evictionSlugs = await currentEvictionSlugs(
    snapshot.slug,
    evictionSlugs,
    callOpts?.currentEvictionBatch,
  );
  const secretMaterial = ctx.pendingRuntimeSecrets.get(snapshot.slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(snapshot.slug, secretMaterial);
  secretMaterial.noteIf(
    (await writeMountAccountSecrets(snapshot.slug, accountId, coachPat, projectAgents, evictionSlugs)).changed,
    "Mattermost account secrets file changed",
  );
  const projectAccounts = buildProjectAgentAccounts(
    snapshot.slug,
    projectAgents,
    brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
  );
  const bindings = buildCustomerBindings([
    {
      slug: snapshot.slug,
      channels: snapshot.channels,
      agentProjects: activeAgentProjectIds(projectAgents),
    },
  ]);
  let routingActivationRequired = mattermostRoutingActivationPending(OPENCLAW_DIR);
  const routingActivationReason = `[add:${snapshot.slug}] account-level Mattermost binding changed`;
  const customerAgentEntries = [agentEntry, ...projectAgentEntries];
  await callOpts?.brokerProfilesReady;
  await reconcileCustomerRosterAgents(
    ctx,
    snapshot.slug,
    evictionSlugs,
    brokerAgentIds,
    customerAgentEntries,
  );
  await materializeCustomerBrokerProfiles(brokerAgentIds, snapshot.slug, ctx.log, secretMaterial);
  const { accountIds: affectedAccountIds, baseline: routingActivationBaseline } = await
    captureRoutingActivationBaseline(ctx, accountId, projectAccounts);
  const pendingProjectAccountIds = pendingProjectActivationAccountIds(snapshot.slug, projectAgents);
  routingActivationRequired = markPendingProjectActivations(routingActivationReason, pendingProjectAccountIds, routingActivationBaseline)
    || routingActivationRequired;
  const startedAt = Date.now();
  let configBefore: unknown;
  const configPatch = await applyConfigPatch(
    {
      buildPatch: (current) => {
        configBefore = current;
        const currentCfg = current as { bindings?: Array<{ agentId?: unknown }> };
        const currentBindings = Array.isArray(currentCfg.bindings) ? currentCfg.bindings : [];
        const missingAccountIds = mattermostAccountBindingsNeedingActivation(
          currentBindings,
          bindings,
        );
        if (missingAccountIds.length > 0) {
          markMattermostRoutingActivationPending(
            OPENCLAW_DIR,
            routingActivationReason,
            missingAccountIds,
            routingActivationBaseline,
          );
          routingActivationRequired = true;
        }
        const agentDefaults = customerAgentDefaults(current, coachModelDefaults, builderGateway);
        const roster = customerGatewayAgentRoster(
          current,
          snapshot.slug,
          customerAgentEntries,
          builderGateway,
        );
        const ownerCommands = builderGateway
          ? builderOwnerCommandsPatch(current, snapshot.slug, brokerCustomerMattermostUserId(brokerSnapshot, snapshot))
          : undefined;
        const mountPatch = {
          ...(ownerCommands ? { commands: ownerCommands } : {}),
          agents: {
            ownership: "explicit",
            defaults: agentDefaults,
            ...customerAgentRosterPatch(
              current,
              snapshot.slug,
              rebindPlatformEmbeddingRefs(roster),
            ),
          },
          bindings: mergeCustomerBindings(
            currentBindings,
            [snapshot.slug, ...evictionSlugs],
            bindings,
          ),
          channels: {
            mattermost: {
              accounts: mountMattermostAccountsPatch(current, snapshot.slug, evictionSlugs,
                mattermostAccountEndpointsForTarget(current, {
                  [accountId]: accountEntry,
                  ...projectAccounts,
                }, !ctx.isBuilderGateway()),
              ),
            },
          },
        };
        return projectMountPolicy(current, mountPatch, snapshot, builderGateway);
      },
      buildReplacePaths: (current) => [...new Set([
        ...[snapshot.slug, ...evictionSlugs].flatMap((slug) =>
          customerConfigAgentRosterReplacePaths(current, slug)
        ),
        ...(builderGateway ? [] : [PLATFORM_MODEL_POLICY_ALLOW_PATH]),
        ...(!builderGateway && !customerModelCredentialsActive(snapshot)
          ? customerSecurityProjectionReplacePaths(current) : []),
      ])],
      logPrefix: `[add:${snapshot.slug}]`,
    },
    {
      rpc: convergedConfigRpc(ctx),
      cache: ctx.configCache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      signal: callOpts?.signal,
    },
  );
  secretMaterial.note(
    await mountPatchSecretMaterialReasons(ctx, configBefore, configPatch.noop === true),
  );
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents, channels: snapshot.channels, baseline: routingActivationBaseline,
    secretMaterial, signal: callOpts?.signal,
    activate: () => activateMattermostRoutingAfterConfigPatch(ctx.rpc, OPENCLAW_DIR, ctx.log, {
      accountIds: affectedAccountIds,
      baseline: routingActivationBaseline,
      configNoop: configPatch.noop === true,
      required: routingActivationRequired,
      reason: routingActivationReason,
      currentSlug: snapshot.slug,
      evictionSlugs,
      restartAccountIds: pendingProjectAccountIds,
    }),
  });
  for (const slug of evictionSlugs) ctx.configRemovedForEviction.add(slug);
  return {
    elapsedMs: Date.now() - startedAt,
    ...(brokerSnapshot
      ? { appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) }
      : {}),
  };
}

async function settleProjectAgentActivations(
  ctx: BrokerCtx,
  input: {
    snapshot: UserSnapshot;
    projectAgents: NonNullable<UserSnapshot["projectAgents"]>;
    channels: UserSnapshot["channels"];
    baseline: Readonly<Record<string, number>>;
    secretMaterial: SecretMaterialLedger;
    signal?: AbortSignal;
    activate(): Promise<void>;
  },
): Promise<void> {
  const errors: unknown[] = [];
  await reloadRuntimeSecretsIfChanged(ctx, `[add:${input.snapshot.slug}]`, input.secretMaterial, input.signal);
  if (ctx.pendingRuntimeSecrets.get(input.snapshot.slug) === input.secretMaterial) {
    ctx.pendingRuntimeSecrets.delete(input.snapshot.slug);
  }
  try {
    await input.activate();
  } catch (error) {
    errors.push(error);
  }
  try {
    await reportProjectAgentReadiness({
      rpc: ctx.rpc, report: (uid, projects) => ctx.client.reportProjectAgentReadiness(uid, projects),
      uid: input.snapshot.uid, slug: input.snapshot.slug, projectAgents: input.projectAgents,
      channels: input.channels, baseline: input.baseline,
    });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    throw new AggregateError(errors, `Project Agent runtime activation did not complete: ${details}`);
  }
}

async function reconcileConfiguredBuilderProjectAgents(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  options: { withoutProjectIds?: readonly string[]; signal?: AbortSignal } = {},
): Promise<{ elapsedMs: number; appliedFingerprint?: string }> {
  const startedAt = Date.now();
  const brokerSnapshot = await snapshotForUidWithProjectMembershipIsolation(ctx, snapshot.uid);
  if (!brokerSnapshot) throw new Error(`Project Agent snapshot unavailable for ${snapshot.slug}`);
  const current = await freshRosterConfig(ctx);
  const managedProjectIds = configuredBuilderManagedProjectIds(readOpenClawConfig(), snapshot.slug,
    (brokerSnapshot.projectAgents ?? []).map((agent) => agent.projectId));
  if (managedProjectIds.length === 0) {
    if (Object.keys(configuredBuilderWorkspacePatch(current, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels)).length > 0) {
      await applyConfigPatch({
        buildPatch: (latest) => configuredBuilderWorkspacePatch(latest, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels),
        buildReplacePaths: (latest) => configuredBuilderWorkspacePatch(latest, snapshot.slug, brokerSnapshot.customerMmUserId, brokerSnapshot.channels).bindings ? ["bindings"] : [],
        logPrefix: `[project-agents:${snapshot.slug}]`,
      }, { rpc: convergedConfigRpc(ctx), cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS, signal: options.signal });
    }
    return { elapsedMs: Date.now() - startedAt, appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) };
  }
  const projectAgents = brokerProjectAgents(brokerSnapshot, snapshot, options.withoutProjectIds);
  const identity = resolveCoachIdentity(brokerSnapshot.coachIdentity, DEFAULT_COACH);
  const projectAgentEntries = buildCustomerProjectAgents(snapshot, projectAgents, identity, brokerSnapshot.customerMmUserId, true);
  const projectAccounts = buildProjectAgentAccounts(snapshot.slug, projectAgents, brokerSnapshot.customerMmUserId);
  const patchInput = {
    slug: snapshot.slug, managedProjectIds, projectAgentEntries, projectAccounts, channels: brokerSnapshot.channels,
    ownerMmUserId: brokerSnapshot.customerMmUserId,
    activationProjectIds: projectAgents.filter((agent) => agent.status === "provisioning" && agent.activationId).map((agent) => agent.projectId),
  };
  const logPrefix = `[project-agents:${snapshot.slug}]`;
  const initial = configuredBuilderProjectAgentPatch(current, patchInput);
  await releaseAgentsAndInvalidateCache(ctx, initial.retiredAgentIds, logPrefix, { purgeStore: true });
  await ensureCustomerRosterAgents(ctx, projectAgentEntries, logPrefix);
  const agentIds = agentIdsFromEntries(projectAgentEntries);
  await Promise.all(agentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })));
  const secretMaterial = ctx.pendingRuntimeSecrets.get(snapshot.slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(snapshot.slug, secretMaterial);
  await materializeCustomerBrokerProfiles(agentIds, snapshot.slug, ctx.log, secretMaterial);
  const projectSecrets = mattermostProjectAccountSecretChange(snapshot.slug, projectAgents);
  const setSecrets = await updateMattermostAccountSecrets(OPENCLAW_DIR, { set: projectSecrets.set });
  secretMaterial.noteIf(setSecrets.changed, "Mattermost account secrets file changed");
  const pendingAccountIds = pendingProjectActivationAccountIds(snapshot.slug, projectAgents);
  const baseline = pendingAccountIds.length > 0
    ? await captureMattermostRoutingActivationBaseline(ctx.rpc, pendingAccountIds)
    : {};
  let configBefore: unknown;
  const configPatch = await applyConfigPatch({
    buildPatch: (current) => {
      configBefore = current;
      return configuredBuilderProjectAgentPatch(current, patchInput).patch;
    },
    buildReplacePaths: (current) => configuredBuilderProjectAgentPatch(current, patchInput).replacePaths,
    logPrefix,
  }, { rpc: convergedConfigRpc(ctx), cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS, signal: options.signal });
  secretMaterial.note(
    await mountPatchSecretMaterialReasons(ctx, configBefore, configPatch.noop === true),
  );
  const retiredAccountIds = managedProjectIds.map((projectId) => `${snapshot.slug}-proj-${projectId}`)
    .filter((accountId) => !projectAccounts[accountId]);
  for (const accountId of retiredAccountIds) await ctx.rpc.channelsStop({ channel: "mattermost", accountId });
  const removedSecrets = await updateMattermostAccountSecrets(OPENCLAW_DIR, { remove: [...new Set([...projectSecrets.remove, ...retiredAccountIds])] });
  secretMaterial.noteIf(removedSecrets.changed, "Mattermost account secrets file changed");
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents, channels: brokerSnapshot.channels, baseline, secretMaterial, signal: options.signal,
    activate: async () => {
      if (pendingAccountIds.length === 0) return;
      markMattermostRoutingActivationPending(OPENCLAW_DIR, logPrefix, pendingAccountIds, baseline);
      await activatePendingMattermostRouting(ctx.rpc, OPENCLAW_DIR, ctx.log, { restartAccountIds: pendingAccountIds });
    },
  });
  return { elapsedMs: Date.now() - startedAt, appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) };
}

async function removeCustomerAccountsWhileStillEvicted(
  ctx: BrokerCtx,
  slug: string,
  slugs: readonly string[],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): Promise<void> {
  const logPrefix = `[remove:${slug}]`;
  let batch = slugs;
  try {
    await applyConfigPatch(
      {
        buildPatch: (current) => buildRemoveCustomerAccountsPatch(current, batch),
        buildReplacePaths: (current) => [...new Set(
          batch.flatMap((batchSlug) => customerConfigReplacePaths(current, batchSlug)),
        )],
        logPrefix,
        beforeRetry: currentEvictionBatch && (async () => {
          const stillEvicted = new Set(await currentEvictionBatch());
          const desiredAgain = batch.filter((batchSlug) => !stillEvicted.has(batchSlug));
          if (desiredAgain.length > 0) {
            ctx.log(`${logPrefix} ${desiredAgain.join(",")} desired on this gateway again — not removing on retry`);
          }
          batch = batch.filter((batchSlug) => stillEvicted.has(batchSlug));
          return batch.length > 0;
        }),
      },
      {
        rpc: convergedConfigRpc(ctx),
        cache: ctx.configCache,
        totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      },
    );
  } catch (err) {
    if (batch.length > 0) throw err;
  }
}

async function applyRemoveCustomerConfigPatch(
  ctx: BrokerCtx,
  slug: string,
  _agentId: string,
  evictionBatch?: readonly string[],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const slugs = [...new Set([slug, ...(evictionBatch ?? [])])];
  if (!ctx.configRemovedForEviction.has(slug)) {
    await deleteDepartingCustomerAgents(ctx, slugs, `[remove:${slug}]`);
    await removeCustomerAccountsWhileStillEvicted(ctx, slug, slugs, currentEvictionBatch);
    for (const batchSlug of slugs) ctx.configRemovedForEviction.add(batchSlug);
  }
  const remaining = currentEvictionBatch
    ? [...new Set(await currentEvictionBatch())].filter((batchSlug) => slugs.includes(batchSlug))
    : slugs;
  if (remaining.length > 0) {
    await stopStaleMattermostRoutingAccounts(ctx.rpc, {
      currentSlug: remaining[0]!,
      desiredAccountIds: [],
      evictionSlugs: remaining.slice(1),
    }, dlog);
    discardMattermostRoutingActivationForCustomers(OPENCLAW_DIR, remaining);
  }
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    remove: remaining.map((batchSlug) => `${batchSlug}-coach`),
    removePrefixes: remaining.map((batchSlug) => `${batchSlug}-proj-`),
  });
  ctx.configRemovedForEviction.delete(slug);
  return remaining;
}

async function waitForAccountHealthy(
  ctx: BrokerCtx,
  { slug, timeoutMs }: { slug: string; timeoutMs: number },
): Promise<boolean> {
  const accountId = `${slug}-coach`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const snapshot = (await ctx.rpc.channelsStatus()) as {
        channelAccounts?: Record<string, Array<{ accountId?: string; running?: boolean; connected?: boolean }>>;
      };
      const entry = (snapshot.channelAccounts?.mattermost ?? []).find(
        (a) => a.accountId === accountId,
      );
      if (entry?.running === true && entry.connected === true) return true;
    } catch (err) {
      ctx.log(
        `[verify:${slug}] attempt=${attempt} channels.status threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, Math.min(2_000 * attempt, 5_000)));
  }
  return false;
}

async function logActivatedCoachModel(ctx: BrokerCtx, slug: string): Promise<void> {
  if (logLevel() !== "debug") return;
  try {
    const agentId = customerCoachAgentId(slug);
    const { config } = await ctx.rpc.configGet();
    const agent = (config as { agents?: { entries?: Record<string, { model?: unknown }> } }).agents?.entries?.[agentId];
    ctx.log(
      `[import:${slug}] post-activation coach model=${JSON.stringify(agent?.model ?? null)} (config-patch hot-reload)`,
    );
  } catch (err) {
    ctx.log(
      `[import:${slug}] post-activation coach model diagnostic unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function quiesceCustomer(
  ctx: BrokerCtx,
  slug: string,
  timeoutMs: number,
  opts: { stopMattermost: boolean; schedulerMigrationId?: string; retainNonportable?: boolean } = { stopMattermost: true },
): Promise<{ drained: boolean; runningCount: number }> {
  const agentIds = agentIdsForMigration(slug);
  if (opts.stopMattermost) {
    if (!opts.schedulerMigrationId) await assertCustomerHasNoScheduledJobs(ctx.rpc, slug, agentIds);
    await setCustomerChannelsRunning(ctx.rpc, slug, false);
  }
  const result = await quiesceCustomerSessionsBounded({
    rpc: ctx.rpc,
    slug,
    agentIds,
    stores: sessionPathsForMigration(slug).map(sessionStoreForPath),
    maxWaitMs: timeoutMs,
    abortAfterGrace: false,
    ...(opts.stopMattermost
      ? {
        schedulerMigrationId: opts.schedulerMigrationId,
        retainNonportable: opts.retainNonportable,
        graceMs: Math.min(MIGRATION_QUIESCE_GRACE_MS, timeoutMs),
        recheckMs: Math.min(MIGRATION_QUIESCE_STOP_RECHECK_MS, timeoutMs),
      }
      : { graceMs: Math.min(MIGRATION_QUIESCE_GRACE_MS, timeoutMs), abortAfterGrace: false }),
    log: dlog,
  });
  if (result.drained && opts.stopMattermost && !opts.schedulerMigrationId) {
    await assertCustomerHasNoScheduledJobs(ctx.rpc, slug, agentIds);
  }
  return { drained: result.drained, runningCount: result.runningCount };
}

function sessionPathsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  if (isConfiguredGatewayBuilder(slug)) {
    const plan = configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir);
    assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, plan);
    return plan.sessionStorePaths.map((relativePath) =>
      path.join(stateDir, ...relativePath.split("/")));
  }
  return agentIdsForMigration(slug).map((agentId) =>
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json"));
}


function agentIdsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  if (isConfiguredGatewayBuilder(slug)) {
    const plan = configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir);
    assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, plan);
    return plan.agentIds;
  }
  return sharedMigrationAgentIds(stateDir, slug);
}

interface AgentStateRelease {
  releaseAgents: (agentIds: readonly string[]) => Promise<void>;
  procRoot: string;
}

async function releaseAgentState(
  agentIds: readonly string[],
  release: AgentStateRelease,
  heldPathOptions: HeldPathOptions = {},
): Promise<string[]> {
  const stateDir = resolveOpenClawStateDir();
  const agentDirs = agentIds.map((agentId) => path.join(stateDir, "agents", agentId));
  await release.releaseAgents(agentIds);
  for (const agentDir of agentDirs) await assertNotHeld(matchUnder(agentDir), release.procRoot, heldPathOptions);
  return agentDirs;
}

async function removeAgentDirs(agentDirs: readonly string[]): Promise<void> {
  for (const agentDir of agentDirs) await fsp.rm(agentDir, { recursive: true, force: true });
}

async function listExportPaths(slug: string): Promise<Array<{ cwd: string; path: string }>> {
  const stateDir = resolveOpenClawStateDir();
  const builderPlan = isConfiguredGatewayBuilder(slug)
    ? configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, builderPlan);
  if (!builderPlan && stateDir === OPENCLAW_DIR) return sharedMigrationExportPaths(stateDir, slug);
  const candidates = [
    ...(builderPlan
      ? builderPlan.paths
        .filter((item) => !isSafeDefaultAgentPortableStatePath(item.relativePath))
        .map((item) => ({ cwd: stateDir, path: item.relativePath }))
      : [
        ...agentIdsForMigration(slug).map((agentId) => ({
          cwd: stateDir,
          path: path.join("agents", agentId),
        })),
      ]),
    ...await customerFileStatePaths(OPENCLAW_DIR, slug),
  ];
  const sources: Array<{ cwd: string; path: string }> = [];
  for (const c of candidates) {
    try {
      await fsp.access(path.join(c.cwd, c.path));
      sources.push(c);
    } catch {
      // Partial local state is valid.
    }
  }
  return sources;
}

async function prepareImportDir(
  slug: string,
  mode: CustomerStateImportMode,
  release: AgentStateRelease,
): Promise<string> {
  const stateDir = resolveOpenClawStateDir();
  const builderPlan = isConfiguredGatewayBuilder(slug)
    ? configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, builderPlan);
  const wipeState = mode !== "final" && !builderPlan;
  if (wipeState) await removeAgentDirs(await releaseAgentState(agentIdsForMigration(slug), release));
  const wipePaths = !wipeState ? [] : [
    path.join(OPENCLAW_DIR, "customers", slug),
    path.join(OPENCLAW_DIR, MIGRATION_ACTIVATION_DIR, slug),
  ];
  if (mode === "default" && !builderPlan) {
    wipePaths.push(path.join(OPENCLAW_DIR, "customer-keys", slug));
  }
  for (const p of wipePaths) {
    await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  await fsp.mkdir(path.join(stateDir, "agents"), { recursive: true });
  if (builderPlan) {
    for (const relativeAgentDir of builderPlan.agentDirs) {
      await fsp.mkdir(path.join(stateDir, ...relativeAgentDir.split("/")), {
        recursive: true,
        mode: 0o700,
      });
    }
    assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, builderPlan);
  } else if (mode !== "final") {
    await fsp.mkdir(path.join(stateDir, "agents", customerCoachAgentId(slug), "agent"), {
      recursive: true,
    });
  }
  await fsp.mkdir(CUSTOMERS_DIR, { recursive: true });
  await fsp.mkdir(CUSTOMER_KEYS_DIR, { recursive: true });
  return OPENCLAW_DIR;
}

async function prepareKeyImportDir(slug: string): Promise<string> {
  await fsp.rm(path.join(OPENCLAW_DIR, "customer-keys", slug), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  await fsp.mkdir(CUSTOMER_KEYS_DIR, { recursive: true });
  return OPENCLAW_DIR;
}

async function activateImportedCustomer(
  ctx: BrokerCtx,
  slug: string,
  opts: { signal?: AbortSignal } | undefined,
): Promise<{ appliedFingerprint: string; verificationPending?: string }> {
  const manifest = await readActivationManifest(OPENCLAW_DIR, slug);
  const configuredBuilder = isConfiguredGatewayBuilder(slug);
  const ownerMmUserId = configuredBuilder
    ? validOwnerMmUserId(slug, (await snapshotForSlug(ctx, slug))?.customerMmUserId)
    : undefined;
  if (configuredBuilder) {
    ctx.log(`[import:${slug}] waiting for the Builder control runtime before roster activation`);
    await waitForAppliedConfigRevision(ctx.rpc, slug, {
      timeoutMs: BUILDER_IMPORT_STARTUP_TIMEOUT_MS,
      signal: opts?.signal,
      acceptSupersedingRevision: true,
    });
    ctx.log(`[import:${slug}] Builder control runtime is ready for roster activation`);
  }
  const secretMaterial = ctx.pendingRuntimeSecrets.get(slug) ?? createSecretMaterialLedger();
  ctx.pendingRuntimeSecrets.set(slug, secretMaterial);
  const { manifest: safeManifest, secretsChanged } = await materializeActivationManifestSecret(
    OPENCLAW_DIR,
    manifest,
  );
  secretMaterial.noteIf(secretsChanged, "Mattermost account secrets file changed");
  const routingActivationReason = `[import:${slug}] account-level Mattermost binding changed`;
  setRepoSshCommand(path.join(CUSTOMERS_DIR, slug), slug);
  ctx.log(`[import:${slug}] canonical workspace Git metadata ready`);
  await deleteSupersededCustomerAgents(ctx, {
    slug,
    evictionSlugs: [],
    keepAgentIds: activationManifestAgentIds(safeManifest),
    logPrefix: `[import:${slug}]`,
    purpose: "import",
  });
  await ensureCustomerRosterAgents(ctx, [
    safeManifest.agent,
    ...safeManifest.projectAgents.map((entry) => entry.agent),
  ], `[import:${slug}]`, {
    signal: opts?.signal,
    waitForAppliedRevision: ctx.isBuilderGateway(),
  });
  await materializeCustomerBrokerProfiles(
    activationManifestAgentIds(safeManifest),
    slug,
    ctx.log,
    secretMaterial,
    `[import:${slug}]`,
  );
  if (ctx.isBuilderGateway()) {
    const restore = await restoreModelCredentialOauthStoreForSlug(slug, {
      logFn: (message) => ctx.log(`[import:${slug}] ${message}`),
    });
    secretMaterial.noteIf(restore.restored, "model credential OAuth store restored");
  }
  const accountIds = [
    safeManifest.accountId,
    ...safeManifest.projectAgents.map((agent) => agent.accountId),
  ];
  const routingActivationBaseline = await captureMattermostRoutingActivationBaseline(
    ctx.rpc,
    accountIds,
  );
  const patch = await applyOpenClawActivationManifest(safeManifest, {
    rpc: ctx.rpc,
    cache: ctx.configCache,
    signal: opts?.signal,
    log: ctx.log,
    gatewayClass: ctx.isBuilderGateway() ? "builder" : "shared",
    ...(configuredBuilder
      ? {
        authInheritanceAnchor: {
          agentId: SAFE_DEFAULT_AGENT_ID,
          agent: buildSafeDefaultAgent(),
        },
        ownerCommandsPatch: (current: unknown) => builderOwnerCommandsPatch(current, slug, ownerMmUserId),
      }
      : {}),
    onRoutingActivationRequired: (accountIds) => {
      markMattermostRoutingActivationPending(
        OPENCLAW_DIR,
        routingActivationReason,
        accountIds,
        routingActivationBaseline,
      );
    },
  });
  ctx.log(`[import:${slug}] activation config patch in ${patch.elapsedMs}ms`);
  secretMaterial.noteIf(patch.configNoop !== true, "activation config patch changed the config");
  const verificationPending = await settleActivatedImport(ctx, {
    slug,
    patch,
    secretMaterial,
    signal: opts?.signal,
    configuredBuilderRouting: configuredBuilder
      ? { accountIds, baseline: routingActivationBaseline }
      : undefined,
  });
  return { appliedFingerprint: manifest.appliedFingerprint, verificationPending };
}

// The patch above is the commit: from here the customer is this gateway's, and
// every step is verification of a runtime that is reloading around it. Reporting
// a step it could not confirm keeps the import — rolling it back would unmount
// work that succeeded and send the retry into the same reload.
async function settleActivatedImport(
  ctx: BrokerCtx,
  input: {
    slug: string;
    patch: {
      routingActivationRequired: boolean;
      restartExistingAccountIds?: string[];
      configNoop?: boolean;
    };
    secretMaterial: SecretMaterialLedger;
    signal?: AbortSignal;
    configuredBuilderRouting?: {
      accountIds: readonly string[];
      baseline: Readonly<Record<string, number>>;
    };
  },
): Promise<string | undefined> {
  const { slug, patch, secretMaterial, signal, configuredBuilderRouting } = input;
  try {
    await waitForAppliedConfigRevision(ctx.rpc, slug, { signal });
    await reloadRuntimeSecretsIfChanged(ctx, `[import:${slug}]`, secretMaterial, signal);
    if (ctx.pendingRuntimeSecrets.get(slug) === secretMaterial) ctx.pendingRuntimeSecrets.delete(slug);
    if (configuredBuilderRouting && patch.configNoop === true) {
      await activateMattermostRoutingAfterConfigPatch(
        ctx.rpc,
        OPENCLAW_DIR,
        ctx.log,
        {
          accountIds: configuredBuilderRouting.accountIds,
          baseline: configuredBuilderRouting.baseline,
          configNoop: true,
          required: patch.routingActivationRequired,
          reason: `[import:${slug}] account-level Mattermost binding changed`,
          currentSlug: slug,
          evictionSlugs: [],
        },
      );
    } else if (
      patch.routingActivationRequired || mattermostRoutingActivationPending(OPENCLAW_DIR)
    ) {
      await activatePendingMattermostRouting(
        ctx.rpc,
        OPENCLAW_DIR,
        ctx.log,
        {
          restartAccountIds: patch.restartExistingAccountIds ?? [],
          restartConfiguredPending: true,
        },
      );
    }
    await removeActivationManifest(OPENCLAW_DIR, slug);
    ctx.log(
      `[import:${slug}] verify: waiting for coach MM account to report running+connected (timeoutMs=${VERIFY_ACCOUNT_TIMEOUT_MS})`,
    );
    const healthy = await waitForAccountHealthy(ctx, {
      slug,
      timeoutMs: VERIFY_ACCOUNT_TIMEOUT_MS,
    });
    if (!healthy) {
      return reportPendingVerification(
        ctx,
        slug,
        `channel did not reach running+connected within ${VERIFY_ACCOUNT_TIMEOUT_MS}ms`,
      );
    }
    await logActivatedCoachModel(ctx, slug);
    ctx.log(`[import:${slug}] activation complete`);
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return reportPendingVerification(
      ctx,
      slug,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function reportPendingVerification(ctx: BrokerCtx, slug: string, reason: string): string {
  ctx.log(
    `[import:${slug}] ⚠ activation committed; verification incomplete — the reconcile ` +
    `converges the rest: ${reason}`,
  );
  return reason;
}

export function projectCheckoutScopeForRuntime(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): FleetBrokerProjectCheckoutScope {
  const gatewayClass = env.GATEWAY_CLASS?.trim();
  const includesProjects = gatewayClass === "shared" || (
    gatewayClass === "builder" &&
    builderClaimSlug(env) === slug
  );
  return includesProjects
    ? "workspace-and-projects"
    : WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
}

async function stopRetainedConfiguredBuilderAccounts(ctx: BrokerCtx, slug: string): Promise<void> {
  try {
    await stopStaleMattermostRoutingAccounts(ctx.rpc, {
      currentSlug: slug,
      desiredAccountIds: [],
      evictionSlugs: [],
    }, dlog);
  } catch (error) {
    const status = await createSurgeOpenClawProcessSupervisorClient(OPENCLAW_DIR).status().catch((statusError) => {
      ctx.log(`[remove:${slug}] cannot verify held OpenClaw: ${String(statusError)}`);
      return null;
    });
    if (!process.env.POD_UID || status?.podUid !== process.env.POD_UID ||
      status.mode !== "held" || status.phase !== "held") throw error;
    ctx.log(`[remove:${slug}] OpenClaw supervisor confirms this pod has no running chat accounts`);
  }
}

async function removeImportedCustomerBySlug(
  ctx: BrokerCtx,
  slug: string,
  evictionBatch?: readonly string[],
  currentEvictionBatch?: () => Promise<readonly string[]>,
): Promise<RemoveCustomerResult> {
  const wasMounted =
    fs.existsSync(path.join(CUSTOMERS_DIR, slug)) ||
    listLocalCoachWiredSlugs(CUSTOMERS_DIR, (s) => s === slug).includes(slug);
  if (!wasMounted && !isConfiguredGatewayBuilder(slug)) return { wasMounted: false, steps: [] };
  if (isConfiguredGatewayBuilder(slug)) {
    await stopRetainedConfiguredBuilderAccounts(ctx, slug);
    await releaseAgentsAndInvalidateCache(ctx, agentIdsForMigration(slug).filter(agentId => !isSafeDefaultAgentPortableStatePath(`agents/${agentId}`)), `[remove:${slug}]`);
    clearMountedMarker(CUSTOMERS_DIR, slug);
    clearMigratingInPin(CUSTOMERS_DIR, slug);
    ctx.configRemovedForEviction.delete(slug);
    await removeActivationManifest(OPENCLAW_DIR, slug);
    dlog(`[remove:${slug}] retained configured Builder overlay during imported cleanup`);
    return { wasMounted: true, steps: [], retained: true };
  }
  const remaining = await applyRemoveCustomerConfigPatch(
    ctx,
    slug,
    customerCoachAgentId(slug),
    evictionBatch,
    currentEvictionBatch,
  );
  if (!remaining.includes(slug)) {
    ctx.configRemovedForEviction.delete(slug);
    return { wasMounted: true, steps: ["config-patch-remove"], retained: true };
  }
  if (currentEvictionBatch && !(await currentEvictionBatch()).includes(slug)) {
    ctx.configRemovedForEviction.delete(slug);
    return { wasMounted: true, steps: ["config-patch-remove"], retained: true };
  }
  const agentDirs = await releaseAgentState(
    agentIdsForMigration(slug),
    agentStateRelease(ctx, `[remove:${slug}]`),
    { ignoreReadOnlyConnections: true },
  );
  await removeDepartedCustomerFileState(slug, { log: ctx.log });
  if (!isConfiguredGatewayBuilder(slug)) {
    await fsp.rm(path.join(CUSTOMER_KEYS_DIR, slug), { recursive: true, force: true });
  }
  await removeAgentDirs(agentDirs);
  await removeActivationManifest(OPENCLAW_DIR, slug);
  return { wasMounted: true, steps: ["config-patch-remove", "delete-dir"] };
}

export function buildBrokeredLifecycleAdapter(
  opts: BuildBrokeredLifecycleAdapterOptions,
): CustomerLifecycleAdapter {
  const ctx: BrokerCtx = {
    client: opts.client,
    rpc: opts.rpc,
    log: opts.log,
    isBuilderGateway: opts.isBuilderGateway ?? (() => false),
    configCache: { current: undefined, hash: "" },
    snapshotsByUid: new Map(),
    snapshotsBySlug: new Map(),
    projectCheckoutScope: opts.projectCheckoutScope,
    configRemovedForEviction: new Set(),
    pendingRuntimeSecrets: new Map(),
    procRoot: opts.procRoot ?? PROC_ROOT,
  };
  const adapter: CustomerLifecycleAdapter = {
    log: opts.log,
    isBuilderGateway: ctx.isBuilderGateway,
    isConfiguredBuilderCustomer: (slug) =>
      Boolean(opts.isBuilderGateway?.()) && isConfiguredGatewayBuilder(slug),
    configuredBuilderOverlayPresent: (slug) =>
      Boolean(opts.isBuilderGateway?.()) &&
      isConfiguredGatewayBuilder(slug) &&
      builderClaimOverlaySlug() === slug,
    materializeBrokerProfiles: async (slug) => {
      const agentId = `octogee-${slug}-coach`;
      await fsp.mkdir(path.join(AGENTS_DIR, agentId, "agent"), { recursive: true });
      const secretMaterial = ctx.pendingRuntimeSecrets.get(slug) ?? createSecretMaterialLedger();
      ctx.pendingRuntimeSecrets.set(slug, secretMaterial);
      await materializeCustomerBrokerProfiles([agentId], slug, opts.log, secretMaterial);
    },
    projectCheckoutScope: (slug) =>
      ctx.snapshotsBySlug.get(slug)?.projectCheckoutScope
      ?? ctx.projectCheckoutScope?.(slug)
      ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE,
    customerCoachWiredInOpenclawConfig: (slug) =>
      customerCoachWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
    hasCustomerAgentRuntime: (slug) =>
      customerAgentRuntimePresent(AGENTS_DIR, slug),
    listLocalCustomerSlugs: () =>
      opts.isBuilderGateway?.()
        ? listLocalCustomerDirs(CUSTOMERS_DIR).filter((slug) =>
          isConfiguredGatewayBuilder(slug) && hasMountedMarker(CUSTOMERS_DIR, slug))
        : listLocalCoachWiredSlugs(CUSTOMERS_DIR, (slug) =>
          customerCoachWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
        ),
    listLocalCustomerDirs: () => listLocalCustomerDirs(CUSTOMERS_DIR),
    customerMountMarked: (slug) => hasMountedMarker(CUSTOMERS_DIR, slug),
    writeMountMarker: (slug) => writeMountedMarker(CUSTOMERS_DIR, slug),
    clearMountMarker: (slug) => clearMountedMarker(CUSTOMERS_DIR, slug),
    customerMigratingIn: (slug) => isMigratingInPinned(CUSTOMERS_DIR, slug, MIGRATING_IN_PIN_TTL_MS),
    markCustomerMigratingIn: (slug) => writeMigratingInPin(CUSTOMERS_DIR, slug),
    clearCustomerMigratingIn: (slug) => clearMigratingInPin(CUSTOMERS_DIR, slug),
    listMigratingInSlugs: () => listMigratingInSlugs(CUSTOMERS_DIR, MIGRATING_IN_PIN_TTL_MS),

    sharedContextCheckpoint: (request, signal) => ctx.client.sharedContextCheckpoint(request, signal),
    loadUserSnapshot: async (uid, options) => {
      if (options?.refresh) invalidateSnapshot(ctx, uid);
      const snapshot = await snapshotForUid(ctx, uid);
      return snapshot ? toUserSnapshot(snapshot) : null;
    },
    seedUserSnapshotForMigration: (snapshot) => {
      cacheSnapshot(ctx, snapshot);
    },
    provisionCoachAutomation: async (snapshot) => {
      await provisionCoachAutomation(ctx.rpc, snapshot);
    },
    setProvisioningStatus: async (uid, status) => {
      await opts.client.setProvisioningStatus(uid, status);
      invalidateSnapshot(ctx, uid);
    },
    setRepoUrl: async (uid, repoUrl) => {
      await opts.client.setRepoUrl(uid, repoUrl);
      invalidateSnapshot(ctx, uid);
    },
    setMattermostFields: async (uid, mmUpdate) => {
      await opts.client.setMattermostFields(uid, mmUpdate);
      invalidateSnapshot(ctx, uid);
    },
    setAgentIds: async (uid, agentIds) => {
      await opts.client.setAgentIds(uid, agentIds);
      invalidateSnapshot(ctx, uid);
    },

    hasCustomerDir: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug)),
    hasWorkspaceGitDir: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug, ".git")),
    hasGitRemote: (slug) => customerRepositoryHasCanonicalRemote(path.join(CUSTOMERS_DIR, slug)),
    ensureCustomerDirectories,
    writeCustomerTemplateFiles,
    removePartialWorkspace,
    deleteDepartedCustomerState: (slug) => removeDepartedCustomerFileState(slug, { log: opts.log }),
    cloneWorkspaceRepo,
    initWorkspaceRepoFromExistingDir: (customerCtx) => initWorkspaceRepo(customerCtx.customerDir, customerCtx.slug),
    hasCustomerSshKey: (slug) => fs.existsSync(customerSshKeyPath(slug)),
    generateCustomerSshKey,
    createGiteaUser,
    ensureGiteaOrg: ensureGiteaOrgForWorkspace,
    ensureSystemConfigRepo,
    readLocalCustomerPubKey,
    readGiteaCustomerPubKeys,
    deleteCustomerSshKey,
    releaseGiteaUserKey,
    blobSyncForSlug: async (slug) => {
      await blobSyncForSlug(slug, { store: createBrokeredBlobStore(opts.client) });
    },
    restoreByosubForAgent: async (slug) =>
      ctx.isBuilderGateway()
        ? restoreModelCredentialOauthStoreForSlug(slug)
        : { restored: false, present: false },
    reassertByotForCustomer: (userData) =>
      syncModelCredentialsForCustomer(
        userData as Parameters<typeof syncModelCredentialsForCustomer>[0],
        {
          applyConfigPatch: (args, options) =>
            applyConfigPatch(args, { ...options, rpc: ctx.rpc, cache: ctx.configCache }),
          refreshCoachRuntimeSessions: refreshModelCredentialRuntimeSessions,
          triggerSecretsReload: () => reloadRuntimeSecrets(ctx, "[byot-sync]"),
        },
      ),
    reassertConvergedContextFilesForCustomer: async (userData) => {
      reassertConvergedContextFilesForSlug(
        userData as Parameters<typeof reassertConvergedContextFilesForSlug>[0],
      );
    },
    listProjectsNeedingClone: (slug) => listProjectsNeedingClone(ctx, slug),
    cloneProjectRepo: (slug, project, repo, options) => cloneProjectRepoForTarget(ctx, slug, project, repo, options),
    seedDeferredProjectWorkspace: async (slug, projectSlug) => {
      seedDeferredProjectWorkspace(slug, projectSlug);
    },
    provisionMattermostUser: (customerCtx) => opts.client.provisionMattermost(customerCtx.uid),
    reconcileCommunityMembership: (customerCtx) => opts.client.ensureCommunityMembership(customerCtx.uid),
    applyAddCustomerConfigPatch: (snapshot, mmUpdate, callOpts) =>
      openClawRuntimeUpdateGuard.run(async () => {
        callOpts?.runtimePublication?.invalidateFingerprint();
        return applyAddCustomerConfigPatch(ctx, snapshot, mmUpdate, callOpts);
      }, {
        signal: callOpts?.signal,
        holdUntil: callOpts?.runtimePublication?.settled,
      }),
    reconcileConfiguredBuilderProjectAgents: (snapshot, options) =>
      openClawRuntimeUpdateGuard.run(async () => {
        options?.runtimePublication?.invalidateFingerprint();
        return reconcileConfiguredBuilderProjectAgents(ctx, snapshot, options);
      }, {
        signal: options?.signal,
        holdUntil: options?.runtimePublication?.settled,
      }),
    applyRemoveCustomerConfigPatch: (slug, agentId, evictionBatch, currentEvictionBatch) =>
      openClawRuntimeUpdateGuard.run(() =>
        applyRemoveCustomerConfigPatch(ctx, slug, agentId, evictionBatch, currentEvictionBatch)),
    cancelPendingEviction: (slug) => ctx.configRemovedForEviction.delete(slug),
    waitForAccountHealthy: (p) => waitForAccountHealthy(ctx, p),
    projectAgentsHealthy: (snapshot) => projectAgentsRuntimeReady({ ...snapshot, rpc: ctx.rpc }),
    notifyOpsOfSignup: (customerCtx) => opts.client.notifySignup(customerCtx.uid),
    uidForSlug: (slug) => opts.client.uidForSlug(slug),
    customerContextRestoreHeld: (slug) => customerContextRestoreHeld(ctx, slug),
    quiesceCustomer: (slug, timeoutMs, opts) => quiesceCustomer(ctx, slug, timeoutMs, opts),
    schedulerMigration: (slug, request) => migrateCustomerScheduler(ctx.rpc, slug, agentIdsForMigration(slug), request),
    schedulerReady: async () => { await ctx.rpc.configGet(); },
    resumeCustomer: async (slug) => {
      const manifest = await readActivationManifest(OPENCLAW_DIR, slug).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (manifest) await activateImportedCustomer(ctx, slug, undefined);
      await setCustomerChannelsRunning(ctx.rpc, slug, true);
    },
    listExportPaths,
    prepareImportDir: (slug, mode) => prepareImportDir(slug, mode, agentStateRelease(ctx, `[prepare-import:${slug}]`)),
    prepareKeyImportDir,
    activateImportedCustomer: (slug, callOpts) =>
      openClawRuntimeUpdateGuard.run(() => activateImportedCustomer(ctx, slug, callOpts), {
        signal: callOpts?.signal,
      }),
    exportOpenClawActivationManifest: (slug, options) =>
      openClawRuntimeUpdateGuard.run(() => exportActivationManifestWithSecret(OPENCLAW_CONFIG, OPENCLAW_DIR, slug), options),
    removeImportedCustomerBySlug: (slug, evictionBatch, currentEvictionBatch) =>
      openClawRuntimeUpdateGuard.run(() =>
        removeImportedCustomerBySlug(ctx, slug, evictionBatch, currentEvictionBatch)),
    releaseAgent: (agentId) => releaseAgentsAndInvalidateCache(ctx, [agentId], `[release:${agentId}]`),
  };
  return adapter;
}
