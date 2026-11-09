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
const OPENCLAW_PROVISIONING_VERSION = "v1";
export async function markProvisioningComplete(ctx, mmUpdate, allAgentIds) {
    await writeSystemConfig(ctx);
    await writeBuilderProvisioningState(ctx, mmUpdate, allAgentIds);
    await writeProductUserFields(ctx, mmUpdate);
    await writeWorkspaceDoc(ctx, mmUpdate);
    await seedWorkspaceChannels(ctx, mmUpdate);
    await seedWorkspaceOwner(ctx);
    await writeAgentDoc(ctx, mmUpdate);
    await updateUserWorkspaceEntry(ctx, buildProvisioningSnapshot(ctx, allAgentIds));
}
function buildProvisioningSnapshot(ctx, allAgentIds) {
    const provisioningObj = {
        status: "complete",
        version: OPENCLAW_PROVISIONING_VERSION,
        slug: ctx.slug,
        ...(allAgentIds.length > 0 ? { agentIds: FieldValue.arrayUnion(...allAgentIds) } : {}),
        activatedAgents: ["coach"],
        customerDir: ctx.customerDir,
        provisionedAt: FieldValue.serverTimestamp(),
    };
    return provisioningObj;
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
function builderProvisioningPatch(ctx, mmUpdate) {
    const mattermostUserId = mmUpdate["mattermost.userId"];
    return {
        slug: ctx.slug,
        workspaceId: ctx.slug,
        ...(typeof mattermostUserId === "string" && mattermostUserId !== "" ? { mattermostUserId } : {}),
        openclaw: {
            version: OPENCLAW_PROVISIONING_VERSION,
            customerDir: ctx.customerDir,
            provisionedAt: { serverNow: true },
        },
    };
}
async function writeBuilderProvisioningState(ctx, mmUpdate, allAgentIds) {
    const { records } = platformStateStore.builders;
    await records.patch(ctx.uid, builderProvisioningPatch(ctx, mmUpdate));
    await records.addAgents(ctx.uid, allAgentIds);
    await records.setActivatedAgents(ctx.uid, ["coach"]);
}
async function writeProductUserFields(ctx, mmUpdate) {
    const productFields = { tier: ctx.tier };
    for (const [key, value] of Object.entries(mmUpdate)) {
        if (key.startsWith("mattermost.") && key !== "mattermost.userId")
            productFields[key] = value;
    }
    await db.collection("users").doc(ctx.uid).update(productFields);
}
async function writeWorkspaceDoc(ctx, mmUpdate) {
    const mmTeamId = mmUpdate["mattermost.teamId"];
    await platformStateStore.workspaces.records.put({
        slug: ctx.slug,
        id: ctx.slug,
        ownerUid: ctx.uid,
        ownerActive: null,
        mattermostTeamId: mmTeamId || null,
        giteaOrgName: ctx.slug,
        giteaRepoName: workspaceRepoName(),
        createdAt: null,
        updatedAt: { serverNow: true },
    });
    await db.doc(`workspaces/${ctx.slug}`).set({ name: ctx.slug, ownerDisplayName: ctx.slug }, { merge: true });
}
async function seedWorkspaceChannel(slug, channelId, mattermostChannelId, name) {
    await platformStateStore.workspaces.channels.put({
        scope: { workspaceSlug: slug, projectSlug: null },
        channelId,
        kind: channelId,
        mattermostChannelId,
        archivedAt: null,
        createdBy: null,
        createdAt: { serverNow: true },
    });
    await db.doc(`workspaces/${slug}/channels/${channelId}`).set({ name }, { merge: true });
}
async function seedWorkspaceChannels(ctx, mmUpdate) {
    const generalChannelId = mmUpdate["mattermost.generalChannelId"];
    if (generalChannelId)
        await seedWorkspaceChannel(ctx.slug, "general", generalChannelId, "general");
    const coachDmChannelId = mmUpdate["mattermost.channelId"];
    if (coachDmChannelId) {
        const name = mmUpdate["mattermost.channelName"] || "coach-dm";
        await seedWorkspaceChannel(ctx.slug, "coach-dm", coachDmChannelId, name);
    }
}
async function seedWorkspaceOwner(ctx) {
    await platformStateStore.workspaces.members.put({
        workspaceSlug: ctx.slug,
        uid: ctx.uid,
        role: "owner",
        joinedAt: { serverNow: true },
        mattermostUserId: null,
    });
}
async function writeAgentDoc(ctx, mmUpdate) {
    const coachMmUserId = mmUpdate["mattermost.coachUserId"];
    if (!coachMmUserId)
        return;
    await platformStateStore.workspaces.agentIdentities.put({
        uid: ctx.uid,
        mattermostUserId: coachMmUserId,
        at: { serverNow: true },
    });
    await db.doc(`agents/${ctx.uid}`).set({ name: "Octo", persona: "", avatarEmoji: "🐙", look: DEFAULT_AGENT_LOOK }, { merge: true });
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
