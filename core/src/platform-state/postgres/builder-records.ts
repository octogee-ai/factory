import { MANAGED_CHANNEL_INSTALLATION } from "../channel-identities.js";
import { clearManagedChannelIdentity, linkChannelIdentity, managedExternalUserIdOf, managedOwnerIdOf } from "./channel-identities.js";
import { isDeepStrictEqual } from "node:util";
import type { AccountLifecycle } from "@octogee/shared/types/account-lifecycle";
import type {
  ActivationLeaseFence,
  AdmitBuilderInput,
  BuilderActivationLease,
  BuilderActivationLeaseStatus,
  BuilderFence,
  BuilderFenceName,
  BuilderFences,
  BuilderGatewayMirror,
  BuilderHomeState,
  BuilderOpenClawState,
  BuilderPatch,
  BuilderProvisioning,
  BuilderRecord,
  BuilderRecordsRepository,
  BuilderRole,
  GatewayFenceHolders,
} from "../builders.js";
import {
  DuplicateRecordError,
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
  type FenceName,
  type RecordKey,
} from "../errors.js";
import type { OpaqueMap, Page, Stored, WatchFilters } from "../store.js";
import { serverNow } from "./records.js";
import type { PostgresSession } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { column, containsServerNow, encodeColumn, isClearField, resolveJsonValue, revisionOf, type ColumnSpec } from "./values.js";
import type { FilterKeys, PostgresWatchSource } from "./watch-sources.js";

const LEASE_STATUSES: readonly BuilderActivationLeaseStatus[] = [
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
  "parked",
  "failed",
];

const COLUMNS = {
  slug: column("slug", "text"),
  workspaceId: column("workspaceId", "text"),
  role: column("role", "text"),
  createdAt: column("createdAt", "bigint"),
  persona: column("persona", "jsonb"),
  provisioningStatus: column("provisioningStatus", "text"),
  provisioningStartedAt: column("provisioningStartedAt", "bigint"),
  gitRepoUrl: column("gitRepoUrl", "text"),
  gitCreatedAt: column("gitCreatedAt", "bigint"),
  gatewayId: column("gatewayId", "text"),
  gatewayAssignedAt: column("gatewayAssignedAt", "bigint"),
  gatewayProfile: column("gatewayProfile", "text"),
  controlUiEnabled: column("controlUiEnabled", "boolean"),
  openclawStatus: column("openclawStatus", "text"),
  openclawVersion: column("openclawVersion", "text"),
  agentId: column("agentId", "text"),
  customerDir: column("customerDir", "text", { column: "user_dir" }),
  provisionedAt: column("provisionedAt", "bigint"),
  mounted: column("mounted", "boolean"),
  managedBy: column("managedBy", "text"),
  greeting: column("greeting", "jsonb"),
  toolchain: column("toolchain", "jsonb"),
  lifecycleStatus: column("lifecycleStatus", "text"),
  lifecycleDeletionId: column("lifecycleDeletionId", "text"),
  lifecycleSuspendedAt: column("lifecycleSuspendedAt", "bigint"),
  lifecycleEraseAfter: column("lifecycleEraseAfter", "bigint"),
  activationLease: column("activationLease", "jsonb"),
  restoreFence: column("restoreFence", "jsonb"),
  sourceTransferFence: column("sourceTransferFence", "jsonb"),
  computerRecovery: column("computerRecovery", "jsonb"),
  migration: column("migration", "jsonb", { column: "migration_marker" }),
  pendingNativeSchedulerRetirement: column("pendingNativeSchedulerRetirement", "jsonb"),
  runtimeReset: column("runtimeReset", "jsonb"),
  computer: column("computer", "jsonb"),
  homeCheckpoint: column("homeCheckpoint", "jsonb"),
  homeDisk: column("homeDisk", "jsonb"),
  homeStorage: column("homeStorage", "jsonb"),
  homeMigration: column("homeMigration", "jsonb"),
  homeErasure: column("homeErasure", "jsonb"),
  homeCapacity: column("homeCapacity", "jsonb"),
  projectStorageNativeBoot: column("projectStorageNativeBoot", "jsonb"),
} as const;

type GroupColumns = Readonly<Record<string, ColumnSpec>>;

const TOP_LEVEL_COLUMNS: GroupColumns = {
  slug: COLUMNS.slug,
  workspaceId: COLUMNS.workspaceId,
  role: COLUMNS.role,
};

const PROVISIONING_COLUMNS = {
  status: COLUMNS.provisioningStatus,
  startedAt: COLUMNS.provisioningStartedAt,
  gitRepoUrl: COLUMNS.gitRepoUrl,
  gitCreatedAt: COLUMNS.gitCreatedAt,
} as const satisfies Record<keyof BuilderProvisioning, ColumnSpec>;

