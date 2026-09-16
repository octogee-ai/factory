export const MODEL_CREDENTIAL_MODES = [
    'api_key',
    'token',
    'oauth',
];
const STATIC_SECRET_STORAGE = {
    kind: 'secret-manager',
    secretNamePrefix: 'byok',
};
const OAUTH_SECRET_STORAGE = {
    kind: 'oauth-secret-manager',
    secretNamePrefix: 'byosub',
};
const CONNECTOR_SECRET_STORAGE = {
    kind: 'connector-secret',
    pathTemplate: 'users/{uid}/secrets/{provider}',
};
export const MODEL_CREDENTIAL_CATALOG = [
    {
        id: 'openai',
        displayName: 'OpenAI API key',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'auth-profile', writesAuthJson: false },
        baseUrl: { kind: 'none' },
        model: { required: false },
        openclaw: {
            authProvider: 'openai',
            configProfileId: 'openai:default',
            storeProfileId: 'openai:default',
            secretRefAllowed: true,
        },
        defaults: { model: 'openai/gpt-5' },
    },
    {
        id: 'openai-codex',
        displayName: 'ChatGPT subscription',
        modes: ['oauth'],
        captureMethods: ['device-oauth'],
        implemented: true,
        activeSlotEligible: true,
        storage: OAUTH_SECRET_STORAGE,
        materialization: { kind: 'oauth-profile-store', writesAuthJson: true },
        oauth: {
            subscriptionProvider: 'openai',
            secretProvider: 'openai',
            gatewayFlow: 'device-auth',
        },
        baseUrl: { kind: 'none' },
        model: { required: false },
        openclaw: {
            authProvider: 'openai',
            configProfileId: 'openai-codex',
            storeProfileId: 'openai-codex:default',
            secretRefAllowed: false,
        },
        defaults: { model: 'openai/gpt-5.5' },
    },
    {
        id: 'anthropic',
        displayName: 'Anthropic API key',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'auth-profile', writesAuthJson: false },
        baseUrl: { kind: 'none' },
        model: { required: false },
        openclaw: {
            authProvider: 'anthropic',
            configProfileId: 'anthropic:default',
            storeProfileId: 'anthropic:default',
            secretRefAllowed: true,
        },
        defaults: { model: null },
    },
    {
        id: 'claude-cli',
        displayName: 'Claude subscription',
        modes: ['oauth'],
        captureMethods: ['sso-oauth'],
        implemented: true,
        activeSlotEligible: true,
        storage: OAUTH_SECRET_STORAGE,
        materialization: { kind: 'oauth-profile-store', writesAuthJson: false },
        oauth: {
            subscriptionProvider: 'anthropic',
            secretProvider: 'anthropic',
            gatewayFlow: 'claude-sso',
        },
        baseUrl: { kind: 'none' },
        model: { required: false },
        openclaw: {
            authProvider: 'claude-cli',
            configProfileId: 'anthropic:claude-cli',
            storeProfileId: 'anthropic:claude-cli',
            secretRefAllowed: false,
        },
        defaults: { model: 'claude-cli/claude-opus-4-8' },
    },
    {
        id: 'openrouter',
        displayName: 'OpenRouter',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
        baseUrl: { kind: 'canonical', value: 'https://openrouter.ai/api/v1' },
        model: { required: true },
        openclaw: {
            authProvider: 'openrouter',
            configProfileId: null,
            storeProfileId: null,
            secretRefAllowed: true,
        },
        defaults: { model: null },
    },
    {
        id: 'grok',
        displayName: 'Grok',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
        baseUrl: { kind: 'canonical', value: 'https://api.x.ai/v1' },
        model: { required: true },
        openclaw: {
            authProvider: 'grok',
            configProfileId: null,
            storeProfileId: null,
            secretRefAllowed: true,
        },
        defaults: { model: null },
    },
    {
        id: 'minimax',
        displayName: 'MiniMax',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
        baseUrl: { kind: 'canonical', value: 'https://api.minimax.io/v1' },
        model: { required: true },
        openclaw: {
            authProvider: 'minimax',
            configProfileId: null,
            storeProfileId: null,
            secretRefAllowed: true,
        },
        defaults: { model: null },
    },
    {
        id: 'openai-compatible',
        displayName: 'Custom OpenAI-compatible',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: true,
        storage: STATIC_SECRET_STORAGE,
        materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
        baseUrl: { kind: 'user', requiresHttps: true },
        model: { required: true },
        openclaw: {
            authProvider: 'openai-compatible',
            configProfileId: null,
            storeProfileId: null,
            secretRefAllowed: true,
        },
        defaults: { model: null },
    },
    {
        id: 'gemini',
        displayName: 'Google Gemini',
        modes: ['api_key'],
        captureMethods: ['api-key'],
        implemented: true,
        activeSlotEligible: false,
        connectorOnlyUntilRouted: true,
        storage: CONNECTOR_SECRET_STORAGE,
        materialization: { kind: 'connector-only', writesAuthJson: false },
        baseUrl: { kind: 'none' },
        model: { required: false },
        openclaw: {
            authProvider: 'gemini',
            configProfileId: null,
            storeProfileId: null,
            secretRefAllowed: false,
        },
        defaults: { model: null },
    },
];
export const MODEL_CREDENTIAL_STATIC_PROVIDER_IDS = [
    'openai',
    'anthropic',
    'openrouter',
    'grok',
    'minimax',
    'openai-compatible',
];
export const MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS = [
    'gemini',
];
export const MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS = [
    'openai-codex',
    'claude-cli',
];
export const MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS = [
    'openai',
    'anthropic',
];
const SAFE_BYOSUB_UID = /^[A-Za-z0-9_-]+$/;
export function byosubSecretNameForUser(uid, provider) {
    return SAFE_BYOSUB_UID.test(uid) ? `byosub-${uid}-${provider}` : null;
}
// eslint-disable-next-line complexity
export function resolveUserByosubCredentialRefs(uid, integration) {
    const providers = integration && typeof integration === 'object' && !Array.isArray(integration)
        ? integration.providers
        : undefined;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
        return { refs: [], skipped: [] };
    }
    const providerSet = providers;
    const refs = [];
    const skipped = [];
    for (const provider of MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS) {
        const raw = providerSet[provider];
        if (raw === undefined)
            continue;
        if (!raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            raw.provider !== provider) {
            skipped.push(`${provider}: malformed provider leaf`);
            continue;
        }
        const leaf = raw;
        if (leaf.connected === false && (leaf.status === 'needs_reauth' || leaf.status === 'disconnected' || leaf.status === 'pending')) {
            continue;
        }
        if (leaf.connected !== true || leaf.status !== 'connected') {
            skipped.push(`${provider}: malformed provider leaf`);
            continue;
        }
        const secretName = byosubSecretNameForUser(uid, provider);
        if (!secretName) {
            skipped.push(`${provider}: unsafe user id`);
            continue;
        }
        refs.push({ provider, secretName });
    }
    return { refs, skipped };
}
export function modelCredentialEntryById(id) {
    const entry = MODEL_CREDENTIAL_CATALOG.find((candidate) => candidate.id === id);
    if (!entry) {
        throw new Error(`Unknown model credential provider: ${id}`);
    }
    return entry;
}
function isModelCredentialOAuthEntry(entry) {
    return entry.modes[0] === 'oauth';
}
export function modelCredentialOAuthEntryByProviderId(id) {
    const entry = MODEL_CREDENTIAL_CATALOG.find((candidate) => isModelCredentialOAuthEntry(candidate) && candidate.id === id);
    if (!entry) {
        throw new Error(`Unknown OAuth model credential provider: ${id}`);
    }
    return entry;
}
export function modelCredentialOAuthEntryBySubscriptionProvider(provider) {
    return MODEL_CREDENTIAL_CATALOG.find((entry) => isModelCredentialOAuthEntry(entry) && entry.oauth.subscriptionProvider === provider) ?? null;
}
export function modelCredentialApiKeyState(args) {
    return {
        active: true,
        provider: args.provider,
        mode: 'api_key',
        status: 'active',
        reasonCode: 'ok',
        secretName: args.secretName,
        fingerprint: args.fingerprint,
        keyHash: args.keyHash,
        ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.addedAt !== undefined ? { addedAt: args.addedAt } : {}),
        lastUsedAt: null,
    };
}
export function modelCredentialOAuthState(args) {
    return {
        active: true,
        provider: args.provider,
        mode: 'oauth',
        status: 'active',
        reasonCode: 'ok',
        secretName: args.secretName,
        ...(args.addedAt !== undefined ? { addedAt: args.addedAt } : {}),
        lastUsedAt: null,
    };
}
