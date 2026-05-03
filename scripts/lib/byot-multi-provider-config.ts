export type Provider = "anthropic" | "openai" | "openai-compatible";

export interface ByotConfigInput {
  slug: string;
  provider: Provider;
  baseUrl?: string;
  model?: string;
}

export interface ExecSecretRef {
  source: "exec";
  provider: string;
  id: string;
}

export interface AuthProfilesJson {
  profiles: Record<string, { type: "api_key"; provider: string; keyRef: ExecSecretRef }>;
}

export interface CustomProviderEntry {
  api: "openai-completions";
  baseUrl: string;
  apiKey: ExecSecretRef;
  models: Array<{ id: string; name: string }>;
}

export interface ModelsJson {
  providers: Record<string, CustomProviderEntry>;
}

export interface ByotConfigOutput {
  authProfiles: AuthProfilesJson | null;
  models: ModelsJson | null;
  agentModelOverride: string | null;
}

const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain query strings or fragments: ${JSON.stringify(input)}`);
  }
}

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
      agentModelOverride: `${provName}/${input.model}`,
    };
  }

  const _exhaustive: never = input.provider;
  throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
}

export function secretNameFor(slug: string, provider: Provider): string {
  assertSlug(slug);
  return `byok-${slug}-${provider}`;
}
