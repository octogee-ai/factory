import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import {
  CONFIG_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
} from "../../shared/types/fleet-controller.js";
import {
  applyConfigPatch,
  customerConfigFullAgentListReplacePaths,
  filterOutCustomerBindings,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  type ConfigCache,
} from "./apply-config-patch.js";
import {
  type CustomerContext,
  type CustomerLifecycleAdapter,
  type MmUpdate,
  type RemoveCustomerResult,
  type UserSnapshot,
} from "./customer-lifecycle.js";
import {
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
  readGiteaCustomerPubKey,
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
  resolveCoachIdentity,
} from "./openclaw-config-builders.js";
import { scheduleBootGreetingCron as scheduleBootGreetingCronImpl } from "./boot-greeting-cron.js";
import { syncModelCredentialsForCustomer } from "./model-credential-sync-runtime.js";
import { blobSyncForSlug } from "./blob-sync.js";
import { createBrokeredBlobStore } from "./blob-sync-broker.js";
import {
  applyOpenClawActivationManifest,
  extractOpenClawActivationManifest,
  MIGRATION_ACTIVATION_DIR,
  readActivationManifest,
  removeActivationManifest,
} from "./migration-activation-manifest.js";
import { writeTierTemplateFiles } from "./tier-template-files.js";

const DEFAULT_COACH = {
  name: "Octo",
  emoji: "",
  model: "platform-openrouter/z-ai/glm-5.2",
};

interface BuildBrokeredLifecycleAdapterOptions {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId?: string;
  isOperatorGateway?: () => boolean;
}

interface BrokerCtx {
  client: FleetBrokerClient;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId?: string;
  configCache: ConfigCache;
  snapshotsByUid: Map<string, FleetBrokerUserSnapshot>;
  snapshotsBySlug: Map<string, FleetBrokerUserSnapshot>;
}

function buildRemoveCustomerPatchLocal(
  current: unknown,
  slug: string,
  agentId: string,
): {
  agents: { list: unknown[] };
  bindings: unknown[];
  channels: { mattermost: { accounts: Record<string, null> } };
} {
  const agents = (current as { agents?: { list?: unknown } })?.agents?.list;
  const currentAgents = Array.isArray(agents) ? agents : [];
  const bindings = (current as { bindings?: unknown })?.bindings;
  const currentBindings = Array.isArray(bindings) ? bindings : [];
  return {
    agents: {
      list: currentAgents.filter(
        (agent) =>
          !(
            agent &&
            typeof agent === "object" &&
            (agent as { id?: unknown }).id === agentId
          ),
      ),
    },
    bindings: currentBindings.filter(
      (binding) =>
        !(
          binding &&
          typeof binding === "object" &&
          (binding as { agentId?: unknown }).agentId === agentId
        ),
    ),
    channels: { mattermost: { accounts: { [`${slug}-coach`]: null } } },
  };
}

function cacheSnapshot(ctx: BrokerCtx, snapshot: FleetBrokerUserSnapshot): void {
  ctx.snapshotsByUid.set(snapshot.uid, snapshot);
  ctx.snapshotsBySlug.set(snapshot.slug, snapshot);
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
    projects: snapshot.projects,
    projectAgents: snapshot.projectAgents,
    byotActive: snapshot.byotActive,
    selectedTier: snapshot.selectedTier,
    subscription: snapshot.subscription,
    builderSubscription: snapshot.builderSubscription,
    trialStartedAt: snapshot.trialStartedAt,
    freeTierModelRef: snapshot.freeTierModelRef,
    systemConfig: snapshot.systemConfig,
  };
}

function ensureCustomerDirectories(slug: string): void {
  const dir = path.join(CUSTOMERS_DIR, slug);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".system"), { recursive: true });
}

