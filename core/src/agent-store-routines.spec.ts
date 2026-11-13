import { describe, expect, it } from "vitest";
import { agentStoreRoutineFingerprint, agentStoreTriggerFingerprint, agentStoreExpressionFingerprint, assertTrustedAgentStoreRoutines, agentStoreExpressionsQuery } from "./agent-store-routines.js";
import trusted from "./agent-store-routines.json" with { type: "json" };

it("allows Native's supported generated-search predecessor before Native upgrades it", async () => {
  const expression = { kind: "default", relname: "session_transcript_fts", name: "openclaw_search",
    definition: "to_tsvector('tenant.openclaw_simple_unaccent'::regconfig, COALESCE(text, ''::text))" };
  await expect(assertTrustedAgentStoreRoutines(acpClient([expression]), "tenant")).resolves.toBeUndefined();
  await expect(assertTrustedAgentStoreRoutines(acpClient([{ ...expression,
    definition: expression.definition.replace("tenant.openclaw_simple_unaccent", "foreign.openclaw_simple_unaccent") }]), "tenant")).rejects.toThrow("untrusted expression");
});

const vectorRoutine = (dimensions: number) => ({
  proname: "memory_index_chunks_vec_sync", arguments: "", result: "trigger", lanname: "plpgsql",
  provolatile: "v", proisstrict: false, prosecdef: false, proparallel: "u", proleakproof: false, proconfig: null,
  prosrc: `
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."embedding" IS NOT DISTINCT FROM NEW."embedding" THEN RETURN NEW; END IF;
  IF octet_length(NEW."embedding") > 0 THEN
    INSERT INTO "memory_index_chunks_vec"(id, embedding) VALUES (NEW."id", openclaw_vector(NEW."embedding", ${dimensions}))
    ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding;
  ELSE
    DELETE FROM "memory_index_chunks_vec" WHERE id = NEW."id";
  END IF;
  RETURN NEW;
END `,
});

