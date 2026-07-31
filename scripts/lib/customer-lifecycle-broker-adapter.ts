import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";
import { DEFAULT_BUILDER_AGENT_MODEL_REF } from "../../shared/types/platform-config.js";
import {
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "../../shared/types/fleet-controller.js";
import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  filterOutCustomerBindings,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  type ConfigCache,
} from "./apply-config-patch.js";
import {
  type CustomerContext,
  type CustomerLifecycleAdapter,
  type CustomerStateImportMode,
  type MmUpdate,
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
  customerSshKeyPath,
  deleteCustomerSshKey,
  generateCustomerSshKey,
  gitExec,
  initWorkspaceRepo,
  readGiteaCustomerPubKeys,
  readLocalCustomerPubKey,
} from "./git.js";
import { ensureGiteaOrgForWorkspace } from "./gitea-admin-broker-client.js";
import {
  hasMountedMarker,
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
import {
  materializeBrokerProfilesForAgents,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
} from "./agent-model-token-materializer.js";
import { blobSyncForSlug } from "./blob-sync.js";
import { createBrokeredBlobStore } from "./blob-sync-broker.js";
import {
  applyOpenClawActivationManifest,
  MIGRATION_ACTIVATION_DIR,
  readActivationManifest,
  removeActivationManifest,
} from "./migration-activation-manifest.js";
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
import { snapshotConfigFingerprint } from "./snapshot-fingerprint.js";

const WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE: FleetBrokerProjectCheckoutScope = "workspace-only";

const DEFAULT_COACH = {
  name: "Octo",
  emoji: "",
  model: DEFAULT_BUILDER_AGENT_MODEL_REF,
};

interface BuildBrokeredLifecycleAdapterOptions {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId?: string;
  isOperatorGateway?: () => boolean;
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
}

function buildRemoveCustomerPatchLocal(
  current: unknown,
  slug: string,
  agentId: string,
): {
  agents: ReturnType<typeof customerAgentRosterPatch>;
  bindings: unknown[];
  channels: { mattermost: { accounts: Record<string, null> } };
} {
  const bindings = (current as { bindings?: unknown })?.bindings;
  const currentBindings = Array.isArray(bindings) ? bindings : [];
  const currentAccounts =
    (current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } })
      ?.channels?.mattermost?.accounts ?? {};
  const accounts: Record<string, null> = { [`${slug}-coach`]: null };
  for (const accountId of Object.keys(currentAccounts)) {
    if (accountId.startsWith(`${slug}-proj-`)) accounts[accountId] = null;
  }
  return {
    agents: customerAgentRosterPatch(
      current,
      slug,
      rebindPlatformEmbeddingRefs(
        replaceCustomerAgentsInFullAgentList(current, slug, []).filter(
          (agent) =>
            !(
              agent &&
              typeof agent === "object" &&
              (agent as { id?: unknown }).id === agentId
            ),
        ),
      ),
    ),
    bindings: filterOutCustomerBindings(
      currentBindings.filter(
        (binding) =>
          !(
            binding &&
            typeof binding === "object" &&
            (binding as { agentId?: unknown }).agentId === agentId
          ),
      ),
      slug,
    ),
    channels: { mattermost: { accounts } },
  };
}

