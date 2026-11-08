import pg from "pg";
const INT8_OID = 20;
const JSON_OID = 114;
const JSONB_OID = 3802;
function parseInt8(text) {
    const value = Number(text);
    if (!Number.isSafeInteger(value))
        throw new RangeError(`bigint ${text} exceeds the safe integer range`);
    return value;
}
function keepText(text) {
    return text;
}
export const PLATFORM_STATE_TYPES = {
    getTypeParser: ((oid, format) => {
        if (oid === INT8_OID)
            return parseInt8;
        if (oid === JSON_OID || oid === JSONB_OID)
            return keepText;
        return format === undefined ? pg.types.getTypeParser(oid) : pg.types.getTypeParser(oid, format);
    }),
};
const SCHEMA_PLACEHOLDER = "$schema";
export function qualify(text, schemaIdentifier) {
    return text.replaceAll(SCHEMA_PLACEHOLDER, schemaIdentifier);
}
export function queryConfig(text, schemaIdentifier, values) {
    return { text: qualify(text, schemaIdentifier), values: [...values], types: PLATFORM_STATE_TYPES };
}
export function poolRunner(pool) {
    return (config) => pool.query(config);
}
export function clientRunner(client) {
    return (config) => client.query(config);
}
export async function runQuery(run, schemaIdentifier, text, values = []) {
    const result = await run(queryConfig(text, schemaIdentifier, values));
    return result.rows;
}
export class SqlParameters {
    values = [];
    add(value, cast) {
        this.values.push(value);
        return cast === undefined ? `$${this.values.length}` : `$${this.values.length}::${cast}`;
    }
}