describe("trusted agent-store routine definitions", () => {
  it.each([
    { kind: "constraint", definition: "PRIMARY KEY (store)" },
    { kind: "index", definition: "CREATE UNIQUE INDEX openclaw_schema_meta_pkey ON tenant.openclaw_schema_meta USING btree (store)" },
  ])("accepts the Native engine metadata $kind", ({ kind, definition }) => {
    const expression = { kind, relname: "openclaw_schema_meta", name: "openclaw_schema_meta_pkey", definition };
    const key = `${kind}:openclaw_schema_meta:openclaw_schema_meta_pkey`;
    const expected = (trusted.expressions as Record<string, string[]>)[key];
    expect(expected).toContain(agentStoreExpressionFingerprint(expression, "tenant"));
    expect(expected).not.toContain(agentStoreExpressionFingerprint({ ...expression, definition: definition.replace("(store)", "(store_id)") }, "tenant"));
  });

  it.each([
    { relname: "cache_entries", name: "idx_agent_cache_expiry", definition: "CREATE INDEX idx_agent_cache_expiry ON tenant.cache_entries USING btree (scope, expires_at NULLS FIRST, key) WHERE (expires_at IS NOT NULL)" },
    { relname: "session_nodes", name: "idx_agent_session_nodes_archived_at", definition: "CREATE INDEX idx_agent_session_nodes_archived_at ON tenant.session_nodes USING btree (archived_at NULLS FIRST, session_key) WHERE (archived_at IS NOT NULL)" },
    { relname: "session_nodes", name: "idx_agent_session_nodes_label", definition: "CREATE INDEX idx_agent_session_nodes_label ON tenant.session_nodes USING btree (label NULLS FIRST, session_key) WHERE (label IS NOT NULL)" },
    { relname: "session_nodes", name: "idx_agent_session_nodes_status", definition: "CREATE INDEX idx_agent_session_nodes_status ON tenant.session_nodes USING btree (status NULLS FIRST, session_key) WHERE (status IS NOT NULL)" },
    { relname: "session_transcript_active_events", name: "idx_agent_transcript_active_messages", definition: "CREATE UNIQUE INDEX idx_agent_transcript_active_messages ON tenant.session_transcript_active_events USING btree (session_id, message_position NULLS FIRST) WHERE (message_position IS NOT NULL)" },
    { relname: "session_windows", name: "idx_agent_session_windows_conversation", definition: "CREATE INDEX idx_agent_session_windows_conversation ON tenant.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)" },
    { relname: "transcript_event_identities", name: "idx_agent_transcript_message_idempotency", definition: "CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency ON tenant.transcript_event_identities USING btree (session_id, message_idempotency_key NULLS FIRST) WHERE (message_idempotency_key IS NOT NULL)" },
])("accepts native $name null ordering only when its predicate excludes nulls", original => {
    const expression = { ...original, kind: "index" };
    const expected = (trusted.expressions as Record<string, string[]>)[`index:${original.relname}:${original.name}`];
    expect(expected).toContain(agentStoreExpressionFingerprint(expression, "tenant"));
    expect(expected).toContain(agentStoreExpressionFingerprint({ ...expression, definition: original.definition.replace(" NULLS FIRST", "") }, "tenant"));
    for (const change of [
      { definition: original.definition.replace("IS NOT NULL", "IS NULL") },
      { definition: original.definition.replace(/ WHERE .+$/, "") },
      { definition: original.definition.replace(" NULLS FIRST", " DESC NULLS FIRST") },
      { definition: original.definition.replace(" USING btree (", " USING btree (foreign_key, ") },
      { definition: original.definition.replace("tenant.", "victim.") },
      { definition: original.definition.replace(" USING btree (", " USING btree (public.leak(key), ") },
      { kind: "constraint" }, { relname: "other" }, { name: "other" },
    ]) expect(expected).not.toContain(agentStoreExpressionFingerprint({ ...expression, ...change }, "tenant"));
  });

  it.each([1, 1536, 3072, 16000])("accepts the native vector trigger at %i dimensions", dimensions => {
    expect(trusted.routines.memory_index_chunks_vec_sync).toContain(agentStoreRoutineFingerprint(vectorRoutine(dimensions), "tenant"));
  });

  it.each([0, 16001, -1])("rejects an invalid vector dimension %i", dimensions => {
    expect(trusted.routines.memory_index_chunks_vec_sync).not.toContain(agentStoreRoutineFingerprint(vectorRoutine(dimensions), "tenant"));
  });

  it("rejects modified bodies, signatures, settings, and security attributes", () => {
    const routine = vectorRoutine(1536);
    for (const change of [
      { prosrc: `${routine.prosrc}\nPERFORM pg_notify('leak', 'secret');` },
      { proname: "other" }, { arguments: "payload text" }, { result: "text" },
      { prosecdef: true }, { proconfig: ["search_path=other_tenant"] }, { lanname: "sql" },
    ]) expect(trusted.routines.memory_index_chunks_vec_sync).not.toContain(agentStoreRoutineFingerprint({ ...routine, ...change }, "tenant"));
  });

  it("normalizes only the trigger's schema and rejects changes to its target", () => {
    const trigger = {
      tgname: "session_entry_snapshots_after_insert", relname: "session_entry_snapshots",
      definition: "CREATE TRIGGER session_entry_snapshots_after_insert AFTER INSERT ON tenant.session_entry_snapshots FOR EACH ROW EXECUTE FUNCTION tenant.openclaw_session_entry_snapshots_trigger()",
    };
    expect(trusted.triggers.session_entry_snapshots_after_insert).toContain(agentStoreTriggerFingerprint(trigger, "tenant"));
    expect(trusted.triggers.session_entry_snapshots_after_insert).not.toContain(agentStoreTriggerFingerprint({ ...trigger, relname: "auth_profile_store" }, "tenant"));
    expect(trusted.triggers.session_entry_snapshots_after_insert).not.toContain(agentStoreTriggerFingerprint({ ...trigger, definition: trigger.definition.replaceAll("tenant.", "victim.") }, "tenant"));
  });
  it("accepts native defaults and rejects an external or built-in execution payload", () => {
    const expression = { kind: "default", relname: "session_nodes", name: "snapshot_revision", definition: "0" };
    const expected = trusted.expressions["default:session_nodes:snapshot_revision"];
    expect(expected).toContain(agentStoreExpressionFingerprint(expression, "tenant"));
    for (const definition of ["aux.leak()", "pg_notify('leak', 'secret')", "1"]) {
      expect(expected).not.toContain(agentStoreExpressionFingerprint({ ...expression, definition }, "tenant"));
    }
  });

  it("does not mistake a search-path list or $user alias for the literal store schema", () => {
    const routine = {
      ...vectorRoutine(1536), proname: "openclaw_session_conversations_trigger",
      prosrc: "\nBEGIN\n  UPDATE session_conversations SET route_context_json = NULL WHERE session_id = NEW.session_id AND conversation_id = NEW.conversation_id AND role = NEW.role;\n  RETURN NULL;\nEND;\n",
      proconfig: ["search_path=tenant"],
    };
    const expected = trusted.routines.openclaw_session_conversations_trigger;
    expect(expected).toContain(agentStoreRoutineFingerprint(routine, "tenant"));
    for (const [schema, path] of [["tenant, victim", "tenant, victim"], ["$user", '"$user"'], ["CaseTenant", "CaseTenant"]]) {
      expect(expected).not.toContain(agentStoreRoutineFingerprint({ ...routine, proconfig: [`search_path=${path}`] }, schema));
    }
    expect(expected).toContain(agentStoreRoutineFingerprint({ ...routine, proconfig: ['search_path="tenant, victim"'] }, "tenant, victim"));
  });

});

