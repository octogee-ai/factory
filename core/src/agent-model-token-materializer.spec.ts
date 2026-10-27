import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatewayRpc } from "./gateway-rpc.js";
import { readAuthProfileStore, writeAuthProfileStore } from "./auth-profile-sqlite.js";
import { OpenClawSecretsApplyError, type OpenClawSecretsPlan } from "./openclaw-secrets-apply.js";
import {
  agentModelTokenSecretId,
  OPENAI_BROKER_PROVIDER_ID,
  OPENAI_BROKER_PROFILE_ID,
  OPENROUTER_BROKER_PROVIDER_ID,
  OPENROUTER_BROKER_PROFILE_ID,
  agentModelTokenProfileEntry,
  materializeBrokerProfilesForAgents,
  missingPlatformBrokerProfileTargets,
  openAiCatalogInputForBaseUrl,
  openRouterCatalogInputForBaseUrl,
  platformBrokerProfileTargets,
  upsertOpenAiBrokerCatalog,
  upsertOpenRouterBrokerCatalog,
  openRouterBrokerModelConfig,
  openRouterBrokerProviderConfig,
  openRouterBrokerModelsJson,
  upsertOpenRouterBrokerModel,
} from "./agent-model-token-materializer.js";
import {
  seedOpenClawAgentDb,
  seedOpenClawAgentDbForId,
} from "./fixtures/openclaw-agent-db.js";

const liveGateway = vi.hoisted(() => ({
  brokerProfilesMaterialize: vi.fn(async (_params: { agentIds: string[] }) => ({ ok: true as const })),
  close: vi.fn(async () => undefined),
}));
vi.mock("./gateway-rpc.js", () => ({ createGatewayRpc: vi.fn(() => liveGateway) }));

const ALL_SURFACES = { openRouter: true, openAi: true };

function fakeSecretsApply(agentsDir: string, opts: { fail?: boolean } = {}) {
  const plans: unknown[] = [];
  const apply = vi.fn(async (plan: OpenClawSecretsPlan) => {
    plans.push(plan);
    if (opts.fail) throw new OpenClawSecretsApplyError("secret provider unavailable", 1);
    for (const target of plan.targets) {
      const agentDir = path.join(agentsDir, target.agentId, "agent");
      const store = (readAuthProfileStore(agentDir) ?? {}) as Record<string, unknown>;
      const profiles = (store.profiles ?? {}) as Record<string, unknown>;
      const profileId = target.path.replace(/^profiles\./, "").replace(/\.key$/, "");
      profiles[profileId] = {
        type: "api_key",
        provider: target.authProfileProvider,
        keyRef: { source: "exec", provider: "gcp-secret-manager", id: target.ref.id },
        key: "resolved-by-openclaw",
      };
      writeAuthProfileStore(agentDir, { ...store, profiles });
    }
    return { mode: "write", changed: true };
  });
  return { plans, secretsApply: { apply }, apply };
}

