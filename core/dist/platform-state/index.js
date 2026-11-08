export { AlreadyExistsError, BackendFailureError, ContentionExhaustedError, DuplicateRecordError, FenceMismatchError, isPlatformStateError, MalformedRecordError, MissingRecordError, UnsupportedOperationError, } from "./errors.js";
export { createFirestorePlatformStateStore, } from "./firestore/store.js";