const acpIndex = {kind: "index",relname: "acp_parent_stream_events",name: "idx_agent_acp_parent_stream_run",definition: "CREATE INDEX idx_agent_acp_parent_stream_run ON tenant.acp_parent_stream_events USING btree (run_id NULLS FIRST, seq NULLS FIRST)"};
const acpPrimary = {kind: "constraint",relname: "acp_parent_stream_events",name: "acp_parent_stream_events_pkey",definition: "PRIMARY KEY (session_id, run_id, seq)"};
function acpClient(rows: unknown[]) {
  return { query: async (sql: string) => ({ rows: sql === agentStoreExpressionsQuery ? rows : [] }) } as never;
}
it("accepts Native's supported predecessor index ordering", async () => {
  await expect(assertTrustedAgentStoreRoutines(acpClient([acpPrimary, acpIndex]), "tenant")).resolves.toBeUndefined();
});
it.each(["changed-primary", "sort", "expression", "foreign-schema"])("refuses an altered native index with %s", async changed => {
  const index = { ...acpIndex }, primary = { ...acpPrimary };
  if (changed === "changed-primary") primary.definition = "PRIMARY KEY (session_id)";
  if (changed === "sort") index.definition = index.definition.replace("run_id NULLS FIRST", "run_id DESC NULLS FIRST");
  if (changed === "expression") index.definition = index.definition.replace("run_id NULLS FIRST", "public.leak(run_id) NULLS FIRST");
  if (changed === "foreign-schema") index.definition = index.definition.replace("tenant.", "victim.");
  await expect(assertTrustedAgentStoreRoutines(acpClient([primary, index]), "tenant")).rejects.toThrow();
});

it.each([
  { relname: "board_widgets", name: "idx_agent_board_widgets_tab_position", keys: 'session_key NULLS FIRST, tab_id NULLS FIRST, "position" NULLS FIRST' },
  { relname: "cache_entries", name: "idx_agent_cache_updated", keys: "scope NULLS FIRST, updated_at DESC NULLS LAST, key NULLS FIRST" },
])("accepts Native's declared predecessor $name without reconstructing its schema admission", async fixture => {
  const expression = { kind: "index", relname: fixture.relname, name: fixture.name, definition: `CREATE INDEX ${fixture.name} ON tenant.${fixture.relname} USING btree (${fixture.keys})` };
  await expect(assertTrustedAgentStoreRoutines(acpClient([expression]), "tenant")).resolves.toBeUndefined();
});