describe("hot broker profile materialization", () => {
  it("uses the running Gateway owner when the offline CLI cannot acquire its database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-hot-broker-profile-"));
    const previousPath = process.env.PATH;
    try {
      const agentsDir = path.join(root, "agents");
      const agentId = "octogee-alice-coach";
      seedOpenClawAgentDbForId(agentsDir, agentId);
      const cliMarker = path.join(root, "offline-cli-used");
      fs.writeFileSync(path.join(root, "openclaw"), `#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(cliMarker)}, "called"); process.stdout.write(JSON.stringify({ok:false,error:{message:"OpenClaw state database is busy; a running Gateway owns it"}})); process.exitCode=1;\n`, { mode: 0o700 });
      process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
      liveGateway.brokerProfilesMaterialize.mockClear();
      liveGateway.close.mockClear();
      const result = await materializeBrokerProfilesForAgents([agentId], { agentsDir });
      expect(result.deferred).toEqual([]);
      expect(liveGateway.brokerProfilesMaterialize).toHaveBeenCalledExactlyOnceWith({ agentIds: [agentId] });
      expect(liveGateway.close).toHaveBeenCalledOnce();
      expect(createGatewayRpc).toHaveBeenCalledWith({ allowLegacyGatewayTokenFallback: true });
      expect(fs.existsSync(cliMarker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("platform broker profile targets", () => {
  it("addresses one api_key target per configured surface, each on its own broker-token ref", () => {
    expect(platformBrokerProfileTargets("octogee-alice-coach", ALL_SURFACES)).toEqual([
      {
        type: "auth-profiles.api_key.key",
        path: "profiles.anthropic:default.key",
        ref: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-model-token-octogee-alice-coach",
        },
        agentId: "octogee-alice-coach",
        authProfileProvider: "anthropic",
      },
      {
        type: "auth-profiles.api_key.key",
        path: `profiles.${OPENROUTER_BROKER_PROFILE_ID}.key`,
        ref: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-model-token-openrouter-octogee-alice-coach",
        },
        agentId: "octogee-alice-coach",
        authProfileProvider: OPENROUTER_BROKER_PROVIDER_ID,
      },
      {
        type: "auth-profiles.api_key.key",
        path: `profiles.${OPENAI_BROKER_PROFILE_ID}.key`,
        ref: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-model-token-openai-octogee-alice-coach",
        },
        agentId: "octogee-alice-coach",
        authProfileProvider: OPENAI_BROKER_PROVIDER_ID,
      },
    ]);
  });

  it("omits a surface this pod does not carry — an unresolvable ref colds the whole exec batch", () => {
    expect(
      platformBrokerProfileTargets("octogee-alice-coach", {
        openRouter: false,
        openAi: false,
      }).map((target) => target.authProfileProvider),
    ).toEqual(["anthropic"]);
  });
});

describe("missingPlatformBrokerProfileTargets", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-"));
    seedOpenClawAgentDb(agentDir);
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("reports every profile when the store is empty", async () => {
    expect(
      (await missingPlatformBrokerProfileTargets(agentDir, "octogee-alice-coach", ALL_SURFACES)),
    ).toHaveLength(3);
  });

  it("reports every profile when openclaw has not created the store at all", async () => {
    const fresh = path.join(agentDir, "never-booted");
    expect(
      (await missingPlatformBrokerProfileTargets(fresh, "octogee-alice-coach", ALL_SURFACES)),
    ).toHaveLength(3);
  });

  it("settles on an applied keyRef without requiring a plaintext key", async () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          keyRef: agentModelTokenProfileEntry("octogee-alice-coach").keyRef,
        },
      },
    });

    expect(
      (await missingPlatformBrokerProfileTargets(agentDir, "octogee-alice-coach", {
        openRouter: false,
        openAi: false,
      })),
    ).toEqual([]);
  });

  it("still reports a profile pinned to another agent's broker token", async () => {
    writeAuthProfileStore(agentDir, {
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          keyRef: agentModelTokenProfileEntry("octogee-bob-coach").keyRef,
        },
      },
    });

    expect(
      (await missingPlatformBrokerProfileTargets(agentDir, "octogee-alice-coach", {
        openRouter: false,
        openAi: false,
      })),
    ).toHaveLength(1);
  });

  it("leaves a byosub OAuth primary alone — it is not one of ours to assert", async () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai-codex": { type: "oauth", provider: "openai-codex", access: "acc" },
      },
    });

    expect(
      (await missingPlatformBrokerProfileTargets(agentDir, "octogee-alice-coach", {
        openRouter: false,
        openAi: false,
      })).map((target) => target.path),
    ).toEqual(["profiles.anthropic:default.key"]);
  });
});

