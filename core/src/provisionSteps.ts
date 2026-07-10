// All fs.* call sites in this module take paths rooted at
// ctx.customerDir = path.join(CUSTOMERS_DIR, slug). `slug` is validated
// by isValidUsername() in buildProvisioningContext() at the only entry
// point that produces a ProvisioningContext — so by the time any helper
// here touches the filesystem, the path component is constrained to
// /^[a-z0-9]+(-[a-z0-9]+)*$/ minus a reserved set. That validator is the
// path-traversal defense.
import { filterOutCustomerBindings } from "./apply-config-patch.js";
import { FieldValue } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

import {
  isValidUsername,
  usernameValidationError,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";
import type { MmUpdate } from "./customer-lifecycle.js";
import {
  persistWorkspaceChannelsWithActivityPairs,
  provisionWorkspaceActivityPair,
} from "./mattermost/provisionWorkspaceActivityPairs.js";
import { mmApiCall as mmApiCallDefault } from "./mattermost/client.js";
import {
  log, OPENCLAW_DIR, CUSTOMERS_DIR,
  agentExists,
} from "./config.js";
import { db } from "./firebase.js";
import { CREW_IDENTITY } from "./crew.js";
import { workspaceRepoName } from "./gitea-naming.js";
import { provisionMattermostUser } from "./mattermost.js";
import { notifyNewSignup } from "./notifications.js";
import { registerAgentIds } from "./gateway.js";
import { writeTierTemplateFiles as writeTierTemplateFilesImpl } from "./tier-template-files.js";

export {
  listTierTemplateFiles,
  writeTierTemplateFiles,
} from "./tier-template-files.js";

export interface AgentBinding {
  agentId: string;
  match?: {
    channel?: string;
    accountId?: string;
    peer?: { kind?: string; id?: string };
  };
}

export interface AgentEntry {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
  identity?: { name?: string; emoji?: string };
  heartbeat?: { every?: string; target?: string; lightContext?: boolean };
  tools?: { fs?: { workspaceOnly?: boolean } };
  [k: string]: unknown;
}

export interface MattermostAccount {
  botToken?: string;
  groupPolicy?: string;
  groupAllowFrom?: string[];
  [k: string]: unknown;
}

export interface OpenclawConfigShape {
  agents?: { list?: AgentEntry[] };
  bindings?: AgentBinding[];
  channels?: {
    mattermost?: {
      accounts?: Record<string, MattermostAccount>;
      defaultAccount?: string;
    };
  };
}

export interface ProvisioningContext {
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

interface UserDataShape {
  tier?: string;
  subscription?: { tier?: string };
  username?: unknown;
  email?: string;
  displayName?: string;
  lastName?: string;
  photoURL?: string;
  onboarding?: { vibe?: string | null };
}

export function buildProvisioningContext(
  uid: string,
  userData: Record<string, unknown>,
): ProvisioningContext {
  const data = userData as UserDataShape;
  const tier = data.tier ?? data.subscription?.tier ?? "trial";

  const username = data.username;
  if (typeof username !== "string" || !username) {
    throw new Error(
      `Cannot provision uid=${uid}: missing users/{uid}.username — onboarding must run first`,
    );
  }
  if (!isValidUsername(username)) {
    const detail = usernameValidationError(username) ?? "invalid";
    throw new Error(
      `Cannot provision uid=${uid}: users/{uid}.username=${JSON.stringify(username)} is not a valid slug — ${detail}`,
    );
  }
  const slug = username;
  const ownerName = username;
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  const today = new Date().toISOString().slice(0, 10);

  const templateVars: Record<string, string> = {
    uid,
    ownerName,
    username,
    tier,
    createdAt: today,
    slug,
  };

  return {
    uid,
    slug,
    tier,
    ownerName,
    customerDir,
    today,
    username,
    templateVars,
    userData,
  };
}

export async function claimProvisioningSlot(ctx: ProvisioningContext): Promise<void> {
  await db.collection("users").doc(ctx.uid).update({
    "provisioning.openclaw.status": "provisioning",
  });
}

export function createCustomerDirectories(ctx: ProvisioningContext): void {
  fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
}

export async function writeCustomerTemplateFiles(
  ctx: ProvisioningContext,
): Promise<void> {
  const written = writeTierTemplateFilesImpl(ctx.customerDir, ctx.tier, ctx.templateVars);
  log(
    written.length
      ? `Template files ensured from tiers/${ctx.tier}/ — wrote ${written.join(", ")}`
      : `Template files ensured from tiers/${ctx.tier}/ — all present, nothing to write`,
  );
}

export function registerCoachAgent(
  ctx: ProvisioningContext,
  config: OpenclawConfigShape,
): string {
  config.agents ??= {};
  config.agents.list ??= [];
  config.bindings ??= [];

  const agentId = `octogee-${ctx.slug}-coach`;
  const agentDir = path.join(OPENCLAW_DIR, "agents", agentId, "agent");

  if (!agentExists(config, agentId)) {
    const agentEntry: AgentEntry = {
      id: agentId,
      name: `${CREW_IDENTITY.coach.name} (${ctx.slug})`,
      workspace: ctx.customerDir,
      agentDir,
      model: CREW_IDENTITY.coach.model,
      identity: {
        name: CREW_IDENTITY.coach.name,
        emoji: CREW_IDENTITY.coach.emoji,
      },
      heartbeat: { every: "60m", target: "last", lightContext: true },
      tools: { fs: { workspaceOnly: true } },
    };
    config.agents.list.push(agentEntry);
    fs.mkdirSync(agentDir, { recursive: true });
    log(`Agent: ${agentId} → Coach, tools: fs.workspaceOnly=true`);
  }

  return agentId;
}

export function buildCoachAgentEntry(ctx: ProvisioningContext): AgentEntry {
  const clone: OpenclawConfigShape = { agents: { list: [] }, bindings: [] };
  const agentId = registerCoachAgent(ctx, clone);
  const entry = clone.agents?.list?.find((a) => a.id === agentId);
  if (!entry) {
    throw new Error(
      `buildCoachAgentEntry: registerCoachAgent did not produce an entry for ${agentId}`,
    );
  }
  return entry;
}

export function buildCoachBindings(
  current: unknown,
  coachAgentId: string,
  slug: string,
  mmUpdate: MmUpdate,
): AgentBinding[] {
  const existing = (current as { bindings?: unknown })?.bindings;
  const currentBindings: AgentBinding[] = Array.isArray(existing)
    ? [...(existing as AgentBinding[])]
    : [];

  const clone: OpenclawConfigShape = { bindings: currentBindings };
  wireCoachMattermostBindings(clone, coachAgentId, slug, mmUpdate);
  return clone.bindings ?? [];
}

export function buildCoachAccountFragment(
  slug: string,
  mmUpdate: MmUpdate,
): { accounts: Record<string, MattermostAccount>; defaultAccount: string } {
  const clone: OpenclawConfigShape = { channels: { mattermost: {} } };
  wireCoachMattermostAccount(clone, slug, mmUpdate);
  const mm = clone.channels?.mattermost ?? {};
  return {
    accounts: mm.accounts ?? {},
    defaultAccount: mm.defaultAccount ?? "default",
  };
}

export function buildRemoveCustomerPatch(
  current: unknown,
  slug: string,
  agentId: string,
): {
  agents: { list: AgentEntry[] };
  bindings: AgentBinding[];
  channels: { mattermost: { accounts: Record<string, null> } };
} {
  const existingAgents = (current as { agents?: { list?: unknown } })?.agents?.list;
  const currentAgents: AgentEntry[] = Array.isArray(existingAgents)
    ? (existingAgents as AgentEntry[])
    : [];
  const existing = (current as { bindings?: unknown })?.bindings;
  const currentBindings: AgentBinding[] = Array.isArray(existing)
    ? (existing as AgentBinding[])
    : [];
  // Vegas: the customer's project agents ({slug}-proj-{pid} accounts and
  // octogee-{slug}-proj-{pid}-coach bindings) leave with the customer.
  const currentAccounts =
    (current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } })
      ?.channels?.mattermost?.accounts ?? {};
  const accounts: Record<string, null> = { [`${slug}-coach`]: null };
  for (const key of Object.keys(currentAccounts)) {
    if (key.startsWith(`${slug}-proj-`)) accounts[key] = null;
  }
  const projectAgentPrefix = `octogee-${slug}-proj-`;
  return {
    agents: {
      list: currentAgents.filter(
        (agent) => agent.id !== agentId && !agent.id.startsWith(projectAgentPrefix),
      ),
    },
    bindings: filterOutCustomerBindings(
      currentBindings.filter((b) => b?.agentId !== agentId),
      slug,
    ),
    channels: { mattermost: { accounts } },
  };
}

