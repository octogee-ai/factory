import { describe, expect, it } from "vitest";
import { agentStoreRoutineFingerprint, agentStoreTriggerFingerprint, agentStoreExpressionFingerprint } from "./agent-store-routines.js";
import trusted from "./agent-store-routines.json" with { type: "json" };

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
    const expected = (trusted.expressions as Record<string, string>)[key];
    expect(agentStoreExpressionFingerprint(expression, "tenant")).toBe(expected);
    expect(agentStoreExpressionFingerprint({ ...expression, definition: definition.replace("(store)", "(store_id)") }, "tenant")).not.toBe(expected);
  });

  it.each([1, 1536, 3072, 16000])("accepts the native vector trigger at %i dimensions", dimensions => {
    expect(agentStoreRoutineFingerprint(vectorRoutine(dimensions), "tenant")).toBe(trusted.routines.memory_index_chunks_vec_sync);
  });

  it.each([0, 16001, -1])("rejects an invalid vector dimension %i", dimensions => {
    expect(agentStoreRoutineFingerprint(vectorRoutine(dimensions), "tenant")).not.toBe(trusted.routines.memory_index_chunks_vec_sync);
  });

  it("rejects modified bodies, signatures, settings, and security attributes", () => {
    const routine = vectorRoutine(1536);
    for (const change of [
      { prosrc: `${routine.prosrc}\nPERFORM pg_notify('leak', 'secret');` },
      { proname: "other" }, { arguments: "payload text" }, { result: "text" },
      { prosecdef: true }, { proconfig: ["search_path=other_tenant"] }, { lanname: "sql" },
    ]) expect(agentStoreRoutineFingerprint({ ...routine, ...change }, "tenant")).not.toBe(trusted.routines.memory_index_chunks_vec_sync);
  });

  it("normalizes only the trigger's schema and rejects changes to its target", () => {
    const trigger = {
      tgname: "session_entry_snapshots_after_insert", relname: "session_entry_snapshots",
      definition: "CREATE TRIGGER session_entry_snapshots_after_insert AFTER INSERT ON tenant.session_entry_snapshots FOR EACH ROW EXECUTE FUNCTION tenant.openclaw_session_entry_snapshots_trigger()",
    };
    expect(agentStoreTriggerFingerprint(trigger, "tenant")).toBe(trusted.triggers.session_entry_snapshots_after_insert);
    expect(agentStoreTriggerFingerprint({ ...trigger, relname: "auth_profile_store" }, "tenant")).not.toBe(trusted.triggers.session_entry_snapshots_after_insert);
    expect(agentStoreTriggerFingerprint({ ...trigger, definition: trigger.definition.replaceAll("tenant.", "victim.") }, "tenant")).not.toBe(trusted.triggers.session_entry_snapshots_after_insert);
  });
  it("accepts native defaults and rejects an external or built-in execution payload", () => {
    const expression = { kind: "default", relname: "session_nodes", name: "snapshot_revision", definition: "0" };
    const expected = trusted.expressions["default:session_nodes:snapshot_revision"];
    expect(agentStoreExpressionFingerprint(expression, "tenant")).toBe(expected);
    for (const definition of ["aux.leak()", "pg_notify('leak', 'secret')", "1"]) {
      expect(agentStoreExpressionFingerprint({ ...expression, definition }, "tenant")).not.toBe(expected);
    }
  });

  it("does not mistake a search-path list or $user alias for the literal store schema", () => {
    const routine = {
      ...vectorRoutine(1536), proname: "openclaw_session_conversations_trigger",
      prosrc: "\nBEGIN\n  UPDATE session_conversations SET route_context_json = NULL WHERE session_id = NEW.session_id AND conversation_id = NEW.conversation_id AND role = NEW.role;\n  RETURN NULL;\nEND;\n",
      proconfig: ["search_path=tenant"],
    };
    const expected = trusted.routines.openclaw_session_conversations_trigger;
    expect(agentStoreRoutineFingerprint(routine, "tenant")).toBe(expected);
    for (const [schema, path] of [["tenant, victim", "tenant, victim"], ["$user", '"$user"'], ["CaseTenant", "CaseTenant"]]) {
      expect(agentStoreRoutineFingerprint({ ...routine, proconfig: [`search_path=${path}`] }, schema)).not.toBe(expected);
    }
    expect(agentStoreRoutineFingerprint({ ...routine, proconfig: ['search_path="tenant, victim"'] }, "tenant, victim")).toBe(expected);
  });

});
