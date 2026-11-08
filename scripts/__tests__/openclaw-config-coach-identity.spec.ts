import { describe, it, expect } from "vitest";
import {
  buildCustomerAgent,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  resolveCoachIdentity,
  type CustomerAgentInput,
} from "../lib/openclaw-config-builders.js";

const DEFAULT_COACH = { name: "Octo", emoji: "🐙", model: "platform-openrouter/z-ai/glm-5.2" };

function mkCustomer(overrides: Partial<CustomerAgentInput> = {}): CustomerAgentInput {
  return {
    uid: "uid-chris",
    slug: "chris-builds-a3f2",
    customerDir: "/home/node/.openclaw/customers/chris-builds-a3f2",
    agentDir: "/home/node/.openclaw/agents/octogee-chris-builds-a3f2-coach/agent",
    coach: DEFAULT_COACH,
    ...overrides,
  };
}

describe("resolveCoachIdentity", () => {
  const DEFAULTS = { name: "Octo", emoji: "🐙" };

  it("returns defaults when custom is undefined", () => {
    expect(resolveCoachIdentity(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("uses the customized name + emoji when both are set", () => {
    expect(
      resolveCoachIdentity({ name: "Scout", emoji: "🧠" }, DEFAULTS),
    ).toEqual({ name: "Scout", emoji: "🧠" });
  });

  it("falls back to default emoji when only name is customized", () => {
    expect(
      resolveCoachIdentity({ name: "Scout", emoji: "" }, DEFAULTS),
    ).toEqual({ name: "Scout", emoji: "🐙" });
  });

  it("falls back to default name when only emoji is customized", () => {
    expect(
      resolveCoachIdentity({ name: "", emoji: "🧠" }, DEFAULTS),
    ).toEqual({ name: "Octo", emoji: "🧠" });
  });

  it("treats empty strings as missing (regression guard against `||` → `??` refactor)", () => {
    expect(
      resolveCoachIdentity({ name: "", emoji: "" }, DEFAULTS),
    ).toEqual(DEFAULTS);
  });
});

describe("buildCustomerAgent", () => {
  it("writes the customer's coach identity into the agent's identity block", () => {
    const agent = buildCustomerAgent(
      mkCustomer({ coach: { name: "Scout", emoji: "🧠", model: "anthropic/claude-sonnet-4-6" } }),
    );
    expect(agent.identity).toEqual({ name: "Scout", emoji: "🧠" });
  });

  it("falls back to platform default identity when caller supplies the shared defaults", () => {
    const agent = buildCustomerAgent(mkCustomer());
    expect(agent.identity).toEqual({ name: "Octo", emoji: "🐙" });
  });

  it("does NOT write a `mattermost` key on the agent (OpenClaw schema rejects it)", () => {
    const agent = buildCustomerAgent(mkCustomer());
    expect(agent).not.toHaveProperty("mattermost");
  });

  it("preserves the stable agent shape without retired heartbeat config", () => {
    const agent = buildCustomerAgent(mkCustomer());
    expect(agent).not.toHaveProperty("heartbeat");
    expect(agent).toMatchObject({
      id: "octogee-chris-builds-a3f2-coach",
      name: "Octo (chris-builds-a3f2)",
      workspace: "/home/node/.openclaw/customers/chris-builds-a3f2",
      agentDir: "/home/node/.openclaw/agents/octogee-chris-builds-a3f2-coach/agent",
      model: "platform-openrouter/z-ai/glm-5.2",
      tools: { fs: { workspaceOnly: true } },
    });
  });

  it("locks a shared-gateway coach down but hands a Builder gateway coach its full OpenClaw", () => {
    const shared = buildCustomerAgent(mkCustomer());
    expect(shared.tools).toMatchObject({
      profile: "coding",
      deny: expect.arrayContaining(["exec", "process", "subagents", "terminal", "browser"]),
      fs: { workspaceOnly: true },
    });

    const builder = buildCustomerAgent(mkCustomer({ hostCode: "builder-full" }));
    expect(builder).not.toHaveProperty("tools");
  });

  it("threads the customer's slug into the agent display name", () => {
    const agent = buildCustomerAgent(
      mkCustomer({ slug: "chris-shop", coach: { ...DEFAULT_COACH, name: "Scout" } }),
    );
    expect(agent.name).toBe("Scout (chris-shop)");
  });

  it("emits caller-provided memory search at the native canonical path", () => {
    const memorySearch = platformOpenAiEmbeddingMemorySearch(
      "octogee-chris-builds-a3f2-coach",
      {},
    );

    const agent = buildCustomerAgent(mkCustomer({ memorySearch }));

    expect(agent).not.toHaveProperty("memorySearch");
    expect(agent).toHaveProperty("memory.search", {
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-chris-builds-a3f2-coach",
        },
      },
      model: "text-embedding-3-small",
    });
  });
});

describe("platformOpenAiEmbeddingMemorySearch", () => {
  it("normalizes the operator-selected endpoint and model", () => {
    expect(
      platformOpenAiEmbeddingMemorySearch("octogee-alice-coach", {
        PLATFORM_OPENAI_BASE_URL: "https://llm-broker.example.test/v1/",
        OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://llm-broker.example.test/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-alice-coach",
        },
      },
      model: "custom-embed-v1",
    });
  });

  it("treats only explicit true-like env values as enabled", () => {
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "true" })).toBe(true);
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "1" })).toBe(true);
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "false" })).toBe(false);
    expect(platformOpenAiEmbeddingsEnabled({})).toBe(false);
  });
});
