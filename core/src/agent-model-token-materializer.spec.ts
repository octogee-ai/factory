import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAuthProfileStore,
  writeAuthProfileStore,
} from "./auth-profile-sqlite.js";
import {
  agentModelTokenSecretId,
  OPENROUTER_BROKER_PROVIDER_ID,
  agentModelTokenProfileEntry,
  materializeAnthropicBrokerForAgents,
  materializeBrokerProfilesForAgents,
  upsertOpenRouterBrokerCatalog,
  openRouterBrokerProviderConfig,
  openRouterBrokerModelsJson,
  upsertOpenRouterBrokerModel,
  upsertAnthropicBrokerProfile,
} from "./agent-model-token-materializer.js";

describe("agent-model-token materializer", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-"));
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("creates the anthropic:default broker-token profile on an empty store", () => {
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(true);
    const store = readAuthProfileStore(agentDir) as { profiles: Record<string, unknown> };
    expect(store.profiles["anthropic:default"]).toEqual(
      agentModelTokenProfileEntry("octogee-alice-coach"),
    );
    expect(
      (store.profiles["anthropic:default"] as { keyRef: { id: string } }).keyRef.id,
    ).toBe("agent-model-token-octogee-alice-coach");
  });

  it("MERGES into an existing byosub OAuth store — preserves the OAuth primary and version", () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai-codex": {
          type: "oauth",
          provider: "openai-codex",
          access: "acc",
          refresh: "ref",
          expires: 0,
        },
      },
    });
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-bob-coach")).toBe(true);

    const store = readAuthProfileStore(agentDir) as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(store.version).toBe(1); // top-level preserved
    expect(store.profiles["openai-codex"]).toMatchObject({ type: "oauth", access: "acc" }); // not clobbered
    expect(store.profiles["anthropic:default"]).toEqual(
      agentModelTokenProfileEntry("octogee-bob-coach"),
    );
  });

  it("MERGES alongside a claude-cli OAuth primary (the adjacent anthropic:-keyed profile)", () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "acc",
          refresh: "ref",
          expires: 0,
        },
      },
    });
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-cc-coach")).toBe(true);
    const store = readAuthProfileStore(agentDir) as { profiles: Record<string, unknown> };
    // both anthropic:-keyed profiles coexist — the exact shape the connect path needs
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({ type: "oauth", access: "acc" });
    expect(store.profiles["anthropic:default"]).toEqual(agentModelTokenProfileEntry("octogee-cc-coach"));
  });

  it("is idempotent — a second upsert is a no-op write", () => {
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(true);
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(false);
  });

  it("creates an OpenRouter custom-provider model file backed by the provider-specific broker token", () => {
    expect(agentModelTokenSecretId("octogee-alice-coach", "anthropic")).toBe(
      "agent-model-token-octogee-alice-coach",
    );
    expect(agentModelTokenSecretId("octogee-alice-coach", "openrouter")).toBe(
      "agent-model-token-openrouter-octogee-alice-coach",
    );

    const baseUrl = "http://llm-broker.octogee-test.svc.cluster.local:3010/v1";
    expect(
      upsertOpenRouterBrokerModel(agentDir, "octogee-alice-coach", {
        baseUrl,
        model: "z-ai/glm-5.2",
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))).toEqual(
      openRouterBrokerModelsJson("octogee-alice-coach", {
        baseUrl,
        model: "z-ai/glm-5.2",
      }),
    );
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))),
    ).toContain(`"id":"agent-model-token-openrouter-octogee-alice-coach"`);
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))),
    ).not.toContain("byok-alice-openrouter");
    expect(
      JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[
        OPENROUTER_BROKER_PROVIDER_ID
      ],
    ).toMatchObject({ api: "openai-completions" });
  });

  it("builds the top-level OpenRouter provider config with the live broker token string OpenClaw validates", () => {
    expect(
      openRouterBrokerProviderConfig({
        baseUrl: "http://llm-broker.octogee-test.svc.cluster.local:3010/v1",
        model: "z-ai/glm-5.2",
        apiKey: "octogee-model-token-live",
        contextTokens: 1_048_576,
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "http://llm-broker.octogee-test.svc.cluster.local:3010/v1",
      apiKey: "octogee-model-token-live",
      models: [
        {
          id: "z-ai/glm-5.2",
          name: "z-ai/glm-5.2",
          contextTokens: 1_048_576,
          contextWindow: 1_048_576,
        },
      ],
    });
  });
});