const MIRROR_COLUMNS = {
  gatewayId: COLUMNS.gatewayId,
  gatewayAssignedAt: COLUMNS.gatewayAssignedAt,
  gatewayProfile: COLUMNS.gatewayProfile,
  controlUiEnabled: COLUMNS.controlUiEnabled,
} as const satisfies Record<keyof BuilderGatewayMirror, ColumnSpec>;

const OPENCLAW_COLUMNS = {
  status: COLUMNS.openclawStatus,
  version: COLUMNS.openclawVersion,
  agentId: COLUMNS.agentId,
  customerDir: COLUMNS.customerDir,
  provisionedAt: COLUMNS.provisionedAt,
  mounted: COLUMNS.mounted,
  managedBy: COLUMNS.managedBy,
  greeting: COLUMNS.greeting,
  toolchain: COLUMNS.toolchain,
} as const satisfies Record<keyof BuilderOpenClawState, ColumnSpec>;

const FENCE_COLUMNS = {
  restoreFence: COLUMNS.restoreFence,
  sourceTransferFence: COLUMNS.sourceTransferFence,
  computerRecovery: COLUMNS.computerRecovery,
  migration: COLUMNS.migration,
  pendingNativeSchedulerRetirement: COLUMNS.pendingNativeSchedulerRetirement,
  runtimeReset: COLUMNS.runtimeReset,
} as const satisfies Record<BuilderFenceName, ColumnSpec>;

const HOME_COLUMNS = {
  computer: COLUMNS.computer,
  homeCheckpoint: COLUMNS.homeCheckpoint,
  homeDisk: COLUMNS.homeDisk,
  homeStorage: COLUMNS.homeStorage,
  homeMigration: COLUMNS.homeMigration,
  homeErasure: COLUMNS.homeErasure,
  homeCapacity: COLUMNS.homeCapacity,
  projectStorageNativeBoot: COLUMNS.projectStorageNativeBoot,
} as const satisfies Record<keyof BuilderHomeState, ColumnSpec>;

const LIFECYCLE_COLUMNS = {
  status: COLUMNS.lifecycleStatus,
  deletionId: COLUMNS.lifecycleDeletionId,
  suspendedAt: COLUMNS.lifecycleSuspendedAt,
  eraseAfter: COLUMNS.lifecycleEraseAfter,
} as const satisfies Record<keyof AccountLifecycle, ColumnSpec>;

const PATCH_GROUPS: Readonly<Record<string, GroupColumns>> = {
  provisioning: PROVISIONING_COLUMNS,
  openclaw: OPENCLAW_COLUMNS,
  home: HOME_COLUMNS,
};

const UNIQUE_LOOKUPS: Readonly<Record<string, string>> = {
  slug: "slug",
  computer_instance_id: "computerInstanceId",
};

const BY_UID = "ORDER BY b.uid";

const SELECT_BUILDERS = `SELECT b.*,
  ${managedExternalUserIdOf("user", "b.uid")} AS channel_host_user_id,
  ARRAY(SELECT a.agent_id FROM $schema.user_agents a WHERE a.uid = b.uid ORDER BY a.agent_id) AS agent_ids
  FROM $schema.users b`;

export const builderKey = (uid: string): RecordKey => ({ aggregate: "builder", key: uid });

type PlainObject = Record<string, unknown>;
type Assignment = readonly [ColumnSpec, unknown];
type Explain = (current: Stored<BuilderRecord>) => void;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function present<T extends object>(fields: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

export function selectBuilders(where: string, suffix = ""): string {
  return `${SELECT_BUILDERS} WHERE ${where} ${suffix}`;
}

class BuilderRow {
  private readonly record: RecordKey;

  constructor(private readonly row: Row) {
    this.record = builderKey(row.uid as string);
  }

  optional<T>(columnName: string): T | undefined {
    const value = this.row[columnName];
    return value === null || value === undefined ? undefined : (value as T);
  }

  nullable<T>(columnName: string): T | null {
    return this.optional<T>(columnName) ?? null;
  }

  private json(columnName: string): unknown {
    const raw = this.optional<string>(columnName);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  map<T = OpaqueMap>(columnName: string): T | undefined {
    const value = this.json(columnName);
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new MalformedRecordError(this.record, `${columnName} is not a map`);
    return value as T;
  }

  boolean(columnName: string): boolean | undefined {
    const value = this.json(columnName);
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new MalformedRecordError(this.record, `${columnName} is not a boolean`);
    return value;
  }

  maps(columnName: string): OpaqueMap[] | undefined {
    const value = this.json(columnName);
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every(isPlainObject)) {
      throw new MalformedRecordError(this.record, `${columnName} is not a list of maps`);
    }
    return value;
  }

  strings(columnName: string): string[] {
    const value = this.row[columnName];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new MalformedRecordError(this.record, `${columnName} is not a list of strings`);
    }
    return value;
  }

  lease(): BuilderActivationLease | null {
    const lease = this.map<BuilderActivationLease>("activation_lease");
    if (lease === undefined) return null;
    if (typeof lease.leaseId !== "string") throw new MalformedRecordError(this.record, "activation_lease.leaseId is not a string");
    if (typeof lease.generation !== "number") throw new MalformedRecordError(this.record, "activation_lease.generation is not a number");
    if (!LEASE_STATUSES.includes(lease.status)) {
      throw new MalformedRecordError(this.record, `activation_lease.status is not one of ${LEASE_STATUSES.join(", ")}`);
    }
    return lease;
  }
}

