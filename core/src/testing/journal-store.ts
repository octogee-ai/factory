import { isDeepStrictEqual } from "node:util";
import {
  isGatewayDesiredDoc,
  isGatewayRuntimeDoc,
  isReleasePayload,
  upgradeReleasePayloadSchema,
} from "@octogee/shared/types/gateway-releases";
import { isOperationAuditRecord, isOperationAuditRow, type GlmOperationRecord } from "@octogee/shared/types/glm";
import { CUSTOMER_DELETION_JOBS_COLLECTION } from "@octogee/shared/types/account-lifecycle";
import { placementReceiptDocId, type PlacementReceipt } from "@octogee/shared/types/placement-receipts";
import type {
  ActivationLeaseFence,
  BuilderFence,
  BuilderRecord,
  BuilderRepositories,
  GatewayFenceHolders,
} from "../platform-state/builders.js";
import type { ConfigRepositories, OrchestratorConfig } from "../platform-state/config.js";
import {
  AlreadyExistsError,
  DuplicateRecordError,
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
  type FenceName,
  type RecordKey,
} from "../platform-state/errors.js";
import type { FleetRegistryRecord, FleetRegistryRepository } from "../platform-state/fleet-registry.js";
import {
  agentStoreFromData,
  BUILDER_ACTIVATION_LEASE_PATH,
  BUILDER_FENCE_PATHS,
  BUILDER_MIRROR_PATHS,
  builderPatchPaths,
  builderRecordFromData,
} from "../platform-state/firestore/builders.js";
import { parseOrchestratorConfig } from "../platform-state/firestore/config.js";
import { assertFenceEquals, assertFenceOneOf } from "../platform-state/firestore/fences.js";
import { decodeGatewayAssignmentData } from "../platform-state/firestore/gateways.js";
import { anonymousArchiveFromData, storedDeletionStatus } from "../platform-state/firestore/jobs.js";
import { builderSecretFromData, secretKindOf } from "../platform-state/firestore/secrets.js";
import { workspaceChannelFromData, workspaceProjectFromData } from "../platform-state/firestore/workspaces.js";
import type { CustomerDeletionJob, CustomerDeletionJobStatus, JobRepositories } from "../platform-state/jobs.js";
import type {
  GatewayAssignment,
  GatewayAssignmentFence,
  GatewayRelease,
  GatewayRepositories,
  GatewayRoot,
  GatewayRootFence,
} from "../platform-state/gateways.js";
import type { MigrationTasksRepository, MigrationTransferTask } from "../platform-state/migration-tasks.js";
import type {
  JournalRepositories,
  OperationAuditFence,
  OperationAuditRow,
  OperationRecord,
} from "../platform-state/operations.js";
import type { SecretsRepository } from "../platform-state/secrets.js";
import type { Page, PageRequest, PlatformStateStore, PlatformStateTransaction, Revision, Stored } from "../platform-state/store.js";
import type { WorkspaceRepositories } from "../platform-state/workspaces.js";

export interface JournalRows {
  get(id: string): Record<string, unknown> | undefined;
  set(id: string, row: Record<string, unknown>): void;
}

export function journalRowsIn(records: Record<string, Record<string, unknown>>): JournalRows {
  return {
    get: (id) => records[id],
    set: (id, row) => {
      records[id] = row;
    },
  };
}

export function journalRowsAtPaths(
  records: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown> | undefined>,
): JournalRows {
  const path = (id: string) => `glmOperations/${id}`;
  if (records instanceof Map) {
    return {
      get: (id) => records.get(path(id)),
      set: (id, row) => {
        records.set(path(id), row);
      },
    };
  }
  return {
    get: (id) => records[path(id)],
    set: (id, row) => {
      records[path(id)] = row;
    },
  };
}