async function writeCustomerTemplateFiles(ctx: CustomerContext): Promise<void> {
  fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
  writeTierTemplateFiles(ctx.customerDir, ctx.tier, ctx.templateVars, ctx.today);
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

async function applyAddCustomerConfigPatch(
  ctx: BrokerCtx,
  snapshot: UserSnapshot,
  mmUpdate: MmUpdate | null,
  callOpts: { signal?: AbortSignal; byosActive?: boolean } | undefined,
): Promise<{ elapsedMs: number }> {
  const brokerSnapshot = await snapshotForUid(ctx, snapshot.uid);
  const coachPat =
    typeof mmUpdate?._coachPersonalToken === "string"
      ? mmUpdate._coachPersonalToken
      : brokerSnapshot?.coachToken ?? null;
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
  const agentEntry = buildCustomerAgent({
    uid: snapshot.uid,
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentDir: path.join(OPENCLAW_DIR, "agents", agentId, "agent"),
    coach: {
      name: identity.name,
      emoji: identity.emoji,
      model: DEFAULT_COACH.model,
    },
  });
  const projectAgents = brokerSnapshot?.projectAgents ?? snapshot.projectAgents ?? [];
  const projectAgentEntries = buildProjectAgents({
    slug: snapshot.slug,
    customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
    agentsDir: path.join(OPENCLAW_DIR, "agents"),
    coach: { name: identity.name, emoji: identity.emoji, model: DEFAULT_COACH.model },
    projectAgents,
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
  await applyConfigPatch(
    {
      buildPatch: (current) => {
        const currentCfg = current as { bindings?: Array<{ agentId?: unknown }> };
        const existingBindings = filterOutCustomerBindings(
          Array.isArray(currentCfg.bindings) ? currentCfg.bindings : [],
          snapshot.slug,
        );
        return {
          agents: {
            list: replaceCustomerAgentsInFullAgentList(current, snapshot.slug, [
              agentEntry,
              ...projectAgentEntries,
            ]),
          },
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
      buildReplacePaths: (current) => customerConfigFullAgentListReplacePaths(current, snapshot.slug),
      logPrefix: `[add:${snapshot.slug}]`,
    },
    {
      rpc: ctx.rpc,
      cache: ctx.configCache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      signal: callOpts?.signal,
    },
  );
  return { elapsedMs: Date.now() - startedAt };
}

async function applyRemoveCustomerConfigPatch(
  ctx: BrokerCtx,
  slug: string,
  agentId: string,
): Promise<void> {
  await applyConfigPatch(
    {
      buildPatch: (current) => buildRemoveCustomerPatchLocal(current, slug, agentId),
      buildReplacePaths: (current) => customerConfigFullAgentListReplacePaths(current, slug),
      logPrefix: `[remove:${slug}]`,
    },
    { rpc: ctx.rpc, cache: ctx.configCache, totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS },
  );
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
  const agentId = customerCoachAgentId(slug);
  const deadline = Date.now() + timeoutMs;
  let runningCount = 0;
  while (Date.now() < deadline) {
    const sessions = await readAgentSessions(stateDir, agentId);
    runningCount = sessions.filter((s) => s.status === "running").length;
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    log(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }
  return { drained: false, runningCount };
}

async function listExportPaths(slug: string): Promise<Array<{ cwd: string; path: string }>> {
  const stateDir = resolveOpenClawStateDir();
  const agentId = customerCoachAgentId(slug);
  const candidates = [
    { cwd: stateDir, path: path.join("agents", agentId) },
    { cwd: stateDir, path: path.join("memory", `${agentId}.sqlite`) },
    { cwd: stateDir, path: path.join("memory", `${agentId}.sqlite-wal`) },
    { cwd: stateDir, path: path.join("memory", `${agentId}.sqlite-shm`) },
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

async function prepareImportDir(slug: string): Promise<string> {
  const stateDir = resolveOpenClawStateDir();
  const agentId = customerCoachAgentId(slug);
  for (const p of [
    path.join(stateDir, "agents", agentId),
    path.join(stateDir, "memory", `${agentId}.sqlite`),
    path.join(stateDir, "memory", `${agentId}.sqlite-wal`),
    path.join(stateDir, "memory", `${agentId}.sqlite-shm`),
    path.join(OPENCLAW_DIR, "customers", slug),
    path.join(OPENCLAW_DIR, "customer-keys", slug),
    path.join(OPENCLAW_DIR, MIGRATION_ACTIVATION_DIR, slug),
  ]) {
    await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  await fsp.mkdir(path.join(stateDir, "agents"), { recursive: true });
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

async function hasOperatorAgentStateForMigration(slug: string): Promise<boolean> {
  const stateDir = resolveOpenClawStateDir();
  const agentDir = path.join(stateDir, "agents", customerCoachAgentId(slug));
  try {
    await fsp.access(agentDir);
    return true;
  } catch {
    return false;
  }
}

async function activateImportedCustomer(
  ctx: BrokerCtx,
  slug: string,
  opts: { signal?: AbortSignal } | undefined,
): Promise<void> {
  let manifest;
  try {
    manifest = await readActivationManifest(OPENCLAW_DIR, slug);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && await hasOperatorAgentStateForMigration(slug)) {
      ctx.log(`[import:${slug}] no customer activation manifest; imported operator agent state only`);
      return;
    }
    throw err;
  }
  const patch = await applyOpenClawActivationManifest(manifest, {
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

async function removeImportedCustomerBySlug(
  ctx: BrokerCtx,
  slug: string,
): Promise<RemoveCustomerResult> {
  const agentId = customerCoachAgentId(slug);
  const wasMounted =
    fs.existsSync(path.join(CUSTOMERS_DIR, slug)) ||
    listLocalCoachWiredSlugs(CUSTOMERS_DIR, (s) => s === slug).includes(slug);
  if (!wasMounted) return { wasMounted: false, steps: [] };
  await applyRemoveCustomerConfigPatch(ctx, slug, agentId);
  await fsp.rm(path.join(CUSTOMERS_DIR, slug), { recursive: true, force: true });
  await fsp.rm(path.join(CUSTOMER_KEYS_DIR, slug), { recursive: true, force: true });
  await fsp.rm(path.join(resolveOpenClawStateDir(), "agents", agentId), {
    recursive: true,
    force: true,
  });
  const stateDir = resolveOpenClawStateDir();
  for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"]) {
    await fsp.rm(path.join(stateDir, "memory", `${agentId}${suffix}`), {
      recursive: true,
      force: true,
    });
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
  };
  const adapter: CustomerLifecycleAdapter = {
    log: opts.log,
    isOperatorGateway: opts.isOperatorGateway ?? (() => false),
    customerCoachWiredInOpenclawConfig: (slug) =>
      customerCoachWiredInOpenclawConfig(OPENCLAW_CONFIG, slug),
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
    hasGitRemote: (slug) => gitExec(path.join(CUSTOMERS_DIR, slug), "remote get-url origin") !== null,
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
    readGiteaCustomerPubKey,
    deleteCustomerSshKey,
    blobSyncForSlug: async (slug) => {
      await blobSyncForSlug(slug, { store: createBrokeredBlobStore(opts.client) });
    },
    restoreByosubForAgent: async () => ({ restored: false, present: false }),
    reassertByotForCustomer: (userData) =>
      syncModelCredentialsForCustomer(userData as Parameters<typeof syncModelCredentialsForCustomer>[0]),
    listProjectsNeedingClone: (slug) => listProjectsNeedingClone(ctx, slug),
    cloneProjectRepo,
    provisionMattermostUser: (customerCtx) => opts.client.provisionMattermost(customerCtx.uid),
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
    exportOpenClawActivationManifest: (slug) => extractOpenClawActivationManifest(OPENCLAW_CONFIG, slug),
    removeImportedCustomerBySlug: (slug) => removeImportedCustomerBySlug(ctx, slug),
  };
  return adapter;
}