function decodeGatewayMirror(fields: BuilderRow): BuilderGatewayMirror | null {
  const gatewayId = fields.optional<string>("gateway_id");
  if (gatewayId === undefined) return null;
  return present<BuilderGatewayMirror>({
    gatewayId,
    gatewayAssignedAt: fields.optional("gateway_assigned_at"),
    gatewayProfile: fields.optional("gateway_profile"),
    controlUiEnabled: fields.optional("control_ui_enabled"),
  });
}

function decodeAccountLifecycle(fields: BuilderRow): AccountLifecycle | null {
  const status = fields.optional<AccountLifecycle["status"]>("lifecycle_status");
  if (status === undefined) return null;
  return present<AccountLifecycle>({
    status,
    deletionId: fields.optional("lifecycle_deletion_id"),
    suspendedAt: fields.optional("lifecycle_suspended_at"),
    eraseAfter: fields.optional("lifecycle_erase_after"),
  });
}

function decodeOpenClaw(fields: BuilderRow): BuilderOpenClawState {
  return present<BuilderOpenClawState>({
    status: fields.optional("openclaw_status"),
    version: fields.optional("openclaw_version"),
    agentId: fields.optional("agent_id"),
    customerDir: fields.optional("user_dir"),
    provisionedAt: fields.optional("provisioned_at"),
    mounted: fields.optional("mounted"),
    managedBy: fields.optional("managed_by"),
    greeting: fields.map("greeting"),
    toolchain: fields.map("toolchain"),
  });
}

function decodeFences(fields: BuilderRow): BuilderFences {
  return present<BuilderFences>({
    restoreFence: fields.map("restore_fence"),
    sourceTransferFence: fields.map("source_transfer_fence"),
    computerRecovery: fields.map("computer_recovery"),
    migration: fields.map("migration_marker"),
    pendingNativeSchedulerRetirement: fields.map("pending_native_scheduler_retirement"),
    runtimeReset: fields.map("runtime_reset"),
  });
}

function decodeHome(fields: BuilderRow): BuilderHomeState {
  return present<BuilderHomeState>({
    computer: fields.map("computer"),
    homeCheckpoint: fields.map("home_checkpoint"),
    homeDisk: fields.map("home_disk"),
    homeStorage: fields.map("home_storage"),
    homeMigration: fields.map("home_migration"),
    homeErasure: fields.maps("home_erasure"),
    homeCapacity: fields.map("home_capacity"),
    projectStorageNativeBoot: fields.boolean("project_storage_native_boot"),
  });
}

export function decodeBuilderRow(row: Row): Stored<BuilderRecord> {
  const fields = new BuilderRow(row);
  return {
    uid: row.uid as string,
    slug: fields.nullable("slug"),
    mattermostUserId: fields.nullable("channel_host_user_id"),
    admitted: row.admitted === true,
    persona: fields.map("persona") ?? null,
    workspaceId: fields.nullable("workspace_id"),
    role: fields.nullable<BuilderRole>("role"),
    createdAt: fields.nullable("created_at"),
    updatedAt: row.updated_at as number,
    provisioning: present<BuilderProvisioning>({
      status: fields.optional("provisioning_status"),
      startedAt: fields.optional("provisioning_started_at"),
      gitRepoUrl: fields.optional("git_repo_url"),
      gitCreatedAt: fields.optional("git_created_at"),
    }),
    gateway: decodeGatewayMirror(fields),
    openclaw: decodeOpenClaw(fields),
    agents: { agentIds: fields.strings("agent_ids"), activatedAgents: fields.strings("activated_agents") },
    accountLifecycle: decodeAccountLifecycle(fields),
    activationLease: fields.lease(),
    fences: decodeFences(fields),
    home: decodeHome(fields),
    revision: revisionOf(row),
  };
}

function groupAssignments(group: unknown, columns: GroupColumns, groupName: string): Assignment[] {
  if (!isPlainObject(group)) throw new TypeError(`builder patch ${groupName} must be a map`);
  const assignments: Assignment[] = [];
  for (const [key, value] of Object.entries(group)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(columns, key)) throw new TypeError(`builder patch ${groupName}.${key} has no stored field`);
    assignments.push([columns[key], value]);
  }
  return assignments;
}

