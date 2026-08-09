import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";
import { resolveBillingProfile } from "../../shared/types/billing.js";
import {
  DEFAULT_BUILDER_AGENT_MODEL_REF,
  parseBuilderAgentModelDefault,
  type BuilderAgentModelDefault,
} from "../../shared/types/platform-config.js";
import {
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "../../shared/types/fleet-controller.js";
import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import { projectRepoSourceFromDoc } from "../../shared/types/project.js";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  customerConfigReplacePaths,
  mergeCustomerBindings,
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
  unrosteredAgentSpecs,
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
  AGENTS_DIR,
  CUSTOMER_KEYS_DIR,
  CUSTOMERS_DIR,
  OPENCLAW_CONFIG,
  OPENCLAW_DIR,
} from "./config.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import {
  customerCoachAgentId,
  readAgentSessions,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
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
  setRepoSshCommand,
} from "./git.js";
import {
  ensureGiteaOrgForWorkspace,
  ensureSystemConfigRepo,
} from "./gitea-admin-broker-client.js";
import {
  hasMountedMarker,
  clearMountedMarker,
  isMigratingInPinned,
  customerCoachWiredInOpenclawConfig,
  listLocalCoachWiredSlugs,
  listLocalCustomerDirs,
  listMigratingInSlugs,
  writeMigratingInPin,
  writeMountedMarker,
} from "./local-coach-wired.js";
import {
  activeAgentProjectIds,
  buildCustomerAgent,
  buildCustomerBindings,
  buildMattermostAccounts,
  buildProjectAgentAccounts,
  buildProjectAgents,
  gatewayAgentRoster,
  mattermostAccountBindingsNeedingActivation,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  rebindPlatformEmbeddingRefs,
  resolveCoachIdentity,
} from "./openclaw-config-builders.js";
import { scheduleBootGreetingCron as scheduleBootGreetingCronImpl } from "./boot-greeting-cron.js";
import {
  refreshModelCredentialRuntimeSessions,
  syncModelCredentialsForCustomer,
} from "./model-credential-sync-runtime.js";
import { isPlatformProviderRef } from "./byot-sync.js";
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
  LegacyActivationManifestFingerprintError,
  MIGRATION_ACTIVATION_DIR,
  readActivationManifest,
  removeActivationManifest,
  type MigrationActivationManifest,
} from "./migration-activation-manifest.js";
import { discardUnusableAgentStores } from "./unusable-agent-store.js";
import {
  exportActivationManifestWithSecret,
  materializeActivationManifestSecret,
} from "./migration-activation-secrets.js";
import { isConfiguredGatewayBuilder } from "./system-config-watch-state.js";
import { writeTierTemplateFiles } from "./tier-template-files.js";
import { reassertConvergedContextFilesForSlug } from "./context-file-convergence.js";
import {
  mattermostProjectAccountSecretChange,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import {
  activatePendingMattermostRouting,
  captureMattermostRoutingActivationBaseline,
  markMattermostRoutingActivationPending,
  mattermostRoutingActivationPending,
} from "./mattermost-routing-activation.js";
import { snapshotConfigFingerprint } from "./snapshot-fingerprint.js";

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
): NonNullable<UserSnapshot["projectAgents"]> {
  return brokerSnapshot?.projectAgents ?? snapshot.projectAgents ?? [];
}

function brokerCustomerMattermostUserId(
  brokerSnapshot: FleetBrokerUserSnapshot | null,
  snapshot: UserSnapshot,
): string | null | undefined {
  return brokerSnapshot?.customerMmUserId ?? snapshot.mattermostUserId;
}

interface BuildBrokeredLifecycleAdapterOptions {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId?: string;
  isBuilderGateway?: () => boolean;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
}

