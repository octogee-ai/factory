import { describe, expect, it } from "vitest";

import {
  agentIdBelongsToSlug,
  catalogEntryForModelRef,
  modelRefForCatalogEntry,
  parseAgentModelSelection,
  parseAgentModelSelections,
  platformModelRefs,
} from "./agent-models";
import { MODEL_CATALOG, modelCatalogEntryFor } from "./model-catalog";

describe("model refs", () => {
  it("anthropic entries ride their catalog id; openrouter/openai ride their platform provider ids", () => {
    expect(
      modelRefForCatalogEntry(modelCatalogEntryFor("anthropic", "anthropic/claude-sonnet-4-6")!),
    ).toBe("anthropic/claude-sonnet-4-6");
    expect(modelRefForCatalogEntry(modelCatalogEntryFor("openrouter", "z-ai/glm-5.2")!)).toBe(
      "platform-openrouter/z-ai/glm-5.2",
    );
    expect(modelRefForCatalogEntry(modelCatalogEntryFor("openai", "gpt-5.4-mini")!)).toBe(
      "platform-openai/gpt-5.4-mini",
    );
  });

  it("round-trips every catalog entry through platformModelRefs", () => {
    const refs = platformModelRefs();
    expect(refs).toHaveLength(MODEL_CATALOG.length);
    for (const ref of refs) {
      expect(catalogEntryForModelRef(ref)).toBeTruthy();
    }
    expect(catalogEntryForModelRef("platform-openrouter/z-ai/glm-5.2")?.label).toBe("GLM 5.2");
    expect(catalogEntryForModelRef("openai/gpt-5.5")).toBeNull();
  });
});

describe("parseAgentModelSelection", () => {
  it("accepts a primary with up to three shape-valid fallbacks", () => {
    expect(
      parseAgentModelSelection({
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: ["anthropic/claude-haiku-4-5"],
      }),
    ).toEqual({
      primary: "platform-openrouter/z-ai/glm-5.2",
      fallbacks: ["anthropic/claude-haiku-4-5"],
    });
    expect(parseAgentModelSelection({ primary: "claude-cli/claude-opus-4-8" })).toEqual({
      primary: "claude-cli/claude-opus-4-8",
      fallbacks: [],
    });
  });

  it("rejects malformed refs, empty primaries, and oversized fallback chains", () => {
    expect(parseAgentModelSelection({ primary: "" })).toBeNull();
    expect(parseAgentModelSelection({ primary: "no-slash" })).toBeNull();
    expect(parseAgentModelSelection({ primary: "bad model/with spaces" })).toBeNull();
    expect(parseAgentModelSelection({ primary: "a/b".padEnd(200, "x") })).toBeNull();
    expect(
      parseAgentModelSelection({
        primary: "anthropic/claude-haiku-4-5",
        fallbacks: ["a/b", "c/d", "e/f", "g/h"],
      }),
    ).toBeNull();
    expect(parseAgentModelSelection(null)).toBeNull();
  });
});

describe("parseAgentModelSelections", () => {
  it("keeps only entries with valid agent ids and selections", () => {
    expect(
      parseAgentModelSelections({
        "octogee-alice-coach": { primary: "anthropic/claude-sonnet-4-6" },
        "octogee-alice-proj-web-coach": {
          primary: "platform-openrouter/minimax/minimax-m3",
          fallbacks: ["anthropic/claude-haiku-4-5"],
        },
        "not an agent id!": { primary: "anthropic/claude-haiku-4-5" },
        "octogee-alice-coach2": "nonsense",
      }),
    ).toEqual({
      "octogee-alice-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
      "octogee-alice-proj-web-coach": {
        primary: "platform-openrouter/minimax/minimax-m3",
        fallbacks: ["anthropic/claude-haiku-4-5"],
      },
    });
    expect(parseAgentModelSelections(undefined)).toEqual({});
  });
});

describe("agentIdBelongsToSlug", () => {
  it("accepts only the slug's coach and project agents", () => {
    expect(agentIdBelongsToSlug("octogee-alice-coach", "alice")).toBe(true);
    expect(agentIdBelongsToSlug("octogee-alice-proj-web-app-coach", "alice")).toBe(true);
    expect(agentIdBelongsToSlug("octogee-bob-coach", "alice")).toBe(false);
    // a hyphenated slug must not be claimable by a prefix slug
    expect(agentIdBelongsToSlug("octogee-alice-smith-coach", "alice")).toBe(false);
    expect(agentIdBelongsToSlug("octogee-alice-smith-coach", "alice-smith")).toBe(true);
    expect(agentIdBelongsToSlug("main", "alice")).toBe(false);
  });
});