function lifecycleAssignments(value: unknown): Assignment[] {
  const columns = Object.entries(LIFECYCLE_COLUMNS);
  if (isClearField(value)) return columns.map(([, spec]) => [spec, value]);
  if (!isPlainObject(value) || typeof value.status !== "string") {
    throw new TypeError("builder patch accountLifecycle must be a lifecycle with a status or { clear: true }");
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(LIFECYCLE_COLUMNS, key)) throw new TypeError(`builder patch accountLifecycle.${key} has no stored field`);
  }
  return columns.map(([key, spec]) => [spec, value[key] ?? null]);
}

function patchAssignments(patch: BuilderPatch): Assignment[] {
  const assignments: Assignment[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Object.hasOwn(TOP_LEVEL_COLUMNS, key)) assignments.push([TOP_LEVEL_COLUMNS[key], value]);
    else if (key === "accountLifecycle") assignments.push(...lifecycleAssignments(value));
    else if (Object.hasOwn(PATCH_GROUPS, key)) assignments.push(...groupAssignments(value, PATCH_GROUPS[key], key));
    else throw new TypeError(`builder patch ${key} has no stored field`);
  }
  return assignments;
}

function encodeValue(spec: ColumnSpec, value: unknown, parameters: SqlParameters, now: number | undefined): string {
  if (value === null || isClearField(value)) return "NULL";
  return encodeColumn(spec, value, parameters, now);
}

async function resolveNow(session: PostgresSession, jsonValues: readonly unknown[]): Promise<number | undefined> {
  return jsonValues.some((value) => !isClearField(value) && containsServerNow(value)) ? serverNow(session) : undefined;
}

function jsonValuesOf(assignments: readonly Assignment[]): unknown[] {
  return assignments.filter(([spec]) => spec.type === "jsonb").map(([, value]) => value);
}

function remapDuplicate(error: unknown): unknown {
  if (!(error instanceof DuplicateRecordError) || !Object.hasOwn(UNIQUE_LOOKUPS, error.lookup)) return error;
  return new DuplicateRecordError("builder", UNIQUE_LOOKUPS[error.lookup], error.value, error.keysFound);
}

async function writeBuilder(
  session: PostgresSession,
  operation: string,
  uid: string,
  text: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  try {
    return await session.write(operation, builderKey(uid), text, values);
  } catch (error) {
    throw remapDuplicate(error);
  }
}

async function readCurrentBuilder(session: PostgresSession, uid: string): Promise<Stored<BuilderRecord> | null> {
  const rows = await session.execute(selectBuilders("b.uid = $1::text"), [uid]);
  return rows.length === 0 ? null : decodeBuilderRow(rows[0]);
}

interface BuilderStatement {
  readonly uid: string;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly explain?: Explain;
}

async function runBuilderStatement(session: PostgresSession, operation: string, statement: BuilderStatement): Promise<void> {
  const { uid, text, values, explain } = statement;
  if (explain === undefined) {
    const rows = await writeBuilder(session, operation, uid, text, values);
    if (rows.length === 0) throw new MissingRecordError(builderKey(uid));
    return;
  }
  await session.atomically(operation, async (fenced) => {
    const rows = await writeBuilder(fenced, operation, uid, text, values);
    if (rows.length > 0) return;
    const current = await readCurrentBuilder(fenced, uid);
    if (current === null) throw new MissingRecordError(builderKey(uid));
    explain(current);
    throw new Error(`${operation} found builder ${JSON.stringify(uid)} unchanged although every fence holds`);
  });
}

class BuilderUpdate {
  readonly parameters = new SqlParameters();
  private readonly sets: string[] = [];
  private readonly conditions: string[] = [];
  private readonly explanations: Explain[] = [];

  constructor(
    readonly uid: string,
    readonly now: number | undefined,
  ) {}

  set(assignments: readonly Assignment[]): this {
    for (const [spec, value] of assignments) this.sets.push(`${spec.column} = ${encodeValue(spec, value, this.parameters, this.now)}`);
    return this;
  }

  setSql(assignment: string): this {
    this.sets.push(assignment);
    return this;
  }

  where(conditions: readonly string[], explain: Explain): this {
    if (conditions.length === 0) return this;
    this.conditions.push(...conditions);
    this.explanations.push(explain);
    return this;
  }

  statement(): BuilderStatement {
    if (this.sets.length === 0) this.sets.push("uid = uid");
    const where = [`uid = ${this.parameters.add(this.uid, "text")}`, ...this.conditions].join(" AND ");
    const explanations = [...this.explanations];
    return {
      uid: this.uid,
      text: `UPDATE $schema.users SET ${this.sets.join(", ")} WHERE ${where} RETURNING revision`,
      values: this.parameters.values,
      explain: explanations.length === 0 ? undefined : (current) => explanations.forEach((explain) => explain(current)),
    };
  }
}