export interface FixtureDocuments {
  get(path: string): Record<string, unknown> | undefined;
  set(path: string, row: Record<string, unknown>): void;
  delete(path: string): void;
  children(collectionPath: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
  group(collectionId: string): ReadonlyArray<readonly [string, Record<string, unknown>]>;
}

export type FixtureDocumentRecords =
  | Map<string, Record<string, unknown>>
  | Record<string, Record<string, unknown> | undefined>;

function fixtureEntries(records: FixtureDocumentRecords): Array<readonly [string, Record<string, unknown>]> {
  const entries = records instanceof Map ? [...records.entries()] : Object.entries(records);
  return entries.flatMap(([path, row]) => (row === undefined ? [] : [[path, row] as const]));
}

export function fixtureDocumentsAt(records: FixtureDocumentRecords): FixtureDocuments {
  return {
    get: (path) => (records instanceof Map ? records.get(path) : records[path]),
    set: (path, row) => {
      if (records instanceof Map) records.set(path, row);
      else records[path] = row;
    },
    delete: (path) => {
      if (records instanceof Map) records.delete(path);
      else delete records[path];
    },
    children: (collectionPath) =>
      fixtureEntries(records).flatMap(([path, row]) => {
        if (!path.startsWith(`${collectionPath}/`)) return [];
        const id = path.slice(collectionPath.length + 1);
        return id.includes("/") ? [] : [[id, row] as const];
      }),
    group: (collectionId) =>
      fixtureEntries(records).filter(([path]) => {
        const segments = path.split("/");
        return segments.length % 2 === 0 && segments[segments.length - 2] === collectionId;
      }),
  };
}

const FIXTURE_REVISION = "fixture" as Revision;

function auditKey(id: string): RecordKey {
  return { aggregate: "operation-audit", key: id };
}

function stored<T>(id: string, row: Record<string, unknown>): Stored<T> {
  return { ...structuredClone(row), id, revision: FIXTURE_REVISION } as unknown as Stored<T>;
}

function decode(id: string, row: Record<string, unknown> | undefined): Stored<GlmOperationRecord> | null {
  if (row === undefined) return null;
  if (isOperationAuditRow(row) && !isOperationAuditRecord(row)) {
    throw new MalformedRecordError(auditKey(id), "fails the operation audit schema");
  }
  return stored<GlmOperationRecord>(id, row);
}

function isClear(value: unknown): boolean {
  return value !== null && typeof value === "object" && "clear" in value && (value as { clear: unknown }).clear === true;
}

function applyPatch(row: Record<string, unknown>, patch: object): Record<string, unknown> {
  const next = { ...row };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isClear(value)) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

function assertAuditFence(id: string, fence: OperationAuditFence, current: Record<string, unknown>): void {
  const key = auditKey(id);
  if (fence.status !== undefined && !fence.status.includes(current.status as never)) {
    throw new FenceMismatchError(key, "status", fence.status, current.status);
  }
  for (const [name, expected, actual] of [
    ["actionClaimId", fence.actionClaimId, current.actionClaimId],
    ["actionStartedAt", fence.actionStartedAt, current.actionStartedAt],
  ] as const) {
    if (expected !== undefined && !isDeepStrictEqual(expected, actual ?? null)) {
      throw new FenceMismatchError(key, name, expected, actual ?? null);
    }
  }
}

function unimplemented(path: string): never {
  throw new Error(`the journal fixture store does not implement ${path}`);
}

function partialRepository<T extends object>(path: string, implemented: Partial<T>): T {
  return new Proxy(implemented as T, {
    get: (target, method) =>
      method in target ? Reflect.get(target, method) : () => unimplemented(`${path}.${String(method)}`),
  });
}

type Write = (apply: () => void) => void;

function withoutIdentity(record: object): Record<string, unknown> {
  const { id: _id, revision: _revision, ...row } = record as Record<string, unknown>;
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

const OPERATIONS = "glmOperations";

function operationRepository(documents: FixtureDocuments, write: Write): JournalRepositories["operations"] {
  const key = (id: string): RecordKey => ({ aggregate: "operation", key: id });
  const decodeOperation = (id: string, row: Record<string, unknown> | undefined) =>
    row === undefined || isOperationAuditRow(row) ? null : stored<OperationRecord>(id, row);
  let minted = 0;
  const create = (operation: OperationRecord) => {
    const path = `${OPERATIONS}/${operation.id}`;
    if (documents.get(path) !== undefined) throw new AlreadyExistsError(key(operation.id));
    write(() => {
      if (documents.get(path) !== undefined) throw new AlreadyExistsError(key(operation.id));
      documents.set(path, withoutIdentity(operation));
    });
  };
  const listWhere = (matches: (operation: Stored<OperationRecord>) => boolean) =>
    documents.children(OPERATIONS).flatMap(([id, row]) => {
      const operation = decodeOperation(id, row);
      return operation !== null && matches(operation) ? [operation] : [];
    });
  return partialRepository<JournalRepositories["operations"]>("journal.operations", {
    get: async (id) => decodeOperation(id, documents.get(`${OPERATIONS}/${id}`)),
    getMany: async (ids) => new Map(ids.flatMap((id) => {
      const operation = decodeOperation(id, documents.get(`${OPERATIONS}/${id}`));
      return operation === null ? [] : [[id, operation] as const];
    })),
    listByStatus: async (statuses) => listWhere((operation) => statuses.includes(operation.status)),
    listByGateway: async (gatewayId, limit) =>
      listWhere((operation) => operation.gatewayId === gatewayId).slice(0, limit),
    listForUid: async (uid, filter) => listWhere((operation) =>
      operation.inputUid === uid &&
      (filter.statuses === undefined || filter.statuses.includes(operation.status)) &&
      (filter.kind === undefined || operation.kind === filter.kind)),
    enqueue: async (operation) => {
      minted += 1;
      const id = `fixture-operation-${minted}`;
      create({ ...operation, id });
      return id;
    },
    create: async (operation) => create(operation),
    put: async (operation) => {
      write(() => documents.set(`${OPERATIONS}/${operation.id}`, withoutIdentity(operation)));
    },
    patch: async (id, patch, fence) => {
      const current = decodeOperation(id, documents.get(`${OPERATIONS}/${id}`));
      if (current === null) throw new MissingRecordError(key(id));
      if (fence !== undefined) {
        assertFenceOneOf(key(id), "status", fence.status, current.status);
        assertFenceEquals(key(id), "startedAt", fence.startedAt, current.startedAt);
      }
      write(() => {
        const latest = documents.get(`${OPERATIONS}/${id}`);
        if (latest === undefined) throw new MissingRecordError(key(id));
        documents.set(`${OPERATIONS}/${id}`, applyPatch(latest, structuredClone(patch)));
      });
    },
  });
}

function journalRepositories(rows: JournalRows, write: Write, documents?: FixtureDocuments): JournalRepositories {
  const getAudit = async (id: string): Promise<Stored<OperationAuditRow> | null> => {
    const record = decode(id, rows.get(id));
    return record !== null && isOperationAuditRow(record) ? (record as Stored<OperationAuditRow>) : null;
  };
  return {
    getRecord: async (id) => decode(id, rows.get(id)),
    listRecent: async (page) => {
      if (documents === undefined) return unimplemented("journal.listRecent");
      const records = documents.children(OPERATIONS)
        .map(([id, row]) => decode(id, row)!)
        .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
      const start = page.after === undefined ? 0 : records.findIndex((record) => record.id === page.after) + 1;
      const items = records.slice(start, start + page.limit);
      return { items, next: start + page.limit < records.length ? items[items.length - 1].id : null };
    },
    operations: documents === undefined
      ? partialRepository<JournalRepositories["operations"]>("journal.operations", {})
      : operationRepository(documents, write),
    recoveryReceipts: partialRepository<JournalRepositories["recoveryReceipts"]>("journal.recoveryReceipts", {}),
    audits: {
      get: getAudit,
      getByIdempotencyKey: () => unimplemented("journal.audits.getByIdempotencyKey"),
      async create(audit) {
        if (rows.get(audit.id) !== undefined) throw new AlreadyExistsError(auditKey(audit.id));
        const { id, ...row } = audit;
        write(() => {
          if (rows.get(id) !== undefined) throw new AlreadyExistsError(auditKey(id));
          rows.set(id, structuredClone(row));
        });
      },
      async patch(auditId, patch, fence) {
        const current = rows.get(auditId);
        if (current === undefined || !isOperationAuditRow(current)) throw new MissingRecordError(auditKey(auditId));
        if (fence !== undefined) assertAuditFence(auditId, fence, current);
        write(() => {
          const latest = rows.get(auditId);
          if (latest === undefined) throw new MissingRecordError(auditKey(auditId));
          rows.set(auditId, applyPatch(latest, patch));
        });
      },
      delete: () => unimplemented("journal.audits.delete"),
    },
  };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRootFence(id: string, fence: GatewayRootFence, current: Record<string, unknown>): void {
  const record: RecordKey = { aggregate: "gateway", key: id };
  const checks: Array<[FenceName, unknown, unknown]> = [
    ["updatedAt", fence.updatedAt, current.updatedAt],
    ["latestRelease", fence.latestRelease, current.latestRelease],
    ["retirementVersion", fence.retirementVersion, current.retirementVersion],
  ];
  for (const [name, expected, actual] of checks) {
    if (expected !== undefined && !isDeepStrictEqual(expected, actual ?? null)) {
      throw new FenceMismatchError(record, name, expected, actual ?? null);
    }
  }
  if (fence.desiredStatus !== undefined && !fence.desiredStatus.includes(current.desiredStatus as never)) {
    throw new FenceMismatchError(record, "status", fence.desiredStatus, current.desiredStatus);
  }
}

function gatewayRepositories(documents: FixtureDocuments, write: Write): GatewayRepositories {
  const rootPath = (id: string) => `gateways/${id}`;
  const releasePath = (id: string, release: number) => `gateways/${id}/releases/${release}`;
  const rootKey = (id: string): RecordKey => ({ aggregate: "gateway", key: id });
  const releaseKey = (id: string, release: number): RecordKey => ({ aggregate: "gateway-release", key: `${id}/${release}` });
  const decodeRoot = (id: string): Stored<GatewayRoot> | null => {
    const row = documents.get(rootPath(id));
    if (row === undefined) return null;
    if (!isGatewayDesiredDoc(row) || row.gatewayId !== id) throw new MalformedRecordError(rootKey(id), "is not a durable gateway root");
    return { ...structuredClone(row), revision: FIXTURE_REVISION } as unknown as Stored<GatewayRoot>;
  };
  const decodeRelease = (id: string, release: number): GatewayRelease | null => {
    const row = documents.get(releasePath(id, release));
    if (row === undefined) return null;
    if (row.gatewayId !== id || row.release !== release) {
      throw new MalformedRecordError(releaseKey(id, release), "stores another release");
    }
    if (isReleasePayload(row.payload)) return structuredClone(row) as unknown as GatewayRelease;
    const upgrade = upgradeReleasePayloadSchema(row.payload, row.payloadHash);
    if (upgrade.status === "unsupported") throw new MalformedRecordError(releaseKey(id, release), upgrade.reason);
    return { ...structuredClone(row), payload: upgrade.payload, payloadHash: upgrade.payloadHash } as unknown as GatewayRelease;
  };
  const presentRoot = (id: string): Record<string, unknown> => {
    const row = documents.get(rootPath(id));
    if (row === undefined) throw new MissingRecordError(rootKey(id));
    return row;
  };
  const updateRoot = (id: string, patch: object) =>
    write(() => documents.set(rootPath(id), applyPatch(presentRoot(id), patch)));
  return {
    roots: partialRepository<GatewayRepositories["roots"]>("gateways.roots", {
      get: async (id) => decodeRoot(id),
      list: async (filter = {}) =>
        documents.children("gateways").flatMap(([id]) => {
          const root = decodeRoot(id);
          if (root === null) return [];
          if (filter.gatewayClass !== undefined && root.gatewayClass !== filter.gatewayClass) return [];
          return filter.ownerUid === undefined || root.ownerUid === filter.ownerUid ? [root] : [];
        }),
      create: async (root) => {
        if (documents.get(rootPath(root.gatewayId)) !== undefined) throw new AlreadyExistsError(rootKey(root.gatewayId));
        write(() => documents.set(rootPath(root.gatewayId), withoutIdentity(root)));
      },
      patch: async (id, patch, fence) => {
        const current = presentRoot(id);
        if (fence !== undefined) assertRootFence(id, fence, current);
        updateRoot(id, patch);
      },
      compareAndSetRuntimeRestartFence: async (id, expected, next) => {
        const actual = presentRoot(id).runtimeRestartFence ?? null;
        if (!isDeepStrictEqual(expected, actual)) {
          throw new FenceMismatchError(rootKey(id), "runtimeRestartFence", expected, actual);
        }
        updateRoot(id, { runtimeRestartFence: next ?? { clear: true } });
      },
    }),
    releases: partialRepository<GatewayRepositories["releases"]>("gateways.releases", {
      get: async (id, release) => decodeRelease(id, release),
      list: async (id, order, limit) => {
        const releases = documents.children(`gateways/${id}/releases`)
          .map(([release]) => decodeRelease(id, Number(release))!)
          .sort((left, right) => (order === "asc" ? left.release - right.release : right.release - left.release));
        return releases.slice(0, limit);
      },
      append: async (input) => {
        const latest = presentRoot(input.gatewayId).latestRelease;
        if (latest !== input.expectedLatestRelease) {
          throw new FenceMismatchError(rootKey(input.gatewayId), "latestRelease", input.expectedLatestRelease, latest);
        }
        const release = input.expectedLatestRelease + 1;
        if (documents.get(releasePath(input.gatewayId, release)) !== undefined) {
          throw new AlreadyExistsError(releaseKey(input.gatewayId, release));
        }
        const document: GatewayRelease = {
          gatewayId: input.gatewayId,
          release,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          sourceRelease: input.sourceRelease,
          note: input.note,
          payloadHash: input.payloadHash,
          payload: input.payload,
        };
        write(() => documents.set(releasePath(input.gatewayId, release), withoutIdentity(document)));
        updateRoot(input.gatewayId, {
          latestRelease: release,
          ...(input.activate ? { desiredRelease: release } : {}),
          updatedAt: input.createdAt,
          updatedBy: input.updatedBy,
        });
        return release;
      },
      createInitial: async (release) => {
        if (documents.get(releasePath(release.gatewayId, release.release)) !== undefined) {
          throw new AlreadyExistsError(releaseKey(release.gatewayId, release.release));
        }
        write(() => documents.set(releasePath(release.gatewayId, release.release), withoutIdentity(release)));
      },
    }),
    assignments: assignmentRepository(documents, write),
    vmRuntime: partialRepository<GatewayRepositories["vmRuntime"]>("gateways.vmRuntime", {}),
  };
}

function assignmentRepository(documents: FixtureDocuments, write: Write): GatewayRepositories["assignments"] {
  const path = (gatewayId: string, uid: string) => `gateways/${gatewayId}/assignments/${uid}`;
  const key = (gatewayId: string, uid: string): RecordKey => ({ aggregate: "gateway-assignment", key: `${gatewayId}/${uid}` });
  const decodeAssignment = (gatewayId: string, uid: string): Stored<GatewayAssignment> | null => {
    const row = documents.get(path(gatewayId, uid));
    if (row === undefined) return null;
    return { ...decodeGatewayAssignmentData(gatewayId, uid, structuredClone(row)), revision: FIXTURE_REVISION };
  };
  const assertFence = (gatewayId: string, uid: string, fence: GatewayAssignmentFence | undefined): void => {
    const current = decodeAssignment(gatewayId, uid);
    if (current === null) throw new MissingRecordError(key(gatewayId, uid));
    if (fence === undefined) return;
    assertFenceEquals(key(gatewayId, uid), "epoch", fence.epoch, current.epoch);
    assertFenceEquals(key(gatewayId, uid), "updatedAt", fence.updatedAt, current.updatedAt);
    assertFenceOneOf(key(gatewayId, uid), "status", fence.state, current.state);
  };
  return partialRepository<GatewayRepositories["assignments"]>("gateways.assignments", {
    get: async (gatewayId, uid) => decodeAssignment(gatewayId, uid),
    list: async (gatewayId, limit) =>
      documents.children(`gateways/${gatewayId}/assignments`)
        .map(([uid]) => decodeAssignment(gatewayId, uid)!)
        .slice(0, limit),
    isEmpty: async (gatewayId) => documents.children(`gateways/${gatewayId}/assignments`).length === 0,
    listAll: async () =>
      documents.group("assignments").flatMap(([assignmentPath]) => {
        const [collection, gatewayId, , uid] = assignmentPath.split("/");
        return collection === "gateways" ? [decodeAssignment(gatewayId, uid)!] : [];
      }),
    put: async (assignment) => {
      write(() => documents.set(path(assignment.gatewayId, assignment.uid), withoutIdentity(assignment)));
    },
    patch: async (gatewayId, uid, patch, fence) => {
      assertFence(gatewayId, uid, fence);
      write(() => {
        const latest = documents.get(path(gatewayId, uid));
        if (latest === undefined) throw new MissingRecordError(key(gatewayId, uid));
        documents.set(path(gatewayId, uid), applyPatch(latest, structuredClone(patch)));
      });
    },
    delete: async (gatewayId, uid, fence) => {
      if (fence !== undefined) assertFence(gatewayId, uid, fence);
      write(() => documents.delete(path(gatewayId, uid)));
    },
  });
}

function withDottedFields(row: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(row);
  for (const [path, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const segments = path.split(".");
    let cursor = next;
    for (const segment of segments.slice(0, -1)) {
      if (!isMap(cursor[segment])) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    const field = segments[segments.length - 1];
    if (isClear(value)) delete cursor[field];
    else cursor[field] = isServerNow(value) ? Date.now() : structuredClone(value);
  }
  return next;
}

function isServerNow(value: unknown): boolean {
  return isMap(value) && Object.keys(value).length === 1 && value.serverNow === true;
}

function fixturePage<T>(items: readonly T[], idOf: (item: T) => string, page: PageRequest, missing: (id: string) => Error): Page<T> {
  const start = page.after === undefined ? 0 : items.findIndex((item) => idOf(item) === page.after) + 1;
  if (page.after !== undefined && start === 0) throw missing(page.after);
  const pageItems = items.slice(start, start + page.limit);
  return { items: pageItems, next: start + page.limit < items.length ? idOf(pageItems[pageItems.length - 1]) : null };
}

function builderRecordRepository(documents: FixtureDocuments, write: Write): Partial<BuilderRepositories["records"]> {
  const path = (uid: string) => `users/${uid}`;
  const key = (uid: string): RecordKey => ({ aggregate: "builder", key: uid });
  const decodeRecord = (uid: string): Stored<BuilderRecord> | null => {
    const row = documents.get(path(uid));
    if (row === undefined) return null;
    return { ...builderRecordFromData(uid, structuredClone(row), 0, null), revision: FIXTURE_REVISION };
  };
  const present = (uid: string): Stored<BuilderRecord> => {
    const record = decodeRecord(uid);
    if (record === null) throw new MissingRecordError(key(uid));
    return record;
  };
  const mismatch = (uid: string, field: string, expected: unknown, actual: unknown) => new FenceMismatchError(
    key(uid),
    expected === null || expected === undefined ? "absent" : "present",
    { [field]: expected },
    { [field]: actual },
  );
  const update = (uid: string, fields: Record<string, unknown>) => write(() => {
    const latest = documents.get(path(uid));
    if (latest === undefined) throw new MissingRecordError(key(uid));
    documents.set(path(uid), withDottedFields(latest, fields));
  });
  const assertBuilderFence = (uid: string, current: Stored<BuilderRecord>, fence: BuilderFence | undefined) => {
    if (fence?.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
      throw mismatch(uid, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
    }
    const status = current.provisioning.status ?? "absent";
    if (fence?.provisioningStatus !== undefined && fence.provisioningStatus !== status) {
      throw mismatch(uid, "provisioningStatus", fence.provisioningStatus, status);
    }
  };
  const assertLeaseFence = (uid: string, current: Stored<BuilderRecord>, fence: ActivationLeaseFence) => {
    const lease = current.activationLease;
    assertFenceEquals(key(uid), "leaseId", fence.leaseId, lease?.leaseId ?? null);
    assertFenceEquals(key(uid), "generation", fence.generation, lease?.generation ?? null);
    assertFenceOneOf(key(uid), "status", fence.status, lease?.status);
  };
  const all = () => documents.children("users").map(([uid]) => present(uid));
  return {
    get: async (uid) => decodeRecord(uid),
    getMany: async (uids) => new Map(uids.flatMap((uid) => {
      const record = decodeRecord(uid);
      return record === null ? [] : [[uid, record] as const];
    })),
    listAll: async () => all(),
    list: async (page) => fixturePage(
      all().filter((record) => record.createdAt !== null)
        .sort((a, b) => b.createdAt! - a.createdAt! || b.uid.localeCompare(a.uid)),
      (record) => record.uid,
      page,
      (uid) => new MissingRecordError(key(uid)),
    ),
    findBySlug: async (slug) => {
      const found = all().filter((record) => record.slug === slug);
      if (found.length > 1) throw new DuplicateRecordError("builder", "slug", slug, found.map((record) => record.uid));
      return found[0] ?? null;
    },
    patch: async (uid, patch, fence) => {
      assertBuilderFence(uid, present(uid), fence);
      update(uid, builderPatchPaths(patch));
    },
    setActivationLease: async (uid, lease, fence) => {
      assertLeaseFence(uid, present(uid), fence);
      update(uid, { [BUILDER_ACTIVATION_LEASE_PATH]: lease });
    },
    setFence: async (uid, name, value, expected) => {
      const current = present(uid);
      if (expected !== undefined) {
        const actual = current.fences[name];
        const wanted = expected === "absent" ? undefined : expected;
        if (!isDeepStrictEqual(actual, wanted)) throw mismatch(uid, name, wanted ?? null, actual ?? null);
      }
      update(uid, { [BUILDER_FENCE_PATHS[name]]: value });
    },
    setGatewayMirror: async (uid, mirror, fence) => {
      const current = present(uid);
      if (fence?.gatewayId !== undefined && fence.gatewayId !== (current.gateway?.gatewayId ?? null)) {
        throw mismatch(uid, "gatewayId", fence.gatewayId, current.gateway?.gatewayId ?? null);
      }
      const paths: Readonly<Record<string, string>> = BUILDER_MIRROR_PATHS;
      update(uid, isClear(mirror)
        ? Object.fromEntries(Object.values(paths).map((field) => [field, mirror]))
        : Object.fromEntries(Object.entries(mirror).map(([field, value]) => [paths[field], value])));
    },
    patchActivationLease: async (uid, patch, fence) => {
      const lease = present(uid).activationLease;
      assertFenceEquals(key(uid), "leaseId", fence.leaseId, lease?.leaseId ?? null);
      assertFenceEquals(key(uid), "generation", fence.generation, lease?.generation ?? null);
      assertFenceOneOf(key(uid), "status", fence.status, lease?.status);
      if (lease === null) throw mismatch(uid, "activationLease", "present", null);
      update(uid, Object.fromEntries(Object.entries(patch).map(([field, value]) => [`${BUILDER_ACTIVATION_LEASE_PATH}.${field}`, value])));
    },
  };
}

function fixtureBuilder(uid: string, row: Record<string, unknown>): Stored<BuilderRecord> {
  const record: RecordKey = { aggregate: "builder", key: uid };
  const provisioning = isMap(row.provisioning) ? row.provisioning : {};
  const openclaw = isMap(provisioning.openclaw) ? provisioning.openclaw : {};
  const fence = (name: string, value: unknown) => {
    if (value !== undefined && !isMap(value)) throw new MalformedRecordError(record, `${name} is not a map`);
    return value;
  };
  return {
    uid,
    gateway: typeof openclaw.gatewayId === "string" ? { gatewayId: openclaw.gatewayId } : null,
    fences: {
      restoreFence: fence("restoreFence", openclaw.restoreFence),
      sourceTransferFence: fence("sourceTransferFence", openclaw.sourceTransferFence),
      computerRecovery: fence("computerRecovery", provisioning.computerRecovery),
    },
    revision: FIXTURE_REVISION,
  } as unknown as Stored<BuilderRecord>;
}

function valueAt(row: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, segment) => (isMap(value) ? value[segment] : undefined), row);
}

function builderRepositories(documents: FixtureDocuments, write: Write): BuilderRepositories {
  const holding = (path: readonly string[], gatewayId: string) =>
    documents.children("users").flatMap(([uid, row]) => (valueAt(row, path) === gatewayId ? [fixtureBuilder(uid, row)] : []));
  const records = partialRepository<BuilderRepositories["records"]>("builders.records", {
    ...builderRecordRepository(documents, write),
    listGatewayFenceHolders: async (gatewayId): Promise<GatewayFenceHolders> => ({
      assigned: holding(["provisioning", "openclaw", "gatewayId"], gatewayId),
      sourceTransferSource: holding(["provisioning", "openclaw", "sourceTransferFence", "sourceGatewayId"], gatewayId),
      sourceTransferTarget: holding(["provisioning", "openclaw", "sourceTransferFence", "targetGatewayId"], gatewayId),
      computerRecovery: holding(["provisioning", "computerRecovery", "gatewayId"], gatewayId),
    }),
  });
  const placementReceipts = partialRepository<BuilderRepositories["placementReceipts"]>("builders.placementReceipts", {
    list: async (uid, page) => fixturePage(
      documents.children(`users/${uid}/placement_receipts`)
        .map(([, row]) => structuredClone(row) as unknown as PlacementReceipt)
        .sort((a, b) => b.at - a.at),
      (receipt) => placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind),
      page,
      (receiptId) => new MissingRecordError({ aggregate: "placement-receipt", key: `${uid}/${receiptId}` }),
    ),
  });
  const agentStores = partialRepository<BuilderRepositories["agentStores"]>("builders.agentStores", {
    list: async (uid) => documents.children(`users/${uid}/agentStores`).map(([storeKey, row]) => ({
      ...agentStoreFromData(uid, storeKey, structuredClone(row)),
      revision: FIXTURE_REVISION,
    })),
  });
  return partialRepository<BuilderRepositories>("builders", { records, placementReceipts, agentStores });
}

function workspaceRepositories(documents: FixtureDocuments): WorkspaceRepositories {
  const channelsPath = (workspaceSlug: string, projectSlug: string | null) =>
    projectSlug === null ? `workspaces/${workspaceSlug}/channels` : `workspaces/${workspaceSlug}/projects/${projectSlug}/channels`;
  return partialRepository<WorkspaceRepositories>("workspaces", {
    projects: partialRepository<WorkspaceRepositories["projects"]>("workspaces.projects", {
      list: async (workspaceSlug) => documents.children(`workspaces/${workspaceSlug}/projects`).map(([projectSlug, row]) => ({
        ...workspaceProjectFromData(workspaceSlug, projectSlug, structuredClone(row)),
        revision: FIXTURE_REVISION,
      })),
    }),
    channels: partialRepository<WorkspaceRepositories["channels"]>("workspaces.channels", {
      get: async (scope, channelId) => {
        const row = documents.get(`${channelsPath(scope.workspaceSlug, scope.projectSlug)}/${channelId}`);
        return row === undefined ? null : { ...workspaceChannelFromData(scope, channelId, structuredClone(row)), revision: FIXTURE_REVISION };
      },
    }),
  });
}

function secretsRepository(documents: FixtureDocuments): SecretsRepository {
  return partialRepository<SecretsRepository>("secrets", {
    get: async (uid, secretId) => {
      const row = documents.get(`users/${uid}/secrets/${secretId}`);
      return row === undefined ? null : { ...builderSecretFromData(uid, secretId, structuredClone(row)), revision: FIXTURE_REVISION };
    },
    list: async (uid, kind) => documents.children(`users/${uid}/secrets`)
      .filter(([secretId]) => kind === undefined || secretKindOf(secretId) === kind)
      .map(([secretId, row]) => ({ ...builderSecretFromData(uid, secretId, structuredClone(row)), revision: FIXTURE_REVISION })),
  });
}

function fleetRegistryRepository(documents: FixtureDocuments, write: Write): FleetRegistryRepository {
  const decodeRuntime = (gatewayId: string, row: Record<string, unknown> | undefined) => {
    if (row === undefined || row.docKind !== "runtime") return null;
    if (!isGatewayRuntimeDoc(row) || row.gatewayId !== gatewayId) {
      throw new MalformedRecordError({ aggregate: "fleet-registry", key: gatewayId }, "is not this gateway's runtime record");
    }
    const { docKind: _docKind, ...record } = structuredClone(row) as Record<string, unknown>;
    return { ...record, revision: FIXTURE_REVISION } as unknown as Stored<FleetRegistryRecord>;
  };
  return partialRepository<FleetRegistryRepository>("fleetRegistry", {
    get: async (gatewayId) => decodeRuntime(gatewayId, documents.get(`glmGateways/${gatewayId}`)),
    list: async (filter = {}) =>
      documents.children("glmGateways").flatMap(([gatewayId, row]) => {
        const record = decodeRuntime(gatewayId, row);
        return record !== null && (filter.runtime === undefined || record.runtime === filter.runtime) ? [record] : [];
      }),
    patch: async (gatewayId, patch, fence) => {
      const path = `glmGateways/${gatewayId}`;
      const current = decodeRuntime(gatewayId, documents.get(path));
      if (current === null) throw new MissingRecordError({ aggregate: "fleet-registry", key: gatewayId });
      if (fence !== undefined) assertFenceOneOf({ aggregate: "fleet-registry", key: gatewayId }, "status", fence.lifecycle, current.lifecycle);
      write(() => documents.set(path, applyPatch(documents.get(path)!, structuredClone(patch))));
    },
  });
}

function orchestratorConfigRepository(documents: FixtureDocuments, write: Write): ConfigRepositories["orchestrator"] {
  const path = "config/orchestrator";
  return partialRepository<ConfigRepositories["orchestrator"]>("config.orchestrator", {
    get: async () => {
      const row = documents.get(path);
      return row === undefined
        ? null
        : { ...parseOrchestratorConfig(structuredClone(row)), revision: FIXTURE_REVISION } as Stored<OrchestratorConfig>;
    },
    patch: async (patch) => {
      write(() => documents.set(path, applyPatch(documents.get(path) ?? {}, structuredClone(patch))));
    },
  });
}

const PRODUCT_CONTEXT_FIELDS = ["stripeCustomerIds", "stripeSubscriptionIds", "posthogErasure"];

function deletionJobsRepository(documents: FixtureDocuments, write: Write): JobRepositories["deletions"] {
  const path = (deletionId: string) => `${CUSTOMER_DELETION_JOBS_COLLECTION}/${deletionId}`;
  const key = (deletionId: string): RecordKey => ({ aggregate: "customer-deletion-job", key: deletionId });
  const statusOf = (stored: unknown): CustomerDeletionJobStatus =>
    stored === storedDeletionStatus("product_verification_pending")
      ? "product_verification_pending"
      : stored as CustomerDeletionJobStatus;
  return partialRepository<JobRepositories["deletions"]>("jobs.deletions", {
    get: async (deletionId) => {
      const row = documents.get(path(deletionId));
      if (row === undefined) return null;
      const productContext = Object.fromEntries(PRODUCT_CONTEXT_FIELDS.filter((field) => field in row).map((field) => [field, row[field]]));
      const fields = Object.fromEntries(Object.entries(structuredClone(row)).filter(([field]) => !PRODUCT_CONTEXT_FIELDS.includes(field)));
      return {
        ...fields,
        deletionId,
        status: statusOf(row.status),
        ...(Object.keys(productContext).length > 0 ? { productContext } : {}),
        revision: FIXTURE_REVISION,
      } as unknown as Stored<CustomerDeletionJob>;
    },
    create: async (job) => {
      if (documents.get(path(job.deletionId)) !== undefined) throw new AlreadyExistsError(key(job.deletionId));
      const { deletionId, productContext, status, ...fields } = job;
      write(() => documents.set(path(deletionId), withoutIdentity({ ...fields, ...productContext, status: storedDeletionStatus(status) })));
    },
    patch: async (deletionId, patch, fence) => {
      const current = documents.get(path(deletionId));
      if (current === undefined) throw new MissingRecordError(key(deletionId));
      assertFenceOneOf(key(deletionId), "status", fence?.status?.map(storedDeletionStatus), current.status as string);
      const { status, ...fields } = patch;
      write(() => documents.set(path(deletionId), applyPatch(current, {
        ...structuredClone(fields),
        ...(status === undefined ? {} : { status: storedDeletionStatus(status) }),
      })));
    },
  });
}

function migrationTasksRepository(documents: FixtureDocuments): MigrationTasksRepository {
  return partialRepository<MigrationTasksRepository>("migrationTasks", {
    listByStatus: async (statuses) =>
      documents.children("glmMigrationTransferTasks").flatMap(([id, row]) =>
        statuses.includes(row.status as never) ? [stored<MigrationTransferTask>(id, row)] : []),
  });
}

function fixtureRepositories(rows: JournalRows, write: Write, documents?: FixtureDocuments): object {
  const journal = journalRepositories(rows, write, documents);
  if (documents === undefined) return { journal };
  return {
    journal,
    gateways: gatewayRepositories(documents, write),
    builders: builderRepositories(documents, write),
    workspaces: workspaceRepositories(documents),
    secrets: secretsRepository(documents),
    fleetRegistry: fleetRegistryRepository(documents, write),
    migrationTasks: migrationTasksRepository(documents),
    config: partialRepository<ConfigRepositories>("config", { orchestrator: orchestratorConfigRepository(documents, write) }),
    jobs: partialRepository<JobRepositories>("jobs", {
      deletions: deletionJobsRepository(documents, write),
      archives: partialRepository<JobRepositories["archives"]>("jobs.archives", {
        list: async (page) => fixturePage(
          documents.children("anonymousOperationalArchives")
            .map(([id, row]) => anonymousArchiveFromData(id, structuredClone(row)))
            .sort((a, b) => b.archivedAt - a.archivedAt),
          (archive) => archive.id,
          page,
          (id) => new MissingRecordError({ aggregate: "anonymous-operational-archive", key: id }),
        ),
      }),
    }),
  };
}

function onlyImplemented<T extends object>(repositories: object, extra: T): T {
  return new Proxy({ ...extra, ...repositories } as T, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === "symbol" || property === "then") return undefined;
      return unimplemented(String(property));
    },
  });
}