describe("agent-model-token catalogs", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-cat0-"));
    seedOpenClawAgentDb(agentDir);
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
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
      upsertOpenRouterBrokerModel(agentDir, {
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
    ).not.toContain("apiKey");
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))),
    ).not.toContain("byok-alice-openrouter");
    expect(
      JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[
        OPENROUTER_BROKER_PROVIDER_ID
      ],
    ).toMatchObject({ api: "openai-completions" });
  });

  it("writes no auth-profile row of its own — only openclaw writes that store", () => {
    upsertOpenRouterBrokerModel(agentDir, {
      baseUrl: "http://llm-broker:3010/v1",
      model: "z-ai/glm-5.2",
    });

    expect(readAuthProfileStore(agentDir)).toBeNull();
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

describe("model-readiness: image input", () => {
  it("declares image input for vision models so OpenClaw offers the computer tool", () => {
    expect(openRouterBrokerModelConfig({ model: "openai/gpt-5.6-luna", contextTokens: 1_050_000, input: ["text", "image"] }))
      .toEqual({
        id: "openai/gpt-5.6-luna",
        name: "openai/gpt-5.6-luna",
        contextTokens: 1_050_000,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      });
    expect(openRouterBrokerModelConfig({ model: "z-ai/glm-5.2" })).not.toHaveProperty("input");
    expect(openRouterCatalogInputForBaseUrl("http://broker/v1").models.find((m) => m.model === "openai/gpt-5.6-luna"))
      .toMatchObject({ input: ["text", "image"] });
    expect(openAiCatalogInputForBaseUrl("http://broker/v1").models.find((m) => m.model === "gpt-5.4-mini"))
      .toMatchObject({ input: ["text", "image"] });
  });
});

describe("model-readiness: openrouter catalog upsert", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-cat-"));
    seedOpenClawAgentDb(agentDir);
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

  it("writes all OpenRouter catalog models without embedding credential data", () => {
    expect(upsertOpenRouterBrokerCatalog(agentDir, CATALOG)).toBe(true);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const provider = models.providers[OPENROUTER_BROKER_PROVIDER_ID];
    expect(provider).toMatchObject({
      api: "openai-completions",
      baseUrl: CATALOG.baseUrl,
      models: [
        {
          id: "z-ai/glm-5.2",
          name: "z-ai/glm-5.2",
          contextTokens: 1_048_576,
          contextWindow: 1_048_576,
        },
        {
          id: "minimax/minimax-m3",
          name: "minimax/minimax-m3",
          contextTokens: 524_288,
          contextWindow: 524_288,
        },
      ],
    });
  });

  it("is idempotent and preserves sibling custom providers", () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { grok: { api: "openai-completions", baseUrl: "x", models: [] } } }),
    );
    expect(upsertOpenRouterBrokerCatalog(agentDir, CATALOG)).toBe(true);
    expect(upsertOpenRouterBrokerCatalog(agentDir, CATALOG)).toBe(false);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    expect(models.providers.grok).toBeTruthy();
    expect(models.providers[OPENROUTER_BROKER_PROVIDER_ID].models).toHaveLength(2);
  });
});

describe("model-readiness: openai catalog upsert", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-oai-"));
    seedOpenClawAgentDb(agentDir);
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const CATALOG = {
    baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    models: [{ model: "gpt-5.4-mini", contextTokens: 400_000 }],
  };

  it("writes OpenAI catalog models without embedding credential data", () => {
    expect(upsertOpenAiBrokerCatalog(agentDir, CATALOG)).toBe(true);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const provider = models.providers[OPENAI_BROKER_PROVIDER_ID];
    expect(provider.api).toBe("openai-responses");
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider.models.map((m: { id: string }) => m.id)).toEqual(["gpt-5.4-mini"]);
  });

  it("coexists with the platform-openrouter provider entry", () => {
    upsertOpenRouterBrokerCatalog(agentDir, {
      baseUrl: CATALOG.baseUrl,
      models: [{ model: "z-ai/glm-5.2", contextTokens: 1_048_576 }],
    });
    expect(upsertOpenAiBrokerCatalog(agentDir, CATALOG)).toBe(true);
    expect(upsertOpenAiBrokerCatalog(agentDir, CATALOG)).toBe(false);
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    expect(models.providers[OPENROUTER_BROKER_PROVIDER_ID]).toBeTruthy();
    expect(models.providers[OPENAI_BROKER_PROVIDER_ID]).toBeTruthy();
  });
});