interface BrokerCtx {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId?: string;
  configCache: ConfigCache;
  snapshotsByUid: Map<string, FleetBrokerUserSnapshot>;
  snapshotsBySlug: Map<string, FleetBrokerUserSnapshot>;
  projectCheckoutScope?: (slug: string) => FleetBrokerProjectCheckoutScope;
  configRemovedForEviction: Set<string>;
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

async function currentRosterConfig(ctx: BrokerCtx): Promise<unknown> {
  if (ctx.configCache.hash !== "" && ctx.configCache.current !== undefined) {
    return ctx.configCache.current;
  }
  const fetched = await ctx.rpc.configGet();
  ctx.configCache.current = fetched.config;
  ctx.configCache.hash = fetched.hash;
  return fetched.config;
}

function invalidateConfigCache(ctx: BrokerCtx): void {
  ctx.configCache.current = undefined;
  ctx.configCache.hash = "";
}

async function deleteAgentsAndInvalidateCache(
  ctx: BrokerCtx,
  agentIds: readonly string[],
  logPrefix: string,
): Promise<void> {
  if (agentIds.length === 0) return;
  try {
    await deleteRosterAgents(agentIds, { rpc: ctx.rpc, log: ctx.log, logPrefix });
  } finally {
    // Each delete rewrites the roster and prunes bindings, so any cached
    // snapshot — and its base hash — is stale the moment the first one lands.
    invalidateConfigCache(ctx);
  }
}

async function deleteDepartingCustomerAgents(
  ctx: BrokerCtx,
  slugs: readonly string[],
  logPrefix: string,
): Promise<void> {
  if (slugs.length === 0) return;
  const current = await currentRosterConfig(ctx);
  await deleteAgentsAndInvalidateCache(
    ctx,
    slugs.flatMap((slug) => customerAgentIdsInRoster(current, slug)),
    logPrefix,
  );
}

/**
 * Every agent the mount does not want, in one pass: the evicted slugs' agents
 * plus the admitted Builder's OWN superseded ones — a project agent retired
 * since the last mount. Both leave by `agents.delete`, because 2026.7.2 refuses
 * a config write that drops roster entries, so neither can be nulled out of the
 * roster patch that follows.
 */
async function deleteSupersededCustomerAgents(
  ctx: BrokerCtx,
  input: {
    slug: string;
    evictionSlugs: readonly string[];
    keepAgentIds: readonly string[];
    logPrefix: string;
  },
): Promise<void> {
  const current = await currentRosterConfig(ctx);
  const keep = new Set(input.keepAgentIds);
  await deleteAgentsAndInvalidateCache(
    ctx,
    [
      ...input.evictionSlugs.flatMap((slug) => customerAgentIdsInRoster(current, slug)),
      ...customerAgentIdsInRoster(current, input.slug).filter((agentId) => !keep.has(agentId)),
    ],
    input.logPrefix,
  );
}

/**
 * Introduce the agents the roster does not carry yet. config.patch may add a
 * roster entry, but for an id `agents.delete` has already tombstoned it would
 * add a rostered-but-fenced agent whose every store access fails. Only
 * `agents.create` clears the tombstone; already-rostered ids stay on the pure
 * patch path.
 */
async function createMissingCustomerAgents(
  ctx: BrokerCtx,
  agentEntries: readonly unknown[],
  logPrefix: string,
): Promise<void> {
  const current = await currentRosterConfig(ctx);
  const missing = unrosteredAgentSpecs(current, rosterAgentSpecsFromEntries(agentEntries));
  if (missing.length === 0) return;
  // The project checkouts clone AFTER the mount patch, so a new project agent's
  // workspace does not exist yet. The directory is ours to own; checkoutProjectRepo
  // clones into an existing dest via its adopt path.
  await Promise.all(missing.map((spec) => fsp.mkdir(spec.workspace, { recursive: true })));
  try {
    await createRosterAgents(missing, { rpc: ctx.rpc, log: ctx.log, logPrefix });
  } finally {
    invalidateConfigCache(ctx);
  }
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

async function snapshotForSlug(ctx: BrokerCtx, slug: string): Promise<FleetBrokerUserSnapshot | null> {
  const cached = ctx.snapshotsBySlug.get(slug);
  if (cached) return cached;
  const uid = await ctx.client.uidForSlug(slug);
  return uid ? snapshotForUid(ctx, uid) : null;
}

function toUserSnapshot(snapshot: FleetBrokerUserSnapshot): UserSnapshot {
  return {
    uid: snapshot.uid,
    slug: snapshot.slug,
    tier: snapshot.tier,
    gatewayId: snapshot.gatewayId,
    status: snapshot.status,
    agentIds: snapshot.agentIds,
    repoUrl: snapshot.repoUrl,
    mattermostUserId: snapshot.mattermostUserId,
    greetingPosted: snapshot.greetingPosted,
    channels: snapshot.channels,
    ownerName: snapshot.ownerName,
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
  return snapshot.projects.flatMap((p) => {
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return [];
    const repoSource = projectRepoSourceFromDoc(p.repoSource);
    if (projectCheckoutMatchesSource(
      slug,
      p.projectSlug,
      p.giteaRepoName ?? "",
      repoSource,
    )) {
      return [];
    }
    if (!repoSource && !p.giteaRepoName) {
      ctx.log(
        `[add:${slug}/${p.projectSlug}] ✖ no checkout source — the project has no Gitea repo and no GitHub repoSource`,
      );
      return [];
    }
    return [{
      projectSlug: p.projectSlug,
      giteaRepoName: p.giteaRepoName,
      ...(repoSource ? { repoSource } : {}),
    }];
  });
}

async function restoreImportedProjectCheckouts(
  ctx: BrokerCtx,
  slug: string,
  scope: FleetBrokerProjectCheckoutScope,
): Promise<void> {
  if (scope === WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE) return;
  const snapshot = await snapshotForSlug(ctx, slug);
  if (!snapshot) {
    throw new Error(`[import:${slug}] trusted snapshot unavailable for project checkout restoration`);
  }
  const missing = await listProjectsNeedingClone(ctx, slug);
  let githubToken: Promise<string | null> | null = null;
  for (const project of missing) {
    const repoSource = projectRepoSourceFromDoc(project.repoSource);
    let cloneOptions: ProjectCloneOptions | undefined;
    if (repoSource?.provider === "github") {
      githubToken ??= resolveGithubCloneToken(ctx, slug).catch((error) => {
        ctx.log(`[import:${slug}] GitHub clone credential unavailable: ${String(error)}`);
        return null;
      });
      cloneOptions = { repoSource, githubToken: await githubToken };
    }
    try {
      const cloned = await cloneProjectRepoForTarget(
        slug,
        project.projectSlug,
        project.giteaRepoName,
        cloneOptions,
      );
      if (cloned) {
        ctx.log(`[import:${slug}/${project.projectSlug}] restored project checkout`);
      }
    } catch (error) {
      ctx.log(
        `[import:${slug}/${project.projectSlug}] project checkout restore failed: ${String(error)}`,
      );
    }
  }
  const remaining = snapshot.projects.flatMap((project) => {
    if (project.provisioningState !== undefined && project.provisioningState !== "active") return [];
    const repoSource = projectRepoSourceFromDoc(project.repoSource);
    return projectCheckoutMatchesSource(
        slug,
        project.projectSlug,
        project.giteaRepoName ?? "",
        repoSource,
      )
      ? []
      : [project.projectSlug];
  });
  if (remaining.length > 0) {
    throw new Error(
      `[import:${slug}] project checkout restoration incomplete: ` +
      [...new Set(remaining)].sort().join(", "),
    );
  }
}

async function resolveGithubCloneToken(ctx: BrokerCtx, slug: string): Promise<string | null> {
  const snapshot = await snapshotForSlug(ctx, slug);
  const uid = snapshot?.uid ?? await ctx.client.uidForSlug(slug);
  if (!uid) return null;
  const token = await ctx.client.githubCloneToken(uid);
  if (!token) {
    ctx.log(`[add:${slug}] GitHub not connected — project clone will use anonymous access`);
  }
  return token;
}

function cloneProjectRepoForTarget(
  customerSlug: string,
  projectSlug: string,
  giteaRepoName: string | null,
  opts?: ProjectCloneOptions,
): Promise<boolean> {
  return cloneProjectRepo(customerSlug, projectSlug, giteaRepoName ?? "", opts);
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
    logFn(`[add:${slug}] broker model profiles materialized before config hot-reload`);
  }
  if (materialized.deferred.length > 0) {
    logFn(
      `[add:${slug}] broker profile deferred for ${materialized.deferred.join(", ")}` +
        ` — ${materialized.deferralReason ?? "openclaw refused the secrets apply"};` +
        ` the post-boot sweep retries it`,
    );
  }
}

function agentIdsFromEntries(entries: ReadonlyArray<Record<string, unknown>>): string[] {
  return entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
}

function initialCoachModelSelection(snapshot: UserSnapshot): BuilderAgentModelDefault | null {
  if (snapshot.byotActive === true) return null;
  if (resolveBillingProfile(snapshot).modelAccess === "house_only") return null;
  const agentId = `octogee-${snapshot.slug}-coach`;
  return snapshot.systemConfig?.agentModels?.[agentId]
    ?? parseBuilderAgentModelDefault(snapshot.builderAgentDefault);
}

function platformModelDefaults(
  selection: BuilderAgentModelDefault | null,
): Record<string, object> | null {
  if (!selection) return null;
  const refs = [selection.primary, ...selection.fallbacks].filter(isPlatformProviderRef);
  return refs.length > 0 ? Object.fromEntries(refs.map((ref) => [ref, {}])) : null;
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

async function reloadRuntimeSecrets(ctx: BrokerCtx, logPrefix: string): Promise<void> {
  const result = await ctx.rpc.secretsReload();
  const warningCount = result.warningCount ?? 0;
  if (result.ok !== true) {
    throw new Error(`${logPrefix} secrets.reload did not acknowledge success`);
  }
  if (warningCount !== 0) {
    throw new Error(
      `${logPrefix} secrets.reload left ${warningCount} unresolved reference${warningCount === 1 ? "" : "s"}`,
    );
  }
  ctx.log(`${logPrefix} secrets.reload complete`);
}

async function applyAddCustomerConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: AddCustomerConfigPatchOptions,
): Promise<{ elapsedMs: number }> {
  let evictionSlugs = evictionSlugsExcept(snapshot.slug, callOpts?.evictionBatch);
  const brokerSnapshot = await snapshotForUid(ctx, snapshot.uid);
  const coachPat = coachToken(mmUpdate, brokerSnapshot);
  if (!coachPat) {
    throw new Error(`[add:${snapshot.slug}] coach PAT unavailable from fleet broker`);
  }

  const identity = resolveCoachIdentity(brokerSnapshot?.coachIdentity, DEFAULT_COACH);
  const projectAgents = brokerProjectAgents(brokerSnapshot, snapshot);
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
    ctx.adminMmUserId,
    (m) => ctx.log(m),
  );
  const accountId = `${snapshot.slug}-coach`;
  const accountEntry = accountsMap[accountId];
  if (!accountEntry) {
    throw new Error(`[add:${snapshot.slug}] fleet broker account fragment was empty`);
  }

  const agentId = `octogee-${snapshot.slug}-coach`;
  const agentDir = path.join(AGENTS_DIR, agentId, "agent");
  const coachModelSelection = initialCoachModelSelection(snapshot);
  const coachModelDefaults = platformModelDefaults(coachModelSelection);
  const agentEntry = buildCustomerAgent({
    uid: snapshot.uid,
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentDir,
    coach: {
      name: identity.name,
      emoji: identity.emoji,
      model: DEFAULT_COACH.model,
    },
    customerMmUserId: brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
    default: process.env.GATEWAY_BUILDER_SLUG?.trim() === snapshot.slug,
    ...(platformOpenAiEmbeddingsEnabled()
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(agentId) }
      : {}),
  });
  if (coachModelSelection) agentEntry.model = coachModelSelection;
  const projectAgentEntries = buildProjectAgents({
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentsDir: AGENTS_DIR,
    coach: { name: identity.name, emoji: identity.emoji, model: DEFAULT_COACH.model },
    projectAgents,
    ownerMmUserId: brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
  });
  const brokerAgentIds = [agentId, ...agentIdsFromEntries(projectAgentEntries)];
  await Promise.all(
    brokerAgentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })),
  );
  await materializeCustomerBrokerProfiles(brokerAgentIds, snapshot.slug, ctx.log);
  const projectSecretChange = mattermostProjectAccountSecretChange(snapshot.slug, projectAgents);
  evictionSlugs = await currentEvictionSlugs(
    snapshot.slug,
    evictionSlugs,
    callOpts?.currentEvictionBatch,
  );
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    set: {
      [accountId]: coachPat,
      ...projectSecretChange.set,
    },
    remove: [
      ...projectSecretChange.remove,
      ...evictionSlugs.map((slug) => `${slug}-coach`),
    ],
    removePrefixes: evictionSlugs.map((slug) => `${slug}-proj-`),
  });
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
  await deleteSupersededCustomerAgents(ctx, {
    slug: snapshot.slug,
    evictionSlugs,
    keepAgentIds: brokerAgentIds,
    logPrefix: `[add:${snapshot.slug}]`,
  });
  await createMissingCustomerAgents(
    ctx,
    customerAgentEntries,
    `[add:${snapshot.slug}]`,
  );
  const routingActivationBaseline = await captureMattermostRoutingActivationBaseline(ctx.rpc, [accountId, ...Object.keys(projectAccounts)]);
  const startedAt = Date.now();
  await applyConfigPatch(
    {
      buildPatch: (current) => {
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
        const nextAgents = replaceCustomerAgentsInFullAgentList(
          current,
          snapshot.slug,
          customerAgentEntries,
        );
        return {
          agents: {
            ...(coachModelDefaults
              ? { defaults: { models: coachModelDefaults } }
              : {}),
            ...customerAgentRosterPatch(
              current,
              snapshot.slug,
              rebindPlatformEmbeddingRefs(gatewayAgentRoster(nextAgents)),
            ),
          },
          bindings: mergeCustomerBindings(
            currentBindings,
            [snapshot.slug, ...evictionSlugs],
            bindings,
          ),
          channels: {
            mattermost: {
              accounts: {
                [accountId]: accountEntry,
                ...projectAccounts,
                ...staleProjectAgentAccountNulls(
                  current,
                  snapshot.slug,
                  Object.keys(projectAccounts),
                ),
                ...(evictionSlugs.length > 0
                  ? buildRemoveCustomerAccountsPatch(current, evictionSlugs)
                    .channels.mattermost.accounts
                  : {}),
              },
            },
          },
        };
      },
      buildReplacePaths: (current) => [...new Set(
        [snapshot.slug, ...evictionSlugs].flatMap((slug) =>
          customerConfigAgentRosterReplacePaths(current, slug)
        ),
      )],
      logPrefix: `[add:${snapshot.slug}]`,
    },
    {
      rpc: convergedConfigRpc(ctx),
      cache: ctx.configCache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      signal: callOpts?.signal,
    },
  );
  if (routingActivationRequired) {
    await activatePendingMattermostRouting(
      ctx.rpc,
      OPENCLAW_DIR,
      ctx.log,
    );
  }
  await reloadRuntimeSecrets(ctx, `[add:${snapshot.slug}]`);
  for (const slug of evictionSlugs) ctx.configRemovedForEviction.add(slug);
  return {
    elapsedMs: Date.now() - startedAt,
    ...(brokerSnapshot
      ? { appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) }
      : {}),
  };
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
    await applyConfigPatch(
      {
        buildPatch: (current) => buildRemoveCustomerAccountsPatch(current, slugs),
        buildReplacePaths: (current) => [...new Set(
          slugs.flatMap((batchSlug) => customerConfigReplacePaths(current, batchSlug)),
        )],
        logPrefix: `[remove:${slug}]`,
      },
      {
        rpc: ctx.rpc,
        cache: ctx.configCache,
        totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
        maxRetries: 1,
      },
    );
    for (const batchSlug of slugs) ctx.configRemovedForEviction.add(batchSlug);
  }
  const remaining = currentEvictionBatch
    ? [...new Set(await currentEvictionBatch())].filter((batchSlug) => slugs.includes(batchSlug))
    : slugs;
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
  try {
    const agentId = customerCoachAgentId(slug);
    const { config } = await ctx.rpc.configGet();
    const list = (config as { agents?: { list?: unknown[] } } | undefined)?.agents?.list;
    const agent = Array.isArray(list)
      ? (list.find((e) => !!e && typeof e === "object" && (e as { id?: unknown }).id === agentId) as
          | { model?: unknown }
          | undefined)
      : undefined;
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

async function scheduleBootGreetingCron(
  ctx: BrokerCtx,
  params: { slug: string; agentId: string; accountId: string },
): Promise<{ jobId: string }> {
  const snapshot = await snapshotForSlug(ctx, params.slug);
  const channelId = snapshot?.channels.find(
    (ch) => ch.scope === "workspace" && ch.kind === "coach-dm",
  )?.channelId;
  if (!channelId) {
    throw new Error(`[cron.add:${params.slug}] fleet broker snapshot has no coach-dm channel`);
  }
  return scheduleBootGreetingCronImpl(
    { ...params, channelId },
    { rpc: ctx.rpc, log: ctx.log },
  );
}

async function quiesceCustomer(
  log: (msg: string) => void,
  slug: string,
  timeoutMs: number,
): Promise<{ drained: boolean; runningCount: number }> {
  const stateDir = resolveOpenClawStateDir();
  const deadline = Date.now() + timeoutMs;
  let runningCount = 0;
  while (Date.now() < deadline) {
    runningCount = 0;
    for (const agentId of agentIdsForMigration(slug)) {
      const sessions = await readAgentSessions(stateDir, agentId);
      runningCount += sessions.filter((s) => s.status === "running").length;
    }
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    log(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }
  return { drained: false, runningCount };
}

function stateDirectoryEntries(directory: string): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true });
}

function agentIdsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  const agentIds = new Set([customerCoachAgentId(slug)]);
  const addIfOwned = (agentId: string): void => {
    if (agentIdBelongsToSlug(agentId, slug)) agentIds.add(agentId);
  };
  for (const entry of stateDirectoryEntries(path.join(stateDir, "agents"))) {
    if (entry.isDirectory()) addIfOwned(entry.name);
  }
  for (const entry of stateDirectoryEntries(path.join(stateDir, "memory"))) {
    if (!entry.isFile()) continue;
    const suffix = [".sqlite-wal", ".sqlite-shm", ".sqlite"].find((candidate) =>
      entry.name.endsWith(candidate),
    );
    if (suffix) addIfOwned(entry.name.slice(0, -suffix.length));
  }
  return [...agentIds].sort();
}

function memoryPathsForAgent(agentId: string): Array<{ cwd: string; path: string }> {
  const stateDir = resolveOpenClawStateDir();
  return [{ cwd: stateDir, path: path.join("memory", `${agentId}.sqlite`) }];
}

async function listExportPaths(slug: string): Promise<Array<{ cwd: string; path: string }>> {
  const stateDir = resolveOpenClawStateDir();
  const candidates = [
    ...agentIdsForMigration(slug).map((agentId) => ({
      cwd: stateDir,
      path: path.join("agents", agentId),
    })),
    ...agentIdsForMigration(slug).flatMap((agentId) => memoryPathsForAgent(agentId)),
    { cwd: OPENCLAW_DIR, path: path.join("customers", slug) },
    { cwd: OPENCLAW_DIR, path: path.join("customer-keys", slug) },
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
): Promise<string> {
  const stateDir = resolveOpenClawStateDir();
  const wipePaths = mode === "final" ? [] : [
    ...agentIdsForMigration(slug).flatMap((agentId) => [
      path.join(stateDir, "agents", agentId),
      path.join(stateDir, "memory", `${agentId}.sqlite`),
      path.join(stateDir, "memory", `${agentId}.sqlite-wal`),
      path.join(stateDir, "memory", `${agentId}.sqlite-shm`),
    ]),
    path.join(OPENCLAW_DIR, "customers", slug),
    path.join(OPENCLAW_DIR, MIGRATION_ACTIVATION_DIR, slug),
  ];
  if (mode === "default") {
    wipePaths.push(path.join(OPENCLAW_DIR, "customer-keys", slug));
  }
  for (const p of wipePaths) {
    await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  await fsp.mkdir(path.join(stateDir, "agents"), { recursive: true });
  await fsp.mkdir(path.join(stateDir, "agents", customerCoachAgentId(slug), "agent"), { recursive: true });
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
): Promise<string> {
  let manifest: MigrationActivationManifest;
  try {
    manifest = await readActivationManifest(OPENCLAW_DIR, slug);
  } catch (error) {
    if (!(error instanceof LegacyActivationManifestFingerprintError)) throw error;
    const desiredSnapshot = await snapshotForSlug(ctx, slug);
    if (!desiredSnapshot) throw error;
    manifest = await readActivationManifest(OPENCLAW_DIR, slug, {
      legacyAppliedFingerprint: snapshotConfigFingerprint(desiredSnapshot),
    });
  }
  const safeManifest = await materializeActivationManifestSecret(OPENCLAW_DIR, manifest);
  const routingActivationReason = `[import:${slug}] account-level Mattermost binding changed`;
  const runtimeProjectCheckoutScope = ctx.projectCheckoutScope?.(slug)
    ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
  if (runtimeProjectCheckoutScope !== WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE) {
    const snapshot = await snapshotForSlug(ctx, slug);
    if (!snapshot) {
      throw new Error(`[import:${slug}] trusted snapshot unavailable for project checkout restoration`);
    }
  }
  const projectCheckoutScope = ctx.snapshotsBySlug.get(slug)?.projectCheckoutScope
    ?? runtimeProjectCheckoutScope;
  await pruneWorkspaceOnlyProjectCheckouts(
    CUSTOMERS_DIR,
    slug,
    projectCheckoutScope,
    ctx.log,
  );
  await restoreImportedProjectCheckouts(ctx, slug, projectCheckoutScope);
  setRepoSshCommand(path.join(CUSTOMERS_DIR, slug), slug);
  ctx.log(`[import:${slug}] canonical workspace Git metadata ready`);
  // The rsync brings whatever store the source pod had. One openclaw cannot
  // open takes down the whole target gateway the moment activation registers
  // the agent, which then blocks the very account health-check below — so
  // clear it here, while the import still owns the state.
  for (const discarded of discardUnusableAgentStores({ agentsDir: AGENTS_DIR, logFn: ctx.log })
    .discarded) {
    ctx.log(
      `[import:${slug}] discarded imported ${discarded.agentId} store (schema ${discarded.schemaVersion})`,
    );
  }
  await deleteSupersededCustomerAgents(ctx, {
    slug,
    evictionSlugs: [],
    keepAgentIds: activationManifestAgentIds(safeManifest),
    logPrefix: `[import:${slug}]`,
  });
  const routingActivationBaseline = await captureMattermostRoutingActivationBaseline(
    ctx.rpc,
    [safeManifest.accountId, ...safeManifest.projectAgents.map((agent) => agent.accountId)],
  );
  const patch = await applyOpenClawActivationManifest(safeManifest, {
    rpc: ctx.rpc,
    cache: ctx.configCache,
    signal: opts?.signal,
    log: ctx.log,
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
  if (patch.routingActivationRequired || mattermostRoutingActivationPending(OPENCLAW_DIR)) {
    await activatePendingMattermostRouting(
      ctx.rpc,
      OPENCLAW_DIR,
      ctx.log,
    );
  }
  await reloadRuntimeSecrets(ctx, `[import:${slug}]`);
  await removeActivationManifest(OPENCLAW_DIR, slug).catch(() => undefined);

  ctx.log(
    `[import:${slug}] verify: waiting for coach MM account to report running+connected (timeoutMs=${VERIFY_ACCOUNT_TIMEOUT_MS})`,
  );
  const healthy = await waitForAccountHealthy(ctx, {
    slug,
    timeoutMs: VERIFY_ACCOUNT_TIMEOUT_MS,
  });
  if (!healthy) {
    throw new Error(`[import:${slug}] channel did not reach running+connected after activation`);
  }
  await logActivatedCoachModel(ctx, slug);
  ctx.log(`[import:${slug}] activation complete`);
  return manifest.appliedFingerprint;
}

export async function pruneWorkspaceOnlyProjectCheckouts(
  customersDir: string,
  slug: string,
  scope: FleetBrokerProjectCheckoutScope,
  log: (message: string) => void,
): Promise<void> {
  if (scope !== WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE) return;
  const projectsDir = path.join(customersDir, slug, "projects");
  await fsp.rm(projectsDir, { recursive: true, force: true });
  await fsp.mkdir(projectsDir, { recursive: true });
  log(`[import:${slug}] removed project checkouts from workspace-only target`);
}

export function projectCheckoutScopeForRuntime(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): FleetBrokerProjectCheckoutScope {
  const gatewayClass = env.GATEWAY_CLASS?.trim();
  const includesProjects = gatewayClass === "shared" || (
    gatewayClass === "builder" &&
    env.GATEWAY_BUILDER_SLUG?.trim() === slug
  );
  return includesProjects
    ? "workspace-and-projects"
    : WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
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
  if (!wasMounted) return { wasMounted: false, steps: [] };
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
  await fsp.rm(path.join(CUSTOMERS_DIR, slug), { recursive: true, force: true });
  if (!isConfiguredGatewayBuilder(slug)) {
    await fsp.rm(path.join(CUSTOMER_KEYS_DIR, slug), { recursive: true, force: true });
  }
  const stateDir = resolveOpenClawStateDir();
  for (const agentId of agentIdsForMigration(slug)) {
    await fsp.rm(path.join(stateDir, "agents", agentId), {
      recursive: true,
      force: true,
    });
    for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"]) {
      await fsp.rm(path.join(stateDir, "memory", `${agentId}${suffix}`), {
        recursive: true,
        force: true,
      });
    }
  }
  return { wasMounted: true, steps: ["config-patch-remove", "delete-dir"] };
}

export function buildBrokeredLifecycleAdapter(
  opts: BuildBrokeredLifecycleAdapterOptions,
): CustomerLifecycleAdapter {
  const ctx: BrokerCtx = {
    client: opts.client,
    rpc: opts.rpc,
    log: opts.log,
    adminMmUserId: opts.adminMmUserId,
    configCache: { current: undefined, hash: "" },
    snapshotsByUid: new Map(),
    snapshotsBySlug: new Map(),
    projectCheckoutScope: opts.projectCheckoutScope,
    configRemovedForEviction: new Set(),
  };
  const adapter: CustomerLifecycleAdapter = {
    log: opts.log,
    isBuilderGateway: opts.isBuilderGateway ?? (() => false),
    materializeBrokerProfiles: (slug) =>
      materializeCustomerBrokerProfiles([`octogee-${slug}-coach`], slug, opts.log),
    projectCheckoutScope: (slug) =>
      ctx.snapshotsBySlug.get(slug)?.projectCheckoutScope
      ?? ctx.projectCheckoutScope?.(slug)
      ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE,
    customerCoachWiredInOpenclawConfig: (slug) =>
      customerCoachWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
    hasCustomerAgentRuntime: (slug) =>
      fs.existsSync(path.join(AGENTS_DIR, `octogee-${slug}-coach`, "agent")),
    listLocalCustomerSlugs: () =>
      listLocalCoachWiredSlugs(CUSTOMERS_DIR, (slug) =>
        customerCoachWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
      ),
    listLocalCustomerDirs: () => listLocalCustomerDirs(CUSTOMERS_DIR),
    customerMountMarked: (slug) => hasMountedMarker(CUSTOMERS_DIR, slug),
    writeMountMarker: (slug) => writeMountedMarker(CUSTOMERS_DIR, slug),
    clearMountMarker: (slug) => clearMountedMarker(CUSTOMERS_DIR, slug),
    customerMigratingIn: (slug) => isMigratingInPinned(CUSTOMERS_DIR, slug, MIGRATING_IN_PIN_TTL_MS),
    markCustomerMigratingIn: (slug) => writeMigratingInPin(CUSTOMERS_DIR, slug),
    listMigratingInSlugs: () => listMigratingInSlugs(CUSTOMERS_DIR, MIGRATING_IN_PIN_TTL_MS),

    loadUserSnapshot: async (uid) => {
      const snapshot = await snapshotForUid(ctx, uid);
      return snapshot ? toUserSnapshot(snapshot) : null;
    },
    seedUserSnapshotForMigration: (snapshot) => {
      cacheSnapshot(ctx, snapshot);
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
    setGreetingResult: async (uid, result) => {
      await opts.client.setGreetingResult(uid, result);
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
    deleteCustomerDir: (slug) => fsp.rm(path.join(CUSTOMERS_DIR, slug), { recursive: true, force: true }),
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
    blobSyncForSlug: async (slug) => {
      await blobSyncForSlug(slug, { store: createBrokeredBlobStore(opts.client) });
    },
    restoreByosubForAgent: async () => ({ restored: false, present: false }),
    reassertByotForCustomer: (userData) =>
      syncModelCredentialsForCustomer(
        userData as Parameters<typeof syncModelCredentialsForCustomer>[0],
        {
          applyConfigPatch: (args, options) =>
            applyConfigPatch(args, { ...options, rpc: ctx.rpc, cache: ctx.configCache }),
          refreshCoachRuntimeSessions: refreshModelCredentialRuntimeSessions,
        },
      ),
    reassertConvergedContextFilesForCustomer: async (userData) => {
      reassertConvergedContextFilesForSlug(
        userData as Parameters<typeof reassertConvergedContextFilesForSlug>[0],
      );
    },
    listProjectsNeedingClone: (slug) => listProjectsNeedingClone(ctx, slug),
    resolveGithubCloneToken: (slug) => resolveGithubCloneToken(ctx, slug),
    cloneProjectRepo: cloneProjectRepoForTarget,
    provisionMattermostUser: (customerCtx) => opts.client.provisionMattermost(customerCtx.uid),
    reconcileCommunityMembership: (customerCtx) => opts.client.ensureCommunityMembership(customerCtx.uid),
    scheduleBootGreetingCron: (params) => scheduleBootGreetingCron(ctx, params),
    applyAddCustomerConfigPatch: (snapshot, mmUpdate, callOpts) =>
      applyAddCustomerConfigPatch(ctx, snapshot, mmUpdate, callOpts),
    applyRemoveCustomerConfigPatch: (slug, agentId, evictionBatch, currentEvictionBatch) =>
      applyRemoveCustomerConfigPatch(ctx, slug, agentId, evictionBatch, currentEvictionBatch),
    cancelPendingEviction: (slug) => ctx.configRemovedForEviction.delete(slug),
    waitForAccountHealthy: (p) => waitForAccountHealthy(ctx, p),
    notifyOpsOfSignup: (customerCtx) => opts.client.notifySignup(customerCtx.uid),
    uidForSlug: (slug) => opts.client.uidForSlug(slug),
    quiesceCustomer: (slug, timeoutMs) => quiesceCustomer(opts.log, slug, timeoutMs),
    listExportPaths,
    prepareImportDir,
    prepareKeyImportDir,
    activateImportedCustomer: async (slug, callOpts) => ({
      appliedFingerprint: await activateImportedCustomer(ctx, slug, callOpts),
    }),
    exportOpenClawActivationManifest: (slug) =>
      exportActivationManifestWithSecret(OPENCLAW_CONFIG, OPENCLAW_DIR, slug),
    removeImportedCustomerBySlug: (slug, evictionBatch, currentEvictionBatch) =>
      removeImportedCustomerBySlug(ctx, slug, evictionBatch, currentEvictionBatch),
  };
  return adapter;
}