function fenceMismatch(record: RecordKey, field: string, expected: unknown, actual: unknown): FenceMismatchError {
  return new FenceMismatchError(
    record,
    expected === null || expected === undefined ? "absent" : "present",
    { [field]: expected },
    { [field]: actual },
  );
}

function assertFenceEquals(record: RecordKey, fence: FenceName, expected: unknown, actual: unknown): void {
  if (expected === undefined) return;
  const stored = actual === undefined ? null : actual;
  if (!isDeepStrictEqual(expected, stored)) throw new FenceMismatchError(record, fence, expected, stored);
}

function assertBuilderFence(record: RecordKey, fence: BuilderFence, current: Stored<BuilderRecord>): void {
  if (fence.revision !== undefined && fence.revision !== current.revision) {
    throw new FenceMismatchError(record, "revision", fence.revision, current.revision);
  }
  const gatewayId = current.gateway?.gatewayId ?? null;
  if (fence.gatewayId !== undefined && fence.gatewayId !== gatewayId) throw fenceMismatch(record, "gatewayId", fence.gatewayId, gatewayId);
  if (fence.provisioningStatus === "absent") {
    if (current.provisioning.status !== undefined) throw fenceMismatch(record, "provisioningStatus", null, current.provisioning.status);
    return;
  }
  assertFenceEquals(record, "status", fence.provisioningStatus, current.provisioning.status);
}

function explainBuilderFence(uid: string, fence: BuilderFence | undefined): Explain {
  return (current) => assertBuilderFence(builderKey(uid), fence ?? {}, current);
}

function builderFenceConditions(fence: BuilderFence | undefined, parameters: SqlParameters): string[] {
  if (fence === undefined) return [];
  const conditions: string[] = [];
  if (fence.revision !== undefined) conditions.push(`revision::text = ${parameters.add(fence.revision, "text")}`);
  if (fence.gatewayId === null) conditions.push("gateway_id IS NULL");
  else if (fence.gatewayId !== undefined) conditions.push(`gateway_id = ${parameters.add(fence.gatewayId, "text")}`);
  if (fence.provisioningStatus === "absent") conditions.push("provisioning_status IS NULL");
  else if (fence.provisioningStatus !== undefined) {
    conditions.push(`provisioning_status = ${parameters.add(fence.provisioningStatus, "text")}`);
  }
  return conditions;
}

function assertActivationLeaseFence(record: RecordKey, fence: ActivationLeaseFence, lease: BuilderActivationLease | null): void {
  assertFenceEquals(record, "leaseId", fence.leaseId, lease?.leaseId ?? null);
  assertFenceEquals(record, "generation", fence.generation, lease?.generation ?? null);
  const status = lease?.status;
  if (fence.status !== undefined && !fence.status.some((allowed) => allowed === status)) {
    throw new FenceMismatchError(record, "status", fence.status, status);
  }
}

function activationLeaseConditions(fence: ActivationLeaseFence, parameters: SqlParameters): string[] {
  const conditions: string[] = [];
  if (fence.leaseId === null) conditions.push("lease_id IS NULL");
  else if (fence.leaseId !== undefined) conditions.push(`lease_id = ${parameters.add(fence.leaseId, "text")}`);
  if (fence.generation === null) conditions.push("lease_generation IS NULL");
  else if (fence.generation !== undefined) conditions.push(`lease_generation = ${parameters.add(fence.generation, "integer")}`);
  if (fence.status !== undefined) conditions.push(`lease_status = ANY(${parameters.add([...fence.status], "text[]")})`);
  return conditions;
}

function jsonParameter(value: unknown, parameters: SqlParameters, now: number | undefined, path: string): string {
  return parameters.add(JSON.stringify(resolveJsonValue(value, now, "reject", path)), "jsonb");
}

function rosterStatement(uid: string, agentIds: readonly string[], change: "add" | "remove"): BuilderStatement {
  const touched = "touched AS (UPDATE $schema.users SET uid = uid WHERE uid = $1::text RETURNING uid)";
  const roster =
    change === "add"
      ? `INSERT INTO $schema.user_agents (uid, agent_id)
           SELECT DISTINCT touched.uid, agent.id FROM touched, unnest($2::text[]) AS agent (id) ON CONFLICT DO NOTHING`
      : "DELETE FROM $schema.user_agents a USING touched WHERE a.uid = touched.uid AND a.agent_id = ANY($2::text[])";
  return { uid, text: `WITH ${touched}, roster AS (${roster}) SELECT uid FROM touched`, values: [uid, [...agentIds]] };
}

async function selectRecords(session: PostgresSession, operation: string, text: string, values: readonly unknown[]) {
  return (await session.read(operation, text, values)).map(decodeBuilderRow);
}

