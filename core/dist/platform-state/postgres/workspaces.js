import { MANAGED_CHANNEL_INSTALLATION } from "../channel-identities.js";
import { linkChannelIdentity, managedExternalUserIdOf } from "./channel-identities.js";
import { DuplicateRecordError, MissingRecordError } from "../errors.js";
import { deleteRecord, revisionFence, selectByKey, selectRecords, serverNow, updateRecord } from "./records.js";
import { SqlParameters } from "./sql.js";
import { column, decodeStored, encodeColumn, inputContainsServerNow, inputFields, isClearField, isServerNow, resolveJsonValue, } from "./values.js";
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
const nullable = { nullAs: "null" };
const WORKSPACES_TABLE = {
    table: "workspaces",
    aggregate: "workspace",
    keyColumns: ["slug"],
    columns: [
        column("slug", "text"),
        column("id", "text"),
        column("ownerUid", "text"),
        column("ownerActive", "boolean", nullable),
        column("channelProvider", "text", { column: "channel_provider" }),
        column("channelInstallation", "text", { column: "channel_installation" }),
        column("mattermostTeamId", "text", { ...nullable, column: "channel_host_team_id" }),
        column("gitHost", "text", { column: "git_host" }),
        column("giteaOrgName", "text", { ...nullable, column: "git_owner" }),
        column("giteaRepoName", "text", { ...nullable, column: "git_repo" }),
        column("createdAt", "bigint", nullable),
        column("updatedAt", "bigint", nullable),
    ],
    immutableFields: ["slug", "id"],
};
const MEMBERS_TABLE = {
    table: "workspace_members",
    aggregate: "workspace-member",
    keyColumns: ["workspace_slug", "uid"],
    columns: [
        column("workspaceSlug", "text"),
        column("uid", "text"),
        column("role", "text"),
        column("joinedAt", "bigint", nullable),
        column("mattermostUserId", "text", { ...nullable, column: "channel_host_user_id" }),
        column("mattermostChannelId", "text", { ...nullable, column: "channel_host_channel_id" }),
        column("canonicalSource", "text", nullable),
        column("canonicalState", "text", nullable),
    ],
};
const PROJECTS_TABLE = {
    table: "workspace_projects",
    aggregate: "workspace-project",
    keyColumns: ["workspace_slug", "project_slug"],
    columns: [
        column("workspaceSlug", "text"),
        column("projectSlug", "text"),
        column("ownerUid", "text"),
        column("ownerActive", "boolean", nullable),
        column("gitHost", "text", { column: "git_host" }),
        column("giteaRepoName", "text", { ...nullable, column: "git_repo" }),
        column("provisioningState", "text", nullable),
        column("provisioningError", "text", nullable),
        column("provisioningCleanup", "jsonb", nullable),
        column("pendingVisibility", "text", nullable),
        column("visibility", "text", nullable),
        column("checkoutEnabled", "boolean", nullable),
        column("status", "text", nullable),
        column("archived", "boolean", nullable),
        column("archivedAt", "bigint", nullable),
        column("commercialLifecycleStatus", "text", nullable),
        column("repoSource", "jsonb", nullable),
        column("agent", "jsonb", nullable),
        column("updatedAt", "bigint", nullable),
    ],
};
const PROJECT_MEMBERS_TABLE = {
    table: "workspace_project_members",
    aggregate: "workspace-project-member",
    keyColumns: ["workspace_slug", "project_slug", "uid"],
    columns: [
        column("workspaceSlug", "text"),
        column("projectSlug", "text"),
        column("uid", "text"),
        column("role", "text"),
        column("joinedAt", "bigint", nullable),
    ],
};
const CHANNELS_TABLE = {
    table: "workspace_channels",
    aggregate: "workspace-channel",
    keyColumns: ["workspace_slug", "project_slug", "channel_id"],
    columns: [
        column("workspaceSlug", "text"),
        column("projectSlug", "text"),
        column("channelId", "text"),
        column("kind", "text", nullable),
        column("channelProvider", "text", { column: "channel_provider" }),
        column("channelInstallation", "text", { column: "channel_installation" }),
        column("mattermostChannelId", "text", { ...nullable, column: "channel_host_channel_id" }),
        column("archivedAt", "bigint", nullable),
        column("createdBy", "text", nullable),
        column("createdAt", "bigint", nullable),
    ],
};
const AGENT_IDENTITIES_TABLE = {
    table: "user_agent_identities",
    aggregate: "builder-agent-identity",
    keyColumns: ["uid"],
    columns: [
        column("uid", "text"),
        column("createdAt", "bigint", nullable),
        column("updatedAt", "bigint", nullable),
    ],
};
const AGENT_IDENTITY_COLUMNS = `*, ${managedExternalUserIdOf("agent", "user_agent_identities.uid")} AS channel_host_user_id`;
const WORKSPACE_SCOPE_PROJECT_SLUG = "";
const workspaceKey = (slug) => ({ aggregate: "workspace", key: slug });
const memberKey = (workspaceSlug, uid) => ({
    aggregate: "workspace-member",
    key: `${workspaceSlug}/${uid}`,
});
const projectKey = (workspaceSlug, projectSlug) => ({
    aggregate: "workspace-project",
    key: `${workspaceSlug}/${projectSlug}`,
});
const channelKey = (scope, channelId) => ({
    aggregate: "workspace-channel",
    key: scope.projectSlug === null ? `${scope.workspaceSlug}/${channelId}` : `${scope.workspaceSlug}/${scope.projectSlug}/${channelId}`,
});
const agentIdentityKey = (uid) => ({ aggregate: "builder-agent-identity", key: uid });
function storedProjectSlug(scope) {
    return scope.projectSlug ?? WORKSPACE_SCOPE_PROJECT_SLUG;
}
function channelTarget(scope, channelId) {
    return { table: CHANNELS_TABLE, key: [scope.workspaceSlug, storedProjectSlug(scope), channelId] };
}
export function resolveMergeValue(value, now, path) {
    if (isServerNow(value) || Array.isArray(value))
        return resolveJsonValue(value, now, "reject", path);
    if (isClearField(value) || !isPlainObject(value))
        return value;
    const resolved = {};
    for (const [key, item] of Object.entries(value)) {
        if (item !== undefined)
            resolved[key] = resolveMergeValue(item, now, `${path}.${key}`);
    }
    return resolved;
}
function mergeContributes(value) {
    if (value === null || value === undefined)
        return false;
    return !isPlainObject(value) || Object.keys(value).length > 0;
}
function mergeAssignment(put, spec, value, parameters, now) {
    const isKey = put.table.keyColumns.includes(spec.column);
    if (!put.deepMergeFields?.includes(spec.field)) {
        const encoded = encodeColumn(spec, value, parameters, now);
        return { column: spec.column, value: encoded, update: isKey ? null : `${spec.column} = EXCLUDED.${spec.column}` };
    }
    if (isClearField(value))
        return { column: spec.column, value: "NULL", update: `${spec.column} = NULL` };
    const patch = parameters.add(JSON.stringify(resolveMergeValue(value, now, spec.field)), "jsonb");
    return {
        column: spec.column,
        value: `$schema.jsonb_merge_deep(NULL, ${patch})`,
        update: `${spec.column} = $schema.jsonb_merge_deep(existing.${spec.column}, ${patch})`,
    };
}
export async function mergePutRecord(session, put) {
    const { table } = put;
    const entries = inputFields(table, put.record, put.input).filter(([spec, value]) => table.keyColumns.includes(spec.column) || mergeContributes(value));
    const now = inputContainsServerNow(entries) ? await serverNow(session) : undefined;
    const parameters = new SqlParameters();
    const assignments = entries.map(([spec, value]) => mergeAssignment(put, spec, value, parameters, now));
    const updates = assignments.flatMap((assignment) => (assignment.update === null ? [] : [assignment.update]));
    if (updates.length === 0)
        updates.push(`${table.keyColumns[0]} = EXCLUDED.${table.keyColumns[0]}`);
    await session.write(put.operation, put.record, `INSERT INTO $schema.${table.table} AS existing (${assignments.map((assignment) => assignment.column).join(", ")})
     VALUES (${assignments.map((assignment) => assignment.value).join(", ")})
     ON CONFLICT (${table.keyColumns.join(", ")}) DO UPDATE SET ${updates.join(", ")}`, parameters.values);
}
function decodeWorkspace(row) {
    return decodeStored(WORKSPACES_TABLE, row);
}
function decodeMember(row) {
    return decodeStored(MEMBERS_TABLE, row);
}
function decodeProject(row) {
    return decodeStored(PROJECTS_TABLE, row);
}
function decodeProjectMember(row) {
    return decodeStored(PROJECT_MEMBERS_TABLE, row);
}
function decodeChannel(row) {
    const { workspaceSlug, projectSlug, ...channel } = decodeStored(CHANNELS_TABLE, row);
    return {
        scope: { workspaceSlug, projectSlug: projectSlug === WORKSPACE_SCOPE_PROJECT_SLUG ? null : projectSlug },
        ...channel,
    };
}
function decodeAgentIdentity(row) {
    return {
        ...decodeStored(AGENT_IDENTITIES_TABLE, row),
        mattermostUserId: row.channel_host_user_id ?? null,
    };
}
async function findWorkspaceByChannelTeam(session, operation, installation, teamId) {
    const rows = await selectRecords(session, operation, `SELECT * FROM $schema.workspaces
     WHERE channel_provider = $1::text AND channel_installation = $2::text AND channel_host_team_id = $3::text
     ORDER BY slug LIMIT 2`, [installation.provider, installation.installation, teamId]);
    if (rows.length > 1)
        throw new DuplicateRecordError("workspace", "mattermostTeamId", teamId, rows.map(row => String(row.slug)));
    return rows.length === 0 ? null : decodeWorkspace(rows[0]);
}
async function findChannelByHostId(session, operation, installation, channelId) {
    const rows = await selectRecords(session, operation, `SELECT * FROM $schema.workspace_channels
     WHERE channel_provider = $1::text AND channel_installation = $2::text AND channel_host_channel_id = $3::text`, [installation.provider, installation.installation, channelId]);
    return rows.length === 0 ? null : decodeChannel(rows[0]);
}
function createWorkspaceRecordsRepository(session) {
    return {
        findByMattermostTeamId(teamId) {
            return findWorkspaceByChannelTeam(session, "workspaces.records.findByMattermostTeamId", MANAGED_CHANNEL_INSTALLATION, teamId);
        },
        findByChannelTeamId(installation, teamId) {
            return findWorkspaceByChannelTeam(session, "workspaces.records.findByChannelTeamId", installation, teamId);
        },
        async get(slug) {
            const row = await selectByKey(session, "workspaces.records.get", { table: WORKSPACES_TABLE, key: [slug] });
            return row === null ? null : decodeWorkspace(row);
        },
        async listByOwner(ownerUid) {
            const rows = await selectRecords(session, "workspaces.records.listByOwner", "SELECT * FROM $schema.workspaces WHERE owner_uid = $1::text ORDER BY slug", [ownerUid]);
            return rows.map(decodeWorkspace);
        },
        async put(record) {
            await mergePutRecord(session, {
                operation: "workspaces.records.put",
                table: WORKSPACES_TABLE,
                record: workspaceKey(record.slug),
                input: record,
            });
        },
        async patch(slug, patch, fence) {
            await updateRecord(session, "workspaces.records.patch", { table: WORKSPACES_TABLE, key: [slug] }, patch, revisionFence(fence?.revision));
        },
        async delete(slug) {
            await deleteRecord(session, "workspaces.records.delete", { table: WORKSPACES_TABLE, key: [slug] });
        },
    };
}
function createWorkspaceMembersRepository(session) {
    const list = async (operation, where, values) => (await selectRecords(session, operation, `SELECT * FROM $schema.workspace_members WHERE ${where} ORDER BY workspace_slug, uid`, values)).map(decodeMember);
    return {
        async get(workspaceSlug, uid) {
            const row = await selectByKey(session, "workspaces.members.get", { table: MEMBERS_TABLE, key: [workspaceSlug, uid] });
            return row === null ? null : decodeMember(row);
        },
        list(workspaceSlug) {
            return list("workspaces.members.list", "workspace_slug = $1::text", [workspaceSlug]);
        },
        listForUid(uid) {
            return list("workspaces.members.listForUid", "uid = $1::text", [uid]);
        },
        async put(member) {
            await mergePutRecord(session, {
                operation: "workspaces.members.put",
                table: MEMBERS_TABLE,
                record: memberKey(member.workspaceSlug, member.uid),
                input: member,
            });
        },
        async delete(workspaceSlug, uid) {
            await deleteRecord(session, "workspaces.members.delete", { table: MEMBERS_TABLE, key: [workspaceSlug, uid] });
        },
    };
}
const PROJECT_DEEP_MERGE_FIELDS = ["repoSource", "agent"];
function createWorkspaceProjectsRepository(session) {
    const list = async (operation, where, values) => (await selectRecords(session, operation, `SELECT * FROM $schema.workspace_projects ${where} ORDER BY workspace_slug, project_slug`, values)).map(decodeProject);
    return {
        async get(workspaceSlug, projectSlug) {
            const row = await selectByKey(session, "workspaces.projects.get", { table: PROJECTS_TABLE, key: [workspaceSlug, projectSlug] });
            return row === null ? null : decodeProject(row);
        },
        list(workspaceSlug) {
            return list("workspaces.projects.list", "WHERE workspace_slug = $1::text", [workspaceSlug]);
        },
        listByOwner(ownerUid, workspaceSlug) {
            if (workspaceSlug === undefined)
                return list("workspaces.projects.listByOwner", "WHERE owner_uid = $1::text", [ownerUid]);
            return list("workspaces.projects.listByOwner", "WHERE owner_uid = $1::text AND workspace_slug = $2::text", [ownerUid, workspaceSlug]);
        },
        listAll() {
            return list("workspaces.projects.listAll", "", []);
        },
        async put(project) {
            await mergePutRecord(session, {
                operation: "workspaces.projects.put",
                table: PROJECTS_TABLE,
                record: projectKey(project.workspaceSlug, project.projectSlug),
                input: project,
                deepMergeFields: PROJECT_DEEP_MERGE_FIELDS,
            });
        },
        async patch(workspaceSlug, projectSlug, patch, fence) {
            await updateRecord(session, "workspaces.projects.patch", { table: PROJECTS_TABLE, key: [workspaceSlug, projectSlug] }, patch, revisionFence(fence?.revision));
        },
        async delete(workspaceSlug, projectSlug) {
            await deleteRecord(session, "workspaces.projects.delete", { table: PROJECTS_TABLE, key: [workspaceSlug, projectSlug] });
        },
    };
}
function createWorkspaceProjectMembersRepository(session) {
    const list = async (operation, where, values) => (await selectRecords(session, operation, `SELECT * FROM $schema.workspace_project_members WHERE ${where} ORDER BY workspace_slug, project_slug, uid`, values)).map(decodeProjectMember);
    return {
        async get(workspaceSlug, projectSlug, uid) {
            const row = await selectByKey(session, "workspaces.projectMembers.get", {
                table: PROJECT_MEMBERS_TABLE,
                key: [workspaceSlug, projectSlug, uid],
            });
            return row === null ? null : decodeProjectMember(row);
        },
        list(workspaceSlug, projectSlug) {
            return list("workspaces.projectMembers.list", "workspace_slug = $1::text AND project_slug = $2::text", [workspaceSlug, projectSlug]);
        },
        listForUid(uid) {
            return list("workspaces.projectMembers.listForUid", "uid = $1::text", [uid]);
        },
        async put(member) {
            await mergePutRecord(session, {
                operation: "workspaces.projectMembers.put",
                table: PROJECT_MEMBERS_TABLE,
                record: { aggregate: "workspace-project-member", key: `${member.workspaceSlug}/${member.projectSlug}/${member.uid}` },
                input: member,
            });
        },
        async delete(workspaceSlug, projectSlug, uid) {
            await deleteRecord(session, "workspaces.projectMembers.delete", {
                table: PROJECT_MEMBERS_TABLE,
                key: [workspaceSlug, projectSlug, uid],
            });
        },
    };
}
async function patchChannel(session, scope, channelId, patch) {
    const operation = "workspaces.channels.patch";
    const record = channelKey(scope, channelId);
    const entries = inputFields(CHANNELS_TABLE, record, patch);
    const parameters = new SqlParameters();
    const assignments = entries.map(([spec, value]) => `${spec.column} = ${isClearField(value) ? "NULL" : encodeColumn(spec, value, parameters, undefined)}`);
    if (assignments.length === 0)
        assignments.push("channel_id = channel_id");
    const workspaceSlug = parameters.add(scope.workspaceSlug, "text");
    const projectSlug = parameters.add(storedProjectSlug(scope), "text");
    const channel = parameters.add(channelId, "text");
    const rows = await session.write(operation, record, `UPDATE $schema.workspace_channels SET ${assignments.join(", ")}
      WHERE workspace_slug = ${workspaceSlug} AND project_slug = ${projectSlug} AND channel_id = ${channel}
      RETURNING revision`, parameters.values);
    if (rows.length === 0)
        throw new MissingRecordError(record);
}
function createWorkspaceChannelsRepository(session) {
    return {
        async get(scope, channelId) {
            const row = await selectByKey(session, "workspaces.channels.get", channelTarget(scope, channelId));
            return row === null ? null : decodeChannel(row);
        },
        async list(scope) {
            const rows = await selectRecords(session, "workspaces.channels.list", "SELECT * FROM $schema.workspace_channels WHERE workspace_slug = $1::text AND project_slug = $2::text ORDER BY channel_id", [scope.workspaceSlug, storedProjectSlug(scope)]);
            return rows.map(decodeChannel);
        },
        findByMattermostChannelId(mattermostChannelId) {
            return findChannelByHostId(session, "workspaces.channels.findByMattermostChannelId", MANAGED_CHANNEL_INSTALLATION, mattermostChannelId);
        },
        findByHostChannelId(installation, channelId) {
            return findChannelByHostId(session, "workspaces.channels.findByHostChannelId", installation, channelId);
        },
        async put(channel) {
            const { scope, ...fields } = channel;
            await mergePutRecord(session, {
                operation: "workspaces.channels.put",
                table: CHANNELS_TABLE,
                record: channelKey(scope, channel.channelId),
                input: { ...fields, workspaceSlug: scope.workspaceSlug, projectSlug: storedProjectSlug(scope) },
            });
        },
        patch(scope, channelId, patch) {
            return patchChannel(session, scope, channelId, patch);
        },
        async delete(scope, channelId) {
            await deleteRecord(session, "workspaces.channels.delete", channelTarget(scope, channelId));
        },
    };
}
function createAgentIdentitiesRepository(session) {
    return {
        async get(uid) {
            const rows = await selectRecords(session, "workspaces.agentIdentities.get", `SELECT ${AGENT_IDENTITY_COLUMNS} FROM $schema.user_agent_identities WHERE uid = $1::text`, [uid]);
            return rows.length === 0 ? null : decodeAgentIdentity(rows[0]);
        },
        async listAll() {
            const rows = await selectRecords(session, "workspaces.agentIdentities.listAll", `SELECT ${AGENT_IDENTITY_COLUMNS} FROM $schema.user_agent_identities ORDER BY uid`);
            return rows.map(decodeAgentIdentity);
        },
        async put(identity) {
            const operation = "workspaces.agentIdentities.put";
            const record = agentIdentityKey(identity.uid);
            await session.atomically(operation, async (transaction) => {
                await mergePutRecord(transaction, {
                    operation,
                    table: AGENT_IDENTITIES_TABLE,
                    record,
                    input: { uid: identity.uid, createdAt: identity.at, updatedAt: identity.at },
                });
                if (identity.mattermostUserId === null)
                    return;
                await linkChannelIdentity(transaction, operation, record, { ...MANAGED_CHANNEL_INSTALLATION, externalUserId: identity.mattermostUserId, ownerKind: "agent", ownerId: identity.uid }, { aggregate: "builder-agent-identity", lookup: "mattermostUserId" });
            });
        },
        async delete(uid) {
            await deleteRecord(session, "workspaces.agentIdentities.delete", { table: AGENT_IDENTITIES_TABLE, key: [uid] });
        },
    };
}
export function createPostgresWorkspaceRepositories(session) {
    return {
        records: createWorkspaceRecordsRepository(session),
        members: createWorkspaceMembersRepository(session),
        projects: createWorkspaceProjectsRepository(session),
        projectMembers: createWorkspaceProjectMembersRepository(session),
        channels: createWorkspaceChannelsRepository(session),
        agentIdentities: createAgentIdentitiesRepository(session),
    };
}
function filterAllows(filterKeys, column, expected) {
    if (expected === undefined)
        return true;
    const values = filterKeys[column];
    return values === undefined || values.includes(expected);
}
function equalityConditions(filters, parameters) {
    return filters.flatMap(([name, value]) => (value === undefined ? [] : [`${name} = ${parameters.add(value, "text")}`]));
}
function whereClause(conditions) {
    return conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
}
function splitKeys(keys, parts) {
    const columns = Array.from({ length: parts }, () => []);
    for (const key of keys) {
        const segments = key.split("/");
        const padded = segments.length === parts ? segments : [segments[0], WORKSPACE_SCOPE_PROJECT_SLUG, ...segments.slice(1)];
        padded.forEach((segment, index) => columns[index].push(segment));
    }
    return columns;
}
function keyedSelects(source) {
    const conditions = (parameters) => equalityConditions(source.filters, parameters);
    return {
        selectAll: (parameters) => `SELECT ${source.columns ?? "*"} FROM $schema.${source.table} ${whereClause(conditions(parameters))} ORDER BY ${source.order}`,
        selectKeys: (keys, parameters) => {
            const arrays = splitKeys(keys, source.keyColumns.length).map((values) => parameters.add(values, "text[]"));
            const keyed = `(${source.keyColumns.join(", ")}) IN (SELECT * FROM unnest(${arrays.join(", ")}))`;
            return `SELECT ${source.columns ?? "*"} FROM $schema.${source.table} ${whereClause([keyed, ...conditions(parameters)])}`;
        },
    };
}
export function postgresWorkspacesWatchSource(filter) {
    return {
        aggregate: "workspaces",
        operation: "watch workspaces",
        ...keyedSelects({ table: "workspaces", keyColumns: ["slug"], order: "slug", filters: [["owner_uid", filter.ownerUid]] }),
        keyOf: (row) => row.slug,
        decode: decodeWorkspace,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "owner_uid", filter.ownerUid),
    };
}
export function postgresWorkspaceMembersWatchSource(filter) {
    return {
        aggregate: "workspaceMembers",
        operation: "watch workspaceMembers",
        ...keyedSelects({
            table: "workspace_members",
            keyColumns: ["workspace_slug", "uid"],
            order: "workspace_slug, uid",
            filters: [
                ["workspace_slug", filter.workspaceSlug],
                ["uid", filter.uid],
            ],
        }),
        keyOf: (row) => `${row.workspace_slug}/${row.uid}`,
        decode: decodeMember,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "workspace_slug", filter.workspaceSlug) && filterAllows(filterKeys, "uid", filter.uid),
    };
}
export function postgresWorkspaceProjectsWatchSource(filter) {
    return {
        aggregate: "workspaceProjects",
        operation: "watch workspaceProjects",
        ...keyedSelects({
            table: "workspace_projects",
            keyColumns: ["workspace_slug", "project_slug"],
            order: "workspace_slug, project_slug",
            filters: [["workspace_slug", filter.workspaceSlug]],
        }),
        keyOf: (row) => `${row.workspace_slug}/${row.project_slug}`,
        decode: decodeProject,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "workspace_slug", filter.workspaceSlug),
    };
}
export function postgresWorkspaceProjectMembersWatchSource(filter) {
    return {
        aggregate: "workspaceProjectMembers",
        operation: "watch workspaceProjectMembers",
        ...keyedSelects({
            table: "workspace_project_members",
            keyColumns: ["workspace_slug", "project_slug", "uid"],
            order: "workspace_slug, project_slug, uid",
            filters: [
                ["workspace_slug", filter.workspaceSlug],
                ["uid", filter.uid],
            ],
        }),
        keyOf: (row) => `${row.workspace_slug}/${row.project_slug}/${row.uid}`,
        decode: decodeProjectMember,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "workspace_slug", filter.workspaceSlug) && filterAllows(filterKeys, "uid", filter.uid),
    };
}
export function postgresWorkspaceChannelsWatchSource(filter) {
    return {
        aggregate: "workspaceChannels",
        operation: "watch workspaceChannels",
        ...keyedSelects({
            table: "workspace_channels",
            keyColumns: ["workspace_slug", "project_slug", "channel_id"],
            order: "workspace_slug, project_slug, channel_id",
            filters: [["workspace_slug", filter.workspaceSlug]],
        }),
        keyOf: (row) => row.channel_key,
        decode: decodeChannel,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "workspace_slug", filter.workspaceSlug),
    };
}
export function postgresAgentIdentitiesWatchSource(filter) {
    return {
        aggregate: "agentIdentities",
        operation: "watch agentIdentities",
        ...keyedSelects({ table: "user_agent_identities", columns: AGENT_IDENTITY_COLUMNS, keyColumns: ["uid"], order: "uid", filters: [["uid", filter.uid]] }),
        keyOf: (row) => row.uid,
        decode: decodeAgentIdentity,
        mayMatch: (filterKeys) => filterAllows(filterKeys, "uid", filter.uid),
    };
}
