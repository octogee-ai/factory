import { createHash } from "node:crypto";
import pg, { type PoolClient } from "pg";
import trusted from "./agent-store-routines.json" with { type: "json" };

export const agentStoreRoutinesQuery = `SELECT p.proname, pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
  pg_catalog.pg_get_function_result(p.oid) AS result, l.lanname, p.provolatile, p.proisstrict,
  p.prosecdef, p.proparallel, p.proleakproof, p.proconfig, p.prosrc
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE n.nspname = $1 ORDER BY p.proname`;

type Routine = {
  proname: string; arguments: string; result: string; lanname: string; provolatile: string;
  proisstrict: boolean; prosecdef: boolean; proparallel: string; proleakproof: boolean;
  proconfig: string[] | null; prosrc: string;
};

export function agentStoreRoutineFingerprint(routine: Routine, schema: string): string {
  const quotedPath = `search_path=${pg.escapeIdentifier(schema)}`;
  const unquotedPath = /^[a-z_][a-z0-9_$]*$/.test(schema) ? `search_path=${schema}` : null;
  const proconfig = routine.proconfig?.map(setting =>
    schema !== "$user" && schema !== "pg_temp" && (setting === quotedPath || setting === unquotedPath) ? "search_path=$schema" : setting) ?? null;
  const prosrc = routine.proname === "memory_index_chunks_vec_sync"
    ? routine.prosrc.replace(/openclaw_vector\(NEW\."embedding", ([1-9]\d{0,4})\)/g, (call, dimensions: string) =>
      Number(dimensions) <= 16_000 ? 'openclaw_vector(NEW."embedding", $dimensions)' : call)
    : routine.prosrc;
  return createHash("sha256").update(JSON.stringify([routine.proname, routine.arguments, routine.result, routine.lanname, routine.provolatile, routine.proisstrict, routine.prosecdef, routine.proparallel, routine.proleakproof, proconfig, prosrc])).digest("hex");
}

export const agentStoreTriggersQuery = `SELECT t.tgname, c.relname, pg_catalog.pg_get_triggerdef(t.oid) AS definition
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`;

export function agentStoreTriggerFingerprint(trigger: { tgname: string; relname: string; definition: string }, schema: string): string {
  const definition = trigger.definition.replaceAll(`${pg.escapeIdentifier(schema)}.`, "$schema.").replaceAll(`${schema}.`, "$schema.");
  return createHash("sha256").update(JSON.stringify([trigger.tgname, trigger.relname, definition])).digest("hex");
}

export const agentStoreExpressionsQuery = `WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1)
  SELECT 'default' AS kind, r.relname, a.attname AS name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS definition
    FROM relations r JOIN pg_catalog.pg_attrdef d ON d.adrelid = r.oid JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.adnum
  UNION ALL SELECT 'constraint', r.relname, c.conname, pg_catalog.pg_get_constraintdef(c.oid)
    FROM relations r JOIN pg_catalog.pg_constraint c ON c.conrelid = r.oid
  UNION ALL SELECT 'index', r.relname, i.relname, pg_catalog.pg_get_indexdef(x.indexrelid)
    FROM relations r JOIN pg_catalog.pg_index x ON x.indrelid = r.oid JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
  ORDER BY kind, relname, name`;

type Expression = { kind: string; relname: string; name: string; definition: string };

const NULL_EXCLUDED_INDEX_DEFINITIONS = new Set([
  "CREATE INDEX idx_agent_cache_expiry ON $schema.cache_entries USING btree (scope, expires_at NULLS FIRST, key) WHERE (expires_at IS NOT NULL)",
  "CREATE INDEX idx_agent_session_nodes_archived_at ON $schema.session_nodes USING btree (archived_at NULLS FIRST, session_key) WHERE (archived_at IS NOT NULL)",
  "CREATE INDEX idx_agent_session_nodes_label ON $schema.session_nodes USING btree (label NULLS FIRST, session_key) WHERE (label IS NOT NULL)",
  "CREATE INDEX idx_agent_session_nodes_status ON $schema.session_nodes USING btree (status NULLS FIRST, session_key) WHERE (status IS NOT NULL)",
  "CREATE UNIQUE INDEX idx_agent_transcript_active_messages ON $schema.session_transcript_active_events USING btree (session_id, message_position NULLS FIRST) WHERE (message_position IS NOT NULL)",
  "CREATE INDEX idx_agent_session_windows_conversation ON $schema.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)",
  "CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency ON $schema.transcript_event_identities USING btree (session_id, message_idempotency_key NULLS FIRST) WHERE (message_idempotency_key IS NOT NULL)",
]);