describe("openAiCatalogInputForBaseUrl", () => {
  it("builds the catalog input from the shared MODEL_CATALOG openai entries", () => {
    const input = openAiCatalogInputForBaseUrl(
      "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    );
    expect(input.models).toContainEqual({ model: "gpt-5.4-mini", contextTokens: 400_000, input: ["text", "image"] });
    expect(input.models).toContainEqual({ model: "gpt-6-astra", contextTokens: 1_050_000, input: ["text", "image"], maxOutputTokens: 128_000, reasoning: true });
    expect(openRouterBrokerModelConfig(input.models.find((model) => model.model === "gpt-6-astra")!))
      .toMatchObject({ id: "gpt-6-astra", contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true });
  });
});

describe("materializeBrokerProfilesForAgents (model-ready sweep)", () => {
  let agentsDir: string;
  const openRouter = {
    baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    models: [{ model: "z-ai/glm-5.2", contextTokens: 1_048_576 }],
  };
  const openAi = {
    baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    models: [{ model: "gpt-5.4-mini", contextTokens: 400_000 }],
  };

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-ready-"));
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("hands every profile to openclaw's secrets apply and writes both catalogs itself", async () => {
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");
    const { plans, secretsApply, apply } = fakeSecretsApply(agentsDir);

    const written = await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      openAi,
      secretsApply,
    });

    expect(written.materialized).toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(plans).toEqual([
      expect.objectContaining({
        generatedBy: "manual",
        targets: platformBrokerProfileTargets("octogee-alice-coach", ALL_SURFACES),
      }),
    ]);
    const agentHome = path.join(agentsDir, "octogee-alice-coach", "agent");
    const models = JSON.parse(fs.readFileSync(path.join(agentHome, "models.json"), "utf8"));
    expect(models.providers[OPENROUTER_BROKER_PROVIDER_ID].models[0].id).toBe("z-ai/glm-5.2");
    expect(models.providers[OPENAI_BROKER_PROVIDER_ID].models[0].id).toBe("gpt-5.4-mini");
  });

  it("hands a large roster to openclaw in one bounded plan with one target per credential identity", async () => {
    const agentIds = Array.from({ length: 40 }, (_, index) => `octogee-user${index}-coach`);
    for (const agentId of agentIds) seedOpenClawAgentDbForId(agentsDir, agentId);
    const { plans, secretsApply, apply } = fakeSecretsApply(agentsDir);

    const result = await materializeBrokerProfilesForAgents(
      [...agentIds, agentIds[0], agentIds[1]],
      {
        agentsDir,
        openRouter,
        openAi,
        secretsApply,
      },
    );

    expect(apply).toHaveBeenCalledOnce();
    expect(plans).toHaveLength(1);
    const targets = (plans[0] as {
      targets: Array<{ agentId: string; ref: { id: string } }>;
    }).targets;
    expect(targets).toHaveLength(agentIds.length * 3);
    expect(new Set(targets.map((target) => `${target.agentId}:${target.ref.id}`))).toHaveLength(
      targets.length,
    );
    expect(result).toEqual({ materialized: agentIds.length, deferred: [] });
  }, 30_000);

  it("defers only the refused agent when openclaw rejects the batched apply", async () => {
    const agentIds = ["octogee-alice-coach", "octogee-bob-coach", "octogee-carol-coach"];
    for (const agentId of agentIds) seedOpenClawAgentDbForId(agentsDir, agentId);
    const good = fakeSecretsApply(agentsDir);
    const secretsApply = {
      apply: vi.fn(async (plan: OpenClawSecretsPlan) => {
        if (plan.targets.some((target) => target.agentId === "octogee-bob-coach")) {
          throw new OpenClawSecretsApplyError(
            'Exec provider "gcp-secret-manager" failed for id "agent-model-token-octogee-bob-coach".',
            1,
          );
        }
        return good.apply(plan);
      }),
    };
    const logs: string[] = [];

    const result = await materializeBrokerProfilesForAgents(agentIds, {
      agentsDir,
      openRouter,
      secretsApply,
      logFn: (message) => logs.push(message),
    });

    expect(result.deferred).toEqual(["octogee-bob-coach"]);
    expect(result.deferralReason).toContain("agent-model-token-octogee-bob-coach");
    expect(secretsApply.apply).toHaveBeenCalledTimes(1 + agentIds.length);
    const reported = Object.fromEntries(logs
      .map((line) => /model-ready: (\S+) \(profiles (\w+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], match[2]]));
    expect(reported).toEqual({
      "octogee-alice-coach": "applied",
      "octogee-bob-coach": "deferred",
      "octogee-carol-coach": "applied",
    });
    for (const agentId of ["octogee-alice-coach", "octogee-carol-coach"]) {
      const store = readAuthProfileStore(path.join(agentsDir, agentId, "agent")) as {
        profiles?: Record<string, unknown>;
      };
      expect(Object.keys(store.profiles ?? {}).length).toBeGreaterThan(0);
    }
    expect(logs.some((line) => line.includes("octogee-bob-coach") && line.includes("deferred"))).toBe(true);
  });

  it("counts only the agents whose own apply landed when no catalog is configured", async () => {
    const agentIds = ["octogee-alice-coach", "octogee-bob-coach"];
    for (const agentId of agentIds) seedOpenClawAgentDbForId(agentsDir, agentId);
    const good = fakeSecretsApply(agentsDir);
    const secretsApply = {
      apply: vi.fn(async (plan: OpenClawSecretsPlan) => {
        if (plan.targets.some((target) => target.agentId === "octogee-bob-coach")) {
          throw new OpenClawSecretsApplyError("refused bob", 1);
        }
        return good.apply(plan);
      }),
    };

    const result = await materializeBrokerProfilesForAgents(agentIds, { agentsDir, secretsApply });

    expect(result).toEqual({
      materialized: 1,
      deferred: ["octogee-bob-coach"],
      deferralReason: "refused bob",
    });
  });

  it("defers every affected agent when the batched apply fails unexpectedly", async () => {
    const agentIds = ["octogee-alice-coach", "octogee-bob-coach"];
    for (const agentId of agentIds) seedOpenClawAgentDbForId(agentsDir, agentId);
    const logs: string[] = [];
    const secretsApply = {
      apply: vi.fn(async () => {
          throw new Error("apply bug");
      }),
    };

    const result = await materializeBrokerProfilesForAgents(agentIds, {
      agentsDir,
      openRouter,
      secretsApply,
      logFn: (message) => logs.push(message),
    });

    expect(result).toEqual({
      materialized: agentIds.length,
      deferred: agentIds,
      deferralReason: "apply bug",
    });
    expect(logs).toContain(
      "⚠ [agent-model-token] model-ready secrets apply failed: apply bug",
    );
  });

  it("never writes the auth-profile store itself", async () => {
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");
    const secretsApply = {
      apply: vi.fn(async () => ({ mode: "write", changed: true })),
    };

    await materializeBrokerProfilesForAgents(["octogee-alice-coach"], { agentsDir, secretsApply });

    expect(
      readAuthProfileStore(path.join(agentsDir, "octogee-alice-coach", "agent")),
    ).toBeNull();
  });

  it("stops calling the gateway once every profile has settled", async () => {
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");
    const { secretsApply, apply } = fakeSecretsApply(agentsDir);

    await materializeBrokerProfilesForAgents(["octogee-alice-coach"], { agentsDir, openRouter, secretsApply });
    const settled = await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      secretsApply,
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(settled).toEqual({ materialized: 0, deferred: [] });
  });

  it("falls back to the anthropic profile alone when no catalog is configured", async () => {
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");
    const { plans, secretsApply } = fakeSecretsApply(agentsDir);

    expect(
      (await materializeBrokerProfilesForAgents(["octogee-alice-coach"], { agentsDir, secretsApply }))
        .materialized,
    ).toBe(1);

    expect((plans[0] as { targets: unknown[] }).targets).toEqual(
      platformBrokerProfileTargets("octogee-alice-coach", { openRouter: false, openAi: false }),
    );
    expect(fs.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent", "models.json"))).toBe(
      false,
    );
  });

  it("skips non-coach agent ids (no broker-token resolver grammar → fail closed)", async () => {
    const { secretsApply, apply } = fakeSecretsApply(agentsDir);
    const logFn = vi.fn();
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");

    await materializeBrokerProfilesForAgents(
      ["octogee-alice-coach", "octogee-unmatched-route", "octogee-alice-alex", "main"],
      { agentsDir, secretsApply, logFn },
    );

    expect(apply).toHaveBeenCalledOnce();
    expect(
      readAuthProfileStore(path.join(agentsDir, "octogee-alice-alex", "agent")),
    ).toBeNull();
    expect(logFn.mock.calls.flat().join("\n")).not.toContain("octogee-unmatched-route");
    expect(logFn.mock.calls.flat().join("\n")).toContain("octogee-alice-alex");
    expect(logFn.mock.calls.flat().join("\n")).toContain("main");
  });

  it("is tolerant — one agent's failure does not abort the sweep", async () => {
    seedOpenClawAgentDbForId(agentsDir, "octogee-good-coach");
    fs.writeFileSync(path.join(agentsDir, "octogee-bad-coach"), "x");
    const { secretsApply } = fakeSecretsApply(agentsDir);

    const result = await materializeBrokerProfilesForAgents(
      ["octogee-good-coach", "octogee-bad-coach"],
      { agentsDir, openRouter, secretsApply },
    );

    expect(result.materialized).toBe(1);
  });

  it("materializes bound broker profiles and catalogs for a canonical project agent", async () => {
    const agentId = "octogee-alice-proj-garden-coach";
    seedOpenClawAgentDbForId(agentsDir, agentId);
    const { plans, secretsApply } = fakeSecretsApply(agentsDir);

    const written = await materializeBrokerProfilesForAgents([agentId], {
      agentsDir,
      openRouter,
      secretsApply,
    });

    expect(written.materialized).toBe(1);
    expect((plans[0] as { targets: unknown[] }).targets).toEqual(
      platformBrokerProfileTargets(agentId, { openRouter: true, openAi: false }),
    );
    const store = readAuthProfileStore(path.join(agentsDir, agentId, "agent")) as {
      profiles: Record<string, { keyRef: { id: string } }>;
    };
    expect(store.profiles["anthropic:default"].keyRef.id).toBe(
      `agent-model-token-${agentId}`,
    );
    expect(store.profiles["platform-openrouter:default"].keyRef.id).toBe(
      `agent-model-token-openrouter-${agentId}`,
    );
  });
});

