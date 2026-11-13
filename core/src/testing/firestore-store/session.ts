import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { AlreadyExistsError, MissingRecordError, type RecordKey } from "../../platform-state/errors.js";
import { firestoreErrorCode, FIRESTORE_ALREADY_EXISTS, FIRESTORE_NOT_FOUND, runFirestoreTransaction } from "./transaction.js";

export interface FirestoreSession {
  readonly db: Firestore;
  readonly transactional: boolean;
  read(operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
  readAll(operation: string, refs: readonly DocumentReference[]): Promise<readonly DocumentSnapshot[]>;
  query(operation: string, query: Query): Promise<QuerySnapshot>;
  readForFence(operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
  create(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
  set(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
  merge(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
  update(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
  delete(operation: string, record: RecordKey, ref: DocumentReference): Promise<void>;
  atomically<T>(operation: string, body: (session: FirestoreSession) => Promise<T>): Promise<T>;
}

export class DirectFirestoreSession implements FirestoreSession {
  readonly transactional = false;

  constructor(readonly db: Firestore) {}

  read(_operation: string, ref: DocumentReference): Promise<DocumentSnapshot> {
    return ref.get();
  }

  async readAll(_operation: string, refs: readonly DocumentReference[]): Promise<readonly DocumentSnapshot[]> {
    if (refs.length === 0) return [];
    return this.db.getAll(...refs);
  }

  query(_operation: string, query: Query): Promise<QuerySnapshot> {
    return query.get();
  }

  readForFence(_operation: string, ref: DocumentReference): Promise<DocumentSnapshot> {
    return ref.get();
  }

  async create(_operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    try {
      await ref.create(data);
    } catch (error) {
      if (firestoreErrorCode(error) === FIRESTORE_ALREADY_EXISTS) throw new AlreadyExistsError(record, { cause: error });
      throw error;
    }
  }

  async set(_operation: string, _record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    await ref.set(data);
  }

  async merge(_operation: string, _record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    await ref.set(data, { merge: true });
  }

  async update(_operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void> {
    try {
      await ref.update(data);
    } catch (error) {
      if (firestoreErrorCode(error) === FIRESTORE_NOT_FOUND) throw new MissingRecordError(record, { cause: error });
      throw error;
    }
  }

  async delete(_operation: string, _record: RecordKey, ref: DocumentReference): Promise<void> {
    await ref.delete();
  }

  atomically<T>(operation: string, body: (session: FirestoreSession) => Promise<T>): Promise<T> {
    return runFirestoreTransaction(this.db, { label: operation }, (session) => body(session));
  }
}
