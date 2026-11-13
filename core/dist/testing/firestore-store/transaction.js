import { AlreadyExistsError, ContentionExhaustedError, isPlatformStateError, MissingRecordError, UnsupportedOperationError, } from "../../platform-state/errors.js";
export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 5;
export const FIRESTORE_NOT_FOUND = 5;
export const FIRESTORE_ALREADY_EXISTS = 6;
export const FIRESTORE_FAILED_PRECONDITION = 9;
const FIRESTORE_ABORTED = 10;
const HTTP_CONFLICT = 409;
const CONTENTION_CODES = new Set([FIRESTORE_ABORTED, HTTP_CONFLICT]);
export function firestoreErrorCode(error) {
    if (error === null || typeof error !== "object")
        return undefined;
    const code = error.code;
    return typeof code === "number" ? code : undefined;
}
export class TransactionFirestoreSession {
    db;
    transaction;
    attempt;
    transactional = true;
    snapshots = new Map();
    stagedWrites = [];
    constructor(db, transaction, attempt) {
        this.db = db;
        this.transaction = transaction;
        this.attempt = attempt;
    }
    assertNoWrites(operation) {
        if (this.stagedWrites.length > 0) {
            throw new UnsupportedOperationError("firestore", operation, "read-after-write");
        }
    }
    remember(snapshot) {
        this.snapshots.set(snapshot.ref.path, snapshot);
        return snapshot;
    }
    async read(operation, ref) {
        this.assertNoWrites(operation);
        return this.snapshots.get(ref.path) ?? this.remember(await this.transaction.get(ref));
    }
    async readAll(operation, refs) {
        this.assertNoWrites(operation);
        const unread = refs.filter((ref) => !this.snapshots.has(ref.path));
        if (unread.length > 0) {
            for (const snapshot of await this.transaction.getAll(...unread))
                this.remember(snapshot);
        }
        return refs.map((ref) => this.snapshots.get(ref.path));
    }
    async query(operation, query) {
        this.assertNoWrites(operation);
        const result = await this.transaction.get(query);
        for (const snapshot of result.docs)
            this.remember(snapshot);
        return result;
    }
    async readForFence(operation, ref) {
        if (this.stagedWrites.some((write) => write.path === ref.path)) {
            throw new UnsupportedOperationError("firestore", operation, "read-after-write");
        }
        return this.snapshots.get(ref.path) ?? this.read(operation, ref);
    }
    stage(operation, verb, record, ref) {
        if (this.attempt.readOnly) {
            throw new UnsupportedOperationError("firestore", operation, "write-in-read-only-transaction");
        }
        this.stagedWrites.push({ verb, record, path: ref.path });
    }
    async create(operation, record, ref, data) {
        this.stage(operation, "create", record, ref);
        this.transaction.create(ref, data);
    }
    async set(operation, record, ref, data) {
        this.stage(operation, "set", record, ref);
        this.transaction.set(ref, data);
    }
    async merge(operation, record, ref, data) {
        this.stage(operation, "merge", record, ref);
        this.transaction.set(ref, data, { merge: true });
    }
    async update(operation, record, ref, data) {
        this.stage(operation, "update", record, ref);
        this.transaction.update(ref, data);
    }
    async delete(operation, record, ref) {
        this.stage(operation, "delete", record, ref);
        this.transaction.delete(ref);
    }
    atomically(_operation, body) {
        return body(this);
    }
    async locateRejectedWrite(verb) {
        const candidates = this.stagedWrites.filter((write) => write.verb === verb);
        if (candidates.length <= 1)
            return candidates[0]?.record;
        const snapshots = await this.db.getAll(...candidates.map((write) => this.db.doc(write.path)));
        const rejected = snapshots.findIndex((snapshot) => snapshot.exists === (verb === "create"));
        return rejected < 0 ? undefined : candidates[rejected].record;
    }
}
async function translateTransactionFailure(error, label, attempts, session) {
    if (isPlatformStateError(error))
        return error;
    const code = firestoreErrorCode(error);
    if (code !== undefined && CONTENTION_CODES.has(code)) {
        return new ContentionExhaustedError("firestore", label, attempts, { cause: error });
    }
    if (code === FIRESTORE_ALREADY_EXISTS) {
        const record = await session?.locateRejectedWrite("create");
        if (record)
            return new AlreadyExistsError(record, { cause: error });
    }
    if (code === FIRESTORE_NOT_FOUND) {
        const record = await session?.locateRejectedWrite("update");
        if (record)
            return new MissingRecordError(record, { cause: error });
    }
    return error;
}
export async function runFirestoreTransaction(db, options, body) {
    const readOnly = options.readOnly === true;
    const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS;
    let attempt = 0;
    let session;
    try {
        return await db.runTransaction((transaction) => {
            attempt += 1;
            session = new TransactionFirestoreSession(db, transaction, { label: options.label, readOnly, attempt });
            return body(session);
        }, readOnly ? { readOnly: true } : { maxAttempts });
    }
    catch (error) {
        throw await translateTransactionFailure(error, options.label, attempt, session);
    }
}
