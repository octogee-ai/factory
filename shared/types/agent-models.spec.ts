import { describe, expect, it } from "vitest";

import {
  SIMPLE_MODEL_TIERS,
  SIMPLE_MODEL_TIER_IDS,
  agentIdBelongsToSlug,
  catalogEntryForModelRef,
  modelRefForCatalogEntry,
  parseAgentModelSelection,
  parseAgentModelSelections,
  platformModelRefs,
  simpleModelTierForRef,
} from "./agent-models";
import { MODEL_CATALOG, VERTEX_MODEL_CATALOG, modelCatalogEntryFor } from "./model-catalog";
import { resolveFreeTierModel } from "./platform-config";

describe("model refs", () => {
  it.each(["luna", "sol", "astra"].flatMap((model) => [model, `${model}-pro`]))(
    "keeps GPT-6 %s on the OpenRouter route rather than direct OpenAI",
    (model) => {
      const id = `openai/gpt-6-${model}`;
      const entry = modelCatalogEntryFor("openrouter", id)!;
      const ref = `platform-openrouter/${id}`;
      expect(entry).toBeTruthy();
      expect(modelRefForCatalogEntry(entry)).toBe(ref);
      expect(catalogEntryForModelRef(ref)).toBe(entry);
      expect(platformModelRefs()).toContain(ref);
      expect(parseAgentModelSelection({ primary: ref })).toEqual({ primary: ref, fallbacks: [] });
    },
  );

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

  it("routes vertex entries through the platform-vertex provider without adding them to the picker catalog", () => {
    const entry = modelCatalogEntryFor("vertex", "vertex/claude-sonnet-5")!;
    const ref = "platform-vertex/claude-sonnet-5";
    expect(modelRefForCatalogEntry(entry)).toBe(ref);
    expect(catalogEntryForModelRef(ref)).toBe(entry);
    expect(platformModelRefs()).toContain(ref);
    expect(platformModelRefs()).not.toContain("vertex/claude-sonnet-5");
    expect(MODEL_CATALOG).not.toContain(entry);
    expect(resolveFreeTierModel(ref)).toEqual({ ref, provider: "vertex", upstreamModelId: "claude-sonnet-5" });
  });

  it("round-trips every catalog entry through platformModelRefs", () => {
    const refs = platformModelRefs();
    expect(refs).toHaveLength(MODEL_CATALOG.length + VERTEX_MODEL_CATALOG.length);
    for (const ref of refs) {
      expect(catalogEntryForModelRef(ref)).toBeTruthy();
    }
    expect(catalogEntryForModelRef("platform-openrouter/z-ai/glm-5.2")?.label).toBe("GLM 5.2");
    expect(catalogEntryForModelRef("openai/gpt-5.5")).toBeNull();
  });
});

describe("SIMPLE_MODEL_TIERS", () => {
  it("maps Errands / Everyday / Hard things to the three OpenAI direct platform refs", () => {
    expect(SIMPLE_MODEL_TIER_IDS).toEqual(["errands", "everyday", "hard"]);
    expect(SIMPLE_MODEL_TIERS.errands).toMatchObject({ label: "Errands", ref: "platform-openai/gpt-6-luna" });
    expect(SIMPLE_MODEL_TIERS.everyday).toMatchObject({ label: "Everyday", ref: "platform-openai/gpt-6.1-terra" });
    expect(SIMPLE_MODEL_TIERS.hard).toMatchObject({ label: "Hard things", ref: "platform-openai/gpt-6.1-sol" });
  });

  it("every tier ref is a priced OpenAI catalog entry the picker API accepts", () => {
    for (const id of SIMPLE_MODEL_TIER_IDS) {
      const tier = SIMPLE_MODEL_TIERS[id];
      expect(tier.id).toBe(id);
      expect(tier.description.length).toBeGreaterThan(0);
      expect(platformModelRefs()).toContain(tier.ref);
      const entry = catalogEntryForModelRef(tier.ref);
      expect(entry?.provider).toBe("openai");
      expect(entry?.pricing?.cacheReadPerMTok).toBeGreaterThan(0);
    }
  });

  it("resolves a tier from its ref and null for anything else in the catalog", () => {
    expect(simpleModelTierForRef("platform-openai/gpt-6.1-terra")?.id).toBe("everyday");
    expect(simpleModelTierForRef("platform-openrouter/openai/gpt-6-luna")).toBeNull();
    expect(simpleModelTierForRef("anthropic/claude-haiku-4-5")).toBeNull();
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
