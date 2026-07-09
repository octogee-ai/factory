import { describe, it, expect, vi } from "vitest";
import {
  buildCustomerAgent,
  fetchCoachIdentities,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  resolveCoachIdentity,
  type CustomerAgentInput,
  type CoachIdentityDeps,
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

  it("preserves the stable agent shape (id, name, workspace, agentDir, model, heartbeat, tools)", () => {
    const agent = buildCustomerAgent(mkCustomer());
    expect(agent).toMatchObject({
      id: "octogee-chris-builds-a3f2-coach",
      name: "Octo (chris-builds-a3f2)",
      workspace: "/home/node/.openclaw/customers/chris-builds-a3f2",
      agentDir: "/home/node/.openclaw/agents/octogee-chris-builds-a3f2-coach/agent",
      model: "platform-openrouter/z-ai/glm-5.2",
      heartbeat: { every: "60m", target: "last", lightContext: true },
      tools: { fs: { workspaceOnly: true } },
    });
  });

  it("threads the customer's slug into the agent display name", () => {
    const agent = buildCustomerAgent(
      mkCustomer({ slug: "chris-shop", coach: { ...DEFAULT_COACH, name: "Scout" } }),
    );
    expect(agent.name).toBe("Scout (chris-shop)");
  });

  it("preserves caller-provided memory search config", () => {
    const memorySearch = platformOpenAiEmbeddingMemorySearch(
      "octogee-chris-builds-a3f2-coach",
      {},
    );

    const agent = buildCustomerAgent(mkCustomer({ memorySearch }));

    expect(agent.memorySearch).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "platform-openai-embedding-octogee-chris-builds-a3f2-coach",
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
        OPENAI_EMBEDDINGS_BASE_URL: "https://embeddings.example.test/v1/",
        OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://embeddings.example.test/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "platform-openai-embedding-octogee-alice-coach",
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

describe("fetchCoachIdentities", () => {
  function mkDeps(
    docs: Record<string, { name?: string; avatarEmoji?: string } | undefined>,
    logSpy = vi.fn(),
  ): CoachIdentityDeps & { logs: ReturnType<typeof vi.fn> } {
    const db = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            const key = `${name}/${id}`;
            const data = docs[key];
            return { exists: !!data, data: () => data };
          },
        }),
      }),
    };
    return { db, log: logSpy, logs: logSpy };
  }

  it("reads agents/{uid}.name + avatarEmoji and returns identities keyed by uid", async () => {
    const deps = mkDeps({
      "agents/uid-chris": { name: "Scout", avatarEmoji: "🧠" },
      "agents/uid-sam": { name: "Pix", avatarEmoji: "🦊" },
    });
    const result = await fetchCoachIdentities(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.get("uid-chris")).toEqual({ name: "Scout", emoji: "🧠" });
    expect(result.get("uid-sam")).toEqual({ name: "Pix", emoji: "🦊" });
  });

  it("omits customers with no agents/{uid} doc and logs a warning", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps(
      { "agents/uid-chris": { name: "Scout", avatarEmoji: "🧠" } },
      logSpy,
    );
    const result = await fetchCoachIdentities(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.has("uid-chris")).toBe(true);
    expect(result.has("uid-sam")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sam-cooks-b4g3"),
    );
  });

  it("omits entries when agents doc exists but has no customized name or emoji", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps(
      { "agents/uid-chris": {} },
      logSpy,
    );
    const result = await fetchCoachIdentities(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
    ]);
    expect(result.has("uid-chris")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("chris-builds-a3f2"),
    );
  });

  it("accepts partial customization (name only or emoji only)", async () => {
    const deps = mkDeps({
      "agents/uid-chris": { name: "Scout" },
      "agents/uid-sam": { avatarEmoji: "🦊" },
    });
    const result = await fetchCoachIdentities(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.get("uid-chris")).toEqual({ name: "Scout", emoji: "" });
    expect(result.get("uid-sam")).toEqual({ name: "", emoji: "🦊" });
  });

  it("tolerates Firestore errors for a single customer (continues others)", async () => {
    const logSpy = vi.fn();
    const db = {
      collection: (_name: string) => ({
        doc: (uid: string) => ({
          get: async () => {
            if (uid === "uid-broken") throw new Error("firestore hiccup");
            return {
              exists: true,
              data: () => ({ name: "Scout", avatarEmoji: "🧠" }),
            };
          },
        }),
      }),
    };
    const deps = { db, log: logSpy };
    const result = await fetchCoachIdentities(deps, [
      { uid: "uid-broken", slug: "broken-slug-a1b2" },
      { uid: "uid-ok", slug: "ok-slug-c3d4" },
    ]);
    expect(result.has("uid-broken")).toBe(false);
    expect(result.get("uid-ok")).toEqual({ name: "Scout", emoji: "🧠" });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken-slug-a1b2"),
    );
  });

  it("distributes identities per customer — no cross-workspace bleed on Map lookup", async () => {
    const deps = mkDeps({
      "agents/uid-a": { name: "Scout", avatarEmoji: "🧠" },
      "agents/uid-b": { name: "Pix", avatarEmoji: "🦊" },
      "agents/uid-c": { name: "Marlo", avatarEmoji: "🐢" },
    });
    const customers = [
      { uid: "uid-a", slug: "slug-a" },
      { uid: "uid-b", slug: "slug-b" },
      { uid: "uid-c", slug: "slug-c" },
    ];
    const identities = await fetchCoachIdentities(deps, customers);

    const agents = customers.map((c) => {
      const ident = identities.get(c.uid);
      return buildCustomerAgent({
        uid: c.uid,
        slug: c.slug,
        customerDir: `/tmp/${c.slug}`,
        agentDir: `/tmp/${c.slug}/agent`,
        coach: {
          name: ident?.name || DEFAULT_COACH.name,
          emoji: ident?.emoji || DEFAULT_COACH.emoji,
          model: DEFAULT_COACH.model,
        },
      });
    });

    expect((agents[0].identity as any)).toEqual({ name: "Scout", emoji: "🧠" });
    expect((agents[1].identity as any)).toEqual({ name: "Pix", emoji: "🦊" });
    expect((agents[2].identity as any)).toEqual({ name: "Marlo", emoji: "🐢" });

    const names = agents.map((a) => (a.identity as any).name);
    expect(new Set(names).size).toBe(3);
  });
});
