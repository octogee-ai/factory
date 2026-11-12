// All fs.* call sites in this module take paths rooted at
// ctx.customerDir = path.join(CUSTOMERS_DIR, slug). `slug` is validated
// by isValidUsername() in buildProvisioningContext() at the only entry
// point that produces a ProvisioningContext — so by the time any helper
// here touches the filesystem, the path component is constrained to
// /^[a-z0-9]+(-[a-z0-9]+)*$/ minus a reserved set. That validator is the
// path-traversal defense.
import { filterOutUserBindings } from "./apply-config-patch.js";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { UNKNOWN_TIME_ZONE } from "./context-file-convergence.js";
import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_AGENT_LOOK } from "@octogee/shared/types/agent-characters";
import * as fs from "fs";
import * as path from "path";
import { isValidUsername, usernameValidationError, } from "@octogee/shared/types/identity";
import { log, OPENCLAW_DIR, CUSTOMERS_DIR, agentExists, } from "./config.js";
import { db, platformStateStore } from "./firebase.js";
import { MissingRecordError } from "./platform-state/errors.js";
import { CREW_IDENTITY } from "./crew.js";
import { workspaceRepoName } from "./gitea-naming.js";
import { provisionMattermostUser } from "./mattermost.js";
import { notifyNewSignup } from "./notifications.js";
import { writeTierTemplateFiles as writeTierTemplateFilesImpl } from "./tier-template-files.js";
export { listTierTemplateFiles, writeTierTemplateFiles, } from "./tier-template-files.js";
export function buildProvisioningContext(uid, userData) {
    const data = userData;
    const entitlements = userEntitlements();
    const planInputs = entitlements.pickInputs(userData);
    const username = data.username;
    if (typeof username !== "string" || !username) {
        throw new Error(`Cannot provision uid=${uid}: missing users/{uid}.username — onboarding must run first`);
    }
    if (!isValidUsername(username)) {
        const detail = usernameValidationError(username) ?? "invalid";
        throw new Error(`Cannot provision uid=${uid}: users/{uid}.username=${JSON.stringify(username)} is not a valid slug — ${detail}`);
    }
    const slug = username;
    const ownerName = username;
    const customerDir = path.join(CUSTOMERS_DIR, slug);
    const today = new Date().toISOString().slice(0, 10);
    const templateVars = {
        uid,
        ownerName,
        username,
        createdAt: today,
        slug,
        timeZone: parseTimeZone(data.preferences?.timeZone) ?? UNKNOWN_TIME_ZONE,
    };
    return {
        uid,
        slug,
        contextTemplateKey: entitlements.seedContextTemplateKey(planInputs),
        provisionedProductFields: entitlements.productProjection?.provisionedUser(planInputs) ?? {},
        ownerName,
        customerDir,
        today,
        username,
        templateVars,
        userData,
    };
}
export function createUserDirectories(ctx) {
    fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
    fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
}
export async function writeUserTemplateFiles(ctx) {
    const written = writeTierTemplateFilesImpl(ctx.customerDir, ctx.contextTemplateKey, ctx.templateVars);
    log(written.length
        ? `Template files ensured from tiers/${ctx.contextTemplateKey}/ — wrote ${written.join(", ")}`
        : `Template files ensured from tiers/${ctx.contextTemplateKey}/ — all present, nothing to write`);
}
export function registerDefaultAgent(ctx, config) {
    config.agents ??= {};
    config.agents.list ??= [];
    config.bindings ??= [];
    const agentId = `octogee-${ctx.slug}-coach`;
    const agentDir = path.join(OPENCLAW_DIR, "agents", agentId, "agent");
    if (!agentExists(config, agentId)) {
        const agentEntry = {
            id: agentId,
            name: `${CREW_IDENTITY.coach.name} (${ctx.slug})`,
            workspace: ctx.customerDir,
            agentDir,
            model: CREW_IDENTITY.coach.model,
            identity: {
                name: CREW_IDENTITY.coach.name,
                emoji: CREW_IDENTITY.coach.emoji,
            },
            tools: { fs: { workspaceOnly: true } },
        };
        config.agents.list.push(agentEntry);
        fs.mkdirSync(agentDir, { recursive: true });
        log(`Agent: ${agentId} → Agent, tools: fs.workspaceOnly=true`);
    }
    return agentId;
}
export function buildDefaultAgentEntry(ctx) {
    const clone = { agents: { list: [] }, bindings: [] };
    const agentId = registerDefaultAgent(ctx, clone);
    const entry = clone.agents?.list?.find((a) => a.id === agentId);
    if (!entry) {
        throw new Error(`buildDefaultAgentEntry: registerDefaultAgent did not produce an entry for ${agentId}`);
    }
    return entry;
}
export function buildDefaultAgentBindings(current, userDefaultAgentId, slug, mmUpdate) {
    const existing = current?.bindings;
    const currentBindings = Array.isArray(existing)
        ? [...existing]
        : [];
    const clone = { bindings: currentBindings };
    wireDefaultAgentMattermostBindings(clone, userDefaultAgentId, slug, mmUpdate);
    return clone.bindings ?? [];
}
export function buildRemoveUserConfig(current, slug, agentId) {
    const config = structuredClone(current);
    const projectAgentPrefix = `octogee-${slug}-proj-`;
    const agents = config.agents?.list ?? [];
    const bindings = config.bindings ?? [];
    if (config.agents) {
        config.agents.list = agents.filter((agent) => agent.id !== agentId && !agent.id.startsWith(projectAgentPrefix));
    }
    config.bindings = filterOutUserBindings(bindings.filter((binding) => binding.agentId !== agentId), slug);
    const accounts = config.channels?.mattermost?.accounts;
    if (accounts) {
        delete accounts[`${slug}-coach`];
        for (const accountId of Object.keys(accounts)) {
            if (accountId.startsWith(`${slug}-proj-`))
                delete accounts[accountId];
        }
    }
    return config;
}
export async function provisionMattermost(ctx, channelHost) {
    const data = ctx.userData;
    const vibe = data.onboarding?.vibe ?? null;
    return provisionMattermostUser({
        uid: ctx.uid,
        slug: ctx.slug,
        firstName: ctx.ownerName,
        email: data.email ?? "",
        vibe,
        lastName: data.lastName ||
            (data.displayName?.split(" ").slice(1).join(" ")) ||
            "",
        photoURL: data.photoURL || "",
    }, channelHost);
}
export function upsertMattermostBindingByAgentAndPeer(bindings, binding) {
    const idx = bindings.findIndex((b) => b.agentId === binding.agentId &&
        b.match?.peer?.id === binding.match.peer.id);
    if (idx >= 0) {
        bindings.splice(idx, 1, binding);
    }
    else {
        bindings.push(binding);
    }
}
export function wireDefaultAgentMattermostBindings(config, userDefaultAgentId, slug, mmUpdate) {
    config.bindings ??= [];
    const accountId = `${slug}-coach`;
    const bindChannels = [
        [mmUpdate["mattermost.channelId"], "coach DM"],
        [mmUpdate["mattermost.generalChannelId"], "general"],
    ];
    for (const [channelIdRaw, label] of bindChannels) {
        if (typeof channelIdRaw !== "string" || !channelIdRaw)
            continue;
        const channelId = channelIdRaw;
        const binding = {
            agentId: userDefaultAgentId,
            match: {
                channel: "mattermost",
                accountId,
                peer: { kind: "group", id: channelId },
            },
        };
        upsertMattermostBindingByAgentAndPeer(config.bindings, binding);
        log(`[mattermost] binding: ${userDefaultAgentId} ← ${label} group:${channelId} (account=${accountId})`);
    }
}
export async function markProvisioningComplete(ctx, mmUpdate, allAgentIds) {
    const provisioningObj = buildProvisioningSnapshot(ctx, allAgentIds);
    await writeSystemConfig(ctx);
    await writeProvisionedUser(ctx, allAgentIds, mmUpdate);
    await db.collection("users").doc(ctx.uid).update(buildUserProductFields(ctx, mmUpdate));
    await writeWorkspaceRecord(ctx, mmUpdate);
    await seedWorkspaceChannels(ctx, mmUpdate);
    await seedWorkspaceOwner(ctx, mmUpdate);
    await writeAgentIdentity(ctx, mmUpdate);
    await updateUserWorkspaceEntry(ctx, provisioningObj);
}
const SERVER_NOW = { serverNow: true };
function buildProvisioningSnapshot(ctx, allAgentIds) {
    return {
        status: "complete",
        version: "v1",
        slug: ctx.slug,
        ...(allAgentIds.length > 0 ? { agentIds: FieldValue.arrayUnion(...allAgentIds) } : {}),
        activatedAgents: ["coach"],
        customerDir: ctx.customerDir,
        provisionedAt: FieldValue.serverTimestamp(),
    };
}
async function writeSystemConfig(ctx) {
    await platformStateStore.transaction({ label: "provisioning.default-role" }, async (transaction) => {
        const user = await transaction.users.records.get(ctx.uid);
        if (user === null)
            throw new MissingRecordError({ aggregate: "builder", key: ctx.uid });
        if (user.role === null)
            await transaction.users.records.patch(ctx.uid, { role: "user" });
    });
    await db.doc(`users/${ctx.uid}/system/config`).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
export function buildProvisionedUserPatch(ctx, mmUpdate) {
    const mattermostUserId = mmUpdate["mattermost.userId"];
    return {
        workspaceId: ctx.slug,
        slug: ctx.slug,
        ...(typeof mattermostUserId === "string" && mattermostUserId !== "" ? { mattermostUserId } : {}),
        openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: SERVER_NOW },
    };
}
async function writeProvisionedUser(ctx, allAgentIds, mmUpdate) {
    await platformStateStore.transaction({ label: "provisioning.complete" }, async (transaction) => {
        await transaction.users.records.patch(ctx.uid, buildProvisionedUserPatch(ctx, mmUpdate));
        if (allAgentIds.length > 0)
            await transaction.users.records.addAgents(ctx.uid, allAgentIds);
        await transaction.users.records.setActivatedAgents(ctx.uid, ["coach"]);
    });
}
export function buildUserProductFields(ctx, mmUpdate) {
    return {
        ...ctx.provisionedProductFields,
        ...Object.fromEntries(Object.entries(mmUpdate).filter(([key]) => key.startsWith("mattermost.") && key !== "mattermost.userId")),
    };
}
async function writeWorkspaceRecord(ctx, mmUpdate) {
    const mattermostTeamId = mmUpdate["mattermost.teamId"] || null;
    const giteaFields = { giteaOrgName: ctx.slug, giteaRepoName: workspaceRepoName() };
    await platformStateStore.transaction({ label: "provisioning.workspace" }, async (transaction) => {
        if ((await transaction.workspaces.records.get(ctx.slug)) === null) {
            await transaction.workspaces.records.put({
                slug: ctx.slug,
                id: ctx.slug,
                ownerUid: ctx.uid,
                ownerActive: null,
                mattermostTeamId,
                ...giteaFields,
                createdAt: SERVER_NOW,
                updatedAt: SERVER_NOW,
            });
            return;
        }
        await transaction.workspaces.records.patch(ctx.slug, {
            ownerUid: ctx.uid,
            ...(mattermostTeamId === null ? {} : { mattermostTeamId }),
            ...giteaFields,
            updatedAt: SERVER_NOW,
        });
    });
    await db.doc(`workspaces/${ctx.slug}`).set({ name: ctx.slug, ownerDisplayName: ctx.slug, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
async function seedWorkspaceChannel(ctx, channelId, mattermostChannelId, name) {
    const scope = { workspaceSlug: ctx.slug, projectSlug: null };
    await platformStateStore.transaction({ label: "provisioning.channel" }, async (transaction) => {
        if ((await transaction.workspaces.channels.get(scope, channelId)) === null) {
            await transaction.workspaces.channels.put({
                scope,
                channelId,
                kind: channelId,
                mattermostChannelId,
                archivedAt: null,
                createdBy: null,
                createdAt: SERVER_NOW,
            });
            return;
        }
        await transaction.workspaces.channels.patch(scope, channelId, { mattermostChannelId });
    });
    await db.doc(`workspaces/${ctx.slug}/channels/${channelId}`).set({ name }, { merge: true });
}
async function seedWorkspaceChannels(ctx, mmUpdate) {
    const generalChannelId = mmUpdate["mattermost.generalChannelId"];
    if (generalChannelId)
        await seedWorkspaceChannel(ctx, "general", generalChannelId, "general");
    const coachDmChannelId = mmUpdate["mattermost.channelId"];
    if (coachDmChannelId) {
        const name = mmUpdate["mattermost.channelName"] || "coach-dm";
        await seedWorkspaceChannel(ctx, "coach-dm", coachDmChannelId, name);
    }
}
async function seedWorkspaceOwner(ctx, mmUpdate) {
    const mattermostUserId = mmUpdate["mattermost.userId"] ?? null;
    await platformStateStore.transaction({ label: "provisioning.owner" }, async (transaction) => {
        if ((await transaction.workspaces.members.get(ctx.slug, ctx.uid)) !== null)
            return;
        await transaction.workspaces.members.put({
            workspaceSlug: ctx.slug,
            uid: ctx.uid,
            role: "owner",
            joinedAt: SERVER_NOW,
            mattermostUserId,
        });
    });
}
async function writeAgentIdentity(ctx, mmUpdate) {
    const defaultAgentMmUserId = mmUpdate["mattermost.coachUserId"];
    if (!defaultAgentMmUserId)
        return;
    await platformStateStore.workspaces.agentIdentities.put({
        uid: ctx.uid,
        mattermostUserId: defaultAgentMmUserId,
        at: SERVER_NOW,
    });
    await db.doc(`agents/${ctx.uid}`).set(buildDefaultAgentDoc(ctx.uid), { merge: true });
}
export function buildDefaultAgentDoc(uid) {
    return {
        id: uid,
        name: "Octo",
        persona: "",
        avatarEmoji: "🐙",
        look: DEFAULT_AGENT_LOOK,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    };
}
async function updateUserWorkspaceEntry(ctx, provisioningObj) {
    const wsSnap = await db
        .collection("users")
        .doc(ctx.uid)
        .collection("workspaces")
        .where("workspaceSlug", "==", ctx.slug)
        .limit(1)
        .get();
    if (!wsSnap.empty) {
        await wsSnap.docs[0].ref.update({
            ...Object.fromEntries(Object.entries(provisioningObj).map(([key, value]) => [`provisioning.openclaw.${key}`, value])),
            updatedAt: FieldValue.serverTimestamp(),
        });
    }
}
export async function notifyOpsOfSignup(ctx) {
    const data = ctx.userData;
    const provisionedTier = ctx.provisionedProductFields.tier;
    await notifyNewSignup({
        name: ctx.ownerName,
        email: data.email || "",
        tier: typeof provisionedTier === "string" ? provisionedTier : "",
        slug: ctx.slug,
        uid: ctx.uid,
    });
}
