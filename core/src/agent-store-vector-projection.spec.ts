import { describe, expect, it } from "vitest";
import { agentStoreExpressionFingerprint } from "./agent-store-routines.js";
import trusted from "./agent-store-routines.json" with { type: "json" };

const projection = (dimensions: number) => ({
  kind: "default", relname: "memory_index_chunks_vec", name: "embedding_bits",
  definition: "\nCASE\n    WHEN (public.vector_norm(embedding) > (0)::double precision) THEN (public.binary_quantize(embedding))::bit(1536)\n    ELSE NULL::\"bit\"\nEND".replace("bit(1536)", `bit(${dimensions})`),
});
const expected = () => trusted.expressions["default:memory_index_chunks_vec:embedding_bits"];

describe("native memory vector bit projection custody", () => {
  it.each([1, 1536, 3072, 16000])("accepts the native projection at %i dimensions", dimensions => {
    expect(expected()).toContain(agentStoreExpressionFingerprint(projection(dimensions), "tenant"));
  });

  it.each([0, 16001, -1])("refuses an invalid projection dimension %i", dimensions => {
    expect(expected()).not.toContain(agentStoreExpressionFingerprint(projection(dimensions), "tenant"));
  });

  it("refuses changed conditions, functions, source columns and projection identity", () => {
    const original = projection(1536);
    for (const change of [
      { definition: original.definition.replace("(0)", "(1)") },
      { definition: original.definition.replace("public.binary_quantize", "other.binary_quantize") },
      { definition: original.definition.replaceAll("embedding)", "foreign_embedding)") },
      { relname: "other" }, { name: "other" }, { kind: "constraint" },
    ]) expect(expected()).not.toContain(agentStoreExpressionFingerprint({ ...original, ...change }, "tenant"));
  });


});
