import { MalformedRecordError } from "../errors.js";
const SQL_CASTS = {
    text: "text",
    bigint: "bigint",
    integer: "integer",
    boolean: "boolean",
    double: "double precision",
    jsonb: "jsonb",
};
const SERVER_NOW_SQL = "$schema.now_ms()";
const IGNORED_INPUT_FIELDS = new Set(["revision"]);
export function snakeCase(field) {
    return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
export function column(field, type, options = {}) {
    return { field, type, column: options.column ?? snakeCase(field), nullAs: options.nullAs ?? "absent" };
}
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
export function containsServerNow(value) {
    if (isServerNow(value))
        return true;
    if (Array.isArray(value))
        return value.some(containsServerNow);
    if (isPlainObject(value))
        return Object.values(value).some(containsServerNow);
    return false;
}
export function resolveJsonValue(value, now, nestedClears, path) {
    if (isServerNow(value)) {
        if (now === undefined)
            throw new TypeError(`${path} holds a server time but none was resolved`);
        return now;
    }
    if (isClearField(value))
        throw new TypeError(`{ clear: true } is only valid at a patch field position; found at ${path}`);
    if (Array.isArray(value))
        return value.map((item, index) => resolveJsonValue(item, now, "reject", `${path}[${index}]`));
    if (isPlainObject(value)) {
        const resolved = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            if (isClearField(item) && nestedClears === "remove")
                continue;
            resolved[key] = resolveJsonValue(item, now, nestedClears, `${path}.${key}`);
        }
        return resolved;
    }
    return value;
}
const COLUMN_VALUE_CHECKS = {
    text: (value) => typeof value === "string",
    bigint: (value) => Number.isSafeInteger(value),
    integer: (value) => Number.isSafeInteger(value),
    double: (value) => typeof value === "number" && Number.isFinite(value),
    boolean: (value) => typeof value === "boolean",
    jsonb: () => true,
};
function assertColumnValue(spec, value) {
    if (!COLUMN_VALUE_CHECKS[spec.type](value))
        throw new TypeError(`${spec.field} must be a ${spec.type} value, got ${JSON.stringify(value)}`);
}
export function encodeColumn(spec, value, parameters, now, nestedClears = "reject") {
    if (value === null)
        return spec.type === "jsonb" ? parameters.add("null", "jsonb") : "NULL";
    if (spec.type === "jsonb") {
        return parameters.add(JSON.stringify(resolveJsonValue(value, now, nestedClears, spec.field)), "jsonb");
    }
    if (isServerNow(value)) {
        if (spec.type !== "bigint")
            throw new TypeError(`${spec.field} is not a time column and cannot take a server time`);
        return now === undefined ? SERVER_NOW_SQL : parameters.add(now, "bigint");
    }
    if (isClearField(value))
        throw new TypeError(`{ clear: true } is only valid at a patch field position; found at ${spec.field}`);
    assertColumnValue(spec, value);
    return parameters.add(value, SQL_CASTS[spec.type]);
}
export function castOf(spec) {
    return SQL_CASTS[spec.type];
}
function columnsByField(table) {
    return new Map(table.columns.map((spec) => [spec.field, spec]));
}
const FIELD_INDEX = new WeakMap();
export function columnFor(table, record, field) {
    let index = FIELD_INDEX.get(table);
    if (index === undefined) {
        index = columnsByField(table);
        FIELD_INDEX.set(table, index);
    }
    const spec = index.get(field);
    if (spec === undefined)
        throw new MalformedRecordError(record, `field ${field} has no column in ${table.table}`);
    return spec;
}
export function assertConstants(table, record, input) {
    for (const [field, expected] of Object.entries(table.constants ?? {})) {
        const actual = input[field];
        if (actual !== undefined && actual !== expected) {
            throw new MalformedRecordError(record, `field ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }
}
export function inputFields(table, record, input) {
    assertConstants(table, record, input);
    const constants = table.constants ?? {};
    const entries = [];
    for (const [field, value] of Object.entries(input)) {
        if (value === undefined || IGNORED_INPUT_FIELDS.has(field) || field in constants)
            continue;
        entries.push([columnFor(table, record, field), value]);
    }
    return entries;
}
export function inputContainsServerNow(entries) {
    return entries.some(([spec, value]) => spec.type === "jsonb" && containsServerNow(value));
}
export function decodeColumn(spec, raw) {
    if (raw === null || raw === undefined)
        return null;
    if (spec.type === "jsonb")
        return JSON.parse(raw);
    return raw;
}
export function revisionOf(row) {
    return String(row.revision);
}
export function decodeRecord(table, row) {
    const record = { ...(table.constants ?? {}) };
    for (const spec of table.columns) {
        const raw = row[spec.column];
        if (raw === null || raw === undefined) {
            if (spec.nullAs === "null")
                record[spec.field] = null;
            continue;
        }
        record[spec.field] = decodeColumn(spec, raw);
    }
    return record;
}
export function decodeStored(table, row) {
    return { ...decodeRecord(table, row), revision: revisionOf(row) };
}
