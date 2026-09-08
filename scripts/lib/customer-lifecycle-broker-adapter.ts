import { customerFileStatePaths } from "./customer-file-state.js";
import { configuredBuilderManagedProjectIds, configuredBuilderProjectAgentPatch } from "./configured-builder-project-agents.js";
import { reportProjectAgentReadiness } from "./project-agent-readiness.js";
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
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "../../shared/types/fleet-controller.js";
import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import { projectCheckoutEnabled, projectRepoSourceFromDoc } from "../../shared/types/project.js";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  customerConfigReplacePaths,
  mergeCustomerBindings,
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
  dlog,
  logLevel,
  AGENTS_DIR,
  CUSTOMER_KEYS_DIR,
  CUSTOMERS_DIR,
  OPENCLAW_CONFIG,
  OPENCLAW_DIR,
} from "./config.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import {
  customerCoachAgentId,
  readAgentSessionsAtPath,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import type { ConfigGetResult, GatewayRpcClient } from "./gateway-rpc.js";
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
  hasReadableOpenclawConfig,
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
import { scheduleBootGreetingCron as scheduleBootGreetingCronImpl } from "./boot-greeting-cron.js";
import {
  customerMountConfigPatch,
  customerSecurityProjectionReplacePaths,
  refreshModelCredentialRuntimeSessions,
  syncModelCredentialsForCustomer,
} from "./model-credential-sync-runtime.js";
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
  const current = await freshRosterConfig(ctx);
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
  const current = await freshRosterConfig(ctx);
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
  await Promise.all(missing.map((spec) => fsp.mkdir(spec.workspace, { recursive: true })));
  try {
    await createRosterAgents(missing, { rpc: ctx.rpc, log: ctx.log, logPrefix });
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
  });
  await createMissingCustomerAgents(ctx, agentEntries, logPrefix);
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
      return [];
    }
    return [target];
  });
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

function initialHouseCoachPatch(snapshot: UserSnapshot) {
  return byosCoachConfigPatch(platformCoachModelInputForUser(snapshot.slug, {
    ...snapshot,
    selectedTier: typeof snapshot.selectedTier === "string" ? snapshot.selectedTier : undefined,
  }));
}

function initialCoachModelSelection(snapshot: UserSnapshot): BuilderAgentModelDefault | null {
  if (snapshot.byotActive === true) return null;
  const housePatch = initialHouseCoachPatch(snapshot);
  if (housePatch) return housePatch.agents.list[0].model as BuilderAgentModelDefault;
  const agentId = `octogee-${snapshot.slug}-coach`;
  return snapshot.systemConfig?.agentModels?.[agentId]
    ?? parseBuilderAgentModelDefault(snapshot.builderAgentDefault);
}

