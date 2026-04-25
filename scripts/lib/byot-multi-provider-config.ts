/**
 * Phase 2 — multi-provider per-agent config builder.
 *
 * Generalizes Phase 1's anthropic-only `buildByotAuthProfilesJson`. Per
 * provider, returns the file contents the gateway provisioner should
 * write into `~/.openclaw/agents/{agentId}/agent/`:
 *
 *   anthropic         → auth-profiles.json with `anthropic:default` keyRef
 *   openai            → auth-profiles.json with `openai:default` keyRef
 *                        (top-level openclaw.json must declare the
 *                        `openai:default` profile shell — see template)
 *   openai-compatible → models.json with `custom-{slug}` provider entry
 *                        carrying baseUrl + apiKey SecretRef
 *
 * Plus an optional `agentModelOverride` the provisioner sets on the
 * agent's `model` field in openclaw.json — required for openai* paths
 * since OpenClaw needs to know which provider to route to.
 *
 * Pure: zero IO, zero deps. Tests live at
 * `tests/specs/byot-multi-provider-config.spec.ts`.
 */

export type Provider = "anthropic" | "openai" | "openai-compatible";

export interface ByotConfigInput {
  slug: string;
  provider: Provider;
  /** Required for openai-compatible (e.g. https://openrouter.ai/api/v1). */
  baseUrl?: string;
  /**
   * Optional for anthropic / openai (defaults applied). REQUIRED for
   * openai-compatible since we can't enumerate models on an arbitrary
   * upstream and the customer must pick one explicitly.
   */
  model?: string;
}

export interface ExecSecretRef {
  source: "exec";
  provider: string;
  id: string;
}

/**
 * The credential entry MUST include a top-level `provider` string.
 * OpenClaw's `coercePersistedAuthProfileStore` (auth-profiles/persisted.ts)
 * passes no fallbackProvider when parsing entries from auth-profiles.json
 * (only the legacy auth.json reader does). Without the explicit provider,
 * `parseCredentialEntry` returns `{ ok: false, reason: "missing_provider" }`
 * and OpenClaw silently logs `ignored invalid auth profile entries during
 * store load` — leaving the customer's BYOT key dropped on the floor and
 * the agent stuck on the platform key.
 */
export interface AuthProfilesJson {
  profiles: Record<string, { type: "api_key"; provider: string; keyRef: ExecSecretRef }>;
}

export interface CustomProviderEntry {
  /**
   * OpenClaw request adapter. `openai-completions` covers OpenRouter,
   * Groq, Mistral, Fireworks, Together, and any other OpenAI-schema
   * endpoint. Without this field, OpenClaw can't route requests.
   */
  api: "openai-completions";
  baseUrl: string;
  apiKey: ExecSecretRef;
  /**
   * Explicit models[] entry so OpenClaw has metadata for the model the
   * customer chose. Without this, agent refs that namespace under the
   * custom provider would force OpenClaw to guess.
   */
  models: Array<{ id: string; name: string }>;
}

export interface ModelsJson {
  providers: Record<string, CustomProviderEntry>;
}

export interface ByotConfigOutput {
  authProfiles: AuthProfilesJson | null;
  models: ModelsJson | null;
  /** What the provisioner should set on the agent's `model` field. */
  agentModelOverride: string | null;
}

const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Default model when the customer hasn't picked one for a provider that
 * has a stable canonical default. openai-compatible has none — every
 * upstream surfaces a different catalog.
 */
const DEFAULT_MODELS: Partial<Record<Provider, string>> = {
  openai: "openai/gpt-5",
};

function secretIdFor(slug: string, provider: Provider): string {
  return `byok-${slug}-${provider}/latest`;
}

function customProviderName(slug: string): string {
  return `custom-${slug}`;
}

function assertSlug(slug: string): void {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)} — must match /^[a-z0-9][a-z0-9-]*$/`);
  }
}

function assertHttpUrl(input: string, label: string): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} is not a valid URL: ${JSON.stringify(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be http or https, got ${JSON.stringify(input)}`);
  }
  // Reject query strings + fragments — they'd compose surprisingly with
  // the `/models` and `/{model}` paths the resolver appends downstream.
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain query strings or fragments: ${JSON.stringify(input)}`);
  }
}

/**
 * Allowed model-id grammar — must compose safely into agent model refs
 * like `custom-{slug}/{model}`. Reject leading/trailing `/`, double-`/`,
 * `..` segments, and any character outside [A-Za-z0-9._-/].
 */
const MODEL_PATTERN = /^[A-Za-z0-9._/-]+$/;

function assertModel(input: string): void {
  const fail = (why: string): never => {
    throw new Error(`invalid model ${JSON.stringify(input)} — ${why}`);
  };
  if (!input) fail("empty");
  if (!MODEL_PATTERN.test(input)) fail("must match /^[A-Za-z0-9._/-]+$/");
  if (input.startsWith("/") || input.endsWith("/")) fail("must not start or end with /");
  if (input.includes("//")) fail("must not contain //");
  if (input.split("/").includes("..")) fail("must not contain .. segments");
}

export function buildByotConfigForProvider(input: ByotConfigInput): ByotConfigOutput {
  assertSlug(input.slug);

  if (input.provider === "anthropic") {
    return {
      authProfiles: {
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            keyRef: {
              source: "exec",
              provider: SECRET_RESOLVER_PROVIDER,
              id: secretIdFor(input.slug, "anthropic"),
            },
          },
        },
      },
      models: null,
      agentModelOverride: null,
    };
  }

  if (input.provider === "openai") {
    const model = input.model || DEFAULT_MODELS.openai!;
    return {
      authProfiles: {
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: {
              source: "exec",
              provider: SECRET_RESOLVER_PROVIDER,
              id: secretIdFor(input.slug, "openai"),
            },
          },
        },
      },
      models: null,
      agentModelOverride: model,
    };
  }

  if (input.provider === "openai-compatible") {
    if (!input.baseUrl) {
      throw new Error("baseUrl is required for openai-compatible providers");
    }
    assertHttpUrl(input.baseUrl, "baseUrl");
    if (!input.model) {
      throw new Error(
        "model is required for openai-compatible providers (no canonical default)",
      );
    }
    assertModel(input.model);
    const provName = customProviderName(input.slug);
    return {
      authProfiles: null,
      models: {
        providers: {
          [provName]: {
            api: "openai-completions",
            baseUrl: input.baseUrl,
            apiKey: {
              source: "exec",
              provider: SECRET_RESOLVER_PROVIDER,
              id: secretIdFor(input.slug, "openai-compatible"),
            },
            models: [{ id: input.model, name: input.model }],
          },
        },
      },
      // Namespaced ref. OpenClaw splits model refs on the FIRST `/` —
      // so `custom-{slug}/anthropic/claude-3.5-sonnet` resolves provider
      // = `custom-{slug}`, model id = `anthropic/claude-3.5-sonnet`.
      // The explicit `models[].id` above ensures OpenClaw can map the
      // ref back to the customer's chosen model.
      agentModelOverride: `${provName}/${input.model}`,
    };
  }

  // Exhaustiveness guard.
  const _exhaustive: never = input.provider;
  throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
}

/** Canonical Secret Manager secret name for a customer + provider. */
export function secretNameFor(slug: string, provider: Provider): string {
  assertSlug(slug);
  return `byok-${slug}-${provider}`;
}
