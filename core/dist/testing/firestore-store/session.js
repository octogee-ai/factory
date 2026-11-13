import { AlreadyExistsError, MissingRecordError } from "../../platform-state/errors.js";
import { firestoreErrorCode, FIRESTORE_ALREADY_EXISTS, FIRESTORE_NOT_FOUND, runFirestoreTransaction } from "./transaction.js";
export class DirectFirestoreSession {
    db;
    transactional = false;
    constructor(db) {
        this.db = db;
    }
    read(_operation, ref) {
        return ref.get();
    }
    async readAll(_operation, refs) {
        if (refs.length === 0)
            return [];
        return this.db.getAll(...refs);
    }
    query(_operation, query) {
        return query.get();
    }
    readForFence(_operation, ref) {
        return ref.get();
    }
    async create(_operation, record, ref, data) {
        try {
            await ref.create(data);
        }
        catch (error) {
            if (firestoreErrorCode(error) === FIRESTORE_ALREADY_EXISTS)
                throw new AlreadyExistsError(record, { cause: error });
            throw error;
        }
    }
    async set(_operation, _record, ref, data) {
        await ref.set(data);
    }
    async merge(_operation, _record, ref, data) {
        await ref.set(data, { merge: true });
    }
    async update(_operation, record, ref, data) {
        try {
            await ref.update(data);
        }
        catch (error) {
            if (firestoreErrorCode(error) === FIRESTORE_NOT_FOUND)
                throw new MissingRecordError(record, { cause: error });
            throw error;
        }
    }
    async delete(_operation, _record, ref) {
        await ref.delete();
    }
    atomically(operation, body) {
        return runFirestoreTransaction(this.db, { label: operation }, (session) => body(session));
    }
}