describe("model-readiness: openrouter catalog upsert", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-cat-"));
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const CATALOG = {
    baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    models: [
      { model: "z-ai/glm-5.2", contextTokens: 1_048_576 },
      { model: "minimax/minimax-m3", contextTokens: 524_288 },
    ],
  };

  it("writes ALL catalog models under the platform-openrouter provider with the agent's broker token", () => {
    expect(upsertOpenRouterBrokerCatalog(agentDir, "octogee-a-coach", CATALOG)).toBe(true);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const provider = models.providers[OPENROUTER_BROKER_PROVIDER_ID];
    expect(provider.apiKey.id).toBe("agent-model-token-openrouter-octogee-a-coach");
    expect(provider.models.map((m: { id: string }) => m.id)).toEqual([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
    ]);
  });

  it("is idempotent and preserves sibling custom providers", () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { grok: { api: "openai-completions", baseUrl: "x", models: [] } } }),
    );
    expect(upsertOpenRouterBrokerCatalog(agentDir, "octogee-a-coach", CATALOG)).toBe(true);
    expect(upsertOpenRouterBrokerCatalog(agentDir, "octogee-a-coach", CATALOG)).toBe(false);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    expect(models.providers.grok).toBeTruthy();
    expect(models.providers[OPENROUTER_BROKER_PROVIDER_ID].models).toHaveLength(2);
  });
});

describe("materializeBrokerProfilesForAgents (model-ready boot sweep)", () => {
  let agentsDir: string;
  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-ready-"));
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("asserts BOTH broker provider surfaces per agent — anthropic profile + openrouter catalog", () => {
    const written = materializeBrokerProfilesForAgents(["octogee-a-coach"], {
      agentsDir,
      openRouter: {
        baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
        models: [{ model: "z-ai/glm-5.2", contextTokens: 1_048_576 }],
      },
    });
    expect(written).toBe(1);
    const agentHome = path.join(agentsDir, "octogee-a-coach", "agent");
    const store = readAuthProfileStore(agentHome) as {
      profiles: Record<string, { keyRef: { id: string } }>;
    };
    expect(store.profiles["anthropic:default"].keyRef.id).toBe("agent-model-token-octogee-a-coach");
    const models = JSON.parse(fs.readFileSync(path.join(agentHome, "models.json"), "utf8"));
    expect(models.providers[OPENROUTER_BROKER_PROVIDER_ID].models[0].id).toBe("z-ai/glm-5.2");
  });

  it("falls back to anthropic-only when no openrouter config is supplied", () => {
    expect(materializeBrokerProfilesForAgents(["octogee-a-coach"], { agentsDir })).toBe(1);
    expect(
      fs.existsSync(path.join(agentsDir, "octogee-a-coach", "agent", "models.json")),
    ).toBe(false);
  });
});

describe("materializeAnthropicBrokerForAgents (boot/reconcile sweep)", () => {
  let agentsDir: string;
  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-loop-"));
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("materializes anthropic:default for each agent under agentsDir/<id>/agent", () => {
    expect(
      materializeAnthropicBrokerForAgents(["octogee-a-coach", "octogee-b-coach"], { agentsDir }),
    ).toBe(2);
    const store = readAuthProfileStore(path.join(agentsDir, "octogee-a-coach", "agent")) as {
      profiles: Record<string, { keyRef: { id: string } }>;
    };
    expect(store.profiles["anthropic:default"].keyRef.id).toBe("agent-model-token-octogee-a-coach");
  });

  it("is tolerant — a failure on one agent does not abort the sweep", () => {
    // a path collision (file where the agent dir should be) makes one agent fail
    fs.writeFileSync(path.join(agentsDir, "octogee-bad-coach"), "x");
    expect(
      materializeAnthropicBrokerForAgents(["octogee-good-coach", "octogee-bad-coach"], { agentsDir }),
    ).toBe(1);
  });

  it("skips non-coach agent ids (no broker-token resolver grammar → fail closed)", () => {
    expect(
      materializeAnthropicBrokerForAgents(["octogee-a-coach", "octogee-a-alex", "main"], { agentsDir }),
    ).toBe(1);
    expect(readAuthProfileStore(path.join(agentsDir, "octogee-a-alex", "agent"))).toBeNull();
  });
});

describe("openRouterCatalogInputForBaseUrl", () => {
  it("builds the catalog input from the shared MODEL_CATALOG openrouter entries", async () => {
    const { openRouterCatalogInputForBaseUrl } = await import(
      "./agent-model-token-materializer.js"
    );
    const { modelCatalogForProvider } = await import("@octogee/shared/types/model-catalog");
    const input = openRouterCatalogInputForBaseUrl(
      "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    );
    expect(input.baseUrl).toBe("http://llm-broker.octogee.svc.cluster.local:3010/v1");
    expect(input.models.map((m) => m.model)).toEqual(
      modelCatalogForProvider("openrouter").map((e) => e.id),
    );
    expect(input.models[0]).toEqual({ model: "z-ai/glm-5.2", contextTokens: 1_048_576 });
  });
});
