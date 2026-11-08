import { FieldValue, Timestamp, type DocumentData, type DocumentSnapshot } from "firebase-admin/firestore";
import type { ClearField, Revision, ServerNow, WatchCursor } from "../store.js";

export interface FieldRepresentations {
  readonly timestampPaths: ReadonlySet<string>;
}

export function storedAsTimestamps(...paths: readonly string[]): FieldRepresentations {
  return { timestampPaths: new Set(paths) };
}

export const STORED_AS_NUMBERS: FieldRepresentations = storedAsTimestamps();

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSoleTrueFlag(value: unknown, flag: string): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === flag && value[flag] === true;
}

export function isServerNow(value: unknown): value is ServerNow {
  return isSoleTrueFlag(value, "serverNow");
}

export function isClearField(value: unknown): value is ClearField {
  return isSoleTrueFlag(value, "clear");
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

type NestedClears = "reject" | "delete";

function encodeValue(
  value: unknown,
  path: string,
  representations: FieldRepresentations,
  nestedClears: NestedClears,
): unknown {
  if (isServerNow(value)) return FieldValue.serverTimestamp();
  if (isClearField(value)) {
    if (nestedClears === "delete") return FieldValue.delete();
    throw new TypeError(`{ clear: true } is only valid at a patch field position; found inside ${path}`);
  }
  if (typeof value === "number" && representations.timestampPaths.has(path)) return Timestamp.fromMillis(value);
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, path, representations, "reject"));
  if (isPlainObject(value)) return encodeMap(value, path, representations, nestedClears);
  return value;
}

function encodeMap(
  map: PlainObject,
  path: string,
  representations: FieldRepresentations,
  nestedClears: NestedClears,
): DocumentData {
  const encoded: DocumentData = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    encoded[key] = encodeValue(value, joinPath(path, key), representations, nestedClears);
  }
  return encoded;
}

export function encodeDocument(
  record: object,
  representations: FieldRepresentations,
  omittedKeys: readonly string[] = [],
): DocumentData {
  const fields: PlainObject = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omittedKeys.includes(key)) fields[key] = value;
  }
  return encodeMap(fields, "", representations, "reject");
}

export function encodeMergeDocument(record: object, representations: FieldRepresentations): DocumentData {
  return encodeMap({ ...record }, "", representations, "delete");
}

export function encodePatch(
  patch: object,
  representations: FieldRepresentations,
  prefix = "",
): DocumentData {
  const encoded: DocumentData = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = joinPath(prefix, key);
    encoded[path] = isClearField(value) ? FieldValue.delete() : encodeValue(value, path, representations, "reject");
  }
  return encoded;
}

export function decodeValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isPlainObject(value)) {
    const decoded: PlainObject = {};
    for (const [key, item] of Object.entries(value)) decoded[key] = decodeValue(item);
    return decoded;
  }
  return value;
}

export function decodeDocumentData(snapshot: DocumentSnapshot): PlainObject {
  const data = snapshot.data();
  if (data === undefined) throw new TypeError(`${snapshot.ref.path} has no data to decode`);
  return decodeValue(data) as PlainObject;
}

export function formatTimestamp(time: Timestamp): string {
  const secondsIso = new Date(time.seconds * 1000).toISOString();
  return `${secondsIso.slice(0, -4)}${String(time.nanoseconds).padStart(9, "0")}Z`;
}

export function revisionOf(snapshot: DocumentSnapshot): Revision {
  const updateTime = snapshot.updateTime;
  if (updateTime === undefined) throw new TypeError(`${snapshot.ref.path} has no update time; only stored documents carry a revision`);
  return formatTimestamp(updateTime) as Revision;
}

export function watchCursorAt(readTime: Timestamp): WatchCursor {
  return formatTimestamp(readTime) as WatchCursor;
}
