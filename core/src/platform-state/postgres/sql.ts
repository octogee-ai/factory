import pg, { type CustomTypesConfig, type QueryConfig, type QueryResultRow } from "pg";

export type Row = Readonly<Record<string, unknown>>;

const INT8_OID = 20;
const JSON_OID = 114;
const JSONB_OID = 3802;

function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new RangeError(`bigint ${text} exceeds the safe integer range`);
  return value;
}

function keepText(text: string): string {
  return text;
}

export const PLATFORM_STATE_TYPES: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8_OID) return parseInt8;
    if (oid === JSON_OID || oid === JSONB_OID) return keepText;
    return format === undefined ? pg.types.getTypeParser(oid) : pg.types.getTypeParser(oid, format);
  }) as CustomTypesConfig["getTypeParser"],
};

const SCHEMA_PLACEHOLDER = "$schema";

export function qualify(text: string, schemaIdentifier: string): string {
  return text.replaceAll(SCHEMA_PLACEHOLDER, schemaIdentifier);
}

export function queryConfig(text: string, schemaIdentifier: string, values: readonly unknown[]): QueryConfig<unknown[]> {
  return { text: qualify(text, schemaIdentifier), values: [...values], types: PLATFORM_STATE_TYPES };
}

export type QueryRunner = (config: QueryConfig<unknown[]>) => Promise<pg.QueryResult<Row & QueryResultRow>>;

export function poolRunner(pool: pg.Pool): QueryRunner {
  return (config) => pool.query<Row & QueryResultRow>(config);
}

export function clientRunner(client: pg.PoolClient): QueryRunner {
  return (config) => client.query<Row & QueryResultRow>(config);
}

export async function runQuery(
  run: QueryRunner,
  schemaIdentifier: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const result = await run(queryConfig(text, schemaIdentifier, values));
  return result.rows;
}

export class SqlParameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return cast === undefined ? `$${this.values.length}` : `$${this.values.length}::${cast}`;
  }
}
