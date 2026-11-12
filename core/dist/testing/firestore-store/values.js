import { FieldValue, Timestamp } from "firebase-admin/firestore";
export function storedAsTimestamps(...paths) {
    return { timestampPaths: new Set(paths) };
}
export const STORED_AS_NUMBERS = storedAsTimestamps();
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isSoleTrueFlag(value, flag) {
    if (!isPlainObject(value))
        return false;
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === flag && value[flag] === true;
}
export function isServerNow(value) {
    return isSoleTrueFlag(value, "serverNow");
}
export function isClearField(value) {
    return isSoleTrueFlag(value, "clear");
}
function joinPath(parent, key) {
    return parent === "" ? key : `${parent}.${key}`;
}
function encodeValue(value, path, representations, nestedClears) {
    if (isServerNow(value))
        return FieldValue.serverTimestamp();
    if (isClearField(value)) {
        if (nestedClears === "delete")
            return FieldValue.delete();
        throw new TypeError(`{ clear: true } is only valid at a patch field position; found inside ${path}`);
    }
    if (typeof value === "number" && representations.timestampPaths.has(path))
        return Timestamp.fromMillis(value);
    if (Array.isArray(value))
        return value.map((item) => encodeValue(item, path, representations, "reject"));
    if (isPlainObject(value))
        return encodeMap(value, path, representations, nestedClears);
    return value;
}
function encodeMap(map, path, representations, nestedClears) {
    const encoded = {};
    for (const [key, value] of Object.entries(map)) {
        if (value === undefined)
            continue;
        encoded[key] = encodeValue(value, joinPath(path, key), representations, nestedClears);
    }
    return encoded;
}
export function encodeDocument(record, representations, omittedKeys = []) {
    const fields = {};
    for (const [key, value] of Object.entries(record)) {
        if (!omittedKeys.includes(key))
            fields[key] = value;
    }
    return encodeMap(fields, "", representations, "reject");
}
export function encodeMergeDocument(record, representations) {
    return encodeMap({ ...record }, "", representations, "delete");
}
export function encodePatch(patch, representations, prefix = "") {
    const encoded = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        const path = joinPath(prefix, key);
        encoded[path] = isClearField(value) ? FieldValue.delete() : encodeValue(value, path, representations, "reject");
    }
    return encoded;
}
export function decodeValue(value) {
    if (value instanceof Timestamp)
        return value.toMillis();
    if (Array.isArray(value))
        return value.map(decodeValue);
    if (isPlainObject(value)) {
        const decoded = {};
        for (const [key, item] of Object.entries(value))
            decoded[key] = decodeValue(item);
        return decoded;
    }
    return value;
}
export function decodeDocumentData(snapshot) {
    const data = snapshot.data();
    if (data === undefined)
        throw new TypeError(`${snapshot.ref.path} has no data to decode`);
    return decodeValue(data);
}
export function formatTimestamp(time) {
    const secondsIso = new Date(time.seconds * 1000).toISOString();
    return `${secondsIso.slice(0, -4)}${String(time.nanoseconds).padStart(9, "0")}Z`;
}
export function revisionOf(snapshot) {
    const updateTime = snapshot.updateTime;
    if (updateTime === undefined)
        throw new TypeError(`${snapshot.ref.path} has no update time; only stored documents carry a revision`);
    return formatTimestamp(updateTime);
}
export function watchCursorAt(readTime) {
    return formatTimestamp(readTime);
}
