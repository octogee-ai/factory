// All fs.* call sites in this module take paths rooted at
// ctx.customerDir = path.join(CUSTOMERS_DIR, slug). `slug` is validated
// by isValidUsername() in buildProvisioningContext() at the only entry
// point that produces a ProvisioningContext — so by the time any helper
// here touches the filesystem, the path component is constrained to
// /^[a-z0-9]+(-[a-z0-9]+)*$/ minus a reserved set. That validator is the
// path-traversal defense.
import { filterOutCustomerBindings } from "./apply-config-patch.js";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
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
    const tier = data.tier ?? data.subscription?.tier ?? "trial";
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
        tier,
        createdAt: today,
        slug,
        timeZone: parseTimeZone(data.preferences?.timeZone) ?? UNKNOWN_TIME_ZONE,
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
export function createCustomerDirectories(ctx) {
    fs.mkdirSync(path.join(ctx.customerDir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(ctx.customerDir, "ideas"), { recursive: true });
    fs.mkdirSync(path.join(ctx.customerDir, ".system"), { recursive: true });
}
export async function writeCustomerTemplateFiles(ctx) {
    const written = writeTierTemplateFilesImpl(ctx.customerDir, ctx.tier, ctx.templateVars);
    log(written.length
        ? `Template files ensured from tiers/${ctx.tier}/ — wrote ${written.join(", ")}`
        : `Template files ensured from tiers/${ctx.tier}/ — all present, nothing to write`);
}
export function registerCoachAgent(ctx, config) {
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
        log(`Agent: ${agentId} → Coach, tools: fs.workspaceOnly=true`);
    }
    return agentId;
}
export function buildCoachAgentEntry(ctx) {
    const clone = { agents: { list: [] }, bindings: [] };
    const agentId = registerCoachAgent(ctx, clone);
    const entry = clone.agents?.list?.find((a) => a.id === agentId);
    if (!entry) {
        throw new Error(`buildCoachAgentEntry: registerCoachAgent did not produce an entry for ${agentId}`);
    }
    return entry;
}
export function buildCoachBindings(current, coachAgentId, slug, mmUpdate) {
    const existing = current?.bindings;
    const currentBindings = Array.isArray(existing)
        ? [...existing]
        : [];
    const clone = { bindings: currentBindings };
    wireCoachMattermostBindings(clone, coachAgentId, slug, mmUpdate);
    return clone.bindings ?? [];
}
export function buildRemoveCustomerConfig(current, slug, agentId) {
    const config = structuredClone(current);
    const projectAgentPrefix = `octogee-${slug}-proj-`;
    const agents = config.agents?.list ?? [];
    const bindings = config.bindings ?? [];
    if (config.agents) {
        config.agents.list = agents.filter((agent) => agent.id !== agentId && !agent.id.startsWith(projectAgentPrefix));
    }
    config.bindings = filterOutCustomerBindings(bindings.filter((binding) => binding.agentId !== agentId), slug);
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
export function wireCoachMattermostBindings(config, coachAgentId, slug, mmUpdate) {
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
export async function markProvisioningComplete(ctx, mmUpdate, allAgentIds) {
    const provisioningObj = buildProvisioningSnapshot(ctx, allAgentIds);
    await writeSystemConfig(ctx);
    await writeProvisionedBuilder(ctx, allAgentIds, mmUpdate);
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
        const builder = await transaction.builders.records.get(ctx.uid);
        if (builder === null)
            throw new MissingRecordError({ aggregate: "builder", key: ctx.uid });
        if (builder.role === null)
            await transaction.builders.records.patch(ctx.uid, { role: "user" });
    });
    const systemConfigData = {
        updatedAt: FieldValue.serverTimestamp(),
    };
    if (ctx.tier === "trial") {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        systemConfigData.trialExpiresAt = expiresAt;
        log(`Trial expires: ${expiresAt.toISOString().slice(0, 10)} for ${ctx.slug}`);
    }
    await db.doc(`users/${ctx.uid}/system/config`).set(systemConfigData, { merge: true });
}
export function buildProvisionedBuilderPatch(ctx, mmUpdate) {
    const mattermostUserId = mmUpdate["mattermost.userId"];
    return {
        workspaceId: ctx.slug,
        slug: ctx.slug,
        ...(typeof mattermostUserId === "string" && mattermostUserId !== "" ? { mattermostUserId } : {}),
        openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: SERVER_NOW },
    };
}
async function writeProvisionedBuilder(ctx, allAgentIds, mmUpdate) {
    await platformStateStore.transaction({ label: "provisioning.complete" }, async (transaction) => {
        await transaction.builders.records.patch(ctx.uid, buildProvisionedBuilderPatch(ctx, mmUpdate));
        if (allAgentIds.length > 0)
            await transaction.builders.records.addAgents(ctx.uid, allAgentIds);
        await transaction.builders.records.setActivatedAgents(ctx.uid, ["coach"]);
    });
}
export function buildUserProductFields(ctx, mmUpdate) {
    return {
        tier: ctx.tier,
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
    const coachMmUserId = mmUpdate["mattermost.coachUserId"];
    if (!coachMmUserId)
        return;
    await platformStateStore.workspaces.agentIdentities.put({
        uid: ctx.uid,
        mattermostUserId: coachMmUserId,
        at: SERVER_NOW,
    });
    await db.doc(`agents/${ctx.uid}`).set(buildCoachAgentDoc(ctx.uid), { merge: true });
}
export function buildCoachAgentDoc(uid) {
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
    await notifyNewSignup({
        name: ctx.ownerName,
        email: data.email || "",
        tier: ctx.tier,
        slug: ctx.slug,
        uid: ctx.uid,
    });
}
