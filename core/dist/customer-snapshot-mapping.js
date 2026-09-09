import { projectAgentSecretDocId } from "./mattermost/project-agent.js";
import { parseAgentModelSelections } from "@octogee/shared/types/agent-models";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { projectAgentConfigured } from "@octogee/shared/types/project";
export function mapWorkspaceChannelDoc(data) {
    const channelId = data.mattermost?.channelId;
    if (!channelId)
        return null;
    return {
        scope: "workspace",
        kind: data.kind ?? "general",
        channelId,
    };
}
export function mapProjectChannelDoc(projectId, data) {
    const channelId = data.mattermost?.channelId;
    if (!channelId)
        return null;
    return {
        scope: "project",
        projectId,
        kind: data.kind ?? "default",
        channelId,
    };
}
class ProjectAgentIdentityError extends Error {
}
function projectIdentity(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object")
        throw new ProjectAgentIdentityError("Invalid project agent identity");
    const { name, emoji, persona } = value;
    if (typeof name !== "string" || !name.trim() || typeof emoji !== "string" || typeof persona !== "string") {
        throw new ProjectAgentIdentityError("Invalid project agent identity");
    }
    return { name, emoji, persona };
}
function projectAgentRuntimeState(value) {
    const agent = value && typeof value === "object" ? value : {};
    return {
        ...(agent.identity === undefined ? {} : { identity: projectIdentity(agent.identity) }),
        ...(agent.kickoff?.status === "pending" ||
            agent.handoff?.status === "pending" ? { deliveryPending: true } : {}),
        activationId: typeof agent.activationId === "string" ? agent.activationId : null,
        status: typeof agent.status === "string" ? agent.status : null,
    };
}
// Vegas: project-agent state for the snapshot. Null when the project has no
// agent state at all (never enabled, nothing minted) so snapshots stay lean;
// a disabled-with-secret entry survives so the reconcile can retire it.
export function mapProjectAgentState(projectId, projectData, secretData) {
    const agent = projectData.agent;
    const requestedEnabled = projectAgentConfigured(agent);
    const commercialLifecycle = projectData.commercialLifecycle;
    const archived = !!commercialLifecycle &&
        typeof commercialLifecycle === "object" &&
        commercialLifecycle.status === "archived";
    const enabled = requestedEnabled && !archived;
    const mmUserId = typeof secretData?.mmUserId === "string" && secretData.mmUserId ? secretData.mmUserId : null;
    const token = typeof secretData?.personalToken === "string" && secretData.personalToken
        ? secretData.personalToken
        : null;
    if (!enabled && mmUserId === null && token === null)
        return null;
    try {
        return { projectId, enabled, mmUserId, token, ...projectAgentRuntimeState(agent) };
    }
    catch (error) {
        if (!(error instanceof ProjectAgentIdentityError))
            throw error;
        console.error("Project agent identity rejected", { projectId, error: error.message });
        return { projectId, enabled, mmUserId, token, status: "error", activationId: null };
    }
}
// Vegas: collect per-project agent states for a snapshot. The secret is read
// only for projects whose doc carries an agent field — untouched projects
// cost no extra reads and can have no lingering secret to retire.
const PROJECT_AGENT_SECRET_PREFIX = projectAgentSecretDocId("");
export async function collectProjectAgentStates(db, uid, slug) {
    const snap = await db.collection("workspaces").doc(slug).collection("projects").get();
    const out = [];
    const seenProjects = new Set();
    for (const doc of snap.docs) {
        const data = doc.data() ?? {};
        if (data.agent === undefined)
            continue;
        seenProjects.add(doc.id);
        const secretSnap = await db
            .collection("users").doc(uid)
            .collection("secrets").doc(projectAgentSecretDocId(doc.id))
            .get();
        const state = mapProjectAgentState(doc.id, data, secretSnap.data());
        if (state)
            out.push(state);
    }
    // Deleting a project removes the doc that carries the agent flag — the
    // lingering secret is then the only retire trigger left. Surface each
    // orphaned projectAgentMattermost-* secret as a retire-pending state.
    const secretsSnap = await db.collection("users").doc(uid).collection("secrets").get();
    for (const doc of secretsSnap.docs) {
        if (!doc.id.startsWith(PROJECT_AGENT_SECRET_PREFIX))
            continue;
        const projectId = doc.id.slice(PROJECT_AGENT_SECRET_PREFIX.length);
        if (!projectId || seenProjects.has(projectId))
            continue;
        const state = mapProjectAgentState(projectId, {}, doc.data());
        if (state)
            out.push(state);
    }
    return out;
}
export function deriveSlug(uid, data) {
    const oc = data.provisioning?.openclaw;
    const slug = oc?.slug ?? data.username;
    if (!slug) {
        throw new Error(`[load:${uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`);
    }
    return slug;
}
function snapshotProvisioning(data) {
    const oc = data.provisioning?.openclaw;
    const git = data.provisioning?.git;
    return {
        gatewayId: oc?.gatewayId ?? "",
        status: (oc?.status ?? ""),
        agentIds: oc?.agentIds ?? [],
        repoUrl: git?.repoUrl ?? "",
        greetingPosted: Boolean(oc?.greeting?.ok),
    };
}
function snapshotIdentity(data, slug) {
    return {
        tier: data.tier ??
            data.subscription?.tier ??
            "trial",
        mattermostUserId: data.mattermost?.userId ?? null,
        ownerName: data.displayName ??
            data.username ??
            slug,
    };
}
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function byotSystemConfigFromRecord(credential) {
    const out = {};
    if (typeof credential.provider === "string")
        out.provider = credential.provider;
    if (typeof credential.baseUrl === "string")
        out.baseUrl = credential.baseUrl;
    if (typeof credential.model === "string")
        out.model = credential.model;
    return Object.keys(out).length > 0 ? { byot: out } : undefined;
}
// Per-agent model picks travel with the snapshot no matter the credential
// state — a plain platform customer's picker choices must survive pod rolls too.
function withAgentModels(sysData, systemConfig) {
    const agentModels = parseAgentModelSelections(sysData?.agentModels);
    if (Object.keys(agentModels).length === 0)
        return systemConfig;
    return { ...(systemConfig ?? {}), agentModels };
}
export function byotSnapshotProjectionFromSystemConfig(sysData) {
    const modelCredential = objectRecord(sysData?.modelCredential);
    if (modelCredential) {
        const byotConfig = modelCredential.active === true
            ? byotSystemConfigFromRecord(modelCredential)
            : undefined;
        const systemConfig = withAgentModels(sysData, byotConfig);
        return {
            byotActive: byotConfig !== undefined,
            ...(systemConfig ? { systemConfig } : {}),
        };
    }
    const byot = objectRecord(sysData?.byot);
    const systemConfig = withAgentModels(sysData, byot ? byotSystemConfigFromRecord(byot) : undefined);
    return {
        byotActive: null,
        ...(systemConfig ? { systemConfig } : {}),
    };
}
// Project a users/{uid}/system/config doc down to the byot fields the mount-time
// re-assert needs. Returns undefined when there is nothing usable so the snapshot stays
// lean; deriveDesiredByotState then defaults the provider to anthropic for an active BYOT.
export function byotSystemConfigFromDoc(sysData) {
    return byotSnapshotProjectionFromSystemConfig(sysData).systemConfig;
}
export function mapUserDocToSnapshot(uid, data, channels) {
    const slug = deriveSlug(uid, data);
    return {
        uid,
        slug,
        channels,
        byotActive: Boolean(data.byotActive),
        ...snapshotIdentity(data, slug),
        ...snapshotProvisioning(data),
        ...pickPlanInputs(data),
    };
}