type BuilderRecordReadMethod =
  | "get"
  | "getRole"
  | "getMany"
  | "findBySlug"
  | "findByMattermostUserId"
  | "findByComputerInstanceId"
  | "listByAgentId"
  | "listByGateway"
  | "listGatewayFenceHolders"
  | "listAdmitted"
  | "listByOpenClawStatus"
  | "listAll"
  | "list";

function builderRecordReads(session: PostgresSession): Pick<BuilderRecordsRepository, BuilderRecordReadMethod> {
  const findOne = async (operation: string, where: string, value: string) =>
    (await selectRecords(session, operation, selectBuilders(where), [value]))[0] ?? null;
  return {
    get(uid) {
      return findOne("builders.records.get", "b.uid = $1::text", uid);
    },

    async getRole(uid) {
      const rows = await session.read("builders.records.getRole", "SELECT role FROM $schema.users WHERE uid = $1::text", [uid]);
      return (rows[0]?.role as BuilderRole | null | undefined) ?? null;
    },

    async getMany(uids) {
      const records = await selectRecords(session, "builders.records.getMany", selectBuilders("b.uid = ANY($1::text[])"), [[...uids]]);
      return new Map(records.map((record) => [record.uid, record]));
    },

    findBySlug(slug) {
      return findOne("builders.records.findBySlug", "b.slug = $1::text", slug);
    },

    findByMattermostUserId(mattermostUserId) {
      return findOne("builders.records.findByMattermostUserId", `b.uid = ${managedOwnerIdOf("user", "$1::text")}`, mattermostUserId);
    },

    findByComputerInstanceId(instanceId) {
      return findOne("builders.records.findByComputerInstanceId", "b.computer_instance_id = $1::text", instanceId);
    },

    listByAgentId(agentId, limit) {
      const where = `b.uid IN (
        (SELECT p.uid FROM $schema.users p WHERE p.agent_id = $1::text ORDER BY p.uid LIMIT $2::integer)
        UNION
        (SELECT r.uid FROM $schema.user_agents r WHERE r.agent_id = $1::text ORDER BY r.uid LIMIT $2::integer))`;
      return selectRecords(session, "builders.records.listByAgentId", selectBuilders(where, BY_UID), [agentId, limit]);
    },

    listByGateway(gatewayId, filter = {}) {
      const parameters = new SqlParameters();
      const conditions = [`b.gateway_id = ${parameters.add(gatewayId, "text")}`];
      if (filter.openclawStatus !== undefined) conditions.push(`b.openclaw_status = ${parameters.add(filter.openclawStatus, "text")}`);
      const bound = filter.limit === undefined ? "" : ` LIMIT ${parameters.add(filter.limit, "integer")}`;
      const text = selectBuilders(conditions.join(" AND "), `${BY_UID}${bound}`);
      return selectRecords(session, "builders.records.listByGateway", text, parameters.values);
    },

    async listGatewayFenceHolders(gatewayId): Promise<GatewayFenceHolders> {
      const rows = await session.read(
        "builders.records.listGatewayFenceHolders",
        selectBuilders(
          `b.gateway_id = $1::text OR b.source_transfer_source_gateway_id = $1::text
            OR b.source_transfer_target_gateway_id = $1::text OR b.computer_recovery_gateway_id = $1::text`,
          BY_UID,
        ),
        [gatewayId],
      );
      const holders = rows.map((row) => ({ row, record: decodeBuilderRow(row) }));
      const holding = (columnName: string) => holders.filter(({ row }) => row[columnName] === gatewayId).map(({ record }) => record);
      return {
        assigned: holding("gateway_id"),
        sourceTransferSource: holding("source_transfer_source_gateway_id"),
        sourceTransferTarget: holding("source_transfer_target_gateway_id"),
        computerRecovery: holding("computer_recovery_gateway_id"),
      };
    },

    listAdmitted() {
      return selectRecords(session, "builders.records.listAdmitted", selectBuilders("b.admitted", BY_UID), []);
    },

    listByOpenClawStatus(openclawStatus) {
      const text = selectBuilders("b.openclaw_status = $1::text", BY_UID);
      return selectRecords(session, "builders.records.listByOpenClawStatus", text, [openclawStatus]);
    },

    listAll() {
      return selectRecords(session, "builders.records.listAll", selectBuilders("TRUE", BY_UID), []);
    },

    async list(page): Promise<Page<Stored<BuilderRecord>>> {
      const name = "builders.records.list";
      const parameters = new SqlParameters();
      const conditions = ["b.created_at IS NOT NULL"];
      if (page.after !== undefined) {
        const anchors = await session.read(name, "SELECT created_at FROM $schema.users WHERE uid = $1::text AND created_at IS NOT NULL", [
          page.after,
        ]);
        if (anchors.length === 0) throw new MissingRecordError(builderKey(page.after));
        conditions.push(`(b.created_at, b.uid) < (${parameters.add(anchors[0].created_at, "bigint")}, ${parameters.add(page.after, "text")})`);
      }
      const limit = parameters.add(page.limit + 1, "integer");
      const records = await selectRecords(
        session,
        name,
        selectBuilders(conditions.join(" AND "), `ORDER BY b.created_at DESC, b.uid DESC LIMIT ${limit}`),
        parameters.values,
      );
      const items = records.slice(0, page.limit);
      return { items, next: records.length > page.limit ? items[items.length - 1].uid : null };
    },
  };
}