describe("model-readiness before openclaw can accept the plan", () => {
  const openRouter = {
    baseUrl: "http://llm-broker.octogee.svc.cluster.local:3010/v1",
    models: [{ model: "z-ai/glm-5.2", contextTokens: 1_048_576 }],
  };
  let agentsDir: string;
  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-nodb-"));
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  const modelsJson = (): { providers: Record<string, { models: { id: string }[] }> } =>
    JSON.parse(
      fs.readFileSync(path.join(agentsDir, "octogee-alice-coach", "agent", "models.json"), "utf8"),
    );

  it("writes the platform-openrouter catalog even though the apply is refused", async () => {
    const { secretsApply } = fakeSecretsApply(agentsDir, { fail: true });

    await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      secretsApply,
    });

    expect(modelsJson().providers[OPENROUTER_BROKER_PROVIDER_ID].models[0].id).toBe("z-ai/glm-5.2");
  });

  it("returns the agent as deferred with the gateway's own reason instead of silently dropping it", async () => {
    const logs: string[] = [];
    const { secretsApply } = fakeSecretsApply(agentsDir, { fail: true });

    const result = await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      secretsApply,
      logFn: (m) => logs.push(m),
    });

    expect(result.deferred).toEqual(["octogee-alice-coach"]);
    // the catalog DID land — only the profiles deferred
    expect(result.materialized).toBe(1);
    expect(result.deferralReason).toContain("secret provider unavailable");
    // The reason must NOT be logged here: this sweep is level-triggered, and a
    // per-agent line would reprint every tick forever.
    expect(logs.join("\n")).not.toContain("secret provider unavailable");
  });

  it("applies the profiles on a retry once openclaw can accept them", async () => {
    const failing = fakeSecretsApply(agentsDir, { fail: true });
    await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      secretsApply: failing.secretsApply,
    });
    seedOpenClawAgentDbForId(agentsDir, "octogee-alice-coach");
    const { secretsApply } = fakeSecretsApply(agentsDir);

    const retry = await materializeBrokerProfilesForAgents(["octogee-alice-coach"], {
      agentsDir,
      openRouter,
      secretsApply,
    });

    expect(retry.deferred).toEqual([]);
    expect(retry.materialized).toBe(1);
    expect(
      (await missingPlatformBrokerProfileTargets(
        path.join(agentsDir, "octogee-alice-coach", "agent"),
        "octogee-alice-coach",
        { openRouter: true, openAi: false },
      )),
    ).toEqual([]);
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
    expect(input.models).toContainEqual(expect.objectContaining({ model: "z-ai/glm-5.2", contextTokens: 1_048_576 }));
    expect(input.models).toContainEqual(expect.objectContaining({
      model: "openai/gpt-5.6-luna",
      contextTokens: 1_050_000,
      input: ["text", "image"],
    }));
    for (const model of ["luna", "sol", "astra"]) {
      expect(input.models).toContainEqual(expect.objectContaining({
        model: `openai/gpt-6-${model}`,
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
      }));
    }
  });
});


describe("broker catalogs leave credential ownership to native profiles", () => {
  it.each([
    ["platform-openrouter", upsertOpenRouterBrokerCatalog],
    ["platform-openai", upsertOpenAiBrokerCatalog],
  ] as const)("removes the obsolete %s credential marker while preserving unrelated providers", (provider, upsert) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-authless-catalog-"));
    try {
      const foreign = { apiKey: "user-owned-key", models: [{ id: "user-owned-model" }] };
      const file = path.join(agentDir, "models.json");
      fs.writeFileSync(file, JSON.stringify({ providers: { [provider]: { apiKey: provider + ":default", models: [] }, foreign } }));
      upsert(agentDir, { baseUrl: "http://broker.invalid/v1", models: [{ model: "catalog-model" }] });
      const providers = JSON.parse(fs.readFileSync(file, "utf8")).providers;
      expect(providers[provider]).not.toHaveProperty("apiKey");
      expect(providers.foreign).toEqual(foreign);
    } finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
  });
});