function initialCoachTools(snapshot: UserSnapshot, current: unknown) {
  if (snapshot.byotActive === true) return current;
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
  coachModelDefaults: Record<string, object> | null,
  builderGateway: boolean,
): Record<string, unknown> | null {
  if (!coachModelDefaults && !builderGateway) return null;
  return {
    ...(coachModelDefaults ? { models: coachModelDefaults } : {}),
    ...(builderGateway ? { authInheritance: { agentId: SAFE_DEFAULT_AGENT_ID } } : {}),
  };
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
  return builderGateway ? [buildSafeDefaultAgent(), ...roster] : roster;
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

async function reloadRuntimeSecrets(ctx: BrokerCtx, logPrefix: string): Promise<void> {
  const result = await ctx.rpc.secretsReload();
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
  opts: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
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
      return await rpc.configGet();
    } catch (error) {
      throwIfConfigApplicationWaitAborted(opts.signal);
      lastReadError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  for (;;) {
    const snapshot = await readSnapshot();
    if (snapshot !== null) {
      targetRevisionHash ??= snapshot.configRevisionHash;
      if (snapshot.configRevisionHash !== targetRevisionHash) {
        throw new Error(
          `[import:${slug}] config revision changed while waiting ` +
            `(expected=${targetRevisionHash}, observed=${snapshot.configRevisionHash})`,
        );
      }
      appliedConfigHash = snapshot.appliedConfigHash;
      if (targetRevisionHash === appliedConfigHash) return;
    }
    if (Date.now() >= deadline) break;
    await idle();
  }
  if (targetRevisionHash === null) {
    throw new Error(
      `[import:${slug}] config revision was unreadable for ${timeoutMs}ms: ${lastReadError}`,
    );
  }
  throw new Error(
    `[import:${slug}] active config did not reach revision ${targetRevisionHash} ` +
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
  if (builderGateway || snapshot.byotActive === true) return patch;
  return customerMountConfigPatch(
    current, patch, snapshot.slug,
    initialCoachModelSelection(snapshot)?.primary ?? DEFAULT_FREE_TIER_MODEL_REF,
  );
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

async function applyAddCustomerConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: AddCustomerConfigPatchOptions,
): Promise<{ elapsedMs: number }> {
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
  const agentDir = path.join(AGENTS_DIR, agentId, "agent");
  const coachModelSelection = initialCoachModelSelection(snapshot);
  const coachModelDefaults = platformModelDefaults(coachModelSelection);
  const agentEntry = buildCustomerAgent({
    uid: snapshot.uid,
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentDir,
    coach: { name: identity.name, emoji: identity.emoji, model: DEFAULT_COACH.model },
    customerMmUserId: brokerCustomerMattermostUserId(brokerSnapshot, snapshot),
    default: builderGateway,
    hostCode: builderGateway ? "builder-full" : "customer-restricted",
    ...(platformOpenAiEmbeddingsEnabled()
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(agentId) }
      : {}),
  });
  if (coachModelSelection) agentEntry.model = coachModelSelection;
  agentEntry.tools = initialCoachTools(snapshot, agentEntry.tools);
  const projectAgentEntries = buildCustomerProjectAgents(snapshot, projectAgents, identity,
    brokerCustomerMattermostUserId(brokerSnapshot, snapshot), builderGateway);
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
  await reconcileCustomerRosterAgents(
    ctx,
    snapshot.slug,
    evictionSlugs,
    brokerAgentIds,
    customerAgentEntries,
  );
  const { accountIds: affectedAccountIds, baseline: routingActivationBaseline } = await
    captureRoutingActivationBaseline(ctx, accountId, projectAccounts);
  const pendingProjectAccountIds = pendingProjectActivationAccountIds(snapshot.slug, projectAgents);
  routingActivationRequired = markPendingProjectActivations(routingActivationReason, pendingProjectAccountIds, routingActivationBaseline)
    || routingActivationRequired;
  const startedAt = Date.now();
  const configPatch = await applyConfigPatch(
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
        const agentDefaults = customerAgentDefaults(coachModelDefaults, builderGateway);
        const roster = customerGatewayAgentRoster(
          current,
          snapshot.slug,
          customerAgentEntries,
          builderGateway,
        );
        const mountPatch = {
          agents: {
            ownership: "explicit",
            ...(agentDefaults ? { defaults: agentDefaults } : {}),
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
        return projectMountPolicy(current, mountPatch, snapshot, builderGateway);
      },
      buildReplacePaths: (current) => [...new Set([
        ...[snapshot.slug, ...evictionSlugs].flatMap((slug) =>
          customerConfigAgentRosterReplacePaths(current, slug)
        ),
        ...(!builderGateway && snapshot.byotActive !== true
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
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents, channels: snapshot.channels, baseline: routingActivationBaseline,
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
    activate(): Promise<void>;
  },
): Promise<void> {
  const errors: unknown[] = [];
  await reloadRuntimeSecrets(ctx, `[add:${input.snapshot.slug}]`);
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
  const managedProjectIds = configuredBuilderManagedProjectIds(current, snapshot.slug,
    (brokerSnapshot.projectAgents ?? []).map((agent) => agent.projectId));
  if (managedProjectIds.length === 0) {
    return { elapsedMs: 0, appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) };
  }
  const projectAgents = brokerProjectAgents(brokerSnapshot, snapshot, options.withoutProjectIds);
  const identity = resolveCoachIdentity(brokerSnapshot.coachIdentity, DEFAULT_COACH);
  const projectAgentEntries = buildCustomerProjectAgents(snapshot, projectAgents, identity, brokerSnapshot.customerMmUserId, true);
  const projectAccounts = buildProjectAgentAccounts(snapshot.slug, projectAgents, brokerSnapshot.customerMmUserId);
  const patchInput = {
    slug: snapshot.slug, managedProjectIds, projectAgentEntries, projectAccounts, channels: brokerSnapshot.channels,
    activationProjectIds: projectAgents.filter((agent) => agent.status === "provisioning" && agent.activationId).map((agent) => agent.projectId),
  };
  const logPrefix = `[project-agents:${snapshot.slug}]`;
  const initial = configuredBuilderProjectAgentPatch(current, patchInput);
  await deleteAgentsAndInvalidateCache(ctx, initial.retiredAgentIds, logPrefix);
  await createMissingCustomerAgents(ctx, projectAgentEntries, logPrefix);
  const agentIds = agentIdsFromEntries(projectAgentEntries);
  await Promise.all(agentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })));
  await materializeCustomerBrokerProfiles(agentIds, snapshot.slug, ctx.log);
  const projectSecrets = mattermostProjectAccountSecretChange(snapshot.slug, projectAgents);
  await updateMattermostAccountSecrets(OPENCLAW_DIR, { set: projectSecrets.set });
  const pendingAccountIds = pendingProjectActivationAccountIds(snapshot.slug, projectAgents);
  const baseline = pendingAccountIds.length > 0
    ? await captureMattermostRoutingActivationBaseline(ctx.rpc, pendingAccountIds)
    : {};
  await applyConfigPatch({
    buildPatch: (current) => configuredBuilderProjectAgentPatch(current, patchInput).patch,
    buildReplacePaths: (current) => configuredBuilderProjectAgentPatch(current, patchInput).replacePaths,
    logPrefix,
  }, { rpc: convergedConfigRpc(ctx), cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS, signal: options.signal });
  const retiredAccountIds = managedProjectIds.map((projectId) => `${snapshot.slug}-proj-${projectId}`)
    .filter((accountId) => !projectAccounts[accountId]);
  for (const accountId of retiredAccountIds) await ctx.rpc.channelsStop({ channel: "mattermost", accountId });
  await updateMattermostAccountSecrets(OPENCLAW_DIR, { remove: [...new Set([...projectSecrets.remove, ...retiredAccountIds])] });
  await settleProjectAgentActivations(ctx, {
    snapshot, projectAgents, channels: brokerSnapshot.channels, baseline,
    activate: async () => {
      if (pendingAccountIds.length === 0) return;
      markMattermostRoutingActivationPending(OPENCLAW_DIR, logPrefix, pendingAccountIds, baseline);
      await activatePendingMattermostRouting(ctx.rpc, OPENCLAW_DIR, ctx.log, { restartAccountIds: pendingAccountIds });
    },
  });
  return { elapsedMs: Date.now() - startedAt, appliedFingerprint: snapshotConfigFingerprint(brokerSnapshot) };
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
        rpc: convergedConfigRpc(ctx),
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
  slug: string,
  timeoutMs: number,
): Promise<{ drained: boolean; runningCount: number }> {
  const deadline = Date.now() + timeoutMs;
  let runningCount = 0;
  while (Date.now() < deadline) {
    runningCount = 0;
    for (const sessionsPath of sessionPathsForMigration(slug)) {
      const sessions = await readAgentSessionsAtPath(sessionsPath);
      runningCount += sessions.filter((s) => s.status === "running").length;
    }
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    dlog(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }
  return { drained: false, runningCount };
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

function stateDirectoryEntries(directory: string): fs.Dirent[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true });
}

function agentIdsForMigration(slug: string): string[] {
  const stateDir = resolveOpenClawStateDir();
  if (isConfiguredGatewayBuilder(slug)) {
    const plan = configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir);
    assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, plan);
    return plan.agentIds;
  }
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
  const builderPlan = isConfiguredGatewayBuilder(slug)
    ? configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, builderPlan);
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
        ...agentIdsForMigration(slug).flatMap((agentId) => memoryPathsForAgent(agentId)),
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
): Promise<string> {
  const stateDir = resolveOpenClawStateDir();
  const builderPlan = isConfiguredGatewayBuilder(slug)
    ? configuredBuilderPortableStatePlan(OPENCLAW_CONFIG, stateDir)
    : null;
  if (builderPlan) assertConfiguredBuilderPortableStatePlanOnDisk(stateDir, builderPlan);
  const wipePaths = mode === "final" || builderPlan ? [] : [
    ...agentIdsForMigration(slug).flatMap((agentId) => [
      path.join(stateDir, "agents", agentId),
      path.join(stateDir, "memory", `${agentId}.sqlite`),
      path.join(stateDir, "memory", `${agentId}.sqlite-wal`),
      path.join(stateDir, "memory", `${agentId}.sqlite-shm`),
    ]),
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
  } else {
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
  const safeManifest = await materializeActivationManifestSecret(OPENCLAW_DIR, manifest);
  const routingActivationReason = `[import:${slug}] account-level Mattermost binding changed`;
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
    ...(isConfiguredGatewayBuilder(slug)
      ? {
        authInheritanceAnchor: {
          agentId: SAFE_DEFAULT_AGENT_ID,
          agent: buildSafeDefaultAgent(),
        },
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
  const verificationPending = await settleActivatedImport(ctx, {
    slug,
    patch,
    signal: opts?.signal,
    configuredBuilderRouting: isConfiguredGatewayBuilder(slug)
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
    signal?: AbortSignal;
    configuredBuilderRouting?: {
      accountIds: readonly string[];
      baseline: Readonly<Record<string, number>>;
    };
  },
): Promise<string | undefined> {
  const { slug, patch, signal, configuredBuilderRouting } = input;
  try {
    await waitForAppliedConfigRevision(ctx.rpc, slug, { signal });
    await reloadRuntimeSecrets(ctx, `[import:${slug}]`);
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
          restartConfiguredPending: patch.routingActivationRequired === false,
        },
      );
    }
    await removeActivationManifest(OPENCLAW_DIR, slug).catch(() => undefined);
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
    env.GATEWAY_BUILDER_SLUG?.trim() === slug
  );
  return includesProjects
    ? "workspace-and-projects"
    : WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
}

// The retained overlay keeps the Builder's config, but a customer that just
// moved out must stop answering chat here: two coaches on one bot account is
// what an unmount prevents. A held pod has no OpenClaw to stop, so an
// unreachable gateway is a logged skip, not a failed cleanup.
async function stopRetainedConfiguredBuilderAccounts(ctx: BrokerCtx, slug: string): Promise<void> {
  try {
    await stopStaleMattermostRoutingAccounts(ctx.rpc, {
      currentSlug: slug,
      desiredAccountIds: [],
      evictionSlugs: [],
    }, dlog);
  } catch (error) {
    ctx.log(
      `[remove:${slug}] configured Builder chat accounts were not stopped ` +
      `(OpenClaw held or unreachable): ${error instanceof Error ? error.message : String(error)}`,
    );
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
  if (!wasMounted) return { wasMounted: false, steps: [] };
  if (isConfiguredGatewayBuilder(slug)) {
    clearMountedMarker(CUSTOMERS_DIR, slug);
    clearMigratingInPin(CUSTOMERS_DIR, slug);
    ctx.configRemovedForEviction.delete(slug);
    await stopRetainedConfiguredBuilderAccounts(ctx, slug);
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
    isBuilderGateway: opts.isBuilderGateway ?? (() => false),
    configCache: { current: undefined, hash: "" },
    snapshotsByUid: new Map(),
    snapshotsBySlug: new Map(),
    projectCheckoutScope: opts.projectCheckoutScope,
    configRemovedForEviction: new Set(),
  };
  const adapter: CustomerLifecycleAdapter = {
    log: opts.log,
    isBuilderGateway: ctx.isBuilderGateway,
    isConfiguredBuilderCustomer: (slug) =>
      Boolean(opts.isBuilderGateway?.()) && isConfiguredGatewayBuilder(slug),
    configuredBuilderOverlayPresent: (slug) =>
      Boolean(opts.isBuilderGateway?.()) &&
      isConfiguredGatewayBuilder(slug) &&
      hasReadableOpenclawConfig(OPENCLAW_CONFIG),
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
    cloneProjectRepo: cloneProjectRepoForTarget,
    provisionMattermostUser: (customerCtx) => opts.client.provisionMattermost(customerCtx.uid),
    reconcileCommunityMembership: (customerCtx) => opts.client.ensureCommunityMembership(customerCtx.uid),
    scheduleBootGreetingCron: (params) => scheduleBootGreetingCron(ctx, params),
    applyAddCustomerConfigPatch: (snapshot, mmUpdate, callOpts) =>
      applyAddCustomerConfigPatch(ctx, snapshot, mmUpdate, callOpts),
    reconcileConfiguredBuilderProjectAgents: (snapshot, options) =>
      reconcileConfiguredBuilderProjectAgents(ctx, snapshot, options),
    applyRemoveCustomerConfigPatch: (slug, agentId, evictionBatch, currentEvictionBatch) =>
      applyRemoveCustomerConfigPatch(ctx, slug, agentId, evictionBatch, currentEvictionBatch),
    cancelPendingEviction: (slug) => ctx.configRemovedForEviction.delete(slug),
    waitForAccountHealthy: (p) => waitForAccountHealthy(ctx, p),
    notifyOpsOfSignup: (customerCtx) => opts.client.notifySignup(customerCtx.uid),
    uidForSlug: (slug) => opts.client.uidForSlug(slug),
    quiesceCustomer,
    listExportPaths,
    prepareImportDir,
    prepareKeyImportDir,
    activateImportedCustomer: (slug, callOpts) =>
      activateImportedCustomer(ctx, slug, callOpts),
    exportOpenClawActivationManifest: (slug) =>
      exportActivationManifestWithSecret(OPENCLAW_CONFIG, OPENCLAW_DIR, slug),
    removeImportedCustomerBySlug: (slug, evictionBatch, currentEvictionBatch) =>
      removeImportedCustomerBySlug(ctx, slug, evictionBatch, currentEvictionBatch),
  };
  return adapter;
}
