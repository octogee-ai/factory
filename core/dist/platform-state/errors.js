function describeRecord(record) {
    return `${record.aggregate} ${JSON.stringify(record.key)}`;
}
function describeValue(value) {
    if (value === undefined)
        return "absent";
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
export class FenceMismatchError extends Error {
    record;
    fence;
    expected;
    actual;
    code = "fence-mismatch";
    constructor(record, fence, expected, actual) {
        super(`${describeRecord(record)} fence ${fence} expected ${describeValue(expected)}, found ${describeValue(actual)}`);
        this.record = record;
        this.fence = fence;
        this.expected = expected;
        this.actual = actual;
        this.name = "FenceMismatchError";
    }
}
export class MissingRecordError extends Error {
    record;
    code = "missing-record";
    constructor(record, options) {
        super(`${describeRecord(record)} does not exist`, options);
        this.record = record;
        this.name = "MissingRecordError";
    }
}
export class AlreadyExistsError extends Error {
    record;
    code = "already-exists";
    constructor(record, options) {
        super(`${describeRecord(record)} already exists`, options);
        this.record = record;
        this.name = "AlreadyExistsError";
    }
}
export class DuplicateRecordError extends Error {
    aggregate;
    lookup;
    value;
    keysFound;
    code = "duplicate-record";
    constructor(aggregate, lookup, value, keysFound) {
        super(`${aggregate} lookup ${lookup} = ${JSON.stringify(value)} matched ${keysFound.length} records: ${keysFound.join(", ")}`);
        this.aggregate = aggregate;
        this.lookup = lookup;
        this.value = value;
        this.keysFound = keysFound;
        this.name = "DuplicateRecordError";
    }
}
export class UnsupportedOperationError extends Error {
    backend;
    operation;
    reason;
    code = "unsupported-operation";
    constructor(backend, operation, reason) {
        super(`${backend} platform state store cannot run ${operation}: ${reason}`);
        this.backend = backend;
        this.operation = operation;
        this.reason = reason;
        this.name = "UnsupportedOperationError";
    }
}
export class ContentionExhaustedError extends Error {
    backend;
    transactionLabel;
    attempts;
    code = "contention-exhausted";
    constructor(backend, transactionLabel, attempts, options) {
        super(`${backend} transaction ${transactionLabel} gave up after ${attempts} contended attempts`, options);
        this.backend = backend;
        this.transactionLabel = transactionLabel;
        this.attempts = attempts;
        this.name = "ContentionExhaustedError";
    }
}
export class MalformedRecordError extends Error {
    record;
    detail;
    code = "malformed-record";
    constructor(record, detail) {
        super(`${describeRecord(record)} is malformed: ${detail}`);
        this.record = record;
        this.detail = detail;
        this.name = "MalformedRecordError";
    }
}
export class BackendFailureError extends Error {
    backend;
    operation;
    code = "backend-failure";
    constructor(backend, operation, options) {
        super(`${backend} platform state store failed during ${operation}: ${describeCause(options.cause)}`, options);
        this.backend = backend;
        this.operation = operation;
        this.name = "BackendFailureError";
    }
}
function describeCause(cause) {
    return cause instanceof Error ? cause.message : describeValue(cause);
}
const PLATFORM_STATE_ERROR_CLASSES = [
    FenceMismatchError,
    MissingRecordError,
    AlreadyExistsError,
    DuplicateRecordError,
    UnsupportedOperationError,
    ContentionExhaustedError,
    MalformedRecordError,
    BackendFailureError,
];
export function isPlatformStateError(error) {
    return PLATFORM_STATE_ERROR_CLASSES.some((errorClass) => error instanceof errorClass);
}
