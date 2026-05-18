/**
 * Unified customer-credential config builder. One primitive for every
 * customer-provided credential — BYOT (api_key) and BYOS (oauth) are the
 * same thing, differing only by `mode`. Provider behaviour is DATA in the
 * `PROVIDERS` registry, not control flow: adding google / github /
 * openrouter is a row, never a new branch. The per-agent sandbox is
 * OpenClaw's `auth.profiles` primitive (proven by BYOT); nothing here
 * adds isolation — it only emits the per-agent config OpenClaw consumes.
 */

export type Provider =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "openai-codex";

export type CredentialMode = "api_key" | "oauth";

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

export type AuthProfileEntry =
  | { type: "api_key"; provider: string; keyRef: ExecSecretRef }
  | { type: "oauth"; provider: string };

export interface AuthProfilesJson {
  profiles: Record<string, AuthProfileEntry>;
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

/**
 * Declarative per-provider behaviour. New providers = a row here.
 *  - shape:"profile"  → emits a per-agent `auth.profiles` entry
 *      (api_key → SecretRef→Secret Manager; oauth → no keyRef, the
 *       credential is the per-agent oauth store openclaw isolates).
 *  - shape:"customProvider" → emits a `models.providers` entry
 *      (openai-completions); `baseUrl` preset = a named endpoint
 *      (e.g. openrouter); absent = caller supplies the endpoint.
 * `defaultModel`: null → never overrides the agent model (anthropic;
 *  future tool-only oauth like google/github). string → `input.model ||`.
 */
export interface ProviderSpec {
  mode: CredentialMode;
  shape: "profile" | "customProvider";
  /** auth.profiles key (shape:"profile" only). */
  profileKey?: string;
  /** provider name recorded in the profile / custom-provider entry. */
  authProvider: string;
  defaultModel: string | null;
  /** customProvider: preset endpoint; absent → caller must supply baseUrl. */
  baseUrl?: string;
}

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  anthropic: {
    mode: "api_key",
    shape: "profile",
    profileKey: "anthropic:default",
    authProvider: "anthropic",
    defaultModel: null,
  },
  openai: {
    mode: "api_key",
    shape: "profile",
    profileKey: "openai:default",
    authProvider: "openai",
    defaultModel: "openai/gpt-5",
  },
  "openai-codex": {
    // BYOS — ChatGPT subscription. Same primitive as BYOT, oauth mode.
    mode: "oauth",
    shape: "profile",
    profileKey: "openai-codex",
    authProvider: "openai-codex",
    defaultModel: "openai/gpt-5.5",
  },
  "openai-compatible": {
    mode: "api_key",
    shape: "customProvider",
    authProvider: "openai-compatible",
    defaultModel: null,
  },
  // Ready slots (add a row + its capture flow — no new code here):
  //   openrouter: { mode:"api_key", shape:"customProvider",
  //     authProvider:"openrouter", defaultModel:null,
  //     baseUrl:"https://openrouter.ai/api/v1" }
  //   google / github: { mode:"oauth", shape:"profile",
  //     profileKey:"<p>", authProvider:"<p>", defaultModel:null }
};

const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

function execRef(slug: string, provider: Provider): ExecSecretRef {
  return { source: "exec", provider: SECRET_RESOLVER_PROVIDER, id: secretIdFor(slug, provider) };
}

export function buildByotConfigForProvider(input: ByotConfigInput): ByotConfigOutput {
  assertSlug(input.slug);

  const spec = PROVIDERS[input.provider];
  if (!spec) {
    throw new Error(`Unsupported provider: ${String(input.provider)}`);
  }

  if (spec.shape === "customProvider") {
    const baseUrl = spec.baseUrl ?? input.baseUrl;
    if (!baseUrl) {
      throw new Error("baseUrl is required for openai-compatible providers");
    }
    assertHttpUrl(baseUrl, "baseUrl");
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
            baseUrl,
            apiKey: execRef(input.slug, input.provider),
            models: [{ id: input.model, name: input.model }],
          },
        },
      },
      agentModelOverride: `${provName}/${input.model}`,
    };
  }

  const profile: AuthProfileEntry =
    spec.mode === "api_key"
      ? { type: "api_key", provider: spec.authProvider, keyRef: execRef(input.slug, input.provider) }
      : { type: "oauth", provider: spec.authProvider };

  return {
    authProfiles: { profiles: { [spec.profileKey!]: profile } },
    models: null,
    agentModelOverride:
      spec.defaultModel === null ? null : input.model || spec.defaultModel,
  };
}