export interface JournalFixtureOptions {
  readonly transactionFailure?: Error;
  readonly documents?: FixtureDocuments;
  readonly beforeTransaction?: (label: string) => void;
  readonly serializeTransactions?: boolean;
}

export function createDocumentFixtureStore(records: FixtureDocumentRecords): PlatformStateStore {
  return createJournalFixtureStore(journalRowsAtPaths(records), { documents: fixtureDocumentsAt(records) });
}

export function createJournalFixtureStore(rows: JournalRows, options: JournalFixtureOptions = {}): PlatformStateStore {
  let committed: Promise<unknown> = Promise.resolve();
  const run = async <T>(
    transactionOptions: { label: string; readOnly?: boolean },
    body: (transaction: PlatformStateTransaction) => Promise<T>,
  ): Promise<T> => {
    if (options.transactionFailure !== undefined) throw options.transactionFailure;
    options.beforeTransaction?.(transactionOptions.label);
    const writes: Array<() => void> = [];
    const transaction = onlyImplemented(fixtureRepositories(rows, (apply) => writes.push(apply), options.documents), {
      label: transactionOptions.label,
      readOnly: transactionOptions.readOnly === true,
      attempt: 1,
    }) as unknown as PlatformStateTransaction;
    const result = await body(transaction);
    for (const apply of writes) apply();
    return result;
  };
  return onlyImplemented(fixtureRepositories(rows, (apply) => apply(), options.documents), {
    transaction<T>(
      transactionOptions: { label: string; readOnly?: boolean },
      body: (transaction: PlatformStateTransaction) => Promise<T>,
    ): Promise<T> {
      if (options.serializeTransactions !== true) return run(transactionOptions, body);
      const execution = committed.then(() => run(transactionOptions, body));
      committed = execution.then(() => undefined, () => undefined);
      return execution;
    },
  }) as unknown as PlatformStateStore;
}
