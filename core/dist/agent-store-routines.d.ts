import { type PoolClient } from "pg";
export declare const agentStoreRoutinesQuery = "SELECT p.proname, pg_catalog.pg_get_function_arguments(p.oid) AS arguments,\n  pg_catalog.pg_get_function_result(p.oid) AS result, l.lanname, p.provolatile, p.proisstrict,\n  p.prosecdef, p.proparallel, p.proleakproof, p.proconfig, p.prosrc\n  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n  JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE n.nspname = $1 ORDER BY p.proname";
type Routine = {
    proname: string;
    arguments: string;
    result: string;
    lanname: string;
    provolatile: string;
    proisstrict: boolean;
    prosecdef: boolean;
    proparallel: string;
    proleakproof: boolean;
    proconfig: string[] | null;
    prosrc: string;
};
export declare function agentStoreRoutineFingerprint(routine: Routine, schema: string): string;
export declare const agentStoreTriggersQuery = "SELECT t.tgname, c.relname, pg_catalog.pg_get_triggerdef(t.oid) AS definition\n  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid\n  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname";
export declare function agentStoreTriggerFingerprint(trigger: {
    tgname: string;
    relname: string;
    definition: string;
}, schema: string): string;
export declare const agentStoreExpressionsQuery = "WITH relations AS (\n  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1)\n  SELECT 'default' AS kind, r.relname, a.attname AS name, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS definition\n    FROM relations r JOIN pg_catalog.pg_attrdef d ON d.adrelid = r.oid JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.adnum\n  UNION ALL SELECT 'constraint', r.relname, c.conname, pg_catalog.pg_get_constraintdef(c.oid)\n    FROM relations r JOIN pg_catalog.pg_constraint c ON c.conrelid = r.oid\n  UNION ALL SELECT 'index', r.relname, i.relname, pg_catalog.pg_get_indexdef(x.indexrelid)\n    FROM relations r JOIN pg_catalog.pg_index x ON x.indrelid = r.oid JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid\n  ORDER BY kind, relname, name";
type Expression = {
    kind: string;
    relname: string;
    name: string;
    definition: string;
};
export declare function agentStoreExpressionFingerprint(expression: Expression, schema: string): string;
export declare function assertTrustedAgentStoreRoutines(client: PoolClient, schema: string): Promise<void>;
export {};
