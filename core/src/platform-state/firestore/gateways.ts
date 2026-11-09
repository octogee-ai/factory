import type { DocumentReference, DocumentSnapshot, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  GATEWAY_RELEASES_SUBCOLLECTION,
  isAssignmentState,
  isGatewayDesiredDoc,
  isReleasePayload,
  upgradeReleasePayloadSchema,
} from "@octogee/shared/types/gateway-releases";
import { gatewayVmRuntimeDocPath, isGatewayVmRuntimeBundle, type GatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import { parseAssignmentDoc } from "../../assignment-doc.js";
import {
  DuplicateRecordError,
  MalformedRecordError,
  MissingRecordError,
  UnsupportedOperationError,
  type RecordKey,
} from "../errors.js";
import type {
  GatewayAssignment,
  GatewayAssignmentFence,
  GatewayAssignmentsRepository,
  GatewayRelease,
  GatewayReleasesRepository,
  GatewayRepositories,
  GatewayRoot,
  GatewayRootFence,
  GatewayRootsRepository,
  GatewayVmRuntimeRepository,
} from "../gateways.js";
import type { Stored } from "../store.js";
import { assertFenceEquals, assertFenceOneOf, assertRevisionFence } from "./fences.js";
import type { FirestoreSession } from "./session.js";
import {
  decodeDocumentData,
  encodeDocument,
  encodePatch,
  revisionOf,
  STORED_AS_NUMBERS,
  storedAsTimestamps,
} from "./values.js";
import type { FirestoreWatchSourceFactory } from "./watch.js";

const ROOT_TIMES = storedAsTimestamps("lastError.at", "lastPreStopFlush.at");
const STORED_ONLY = ["revision"] as const;

const rootKey = (gatewayId: string): RecordKey => ({ aggregate: "gateway", key: gatewayId });
const releaseKey = (gatewayId: string, release: number | string): RecordKey => ({
  aggregate: "gateway-release",
  key: `${gatewayId}/${release}`,
});
const assignmentKey = (gatewayId: string, uid: string): RecordKey => ({
  aggregate: "gateway-assignment",
  key: `${gatewayId}/${uid}`,
});
const vmRuntimeKey = (gatewayId: string): RecordKey => ({ aggregate: "gateway-vm-runtime", key: gatewayId });

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

interface PresentTarget<T> {
  readonly operation: string;
  readonly key: RecordKey;
  readonly ref: DocumentReference;
  readonly decode: (snapshot: DocumentSnapshot) => T | null;
}

async function updatePresent<T>(
  session: FirestoreSession,
  target: PresentTarget<T>,
  write: (current: T, fenced: FirestoreSession) => Promise<void>,
): Promise<void> {
  const { operation, key, ref, decode } = target;
  await session.atomically(operation, async (fenced) => {
    const current = decode(await fenced.readForFence(operation, ref));
    if (current === null) throw new MissingRecordError(key);
    await write(current, fenced);
  });
}

export function decodeGatewayRoot(snapshot: DocumentSnapshot): Stored<GatewayRoot> | null {
  if (!snapshot.exists) return null;
  const data = decodeDocumentData(snapshot);
  if (!isGatewayDesiredDoc(data)) {
    throw new MalformedRecordError(rootKey(snapshot.id), "is not a durable gateway root");
  }
  if (data.gatewayId !== snapshot.id) {
    throw new MalformedRecordError(rootKey(snapshot.id), `stores gatewayId ${JSON.stringify(data.gatewayId)}`);
  }
  return { ...data, revision: revisionOf(snapshot) } as unknown as Stored<GatewayRoot>;
}

function gatewayIdOfAssignment(snapshot: DocumentSnapshot): string | null {
  const gateway = snapshot.ref.parent.parent;
  if (gateway === null || gateway.parent.id !== GATEWAYS_COLLECTION || gateway.parent.parent !== null) return null;
  return snapshot.ref.parent.id === GATEWAY_ASSIGNMENTS_SUBCOLLECTION ? gateway.id : null;
}

function storedFieldDetail(field: string, value: unknown): string {
  return value === undefined ? `has no ${field}` : `stores ${field} ${JSON.stringify(value)}`;
}

function isFenceCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertStoredFences(key: RecordKey, uid: string, data: Record<string, unknown>): void {
  if (data.uid !== uid) throw new MalformedRecordError(key, storedFieldDetail("uid", data.uid));
  if (!isAssignmentState(data.state)) throw new MalformedRecordError(key, storedFieldDetail("state", data.state));
  if (!isFenceCount(data.epoch)) throw new MalformedRecordError(key, storedFieldDetail("epoch", data.epoch));
  if (data.updatedAt !== undefined && !isFenceCount(data.updatedAt)) {
    throw new MalformedRecordError(key, storedFieldDetail("updatedAt", data.updatedAt));
  }
  const operationId = data.updatedByOperationId;
  if (operationId !== undefined && operationId !== null && typeof operationId !== "string") {
    throw new MalformedRecordError(key, storedFieldDetail("updatedByOperationId", operationId));
  }
}

export function decodeGatewayAssignmentData(gatewayId: string, uid: string, data: Record<string, unknown>): GatewayAssignment {
  const key = assignmentKey(gatewayId, uid);
  let assignment: GatewayAssignment | null;
  try {
    assignment = parseAssignmentDoc(uid, data);
  } catch (error) {
    throw new MalformedRecordError(key, error instanceof Error ? error.message : String(error));
  }
  if (assignment === null) throw new MalformedRecordError(key, "is not a complete assignment");
  if (assignment.gatewayId !== gatewayId) {
    throw new MalformedRecordError(key, `stores gatewayId ${JSON.stringify(assignment.gatewayId)}`);
  }
  assertStoredFences(key, uid, data);
  return assignment;
}

export function decodeGatewayAssignment(snapshot: DocumentSnapshot): Stored<GatewayAssignment> | null {
  if (!snapshot.exists) return null;
  const gatewayId = gatewayIdOfAssignment(snapshot);
  if (gatewayId === null) return null;
  return { ...decodeGatewayAssignmentData(gatewayId, snapshot.id, decodeDocumentData(snapshot)), revision: revisionOf(snapshot) };
}

function decodeRelease(snapshot: DocumentSnapshot): GatewayRelease | null {
  if (!snapshot.exists) return null;
  const gatewayId = snapshot.ref.parent.parent?.id ?? "";
  const key = releaseKey(gatewayId, snapshot.id);
  const data = decodeDocumentData(snapshot);
  if (data.gatewayId !== gatewayId || String(data.release) !== snapshot.id) {
    throw new MalformedRecordError(key, `stores release ${JSON.stringify(data.gatewayId)}/${JSON.stringify(data.release)}`);
  }
  if (isReleasePayload(data.payload)) return data as unknown as GatewayRelease;
  const upgrade = upgradeReleasePayloadSchema(data.payload, data.payloadHash);
  if (upgrade.status === "unsupported") throw new MalformedRecordError(key, `payload is unreadable: ${upgrade.reason}`);
  return { ...data, payload: upgrade.payload, payloadHash: upgrade.payloadHash } as unknown as GatewayRelease;
}

function decodeVmRuntime(snapshot: DocumentSnapshot): Stored<GatewayVmRuntimeBundle> | null {
  if (!snapshot.exists) return null;
  const gatewayId = snapshot.ref.parent.parent?.id ?? "";
  const data = decodeDocumentData(snapshot);
  if (!isGatewayVmRuntimeBundle(data) || data.gatewayId !== gatewayId) {
    throw new MalformedRecordError(vmRuntimeKey(gatewayId), "is not this gateway's VM runtime bundle");
  }
  return { ...data, revision: revisionOf(snapshot) };
}

function assertRootFence(key: RecordKey, fence: GatewayRootFence, current: Stored<GatewayRoot>): void {
  assertRevisionFence(key, fence.revision, current.revision);
  assertFenceEquals(key, "updatedAt", fence.updatedAt, current.updatedAt);
  assertFenceEquals(key, "latestRelease", fence.latestRelease, current.latestRelease);
  assertFenceEquals(key, "retirementVersion", fence.retirementVersion, current.retirementVersion);
  assertFenceOneOf(key, "status", fence.desiredStatus, current.desiredStatus);
  assertFenceEquals(key, "generation", fence.allocationGeneration, current.allocation?.generation);
  assertFenceEquals(key, "present", fence.lastErrorSlug, current.lastError?.slug);
}

function assertAssignmentFence(key: RecordKey, fence: GatewayAssignmentFence, current: Stored<GatewayAssignment>): void {
  assertRevisionFence(key, fence.revision, current.revision);
  assertFenceEquals(key, "epoch", fence.epoch, current.epoch);
  assertFenceEquals(key, "updatedAt", fence.updatedAt, current.updatedAt);
  assertFenceOneOf(key, "status", fence.state, current.state);
}

function rootsCollection(session: FirestoreSession) {
  return session.db.collection(GATEWAYS_COLLECTION);
}

function rootRef(session: FirestoreSession, gatewayId: string): DocumentReference {
  return rootsCollection(session).doc(gatewayId);
}

function releasesCollection(session: FirestoreSession, gatewayId: string) {
  return rootRef(session, gatewayId).collection(GATEWAY_RELEASES_SUBCOLLECTION);
}

function assignmentsCollection(session: FirestoreSession, gatewayId: string) {
  return rootRef(session, gatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION);
}

function assignmentGroup(session: FirestoreSession): Query {
  return session.db.collectionGroup(GATEWAY_ASSIGNMENTS_SUBCOLLECTION);
}

async function assertNoGatewayChildren(session: FirestoreSession, operation: string, gatewayId: string): Promise<void> {
  const [releases, assignments] = await Promise.all([
    session.query(operation, releasesCollection(session, gatewayId).limit(1)),
    session.query(operation, assignmentsCollection(session, gatewayId).limit(1)),
  ]);
  if (!releases.empty || !assignments.empty) {
    throw new UnsupportedOperationError(
      "firestore",
      `${operation} of ${gatewayId} while it still has releases or assignments inside a transaction`,
      "backend-capability",
    );
  }
}

function createRootsRepository(session: FirestoreSession): GatewayRootsRepository {
  const ref = (gatewayId: string) => rootRef(session, gatewayId);
  const list = async (operation: string, query: Query) =>
    (await session.query(operation, query)).docs.map(decodeGatewayRoot).filter(isPresent);

  return {
    async get(gatewayId) {
      return decodeGatewayRoot(await session.read("gateways.roots.get", ref(gatewayId)));
    },

    async getMany(gatewayIds) {
      const snapshots = await session.readAll("gateways.roots.getMany", gatewayIds.map(ref));
      const found = new Map<string, Stored<GatewayRoot>>();
      for (const root of snapshots.map(decodeGatewayRoot)) if (root !== null) found.set(root.gatewayId, root);
      return found;
    },

    async list(filter = {}) {
      let query: Query = rootsCollection(session);
      if (filter.gatewayClass !== undefined) query = query.where("gatewayClass", "==", filter.gatewayClass);
      if (filter.ownerUid !== undefined) query = query.where("ownerUid", "==", filter.ownerUid);
      return list("gateways.roots.list", query);
    },

    async findByServiceAccountName(serviceAccountName) {
      const docs = (
        await session.query(
          "gateways.roots.findByServiceAccountName",
          rootsCollection(session).where("serviceAccountName", "==", serviceAccountName).limit(2),
        )
      ).docs;
      if (docs.length > 1) {
        throw new DuplicateRecordError("gateway", "serviceAccountName", serviceAccountName, docs.map((doc) => doc.id));
      }
      return docs.length === 0 ? null : decodeGatewayRoot(docs[0]);
    },

    async create(root) {
      await session.create(
        "gateways.roots.create",
        rootKey(root.gatewayId),
        ref(root.gatewayId),
        encodeDocument(root, ROOT_TIMES, STORED_ONLY),
      );
    },

    async patch(gatewayId, patch, fence) {
      const name = "gateways.roots.patch";
      const key = rootKey(gatewayId);
      const data = encodePatch(patch, ROOT_TIMES);
      if (fence === undefined) {
        await session.update(name, key, ref(gatewayId), data);
        return;
      }
      await updatePresent(session, { operation: name, key, ref: ref(gatewayId), decode: decodeGatewayRoot }, async (current, fenced) => {
        assertRootFence(key, fence, current);
        await fenced.update(name, key, ref(gatewayId), data);
      });
    },

    async compareAndSetRuntimeRestartFence(gatewayId, expected, next) {
      const name = "gateways.roots.compareAndSetRuntimeRestartFence";
      const key = rootKey(gatewayId);
      await updatePresent(session, { operation: name, key, ref: ref(gatewayId), decode: decodeGatewayRoot }, async (current, fenced) => {
        assertFenceEquals(key, "runtimeRestartFence", expected, current.runtimeRestartFence);
        await fenced.update(name, key, ref(gatewayId), encodePatch({ runtimeRestartFence: next ?? { clear: true } }, ROOT_TIMES));
      });
    },

    async deleteChildren(gatewayId) {
      if (session.transactional) {
        throw new UnsupportedOperationError("firestore", "gateways.roots.deleteChildren inside a transaction", "backend-capability");
      }
      for (const child of await ref(gatewayId).listCollections()) {
        if (child.id !== GATEWAY_ASSIGNMENTS_SUBCOLLECTION) await session.db.recursiveDelete(child);
      }
    },

    async delete(gatewayId, fence) {
      const name = "gateways.roots.delete";
      const key = rootKey(gatewayId);
      const deleteRoot = async (fenced: FirestoreSession) => {
        if (fence !== undefined) {
          const current = decodeGatewayRoot(await fenced.readForFence(name, ref(gatewayId)));
          if (current === null) throw new MissingRecordError(key);
          assertRootFence(key, fence, current);
        }
        await fenced.delete(name, key, ref(gatewayId));
      };
      if (session.transactional) {
        await assertNoGatewayChildren(session, name, gatewayId);
        await deleteRoot(session);
        return;
      }
      await session.atomically(name, deleteRoot);
      await session.db.recursiveDelete(ref(gatewayId));
    },
  };
}

function createReleasesRepository(session: FirestoreSession): GatewayReleasesRepository {
  const ref = (gatewayId: string, release: number) => releasesCollection(session, gatewayId).doc(String(release));
  const encode = (release: GatewayRelease) => encodeDocument(release, STORED_AS_NUMBERS);

  return {
    async get(gatewayId, release) {
      return decodeRelease(await session.read("gateways.releases.get", ref(gatewayId, release)));
    },

    async list(gatewayId, order, limit) {
      const ordered = releasesCollection(session, gatewayId).orderBy("release", order);
      const snapshot = await session.query("gateways.releases.list", limit === undefined ? ordered : ordered.limit(limit));
      return snapshot.docs.map(decodeRelease).filter(isPresent);
    },

    async append(input) {
      const name = "gateways.releases.append";
      const key = rootKey(input.gatewayId);
      return session.atomically(name, async (fenced) => {
        const root = decodeGatewayRoot(await fenced.readForFence(name, rootRef(session, input.gatewayId)));
        if (root === null) throw new MissingRecordError(key);
        assertFenceEquals(key, "latestRelease", input.expectedLatestRelease, root.latestRelease);
        const release = input.expectedLatestRelease + 1;
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
        await fenced.create(name, releaseKey(input.gatewayId, release), ref(input.gatewayId, release), encode(document));
        await fenced.update(
          name,
          key,
          rootRef(session, input.gatewayId),
          encodePatch(
            {
              latestRelease: release,
              ...(input.activate ? { desiredRelease: release } : {}),
              updatedAt: input.createdAt,
              updatedBy: input.updatedBy,
            },
            ROOT_TIMES,
          ),
        );
        return release;
      });
    },

    async createInitial(release) {
      await session.create(
        "gateways.releases.createInitial",
        releaseKey(release.gatewayId, release.release),
        ref(release.gatewayId, release.release),
        encode(release),
      );
    },

    async replace(release) {
      await session.set(
        "gateways.releases.replace",
        releaseKey(release.gatewayId, release.release),
        ref(release.gatewayId, release.release),
        encode(release),
      );
    },
  };
}

function createAssignmentsRepository(session: FirestoreSession): GatewayAssignmentsRepository {
  const ref = (gatewayId: string, uid: string) => assignmentsCollection(session, gatewayId).doc(uid);
  const list = async (operation: string, query: Query) =>
    (await session.query(operation, query)).docs.map(decodeGatewayAssignment).filter(isPresent);
  const encode = (assignment: GatewayAssignment) => encodeDocument(assignment, STORED_AS_NUMBERS, STORED_ONLY);

  return {
    async get(gatewayId, uid) {
      return decodeGatewayAssignment(await session.read("gateways.assignments.get", ref(gatewayId, uid)));
    },

    async list(gatewayId, limit) {
      const collection = assignmentsCollection(session, gatewayId);
      return list("gateways.assignments.list", limit === undefined ? collection : collection.limit(limit));
    },

    async isEmpty(gatewayId) {
      return (await session.query("gateways.assignments.isEmpty", assignmentsCollection(session, gatewayId).limit(1))).empty;
    },

    async findBySlug(gatewayId, slug) {
      const docs = (
        await session.query(
          "gateways.assignments.findBySlug",
          assignmentsCollection(session, gatewayId).where("slug", "==", slug).limit(2),
        )
      ).docs;
      if (docs.length > 1) {
        throw new DuplicateRecordError("gateway-assignment", "slug", slug, docs.map((doc) => `${gatewayId}/${doc.id}`));
      }
      return docs.length === 0 ? null : decodeGatewayAssignment(docs[0]);
    },

    async listForUid(uid) {
      return list("gateways.assignments.listForUid", assignmentGroup(session).where("uid", "==", uid));
    },

    async listForSlug(slug) {
      return list("gateways.assignments.listForSlug", assignmentGroup(session).where("slug", "==", slug));
    },

    async listAll() {
      return list("gateways.assignments.listAll", assignmentGroup(session));
    },

    async create(assignment) {
      await session.create(
        "gateways.assignments.create",
        assignmentKey(assignment.gatewayId, assignment.uid),
        ref(assignment.gatewayId, assignment.uid),
        encode(assignment),
      );
    },

    async put(assignment) {
      await session.set(
        "gateways.assignments.put",
        assignmentKey(assignment.gatewayId, assignment.uid),
        ref(assignment.gatewayId, assignment.uid),
        encode(assignment),
      );
    },

    async patch(gatewayId, uid, patch, fence) {
      const name = "gateways.assignments.patch";
      const key = assignmentKey(gatewayId, uid);
      const data = encodePatch(patch, STORED_AS_NUMBERS);
      if (fence === undefined) {
        await session.update(name, key, ref(gatewayId, uid), data);
        return;
      }
      await updatePresent(session, { operation: name, key, ref: ref(gatewayId, uid), decode: decodeGatewayAssignment }, async (current, fenced) => {
        assertAssignmentFence(key, fence, current);
        await fenced.update(name, key, ref(gatewayId, uid), data);
      });
    },

    async delete(gatewayId, uid, fence) {
      const name = "gateways.assignments.delete";
      const key = assignmentKey(gatewayId, uid);
      if (fence === undefined) {
        await session.delete(name, key, ref(gatewayId, uid));
        return;
      }
      await updatePresent(session, { operation: name, key, ref: ref(gatewayId, uid), decode: decodeGatewayAssignment }, async (current, fenced) => {
        assertAssignmentFence(key, fence, current);
        await fenced.delete(name, key, ref(gatewayId, uid));
      });
    },
  };
}

function createVmRuntimeRepository(session: FirestoreSession): GatewayVmRuntimeRepository {
  const ref = (gatewayId: string) => session.db.doc(gatewayVmRuntimeDocPath(gatewayId));

  return {
    async get(gatewayId) {
      return decodeVmRuntime(await session.read("gateways.vmRuntime.get", ref(gatewayId)));
    },

    async put(gatewayId, bundle) {
      if (bundle.gatewayId !== gatewayId) {
        throw new MalformedRecordError(vmRuntimeKey(gatewayId), `bundle names gateway ${JSON.stringify(bundle.gatewayId)}`);
      }
      await session.set(
        "gateways.vmRuntime.put",
        vmRuntimeKey(gatewayId),
        ref(gatewayId),
        encodeDocument(bundle, STORED_AS_NUMBERS, STORED_ONLY),
      );
    },

    async delete(gatewayId) {
      await session.delete("gateways.vmRuntime.delete", vmRuntimeKey(gatewayId), ref(gatewayId));
    },
  };
}

export function createFirestoreGatewayRepositories(session: FirestoreSession): GatewayRepositories {
  return {
    roots: createRootsRepository(session),
    releases: createReleasesRepository(session),
    assignments: createAssignmentsRepository(session),
    vmRuntime: createVmRuntimeRepository(session),
  };
}

const assignmentWatchKey = (snapshot: QueryDocumentSnapshot) => `${gatewayIdOfAssignment(snapshot)}/${snapshot.id}`;

export const firestoreGatewaysWatchSource: FirestoreWatchSourceFactory<"gateways"> = (db, filter) => ({
  operation: "watch gateways",
  targets: [
    filter.gatewayId === undefined
      ? { query: db.collection(GATEWAYS_COLLECTION), key: (snapshot) => snapshot.id, decode: decodeGatewayRoot }
      : { document: db.collection(GATEWAYS_COLLECTION).doc(filter.gatewayId), key: filter.gatewayId, decode: decodeGatewayRoot },
  ],
});

export const firestoreAssignmentsWatchSource: FirestoreWatchSourceFactory<"assignments"> = (db, filter) => ({
  operation: "watch assignments",
  targets: [
    {
      query:
        filter.gatewayId === undefined
          ? db.collectionGroup(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
          : db.collection(GATEWAYS_COLLECTION).doc(filter.gatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION),
      key: assignmentWatchKey,
      decode: decodeGatewayAssignment,
    },
  ],
});
