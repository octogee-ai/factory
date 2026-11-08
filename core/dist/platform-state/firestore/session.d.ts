import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, Query, QuerySnapshot } from "firebase-admin/firestore";
import { type RecordKey } from "../errors.js";
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
export declare class DirectFirestoreSession implements FirestoreSession {
    readonly db: Firestore;
    readonly transactional = false;
    constructor(db: Firestore);
    read(_operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
    readAll(_operation: string, refs: readonly DocumentReference[]): Promise<readonly DocumentSnapshot[]>;
    query(_operation: string, query: Query): Promise<QuerySnapshot>;
    readForFence(_operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
    create(_operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    set(_operation: string, _record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    merge(_operation: string, _record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    update(_operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    delete(_operation: string, _record: RecordKey, ref: DocumentReference): Promise<void>;
    atomically<T>(operation: string, body: (session: FirestoreSession) => Promise<T>): Promise<T>;
}