function admitStatement(uid: string, input: AdmitBuilderInput, now: number | undefined): BuilderStatement {
  const parameters = new SqlParameters();
  const key = builderKey(uid);
  const values = [
    parameters.add(uid, "text"),
    parameters.add(input.slug, "text"),
    encodeValue(COLUMNS.persona, input.persona, parameters, now),
    encodeValue(COLUMNS.provisioningStartedAt, input.provisioningStartedAt, parameters, now),
  ];
  return {
    uid,
    text: `INSERT INTO $schema.users AS b (uid, slug, persona, provisioning_started_at, admitted, provisioning_status)
             VALUES (${values.join(", ")}, true, 'in_progress')
           ON CONFLICT (uid) DO UPDATE SET slug = COALESCE(b.slug, EXCLUDED.slug), persona = EXCLUDED.persona,
             provisioning_started_at = EXCLUDED.provisioning_started_at, admitted = true, provisioning_status = EXCLUDED.provisioning_status
           WHERE b.provisioning_status IS NULL AND (b.slug IS NULL OR b.slug = EXCLUDED.slug)
           RETURNING b.revision`,
    values: parameters.values,
    explain: (current) => {
      if (current.provisioning.status !== undefined) throw fenceMismatch(key, "provisioningStatus", null, current.provisioning.status);
      if (current.slug !== null && current.slug !== input.slug) throw fenceMismatch(key, "slug", input.slug, current.slug);
    },
  };
}

