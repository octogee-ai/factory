import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
} from "firebase-admin/firestore";
import {
  AlreadyExistsError,
  ContentionExhaustedError,
  isPlatformStateError,
  MissingRecordError,
  UnsupportedOperationError,
  type RecordKey,
} from "../errors.js";
import type { TransactionOptions } from "../store.js";
import type { FirestoreSession } from "./session.js";

export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 5;

export const FIRESTORE_NOT_FOUND = 5;
export const FIRESTORE_ALREADY_EXISTS = 6;
export const FIRESTORE_FAILED_PRECONDITION = 9;
const FIRESTORE_ABORTED = 10;
const HTTP_CONFLICT = 409;
const CONTENTION_CODES: ReadonlySet<number> = new Set([FIRESTORE_ABORTED, HTTP_CONFLICT]);

export function firestoreErrorCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

type StagedVerb = "create" | "set" | "merge" | "update" | "delete";

interface StagedWrite {
  readonly verb: StagedVerb;
  readonly record: RecordKey;
  readonly path: string;
}

export interface TransactionAttempt {
  readonly label: string;
  readonly readOnly: boolean;
  readonly attempt: number;
}

export class TransactionFirestoreSession implements FirestoreSession {
  readonly transactional = true;
  private readonly snapshots = new Map<string, DocumentSnapshot>();
  private readonly stagedWrites: StagedWrite[] = [];

  constructor(
    readonly db: Firestore,
    private readonly transaction: Transaction,
    readonly attempt: TransactionAttempt,
  ) {}

  private assertNoWrites(operation: string): void {
    if (this.stagedWrites.length > 0) {
      throw new UnsupportedOperationError("firestore", operation, "read-after-write");
    }
  }

  private remember<S extends DocumentSnapshot>(snapshot: S): S {
    this.snapshots.set(snapshot.ref.path, snapshot);
    return snapshot;
  }

  async read(operation: string, ref: DocumentReference): Promise<DocumentSnapshot> {
    this.assertNoWrites(operation);
    return this.snapshots.get(ref.path) ?? this.remember(await this.transaction.get(ref));
  }

  async readAll(operation: string, refs: readonly DocumentReference[]): Promise<readonly DocumentSnapshot[]> {
    this.assertNoWrites(operation);
    const unread = refs.filter((ref) => !this.snapshots.has(ref.path));
    if (unread.length > 0) {
      for (const snapshot of await this.transaction.getAll(...unread)) this.remember(snapshot);
    }
    return refs.map((ref) => this.snapshots.get(ref.path) as DocumentSnapshot);
  }

  async query(operation: string, query: Query): Promise<QuerySnapshot> {
    this.assertNoWrites(operation);
    const result = await this.transaction.get(query);
    for (const snapshot of result.docs) this.remember(snapshot);
    return result;
  }

  async readForFence(operation: string, ref: DocumentReference): Promise<DocumentSnapshot> {
    if (this.stagedWrites.some((write) => write.path === ref.path)) {
      throw new UnsupportedOperationError("firestore", operation, "read-after-write");
    }
    return this.snapshots.get(ref.path) ?? this.read(operation, ref);
  }

  private stage(operation: string, verb: StagedVerb, record: RecordKey, ref: DocumentReference): void {
    if (this.attempt.readOnly) {
      throw new UnsupportedOperationError("firestore", operation, "write-in-read-only-transaction");
    }
    this.stagedWrites.push({ verb, record, path: ref.path });
  }

  async create(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    this.stage(operation, "create", record, ref);
    this.transaction.create(ref, data);
  }

  async set(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    this.stage(operation, "set", record, ref);
    this.transaction.set(ref, data);
  }

  async merge(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    this.stage(operation, "merge", record, ref);
    this.transaction.set(ref, data, { merge: true });
  }

  async update(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    this.stage(operation, "update", record, ref);
    this.transaction.update(ref, data);
  }

  async delete(operation: string, record: RecordKey, ref: DocumentReference): Promise<void> {
    this.stage(operation, "delete", record, ref);
    this.transaction.delete(ref);
  }

  atomically<T>(_operation: string, body: (session: FirestoreSession) => Promise<T>): Promise<T> {
    return body(this);
  }

  async locateRejectedWrite(verb: "create" | "update"): Promise<RecordKey | undefined> {
    const candidates = this.stagedWrites.filter((write) => write.verb === verb);
    if (candidates.length <= 1) return candidates[0]?.record;
    const snapshots = await this.db.getAll(...candidates.map((write) => this.db.doc(write.path)));
    const rejected = snapshots.findIndex((snapshot) => snapshot.exists === (verb === "create"));
    return rejected < 0 ? undefined : candidates[rejected].record;
  }
}

async function translateTransactionFailure(
  error: unknown,
  label: string,
  attempts: number,
  session: TransactionFirestoreSession | undefined,
): Promise<unknown> {
  if (isPlatformStateError(error)) return error;
  const code = firestoreErrorCode(error);
  if (code !== undefined && CONTENTION_CODES.has(code)) {
    return new ContentionExhaustedError("firestore", label, attempts, { cause: error });
  }
  if (code === FIRESTORE_ALREADY_EXISTS) {
    const record = await session?.locateRejectedWrite("create");
    if (record) return new AlreadyExistsError(record, { cause: error });
  }
  if (code === FIRESTORE_NOT_FOUND) {
    const record = await session?.locateRejectedWrite("update");
    if (record) return new MissingRecordError(record, { cause: error });
  }
  return error;
}

export async function runFirestoreTransaction<T>(
  db: Firestore,
  options: TransactionOptions,
  body: (session: TransactionFirestoreSession) => Promise<T>,
): Promise<T> {
  const readOnly = options.readOnly === true;
  const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS;
  let attempt = 0;
  let session: TransactionFirestoreSession | undefined;
  try {
    return await db.runTransaction(
      (transaction) => {
        attempt += 1;
        session = new TransactionFirestoreSession(db, transaction, { label: options.label, readOnly, attempt });
        return body(session);
      },
      readOnly ? { readOnly: true } : { maxAttempts },
    );
  } catch (error) {
    throw await translateTransactionFailure(error, options.label, attempt, session);
  }
}