export async function provisionMattermost(
  ctx: ProvisioningContext,
): Promise<MmUpdate> {
  const data = ctx.userData as UserDataShape;
  const vibe = data.onboarding?.vibe ?? null;
  return provisionMattermostUser({
    uid: ctx.uid,
    slug: ctx.slug,
    firstName: ctx.ownerName,
    email: data.email ?? "",
    vibe,
    lastName:
      data.lastName ||
      (data.displayName?.split(" ").slice(1).join(" ")) ||
      "",
    photoURL: data.photoURL || "",
  });
}

export function upsertMattermostBindingByAgentAndPeer(
  bindings: AgentBinding[],
  binding: AgentBinding & { match: { peer: { id: string } } },
): void {
  const idx = bindings.findIndex(
    (b) =>
      b.agentId === binding.agentId &&
      b.match?.peer?.id === binding.match.peer.id,
  );
  if (idx >= 0) {
    bindings.splice(idx, 1, binding);
  } else {
    bindings.push(binding);
  }
}

export function wireCoachMattermostBindings(
  config: OpenclawConfigShape,
  coachAgentId: string,
  slug: string,
  mmUpdate: MmUpdate,
): void {
  config.bindings ??= [];
  const accountId = `${slug}-coach`;
  const bindChannels: Array<[unknown, string]> = [
    [mmUpdate["mattermost.channelId"], "coach DM"],
    [mmUpdate["mattermost.generalChannelId"], "general"],
    [mmUpdate["mattermost.adminChannelId"], "admin"],
  ];

  for (const [channelIdRaw, label] of bindChannels) {
    if (typeof channelIdRaw !== "string" || !channelIdRaw) continue;
    const channelId = channelIdRaw;
    const binding: AgentBinding & { match: { peer: { id: string } } } = {
      agentId: coachAgentId,
      match: {
        channel: "mattermost",
        accountId,
        peer: { kind: "group", id: channelId },
      },
    };
    upsertMattermostBindingByAgentAndPeer(config.bindings, binding);
    log(`[mattermost] binding: ${coachAgentId} ← ${label} group:${channelId} (account=${accountId})`);
  }
}