export function agentStoreExpressionFingerprint(expression: Expression, schema: string): string {
  let definition = expression.definition.replaceAll(`${pg.escapeIdentifier(schema)}.`, "$schema.").replaceAll(`${schema}.`, "$schema.");
  if (expression.kind === "index" && NULL_EXCLUDED_INDEX_DEFINITIONS.has(definition)) {
    definition = definition.replace(" NULLS FIRST", "");
  }
  if (expression.kind === "default" && expression.relname === "memory_index_chunks_vec" && expression.name === "embedding_bits") {
    definition = definition.replace(/::bit\(([1-9]\d{0,4})\)/g, (cast, dimensions: string) =>
      Number(dimensions) <= 16_000 ? "::bit($dimensions)" : cast);
  }
  return createHash("sha256").update(JSON.stringify([expression.kind, expression.relname, expression.name, definition])).digest("hex");
}

export const agentStoreNonNullColumnsQuery = `SELECT c.relname, a.attname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull`;

function nonNullQualifiedExpression(expression: Expression, columns: Array<{ relname: string; attname: string }>): Expression {
  if (expression.kind !== "index") return expression;
  const nonNull = new Set(columns.filter(column => column.relname === expression.relname).map(column => column.attname));
  const definition = expression.definition.replace(
    /([,(]\s*)("[A-Za-z_]\w*"|[a-z_][a-z0-9_]*)( DESC| ASC)? NULLS (?:FIRST|LAST)(?=\s*[,)])/g,
    (original, prefix: string, identifier: string, direction: string | undefined) => {
      const name = identifier.startsWith('"') ? identifier.slice(1, -1) : identifier;
      return nonNull.has(name) ? prefix + identifier + (direction ?? "") : original;
    },
  );
  return { ...expression, definition };
}

async function assertTrustedTableExpressions(client: PoolClient, schema: string): Promise<void> {
  const expressions = await client.query<Expression>(agentStoreExpressionsQuery, [schema]);
  let nonNull: Array<{ relname: string; attname: string }> | undefined;
  for (const expression of expressions.rows) {
    const key = `${expression.kind}:${expression.relname}:${expression.name}`;
    const expected = (trusted.expressions as Record<string, string>)[key];
    let fingerprint = agentStoreExpressionFingerprint(expression, schema);
    if (expected !== fingerprint && expression.kind === "index") {
      nonNull ??= (await client.query<{ relname: string; attname: string }>(agentStoreNonNullColumnsQuery, [schema])).rows;
      fingerprint = agentStoreExpressionFingerprint(nonNullQualifiedExpression(expression, nonNull), schema);
    }
    if (expected !== fingerprint) {
      throw new Error(`unsafe agent-store schema ${schema}: untrusted expression ${key}`);
    }
  }
  const types = await client.query(`SELECT a.attname FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND tn.nspname <> 'pg_catalog' AND NOT (tn.nspname = 'public' AND t.typname = 'vector' AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e' AND e.extname = 'vector'))
    LIMIT 1`, [schema]);
  if (types.rowCount) throw new Error(`unsafe agent-store schema ${schema}: untrusted column type ${types.rows[0].attname}`);
}

export async function assertTrustedAgentStoreRoutines(client: PoolClient, schema: string): Promise<void> {
  await client.query("SET LOCAL search_path = pg_catalog");
  await assertTrustedTableExpressions(client, schema);
  const { rows } = await client.query<Routine>(agentStoreRoutinesQuery, [schema]);
  for (const routine of rows) {
    if ((trusted.routines as Record<string, string>)[routine.proname] !== agentStoreRoutineFingerprint(routine, schema)) {
      throw new Error(`unsafe agent-store schema ${schema}: untrusted routine ${routine.proname}`);
    }
  }
  const triggers = await client.query<{ tgname: string; relname: string; definition: string }>(agentStoreTriggersQuery, [schema]);
  for (const trigger of triggers.rows) {
    if ((trusted.triggers as Record<string, string>)[trigger.tgname] !== agentStoreTriggerFingerprint(trigger, schema)) {
      throw new Error(`unsafe agent-store schema ${schema}: untrusted trigger ${trigger.tgname}`);
    }
  }
}
