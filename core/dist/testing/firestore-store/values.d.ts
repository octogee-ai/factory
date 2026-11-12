import { Timestamp, type DocumentData, type DocumentSnapshot } from "firebase-admin/firestore";
import type { ClearField, Revision, ServerNow, WatchCursor } from "../../platform-state/store.js";
export interface FieldRepresentations {
    readonly timestampPaths: ReadonlySet<string>;
}
export declare function storedAsTimestamps(...paths: readonly string[]): FieldRepresentations;
export declare const STORED_AS_NUMBERS: FieldRepresentations;
type PlainObject = Record<string, unknown>;
export declare function isServerNow(value: unknown): value is ServerNow;
export declare function isClearField(value: unknown): value is ClearField;
export declare function encodeDocument(record: object, representations: FieldRepresentations, omittedKeys?: readonly string[]): DocumentData;
export declare function encodeMergeDocument(record: object, representations: FieldRepresentations): DocumentData;
export declare function encodePatch(patch: object, representations: FieldRepresentations, prefix?: string): DocumentData;
export declare function decodeValue(value: unknown): unknown;
export declare function decodeDocumentData(snapshot: DocumentSnapshot): PlainObject;
export declare function formatTimestamp(time: Timestamp): string;
export declare function revisionOf(snapshot: DocumentSnapshot): Revision;
export declare function watchCursorAt(readTime: Timestamp): WatchCursor;
export {};