export function wireCoachMattermostAccount(
  config: OpenclawConfigShape,
  slug: string,
  mmUpdate: MmUpdate,
): void {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mm = config.channels.mattermost;
  mm.accounts ??= {};
  if (!mm.defaultAccount) mm.defaultAccount = "default";

  const token = mmUpdate._coachPersonalToken;
  if (typeof token !== "string" || token.length === 0) {
    log(
      `[mattermost] ⚠ no coach PAT in mmUpdate for ${slug} — skipping accounts upsert; coach WS will not connect until re-provisioned`,
    );
    return;
  }
  const accountId = `${slug}-coach`;
  const customerMmUserId = mmUpdate["mattermost.userId"];
  const adminMmUserId = process.env.MM_ADMIN_USER_ID;
  // "open": the coach answers any member of the group channels it has been added
  // to (MM channel membership is the auditable/revocable access boundary). The
  // prior owner+admin allowlist silently dropped invited guests. groupAllowFrom
  // kept as an advisory seed (ignored under "open"). See PR.
  const groupAllowFrom = [customerMmUserId, adminMmUserId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  mm.accounts[accountId] = {
    botToken: token,
    groupPolicy: "open",
    ...(groupAllowFrom.length > 0 ? { groupAllowFrom } : {}),
  };
  log(`[mattermost] account: ${accountId} ← coach PAT (WS will subscribe on next reload)`);
}

export async function markProvisioningComplete(
  ctx: ProvisioningContext,
  mmUpdate: MmUpdate,
  allAgentIds: string[],
): Promise<void> {
  const provisioningObj = buildProvisioningSnapshot(ctx, allAgentIds, mmUpdate);

  await writeSystemConfig(ctx);
  await writeUserOperationalFields(ctx, provisioningObj, mmUpdate);
  await writeWorkspaceDoc(ctx, mmUpdate);
  await seedWorkspaceChannels(ctx, mmUpdate);
  await provisionActivityPairsForWorkspace(ctx, mmUpdate);
  await seedWorkspaceOwner(ctx);
  await writeAgentDoc(ctx, mmUpdate);
  registerAgentIds(ctx.uid, allAgentIds);
  await updateUserWorkspaceEntry(ctx, provisioningObj);
}

function buildProvisioningSnapshot(
  ctx: ProvisioningContext,
  allAgentIds: string[],
  mmUpdate: MmUpdate,
): Record<string, unknown> {
  const provisioningObj: Record<string, unknown> = {
    status: "complete",
    version: "v1",
    slug: ctx.slug,
    agentIds: allAgentIds,
    activatedAgents: ["coach"],
    customerDir: ctx.customerDir,
    provisionedAt: FieldValue.serverTimestamp(),
  };

  const greeting = mmUpdate["provisioning.openclaw.greeting"];
  if (greeting) provisioningObj.greeting = greeting;

  return provisioningObj;
}

async function writeSystemConfig(ctx: ProvisioningContext): Promise<void> {
  const systemConfigData: Record<string, unknown> = {
    role: "user",
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (ctx.tier === "trial") {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    systemConfigData.trialExpiresAt = expiresAt;
    log(
      `Trial expires: ${expiresAt.toISOString().slice(0, 10)} for ${ctx.slug}`,
    );
  }

  await db.doc(`users/${ctx.uid}/system/config`).set(systemConfigData, { merge: true });
}

async function writeUserOperationalFields(
  ctx: ProvisioningContext,
  provisioningObj: Record<string, unknown>,
  mmUpdate: MmUpdate,
): Promise<void> {
  const operationalFields: Record<string, unknown> = {
    tier: ctx.tier,
  };
  for (const [key, value] of Object.entries(provisioningObj)) {
    if (key === "status") continue;
    operationalFields[`provisioning.openclaw.${key}`] = value;
  }
  for (const [key, value] of Object.entries(mmUpdate)) {
    if (key.startsWith("mattermost.")) {
      operationalFields[key] = value;
    }
  }
  await db.collection("users").doc(ctx.uid).update(operationalFields);
}

async function writeWorkspaceDoc(
  ctx: ProvisioningContext,
  mmUpdate: MmUpdate,
): Promise<void> {
  const mmTeamId = (mmUpdate["mattermost.teamId"] as string | undefined) ?? "";
  await db.doc(`workspaces/${ctx.slug}`).set(
    {
      id: ctx.slug,
      ownerUid: ctx.uid,
      slug: ctx.slug,
      name: ctx.slug,
      ownerDisplayName: ctx.slug,
      mattermost: { teamId: mmTeamId },
      gitea: { orgName: ctx.slug, repoName: workspaceRepoName() },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function seedWorkspaceChannels(
  ctx: ProvisioningContext,
  mmUpdate: MmUpdate,
): Promise<void> {
  const generalChannelId = mmUpdate["mattermost.generalChannelId"] as string | undefined;
  if (generalChannelId) {
    await db.doc(`workspaces/${ctx.slug}/channels/general`).set(
      {
        id: "general",
        kind: "general",
        name: "general",
        mattermost: { channelId: generalChannelId },
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const coachDmChannelId = mmUpdate["mattermost.channelId"] as string | undefined;
  if (coachDmChannelId) {
    await db.doc(`workspaces/${ctx.slug}/channels/coach-dm`).set(
      {
        id: "coach-dm",
        kind: "coach-dm",
        name: (mmUpdate["mattermost.channelName"] as string | undefined) || "coach-dm",
        mattermost: { channelId: coachDmChannelId },
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const adminChannelId = mmUpdate["mattermost.adminChannelId"] as string | undefined;
  if (adminChannelId) {
    await db.doc(`workspaces/${ctx.slug}/channels/admin`).set(
      {
        id: "admin",
        kind: "admin",
        name: "admin",
        mattermost: { channelId: adminChannelId },
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}

async function provisionActivityPairsForWorkspace(
  ctx: ProvisioningContext,
  mmUpdate: MmUpdate,
): Promise<void> {
  const generalChannelId = mmUpdate["mattermost.generalChannelId"] as string | undefined;
  const coachDmChannelId = mmUpdate["mattermost.channelId"] as string | undefined;
  const apTeamId = (mmUpdate["mattermost.teamId"] as string | undefined) ?? "";
  const apCustomerMmUserId = mmUpdate["mattermost.userId"] as string | undefined;
  const apCoachMmUserId = mmUpdate["mattermost.coachUserId"] as string | undefined;
  const apAdminMmUserIdEnv = process.env.MM_ADMIN_USER_ID || null;

  const mmApiCall = mmApiCallDefault;
  if (!(apTeamId && apCustomerMmUserId && apCoachMmUserId)) return;

  const activityResult = await persistWorkspaceChannelsWithActivityPairs(
    {
      workspaceSlug: ctx.slug,
      teamId: apTeamId,
      customerMmUserId: apCustomerMmUserId,
      coachMmUserId: apCoachMmUserId,
      adminMmUserId: apAdminMmUserIdEnv,
      generalChannel: generalChannelId
        ? { id: generalChannelId, name: workspaceGeneralChannelName(ctx.slug) }
        : null,
      coachDmChannel: coachDmChannelId
        ? {
            id: coachDmChannelId,
            name:
              (mmUpdate["mattermost.channelName"] as string | undefined) ||
              `octogee-${ctx.slug}-coach`,
          }
        : null,
    },
    {
      provisionPair: (apInput) =>
        provisionWorkspaceActivityPair(apInput, { db, mmApiCall, log }),
      log,
    },
  );
  if (activityResult.failures.length > 0) {
    const failureSummary = activityResult.failures.map((f) => `${f.kind}=${f.error}`).join("; ");
    log(
      `[provisioner] ⚠ ${activityResult.failures.length} activity-pair(s) failed for ${ctx.slug}: ${failureSummary}`,
    );
  }
  if (activityResult.successes.length > 0) {
    log(
      `[provisioner] ✓ activity pairs created for ${ctx.slug}: ${activityResult.successes.map((s) => s.kind).join(", ")}`,
    );
  }
}

async function seedWorkspaceOwner(ctx: ProvisioningContext): Promise<void> {
  await db.doc(`workspaces/${ctx.slug}/members/${ctx.uid}`).set(
    {
      id: ctx.uid,
      role: "owner",
      joinedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function writeAgentDoc(
  ctx: ProvisioningContext,
  mmUpdate: MmUpdate,
): Promise<void> {
  const coachMmUserId = mmUpdate["mattermost.coachUserId"] as string | undefined;
  if (!coachMmUserId) return;
  await db.doc(`agents/${ctx.uid}`).set(
    {
      id: ctx.uid,
      name: "Octo",
      persona: "",
      avatarEmoji: "🐙",
      mattermost: { userId: coachMmUserId },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function updateUserWorkspaceEntry(
  ctx: ProvisioningContext,
  provisioningObj: Record<string, unknown>,
): Promise<void> {
  const wsSnap = await db
    .collection("users")
    .doc(ctx.uid)
    .collection("workspaces")
    .where("workspaceSlug", "==", ctx.slug)
    .limit(1)
    .get();
  if (!wsSnap.empty) {
    await wsSnap.docs[0].ref.update({
      "provisioning.openclaw": provisioningObj,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

export async function notifyOpsOfSignup(ctx: ProvisioningContext): Promise<void> {
  const data = ctx.userData as UserDataShape;
  await notifyNewSignup({
    name: ctx.ownerName,
    email: data.email || "",
    tier: ctx.tier,
    slug: ctx.slug,
    uid: ctx.uid,
  });
}