function cacheSnapshot(ctx: BrokerCtx, snapshot: FleetBrokerUserSnapshot): void {
  const projectCheckoutScope = snapshot.projectCheckoutScope
    ?? ctx.projectCheckoutScope?.(snapshot.slug)
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
): Promise<Array<{ projectSlug: string; giteaRepoName: string }>> {
  const snapshot = await snapshotForSlug(ctx, slug);
  if (!snapshot) return [];
  return snapshot.projects.flatMap((p) => {
    if (!p.giteaRepoName) return [];
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return [];
    if (fs.existsSync(path.join(CUSTOMERS_DIR, slug, "projects", p.projectSlug, ".git"))) {
      return [];
    }
    return [{ projectSlug: p.projectSlug, giteaRepoName: p.giteaRepoName }];
  });
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

function materializeCustomerBrokerProfiles(
  agentIds: string[],
  slug: string,
  logFn: (message: string) => void,
): void {
  const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
  const platformOpenAiBaseUrl = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
  const materialized = materializeBrokerProfilesForAgents(agentIds, {
    logFn,
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(platformOpenAiBaseUrl
      ? { openAi: openAiCatalogInputForBaseUrl(platformOpenAiBaseUrl) }
      : {}),
  });
  if (materialized > 0) {
    logFn(`[add:${slug}] broker model profiles materialized before config hot-reload`);
  }
}

function agentIdsFromEntries(entries: ReadonlyArray<Record<string, unknown>>): string[] {
  return entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
}

async function restartMattermostRoutingMonitors(
  ctx: BrokerCtx,
  slug: string,
  accountIds: readonly string[],
): Promise<void> {
  const failures: Error[] = [];
  const failedAccounts = new Set<string>();
  for (const accountId of new Set(accountIds)) {
    const failureCountBefore = failures.length;
    try {
      await ctx.rpc.channelsStop({ channel: "mattermost", accountId });
    } catch (error) {
      failedAccounts.add(accountId);
      failures.push(
        new Error(
          `${accountId} stop failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
    try {
      await ctx.rpc.channelsStart({ channel: "mattermost", accountId });
    } catch (error) {
      failedAccounts.add(accountId);
      failures.push(
        new Error(
          `${accountId} start failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
    if (failures.length === failureCountBefore) {
      ctx.log(`[add:${slug}] restarted Mattermost account ${accountId} with current bindings`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[add:${slug}] Mattermost monitor restart failed for ${[...failedAccounts].join(", ")}`,
    );
  }
}

async function applyAddCustomerConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: { signal?: AbortSignal; byosActive?: boolean } | undefined,
): Promise<{ elapsedMs: number }> {
  const brokerSnapshot = await snapshotForUid(ctx, snapshot.uid);
  const coachPat = coachToken(mmUpdate, brokerSnapshot);
  if (!coachPat) {
    throw new Error(`[add:${snapshot.slug}] coach PAT unavailable from fleet broker`);
  }

  const identity = resolveCoachIdentity(brokerSnapshot?.coachIdentity, DEFAULT_COACH);
  const accountsMap = buildMattermostAccounts(
    [
      {
        uid: snapshot.uid,
        slug: snapshot.slug,
        customerMmUserId: brokerSnapshot?.customerMmUserId ?? snapshot.mattermostUserId,
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
    default: process.env.GATEWAY_BUILDER_SLUG?.trim() === snapshot.slug,
    ...(platformOpenAiEmbeddingsEnabled()
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(agentId) }
      : {}),
  });
  const projectAgents = brokerSnapshot?.projectAgents ?? snapshot.projectAgents ?? [];
  const projectAgentEntries = buildProjectAgents({
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentsDir: AGENTS_DIR,
    coach: { name: identity.name, emoji: identity.emoji, model: DEFAULT_COACH.model },
    projectAgents,
  });
  const brokerAgentIds = [agentId, ...agentIdsFromEntries(projectAgentEntries)];
  await Promise.all(
    brokerAgentIds.map((id) => fsp.mkdir(path.join(AGENTS_DIR, id, "agent"), { recursive: true })),
  );
  materializeCustomerBrokerProfiles(brokerAgentIds, snapshot.slug, ctx.log);
  const projectSecretChange = mattermostProjectAccountSecretChange(snapshot.slug, projectAgents);
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    set: {
      [accountId]: coachPat,
      ...projectSecretChange.set,
    },
    remove: projectSecretChange.remove,
  });
  const projectAccounts = buildProjectAgentAccounts(snapshot.slug, projectAgents);
  const bindings = buildCustomerBindings([
    {
      slug: snapshot.slug,
      channels: snapshot.channels,
      agentProjects: activeAgentProjectIds(projectAgents),
    },
  ]);
  const startedAt = Date.now();
  const convergedRpc = {
    ...ctx.rpc,
    configPatch: (
      patch: object,
      baseHash: string,
      options?: { replacePaths?: readonly string[] },
    ) => ctx.rpc.configPatchAndWaitForChange(patch, baseHash, options),
  };
  const configPatch = await applyConfigPatch(
    {
      buildPatch: (current) => {
        const currentCfg = current as { bindings?: Array<{ agentId?: unknown }> };
        const existingBindings = filterOutCustomerBindings(
          Array.isArray(currentCfg.bindings) ? currentCfg.bindings : [],
          snapshot.slug,
        );
        return {
          agents: customerAgentRosterPatch(
            current,
            snapshot.slug,
            rebindPlatformEmbeddingRefs(
              replaceCustomerAgentsInFullAgentList(current, snapshot.slug, [
                agentEntry,
                ...projectAgentEntries,
              ]),
            ),
          ),
          bindings: [...existingBindings, ...bindings],
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
              },
            },
          },
        };
      },
      buildReplacePaths: (current) => customerConfigAgentRosterReplacePaths(current, snapshot.slug),
      logPrefix: `[add:${snapshot.slug}]`,
    },
    {
      rpc: convergedRpc,
      cache: ctx.configCache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      signal: callOpts?.signal,
    },
  );
  if (configPatch.noop) {
    await restartMattermostRoutingMonitors(ctx, snapshot.slug, [
      accountId,
      ...Object.keys(projectAccounts),
    ]);
  }
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
  agentId: string,
): Promise<void> {
  await applyConfigPatch(
    {
      buildPatch: (current) => buildRemoveCustomerPatchLocal(current, slug, agentId),
      buildReplacePaths: (current) => customerConfigAgentRosterReplacePaths(current, slug),
      logPrefix: `[remove:${slug}]`,
    },
    { rpc: ctx.rpc, cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS },
  );
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    remove: [`${slug}-coach`],
    removePrefixes: [`${slug}-proj-`],
  });
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
  return [".sqlite", ".sqlite-wal", ".sqlite-shm"].map((suffix) => ({
    cwd: stateDir,
    path: path.join("memory", `${agentId}${suffix}`),
  }));
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
  const wipePaths = [
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
): Promise<void> {
  const manifest = await readActivationManifest(OPENCLAW_DIR, slug);
  const safeManifest = await materializeActivationManifestSecret(OPENCLAW_DIR, manifest);
  await pruneWorkspaceOnlyProjectCheckouts(
    CUSTOMERS_DIR,
    slug,
    ctx.snapshotsBySlug.get(slug)?.projectCheckoutScope
      ?? ctx.projectCheckoutScope?.(slug)
      ?? WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE,
    ctx.log,
  );
  const patch = await applyOpenClawActivationManifest(safeManifest, {
    rpc: ctx.rpc,
    cache: ctx.configCache,
    signal: opts?.signal,
    log: ctx.log,
  });
  ctx.log(`[import:${slug}] activation config patch in ${patch.elapsedMs}ms`);
  await removeActivationManifest(OPENCLAW_DIR, slug).catch(() => undefined);
  ctx.log(
    `[import:${slug}] activation relies on config-patch hot-reload; no explicit gateway restart requested`,
  );

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

export function projectCheckoutScopeForRuntime(): FleetBrokerProjectCheckoutScope {
  return WORKSPACE_ONLY_PROJECT_CHECKOUT_SCOPE;
}

async function removeImportedCustomerBySlug(
  ctx: BrokerCtx,
  slug: string,
): Promise<RemoveCustomerResult> {
  const wasMounted =
    fs.existsSync(path.join(CUSTOMERS_DIR, slug)) ||
    listLocalCoachWiredSlugs(CUSTOMERS_DIR, (s) => s === slug).includes(slug);
  if (!wasMounted) return { wasMounted: false, steps: [] };
  await applyRemoveCustomerConfigPatch(ctx, slug, customerCoachAgentId(slug));
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
  };
  const adapter: CustomerLifecycleAdapter = {
    log: opts.log,
    isOperatorGateway: opts.isOperatorGateway ?? (() => false),
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
    hasGitRemote: (slug) => gitExec(path.join(CUSTOMERS_DIR, slug), ["remote", "get-url", "origin"]) !== null,
    ensureCustomerDirectories,
    writeCustomerTemplateFiles,
    deleteCustomerDir: (slug) => fsp.rm(path.join(CUSTOMERS_DIR, slug), { recursive: true, force: true }),
    cloneWorkspaceRepo,
    initWorkspaceRepoFromExistingDir: (customerCtx) => initWorkspaceRepo(customerCtx.customerDir, customerCtx.slug),
    hasCustomerSshKey: (slug) => fs.existsSync(customerSshKeyPath(slug)),
    generateCustomerSshKey,
    createGiteaUser,
    ensureGiteaOrg: ensureGiteaOrgForWorkspace,
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
    warmAgentRuntimePlugins: async (slug) => {
      await ctx.rpc.toolsCatalog(
        {
          agentId: customerCoachAgentId(slug),
          includePlugins: true,
        },
        180_000,
      );
    },
    listProjectsNeedingClone: (slug) => listProjectsNeedingClone(ctx, slug),
    cloneProjectRepo,
    provisionMattermostUser: (customerCtx) => opts.client.provisionMattermost(customerCtx.uid),
    reconcileCommunityMembership: (customerCtx) => opts.client.ensureCommunityMembership(customerCtx.uid),
    scheduleBootGreetingCron: (params) => scheduleBootGreetingCron(ctx, params),
    applyAddCustomerConfigPatch: (snapshot, mmUpdate, callOpts) =>
      applyAddCustomerConfigPatch(ctx, snapshot, mmUpdate, callOpts),
    applyRemoveCustomerConfigPatch: (slug, agentId) =>
      applyRemoveCustomerConfigPatch(ctx, slug, agentId),
    waitForAccountHealthy: (p) => waitForAccountHealthy(ctx, p),
    notifyOpsOfSignup: (customerCtx) => opts.client.notifySignup(customerCtx.uid),
    uidForSlug: (slug) => opts.client.uidForSlug(slug),
    quiesceCustomer: (slug, timeoutMs) => quiesceCustomer(opts.log, slug, timeoutMs),
    listExportPaths,
    prepareImportDir,
    prepareKeyImportDir,
    activateImportedCustomer: (slug, callOpts) => activateImportedCustomer(ctx, slug, callOpts),
    exportOpenClawActivationManifest: (slug) =>
      exportActivationManifestWithSecret(OPENCLAW_CONFIG, OPENCLAW_DIR, slug),
    removeImportedCustomerBySlug: (slug) => removeImportedCustomerBySlug(ctx, slug),
  };
  return adapter;
}