export function secretNameFor(slug: string, provider: Provider): string {
  assertSlug(slug);
  return `byok-${slug}-${provider}`;
}

/** Credential mode for a provider — the single seam consumers use instead
 *  of reaching into the PROVIDERS registry directly. */
export function isOauthProvider(provider: Provider): boolean {
  // eslint-disable-next-line security/detect-object-injection -- typed Provider key into the closed PROVIDERS Record (no injection)
  return PROVIDERS[provider].mode === "oauth";
}

/**
 * BYOS coach model + its `agents.defaults.models` registry entry. The
 * entry pins `agentRuntime:{id:"codex"}` so the model is explicitly routed
 * through the `@openclaw/codex` harness (+ the per-agent codex-home OAuth)
 * — required when openai/gpt-5.5 is a per-agent override on a Sonnet-
 * default gateway, not the gateway default (proven against the Mac
 * 2026.5.12 codex env; the plain `{}` form silently fell back to the
 * direct OpenAI API → "No API key for provider openai"). Single source:
 * the PROVIDERS registry. Consumed by the per-customer config-patch.
 */
export function codexRuntimeConfig(): {
  model: string;
  modelsDef: Record<string, { agentRuntime: { id: "codex" } }>;
} {
  const model = PROVIDERS["openai-codex"].defaultModel!;
  return { model, modelsDef: { [model]: { agentRuntime: { id: "codex" } } } };
}

/**
 * Plane-1 (per-agent `<agentDir>/auth-profiles.json`) OAuth credential —
 * openclaw's normalized shape. codex is the first row; future model-auth
 * rows (e.g. github-copilot `type:"token"`) extend the same store by a
 * registry row, not a rewrite.
 */
export interface OAuthCredential {
  type: "oauth";
  provider: string;
  access: string;
  refresh?: string;
  expires: number;
  accountId?: string;
  idToken?: string;
  chatgptPlanType?: string;
  email?: string;
  copyToAgents?: boolean;
}

/** On-disk auth-profiles.json envelope (openclaw AUTH_STORE_VERSION = 1). */
export interface AuthProfilesStoreV1 {
  version: 1;
  profiles: Record<string, OAuthCredential>;
}

/** Resolved default profile id for the codex provider on beta.6. */
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";

/**
 * Map a codex CLI `auth.json` (the byosub-captured ChatGPT-sub blob) into
 * the per-agent auth-profiles store openclaw beta.6's @openclaw/codex reads
 * (provider "openai-codex"). `expires:0` makes openclaw mint a fresh access
 * token from `refresh` on first use — so both `tokens.access_token` AND
 * `tokens.refresh_token` are required: a refresh-less blob plus `expires:0`
 * is a dead-on-arrival credential (openclaw would have no refresh material
 * and a token it believes already expired). Fail loud on either missing —
 * symmetric with the §13 capture-callback's required fields, so
 * validate-before-write keeps its "never flip routing without a usable
 * cred on disk" guarantee.
 */
export function buildCodexAuthProfilesStore(
  codexAuthJsonText: string,
): AuthProfilesStoreV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(codexAuthJsonText);
  } catch {
    throw new Error("codex auth.json: unparseable JSON");
  }
  const tokens =
    (parsed as { tokens?: Record<string, unknown> } | null)?.tokens ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const access = str(tokens.access_token);
  if (!access) {
    throw new Error("codex auth.json: missing tokens.access_token");
  }
  const refresh = str(tokens.refresh_token);
  if (!refresh) {
    throw new Error("codex auth.json: missing tokens.refresh_token");
  }
  const accountId = str(tokens.account_id);
  const idToken = str(tokens.id_token);

  let chatgptPlanType: string | undefined;
  let email: string | undefined;
  if (idToken) {
    try {
      const claims = JSON.parse(
        Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      email = str(claims.email);
      const ocAuth = claims["https://api.openai.com/auth"] as
        | Record<string, unknown>
        | undefined;
      chatgptPlanType = str(ocAuth?.chatgpt_plan_type);
    } catch {
      // id_token undecodable → plan/email simply absent; not fatal.
    }
  }

  const profile: OAuthCredential = {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires: 0,
    copyToAgents: true,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(email ? { email } : {}),
  };
  return {
    version: 1,
    profiles: { [OPENAI_CODEX_DEFAULT_PROFILE_ID]: profile },
  };
}
