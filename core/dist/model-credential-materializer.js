import { MODEL_CREDENTIAL_CATALOG, } from "@octogee/shared/types/model-credentials";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
export const MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS = Object.fromEntries(MODEL_CREDENTIAL_CATALOG
    .filter((entry) => entry.activeSlotEligible)
    .map((entry) => [
    entry.id,
    {
        mode: entry.modes[0],
        shape: entry.materialization.kind === "custom-openai-provider"
            ? "customProvider"
            : "profile",
        ...(entry.openclaw.configProfileId
            ? { profileKey: entry.openclaw.configProfileId }
            : {}),
        authProvider: entry.openclaw.authProvider,
        defaultModel: entry.defaults.model,
        ...(entry.baseUrl.kind === "canonical"
            ? { baseUrl: entry.baseUrl.value }
            : {}),
    },
]));
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
function secretIdFor(slug, provider) {
    return `byok-${slug}-${provider}/latest`;
}
function customProviderName(slug) {
    return `custom-${slug}`;
}
function assertSlug(slug) {
    if (!slug || !SLUG_PATTERN.test(slug)) {
        throw new Error(`invalid slug ${JSON.stringify(slug)} — must match /^[a-z0-9][a-z0-9-]*$/`);
    }
}
function assertHttpUrl(input, label) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
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
function assertModel(input) {
    const fail = (why) => {
        throw new Error(`invalid model ${JSON.stringify(input)} — ${why}`);
    };
    if (!input)
        fail("empty");
    if (!MODEL_PATTERN.test(input))
        fail("must match /^[A-Za-z0-9._/-]+$/");
    if (input.startsWith("/") || input.endsWith("/"))
        fail("must not start or end with /");
    if (input.includes("//"))
        fail("must not contain //");
    if (input.split("/").includes(".."))
        fail("must not contain .. segments");
}
function execRef(slug, provider) {
    return { source: "exec", provider: SECRET_RESOLVER_PROVIDER, id: secretIdFor(slug, provider) };
}
export function buildModelCredentialConfigForProvider(input) {
    assertSlug(input.slug);
    const spec = MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS[input.provider];
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
            throw new Error("model is required for openai-compatible providers (no canonical default)");
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
    const profile = spec.mode === "api_key"
        ? { type: "api_key", provider: spec.authProvider, keyRef: execRef(input.slug, input.provider) }
        : { type: "oauth", provider: spec.authProvider };
    return {
        authProfiles: { profiles: { [spec.profileKey]: profile } },
        models: null,
        agentModelOverride: spec.defaultModel === null ? null : input.model || spec.defaultModel,
    };
}
export function modelCredentialSecretNameFor(slug, provider) {
    assertSlug(slug);
    return `byok-${slug}-${provider}`;
}
export function isModelCredentialOauthProvider(provider) {
    return MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS[provider].mode === "oauth";
}
export function codexRuntimeConfig() {
    const model = MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS["openai-codex"].defaultModel;
    const refs = new Set([
        model,
        ...MODEL_CATALOG.filter((entry) => entry.provider === "openai")
            .map((entry) => `openai/${entry.id}`),
    ]);
    return {
        model,
        modelsDef: Object.fromEntries([...refs].map((ref) => [ref, { agentRuntime: { id: "codex" } }])),
    };
}
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
    "claude-cli/claude-opus-5",
    "claude-cli/claude-sonnet-5",
    "claude-cli/claude-opus-4-8",
    "claude-cli/claude-opus-4-7",
    "claude-cli/claude-sonnet-4-6",
    "claude-cli/claude-opus-4-6",
];
export function claudeCliRuntimeConfig() {
    const model = MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS["claude-cli"].defaultModel;
    return {
        model,
        modelsDef: Object.fromEntries(CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) => [ref, {}])),
    };
}
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
export const CLAUDE_CLI_DEFAULT_PROFILE_ID = "anthropic:claude-cli";
const CLAUDE_CLI_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
function parseClaudeCliSsoCredentialObject(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("claude-cli SSO credential: expected JSON object");
    }
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
        throw new Error("claude-cli SSO credential: missing claudeAiOauth object");
    }
    const fields = oauth;
    const accessToken = fields.accessToken;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new Error("claude-cli SSO credential: missing claudeAiOauth.accessToken");
    }
    const refreshToken = fields.refreshToken;
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw new Error("claude-cli SSO credential: missing claudeAiOauth.refreshToken");
    }
    const expiresAt = fields.expiresAt;
    if (typeof expiresAt !== "number" ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= 0) {
        throw new Error("claude-cli SSO credential: invalid claudeAiOauth.expiresAt");
    }
    return {
        type: "oauth",
        provider: "claude-cli",
        access: accessToken,
        refresh: refreshToken,
        expires: Math.floor(expiresAt),
        copyToAgents: true,
    };
}
function parseClaudeCliSsoCredential(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("claude-cli SSO credential: not valid JSON");
    }
    return parseClaudeCliSsoCredentialObject(parsed);
}
export function buildClaudeCliNativeCredentialsJson(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{"))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        throw new Error("claude-cli SSO credential: not valid JSON");
    }
    parseClaudeCliSsoCredentialObject(parsed);
    return `${JSON.stringify(parsed, null, 2)}\n`;
}
// Claude SUBSCRIPTION (claude setup-token) → the per-agent claude-cli OAuth
// profile. The credential is a single long-lived bearer (sk-ant-oat01-…) with
// NO refresh token, so — unlike codex — there is no JWT to parse and nothing to
// refresh; stamp a 1-year horizon from the mint time so openclaw uses it rather
// than treating expires:0 as refresh-needed. Real death surfaces reactively as
// a 401 → needs_reauth.
export function buildClaudeCliAuthProfilesStore(token, nowMs) {
    if (!token || !token.trim()) {
        throw new Error("claude-cli credential: empty setup-token");
    }
    const trimmed = token.trim();
    const profile = trimmed.startsWith("{")
        ? parseClaudeCliSsoCredential(trimmed)
        : null;
    if (profile && profile.expires <= nowMs) {
        throw new Error("claude-cli SSO credential: expired");
    }
    return {
        version: 1,
        profiles: {
            [CLAUDE_CLI_DEFAULT_PROFILE_ID]: profile ?? {
                type: "oauth",
                provider: "claude-cli",
                access: trimmed,
                expires: nowMs + CLAUDE_CLI_TOKEN_TTL_MS,
                copyToAgents: true,
            },
        },
    };
}
function codexStr(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function codexJwtClaims(token) {
    if (!token)
        return undefined;
    try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    }
    catch {
        return undefined;
    }
}
function codexJwtDerived(access, idToken) {
    const accessExp = codexJwtClaims(access)?.exp;
    const expires = typeof accessExp === "number" && Number.isFinite(accessExp) && accessExp > 0
        ? Math.floor(accessExp) * 1000
        : 0;
    const idClaims = codexJwtClaims(idToken);
    if (!idClaims)
        return { expires };
    const ocAuth = idClaims["https://api.openai.com/auth"];
    const chatgptPlanType = codexStr(ocAuth?.chatgpt_plan_type);
    const email = codexStr(idClaims.email);
    return {
        expires,
        ...(chatgptPlanType ? { chatgptPlanType } : {}),
        ...(email ? { email } : {}),
    };
}
export function buildCodexAuthProfilesStore(codexAuthJsonText) {
    let parsed;
    try {
        parsed = JSON.parse(codexAuthJsonText);
    }
    catch {
        throw new Error("codex auth.json: unparseable JSON");
    }
    const tokens = parsed?.tokens ?? {};
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
    const profile = {
        type: "oauth",
        provider: "openai",
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
export function buildCodexAuthJsonFromStore(authProfilesStoreText) {
    let parsed;
    try {
        parsed = JSON.parse(authProfilesStoreText);
    }
    catch {
        return null;
    }
    const profiles = parsed
        ?.profiles;
    if (!profiles || typeof profiles !== "object")
        return null;
    const p = profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
    if (!p || p.type !== "oauth")
        return null;
    const access = codexStr(p.access);
    const refresh = codexStr(p.refresh);
    if (!access || !refresh)
        return null;
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
