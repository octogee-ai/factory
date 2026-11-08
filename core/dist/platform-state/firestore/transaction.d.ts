import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, Query, QuerySnapshot, Transaction } from "firebase-admin/firestore";
import { type RecordKey } from "../errors.js";
import type { TransactionOptions } from "../store.js";
import type { FirestoreSession } from "./session.js";
export declare const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 5;
export declare const FIRESTORE_NOT_FOUND = 5;
export declare const FIRESTORE_ALREADY_EXISTS = 6;
export declare const FIRESTORE_FAILED_PRECONDITION = 9;
export declare function firestoreErrorCode(error: unknown): number | undefined;
export interface TransactionAttempt {
    readonly label: string;
    readonly readOnly: boolean;
    readonly attempt: number;
}
export declare class TransactionFirestoreSession implements FirestoreSession {
    readonly db: Firestore;
    private readonly transaction;
    readonly attempt: TransactionAttempt;
    readonly transactional = true;
    private readonly snapshots;
    private readonly stagedWrites;
    constructor(db: Firestore, transaction: Transaction, attempt: TransactionAttempt);
    private assertNoWrites;
    private remember;
    read(operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
    readAll(operation: string, refs: readonly DocumentReference[]): Promise<readonly DocumentSnapshot[]>;
    query(operation: string, query: Query): Promise<QuerySnapshot>;
    readForFence(operation: string, ref: DocumentReference): Promise<DocumentSnapshot>;
    private stage;
    create(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    set(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    merge(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    update(operation: string, record: RecordKey, ref: DocumentReference, data: DocumentData): Promise<void>;
    delete(operation: string, record: RecordKey, ref: DocumentReference): Promise<void>;
    atomically<T>(_operation: string, body: (session: FirestoreSession) => Promise<T>): Promise<T>;
    locateRejectedWrite(verb: "create" | "update"): Promise<RecordKey | undefined>;
}
export declare function runFirestoreTransaction<T>(db: Firestore, options: TransactionOptions, body: (session: TransactionFirestoreSession) => Promise<T>): Promise<T>;
