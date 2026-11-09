import { isDeepStrictEqual } from "node:util";
import { FenceMismatchError, MissingRecordError } from "../errors.js";
import { SqlParameters } from "./sql.js";
import { castOf, decodeColumn, encodeColumn, inputContainsServerNow, inputFields, isClearField, revisionOf, } from "./values.js";
export function revisionFence(expected) {
    return expected === undefined ? [] : [{ fence: "revision", expected }];
}
export function equalsFence(fence, spec, expected) {
    return expected === undefined ? [] : [{ fence, column: spec, match: "equals", expected }];
}
export function oneOfFence(fence, spec, expected) {
    return expected === undefined ? [] : [{ fence, column: spec, match: "oneOf", expected }];
}
export function recordKeyOf(target) {
    return { aggregate: target.table.aggregate, key: target.key.map(String).join("/") };
}
function keyValuesOf(table, input) {
    const fields = input;
    return table.keyColumns.map((columnName) => {
        const spec = table.columns.find((candidate) => candidate.column === columnName);
        const value = spec === undefined ? undefined : fields[spec.field];
        if (value === undefined || value === null)
            throw new TypeError(`${table.table} record is missing its key ${columnName}`);
        return value;
    });
}
function keyColumnCast(table, columnName) {
    const spec = table.columns.find((candidate) => candidate.column === columnName);
    return spec === undefined ? "text" : castOf(spec);
}
export function keyPredicate(target, parameters) {
    const { table, key } = target;
    if (key.length !== table.keyColumns.length) {
        throw new TypeError(`${table.table} is keyed by ${table.keyColumns.join(", ")}; got ${key.length} key values`);
    }
    return table.keyColumns
        .map((columnName, index) => `${columnName} = ${parameters.add(key[index], keyColumnCast(table, columnName))}`)
        .join(" AND ");
}
function fencePredicate(check, parameters) {
    if (!("column" in check))
        return `revision::text = ${parameters.add(check.expected, "text")}`;
    const name = check.column.column;
    const cast = castOf(check.column);
    if (check.match === "oneOf") {
        const allowed = check.expected;
        const encoded = check.column.type === "jsonb" ? allowed.map((value) => JSON.stringify(value)) : [...allowed];
        const arrayCast = cast + "[]";
        return `${name} = ANY(${parameters.add(encoded, arrayCast)})`;
    }
    if (check.expected === null) {
        return check.column.type === "jsonb" ? `(${name} IS NULL OR ${name} = 'null'::jsonb)` : `${name} IS NULL`;
    }
    const encoded = check.column.type === "jsonb" ? JSON.stringify(check.expected) : check.expected;
    return `${name} = ${parameters.add(encoded, cast)}`;
}
function actualFenceValue(check, row) {
    if (!("column" in check))
        return revisionOf(row);
    return decodeColumn(check.column, row[check.column.column]);
}
function fenceHolds(check, actual) {
    if (!("column" in check))
        return actual === check.expected;
    if (check.match === "oneOf")
        return check.expected.some((value) => isDeepStrictEqual(value, actual));
    return isDeepStrictEqual(check.expected, actual);
}
async function failFencedMutation(session, operation, target, fences) {
    const record = recordKeyOf(target);
    const parameters = new SqlParameters();
    const columns = new Set(["revision"]);
    for (const check of fences)
        if ("column" in check)
            columns.add(check.column.column);
    const rows = await session.execute(`SELECT ${[...columns].join(", ")} FROM $schema.${target.table.table} WHERE ${keyPredicate(target, parameters)}`, parameters.values);
    if (rows.length === 0)
        throw new MissingRecordError(record);
    for (const check of fences) {
        const actual = actualFenceValue(check, rows[0]);
        if (!fenceHolds(check, actual))
            throw new FenceMismatchError(record, check.fence, check.expected, actual);
    }
    throw new Error(`${operation} found ${record.aggregate} ${record.key} unchanged although every fence holds`);
}
export async function serverNow(session) {
    const rows = await session.execute("SELECT $schema.now_ms() AS now");
    return rows[0].now;
}
export async function selectRecords(session, operation, text, values = []) {
    return session.read(operation, text, values);
}
export async function selectByKey(session, operation, target) {
    const parameters = new SqlParameters();
    const rows = await session.read(operation, `SELECT * FROM $schema.${target.table.table} WHERE ${keyPredicate(target, parameters)}`, parameters.values);
    return rows[0] ?? null;
}
export async function insertRecord(session, operation, table, input, mode) {
    const record = recordKeyOf({ table, key: keyValuesOf(table, input) });
    const entries = inputFields(table, record, input);
    const now = inputContainsServerNow(entries) ? await serverNow(session) : undefined;
    const parameters = new SqlParameters();
    const columns = [];
    const values = [];
    for (const [spec, value] of entries) {
        columns.push(spec.column);
        values.push(encodeColumn(spec, value, parameters, now));
    }
    let conflict = "";
    if (mode === "put") {
        for (const spec of table.columns) {
            if (columns.includes(spec.column))
                continue;
            columns.push(spec.column);
            values.push("DEFAULT");
        }
        const updates = columns.filter((name) => !table.keyColumns.includes(name)).map((name) => `${name} = EXCLUDED.${name}`);
        conflict = ` ON CONFLICT (${table.keyColumns.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
    }
    await session.write(operation, record, `INSERT INTO $schema.${table.table} (${columns.join(", ")}) VALUES (${values.join(", ")})${conflict}`, parameters.values);
}
export async function updateRecord(session, operation, target, patch, fences) {
    const { table } = target;
    const record = recordKeyOf(target);
    const entries = inputFields(table, record, patch);
    const immutableFields = table.immutableFields ?? [];
    const fixed = entries.find(([spec]) => immutableFields.includes(spec.field) || table.keyColumns.includes(spec.column));
    if (fixed !== undefined)
        throw new TypeError(`${operation} cannot change ${fixed[0].field}`);
    const settable = entries.filter(([, value]) => !isClearField(value));
    const now = inputContainsServerNow(settable) ? await serverNow(session) : undefined;
    const parameters = new SqlParameters();
    const assignments = entries.map(([spec, value]) => `${spec.column} = ${isClearField(value) ? "NULL" : encodeColumn(spec, value, parameters, now)}`);
    if (assignments.length === 0)
        assignments.push(`${table.keyColumns[0]} = ${table.keyColumns[0]}`);
    await applyAssignments(session, operation, target, assignments, parameters, fences);
}
// eslint-disable-next-line max-params -- session context, target, column, and fence set are independent inputs
export async function mergeJsonColumn(session, operation, target, spec, additions, fences) {
    const now = inputContainsServerNow([[spec, additions]]) ? await serverNow(session) : undefined;
    const parameters = new SqlParameters();
    const assignment = `${spec.column} = ${spec.column} || ${encodeColumn(spec, additions, parameters, now)}`;
    await applyAssignments(session, operation, target, [assignment], parameters, fences);
}
// eslint-disable-next-line max-params -- session context, target, statement parts, and fence set are independent inputs
async function applyAssignments(session, operation, target, assignments, parameters, fences) {
    const record = recordKeyOf(target);
    const conditions = [keyPredicate(target, parameters), ...fences.map((check) => fencePredicate(check, parameters))];
    const text = `UPDATE $schema.${target.table.table} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING revision`;
    if (fences.length === 0) {
        const rows = await session.write(operation, record, text, parameters.values);
        if (rows.length === 0)
            throw new MissingRecordError(record);
        return;
    }
    await session.atomically(operation, async (fenced) => {
        const rows = await fenced.write(operation, record, text, parameters.values);
        if (rows.length === 0)
            await failFencedMutation(fenced, operation, target, fences);
    });
}
export async function deleteRecord(session, operation, target, fences = []) {
    const record = recordKeyOf(target);
    const parameters = new SqlParameters();
    const conditions = [keyPredicate(target, parameters), ...fences.map((check) => fencePredicate(check, parameters))];
    const text = `DELETE FROM $schema.${target.table.table} WHERE ${conditions.join(" AND ")} RETURNING 1 AS deleted`;
    if (fences.length === 0) {
        await session.write(operation, record, text, parameters.values);
        return;
    }
    await session.atomically(operation, async (fenced) => {
        const rows = await fenced.write(operation, record, text, parameters.values);
        if (rows.length === 0)
            await failFencedMutation(fenced, operation, target, fences);
    });
}