function builderRecordWrites(session: PostgresSession): Omit<BuilderRecordsRepository, BuilderRecordReadMethod> {
  const update = async (operation: string, uid: string, jsonValues: readonly unknown[], build: (update: BuilderUpdate) => BuilderUpdate) => {
    const now = await resolveNow(session, jsonValues);
    await runBuilderStatement(session, operation, build(new BuilderUpdate(uid, now)).statement());
  };
  return {
    async create(record) {
      const parameters = new SqlParameters();
      const createdAt = encodeValue(COLUMNS.createdAt, record.createdAt, parameters, undefined);
      const text = `INSERT INTO $schema.users (uid, created_at) VALUES (${parameters.add(record.uid, "text")}, ${createdAt})
        ON CONFLICT (uid) DO UPDATE SET created_at = EXCLUDED.created_at`;
      await writeBuilder(session, "builders.records.create", record.uid, text, parameters.values);
    },

    async patch(uid, patch, fence) {
      const operation = "builders.records.patch";
      const { mattermostUserId, ...fields } = patch;
      const assignments = patchAssignments(fields);
      const applyFields = async (target: PostgresSession) => {
        const now = await resolveNow(target, jsonValuesOf(assignments));
        const builder = new BuilderUpdate(uid, now);
        const fenced = builder.set(assignments).where(builderFenceConditions(fence, builder.parameters), explainBuilderFence(uid, fence));
        await runBuilderStatement(target, operation, fenced.statement());
      };
      if (mattermostUserId === undefined) {
        await applyFields(session);
        return;
      }
      await session.atomically(operation, async (transaction) => {
        await applyFields(transaction);
        if (mattermostUserId === null || isClearField(mattermostUserId)) {
          await clearManagedChannelIdentity(transaction, operation, builderKey(uid), "user", uid);
          return;
        }
        await linkChannelIdentity(
          transaction,
          operation,
          builderKey(uid),
          { ...MANAGED_CHANNEL_INSTALLATION, externalUserId: mattermostUserId, ownerKind: "user", ownerId: uid },
          { aggregate: "builder", lookup: "mattermostUserId" },
        );
      });
    },

    async admit(uid, input) {
      const now = await resolveNow(session, [input.persona]);
      await runBuilderStatement(session, "builders.records.admit", admitStatement(uid, input, now));
    },

    async setGatewayMirror(uid, mirror, fence) {
      const assignments: Assignment[] = isClearField(mirror)
        ? Object.values(MIRROR_COLUMNS).map((spec) => [spec, mirror])
        : groupAssignments(mirror, MIRROR_COLUMNS, "gateway");
      await update("builders.records.setGatewayMirror", uid, [], (builder) =>
        builder.set(assignments).where(builderFenceConditions(fence, builder.parameters), explainBuilderFence(uid, fence)),
      );
    },

    async addAgents(uid, agentIds) {
      if (agentIds.length === 0) return;
      await runBuilderStatement(session, "builders.records.addAgents", rosterStatement(uid, agentIds, "add"));
    },

    async removeAgents(uid, agentIds) {
      if (agentIds.length === 0) return;
      await runBuilderStatement(session, "builders.records.removeAgents", rosterStatement(uid, agentIds, "remove"));
    },

    async setActivatedAgents(uid, activatedAgents) {
      await update("builders.records.setActivatedAgents", uid, [], (builder) =>
        builder.setSql(`activated_agents = ${builder.parameters.add([...activatedAgents], "text[]")}`),
      );
    },

    async setActivationLease(uid, lease, fence) {
      await update("builders.records.setActivationLease", uid, [lease], (builder) =>
        builder
          .set([[COLUMNS.activationLease, lease]])
          .where(activationLeaseConditions(fence, builder.parameters), (current) =>
            assertActivationLeaseFence(builderKey(uid), fence, current.activationLease),
          ),
      );
    },

    async patchActivationLease(uid, patch, fence) {
      if (Object.hasOwn(patch, "leaseId") || Object.hasOwn(patch, "generation")) {
        throw new TypeError("an activation lease patch cannot change its leaseId or generation");
      }
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const removed = entries.filter(([, value]) => isClearField(value)).map(([key]) => key);
      const kept = Object.fromEntries(entries.filter(([, value]) => !isClearField(value)));
      const key = builderKey(uid);
      await update("builders.records.patchActivationLease", uid, [kept], (builder) => {
        const removals = builder.parameters.add(removed, "text[]");
        const additions = jsonParameter(kept, builder.parameters, builder.now, "activationLease");
        return builder
          .setSql(`activation_lease = (activation_lease - ${removals}) || ${additions}`)
          .where(["activation_lease IS NOT NULL", ...activationLeaseConditions(fence, builder.parameters)], (current) => {
            assertActivationLeaseFence(key, fence, current.activationLease);
            if (current.activationLease === null) throw fenceMismatch(key, "activationLease", "present", null);
          });
      });
    },

    async setFence(uid, fenceName, value, expected) {
      if (!Object.hasOwn(FENCE_COLUMNS, fenceName)) throw new TypeError(`builder fence ${fenceName} has no stored field`);
      const spec = FENCE_COLUMNS[fenceName];
      const key = builderKey(uid);
      await update("builders.records.setFence", uid, [value], (builder) => {
        if (expected === undefined) return builder.set([[spec, value]]);
        const condition =
          expected === "absent" ? `${spec.column} IS NULL` : `${spec.column} = ${jsonParameter(expected, builder.parameters, undefined, fenceName)}`;
        return builder.set([[spec, value]]).where([condition], (current) => {
          const actual = current.fences[fenceName];
          const wanted = expected === "absent" ? undefined : expected;
          if (!isDeepStrictEqual(actual, wanted)) throw fenceMismatch(key, fenceName, wanted ?? null, actual ?? null);
        });
      });
    },

    async delete(uid) {
      await writeBuilder(session, "builders.records.delete", uid, "DELETE FROM $schema.users WHERE uid = $1::text", [uid]);
    },
  };
}

export function createPostgresBuilderRecordsRepository(session: PostgresSession): BuilderRecordsRepository {
  return { ...builderRecordReads(session), ...builderRecordWrites(session) };
}

function mayInclude(values: readonly unknown[] | undefined, wanted: string | undefined): boolean {
  return wanted === undefined || values === undefined || values.includes(wanted);
}

export function postgresBuildersWatchSource(filter: WatchFilters["builders"]): PostgresWatchSource<"builders"> {
  const conditions = (parameters: SqlParameters): string[] => {
    const where: string[] = [];
    if (filter.uid !== undefined) where.push(`b.uid = ${parameters.add(filter.uid, "text")}`);
    if (filter.gatewayId !== undefined) where.push(`b.gateway_id = ${parameters.add(filter.gatewayId, "text")}`);
    return where;
  };
  return {
    aggregate: "builders",
    operation: "watch builders",
    selectAll: (parameters) => selectBuilders(["true", ...conditions(parameters)].join(" AND "), BY_UID),
    selectKeys: (keys, parameters) =>
      selectBuilders([...conditions(parameters), `b.uid = ANY(${parameters.add([...keys], "text[]")})`].join(" AND ")),
    keyOf: (row) => row.uid as string,
    decode: decodeBuilderRow,
    mayMatch: (filterKeys: FilterKeys) => mayInclude(filterKeys.uid, filter.uid) && mayInclude(filterKeys.gateway_id, filter.gatewayId),
  };
}
