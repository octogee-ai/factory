

export type Provider =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "openai-codex"
  | "claude-cli"
  | "grok"
  | "openrouter"
  | "minimax";

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

export interface ProviderSpec {
  mode: CredentialMode;
  shape: "profile" | "customProvider";
  
  profileKey?: string;
  
  authProvider: string;
  defaultModel: string | null;
  
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

    mode: "oauth",
    shape: "profile",
    profileKey: "openai-codex",
    authProvider: "openai-codex",
    defaultModel: "openai/gpt-5.5",
  },
  "claude-cli": {
    // Claude SUBSCRIPTION (claude setup-token) — distinct from `anthropic`
    // (api_key). Routes the agent through the claude-cli runtime on the
    // customer's own sub. Opus 4.8 is a distinct model id from the shared-pool
    // Sonnet default, so the global runtime mapping is per-customer-safe.
    mode: "oauth",
    shape: "profile",
    profileKey: "anthropic:claude-cli",
    authProvider: "claude-cli",
    // openclaw exposes the Claude-sub model as claude-cli/<model> (the provider
    // prefix selects the native claude-cli runtime); allowlisted with an empty
    // entry. NOT anthropic/<model>+agentRuntime — that id is rejected (proven live).
    defaultModel: "claude-cli/claude-opus-4-8",
  },
  "openai-compatible": {
    mode: "api_key",
    shape: "customProvider",
    authProvider: "openai-compatible",
    defaultModel: null,
  },
  // Native-HTTP OpenAI-compatible providers — work on every gateway class
  // (no exec). Canonical baseUrl so the Builder supplies only a model + key.
  grok: {
    mode: "api_key",
    shape: "customProvider",
    authProvider: "grok",
    defaultModel: null,
    baseUrl: "https://api.x.ai/v1",
  },
  openrouter: {
    mode: "api_key",
    shape: "customProvider",
    authProvider: "openrouter",
    defaultModel: null,
    baseUrl: "https://openrouter.ai/api/v1",
  },
  minimax: {
    mode: "api_key",
    shape: "customProvider",
    authProvider: "minimax",
    defaultModel: null,
    // TODO(byok): confirm MiniMax's OpenAI-compatible base before the live demo.
    baseUrl: "https://api.minimax.io/v1",
  },
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

export function isOauthProvider(provider: Provider): boolean {
  return PROVIDERS[provider].mode === "oauth";
}

export function codexRuntimeConfig(): {
  model: string;
  modelsDef: Record<string, { agentRuntime: { id: "codex" } }>;
} {
  const model = PROVIDERS["openai-codex"].defaultModel!;
  return { model, modelsDef: { [model]: { agentRuntime: { id: "codex" } } } };
}

export function claudeCliRuntimeConfig(): {
  model: string;
  modelsDef: Record<string, Record<string, never>>;
} {
  const model = PROVIDERS["claude-cli"].defaultModel!;
  // Empty entry = allowlist the native claude-cli/<model> id; the prefix selects
  // the runtime, so no agentRuntime remap (unlike codex, a plugin).
  return { model, modelsDef: { [model]: {} } };
}

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

export interface AuthProfilesStoreV1 {
  version: 1;
  profiles: Record<string, OAuthCredential>;
}

export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
export const CLAUDE_CLI_DEFAULT_PROFILE_ID = "anthropic:claude-cli";
const CLAUDE_CLI_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Claude SUBSCRIPTION (claude setup-token) → the per-agent claude-cli OAuth
// profile. The credential is a single long-lived bearer (sk-ant-oat01-…) with
// NO refresh token, so — unlike codex — there is no JWT to parse and nothing to
// refresh; stamp a 1-year horizon from the mint time so openclaw uses it rather
// than treating expires:0 as refresh-needed. Real death surfaces reactively as
// a 401 → needs_reauth.
export function buildClaudeCliAuthProfilesStore(
  token: string,
  nowMs: number,
): AuthProfilesStoreV1 {
  if (!token || !token.trim()) {
    throw new Error("claude-cli credential: empty setup-token");
  }
  const profile: OAuthCredential = {
    type: "oauth",
    provider: "claude-cli",
    access: token,
    expires: nowMs + CLAUDE_CLI_TOKEN_TTL_MS,
    copyToAgents: true,
  };
  return {
    version: 1,
    profiles: { [CLAUDE_CLI_DEFAULT_PROFILE_ID]: profile },
  };
}

function codexStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function codexJwtClaims(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined; 
  }
}

function codexJwtDerived(
  access: string,
  idToken: string | undefined,
): { expires: number; chatgptPlanType?: string; email?: string } {
  const accessExp = codexJwtClaims(access)?.exp;
  const expires =
    typeof accessExp === "number" && Number.isFinite(accessExp) && accessExp > 0
      ? Math.floor(accessExp) * 1000
      : 0;
  const idClaims = codexJwtClaims(idToken);
  if (!idClaims) return { expires };
  const ocAuth = idClaims["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const chatgptPlanType = codexStr(ocAuth?.chatgpt_plan_type);
  const email = codexStr(idClaims.email);
  return {
    expires,
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(email ? { email } : {}),
  };
}

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

  const access = codexStr(tokens.access_token);
  if (!access) {
    throw new Error("codex auth.json: missing tokens.access_token");
  }
  const refresh = codexStr(tokens.refresh_token);
  if (!refresh) {
    throw new Error("codex auth.json: missing tokens.refresh_token");
  }
  const accountId = codexStr(tokens.account_id);
  const idToken = codexStr(tokens.id_token);
  const { expires, chatgptPlanType, email } = codexJwtDerived(access, idToken);

  const profile: OAuthCredential = {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires,
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

export function buildCodexAuthJsonFromStore(
  authProfilesStoreText: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authProfilesStoreText);
  } catch {
    return null;
  }
  const profiles = (parsed as { profiles?: Record<string, unknown> } | null)
    ?.profiles;
  if (!profiles || typeof profiles !== "object") return null;
  const p = profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID] as
    | Record<string, unknown>
    | undefined;
  if (!p || p.type !== "oauth") return null;
  const access = codexStr(p.access);
  const refresh = codexStr(p.refresh);
  if (!access || !refresh) return null; 
  const accountId = codexStr(p.accountId);
  const idToken = codexStr(p.idToken);
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: access,
      refresh_token: refresh,
      ...(accountId ? { account_id: accountId } : {}),
      ...(idToken ? { id_token: idToken } : {}),
    },
  });
}
