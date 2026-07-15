export type ModelCredentialActiveStaticProviderId = 'openai' | 'anthropic' | 'openrouter' | 'grok' | 'minimax' | 'openai-compatible';
export type ModelCredentialConnectorOnlyProviderId = 'gemini';
export type ModelCredentialStaticProviderId = ModelCredentialActiveStaticProviderId | ModelCredentialConnectorOnlyProviderId;
export type ModelCredentialOAuthProviderId = 'openai-codex' | 'claude-cli';
export type ModelCredentialProviderId = ModelCredentialStaticProviderId | ModelCredentialOAuthProviderId;
export declare const MODEL_CREDENTIAL_MODES: readonly ['api_key', 'token', 'oauth'];
export type ModelCredentialMode = typeof MODEL_CREDENTIAL_MODES[number];
export type ModelCredentialSubscriptionProviderId = 'openai' | 'anthropic';
export type ModelCredentialOAuthGatewayFlow = 'device-auth' | 'claude-sso';
export type ModelCredentialStateStatus = 'active' | 'needs_reauth' | 'missing' | 'invalid' | 'sync_pending';
export type ModelCredentialStateReasonCode = 'ok' | 'missing_credential' | 'invalid_expires' | 'expired' | 'unresolved_ref' | 'no_model';
export type ModelCredentialCaptureMethod = 'api-key' | 'device-oauth' | 'sso-oauth';
export type ModelCredentialStaticStorage = {
    kind: 'secret-manager';
    secretNamePrefix: 'byok';
};
export type ModelCredentialConnectorOnlyStorage = {
    kind: 'connector-secret';
    pathTemplate: 'users/{uid}/secrets/{provider}';
};
export type ModelCredentialOAuthStorage = {
    kind: 'oauth-secret-manager';
    secretNamePrefix: 'byosub';
};
export type ModelCredentialStorage = ModelCredentialStaticStorage | ModelCredentialConnectorOnlyStorage | ModelCredentialOAuthStorage;
export type ModelCredentialActiveStaticMaterialization = {
    kind: 'auth-profile';
    writesAuthJson: false;
} | {
    kind: 'custom-openai-provider';
    writesAuthJson: false;
};
export type ModelCredentialConnectorOnlyMaterialization = {
    kind: 'connector-only';
    writesAuthJson: false;
};
export type ModelCredentialStaticMaterialization = ModelCredentialActiveStaticMaterialization | ModelCredentialConnectorOnlyMaterialization;
export type ModelCredentialOAuthMaterialization = {
    kind: 'oauth-profile-store';
    writesAuthJson: boolean;
};
export type ModelCredentialMaterialization = ModelCredentialStaticMaterialization | ModelCredentialOAuthMaterialization;
export type ModelCredentialBaseUrl = {
    kind: 'none';
} | {
    kind: 'canonical';
    value: string;
} | {
    kind: 'user';
    requiresHttps: true;
};
export interface ModelCredentialModel {
    required: boolean;
}
export interface ModelCredentialOpenClawBase {
    authProvider: string;
    configProfileId: string | null;
    storeProfileId: string | null;
}
export type ModelCredentialStaticOpenClaw = ModelCredentialOpenClawBase & {
    secretRefAllowed: true;
};
export type ModelCredentialOAuthOpenClaw = ModelCredentialOpenClawBase & {
    secretRefAllowed: false;
};
export type ModelCredentialConnectorOnlyOpenClaw = ModelCredentialOpenClawBase & {
    secretRefAllowed: false;
};
export type ModelCredentialOpenClaw = ModelCredentialStaticOpenClaw | ModelCredentialConnectorOnlyOpenClaw | ModelCredentialOAuthOpenClaw;
export interface ModelCredentialDefaults {
    model: string | null;
}
export interface ModelCredentialOAuthRuntime {
    subscriptionProvider: ModelCredentialSubscriptionProviderId;
    secretProvider: ModelCredentialSubscriptionProviderId;
    gatewayFlow: ModelCredentialOAuthGatewayFlow;
}
export interface ModelCredentialCatalogBase<Id extends ModelCredentialProviderId> {
    id: Id;
    displayName: string;
    captureMethods: readonly ModelCredentialCaptureMethod[];
    implemented: boolean;
    baseUrl: ModelCredentialBaseUrl;
    model: ModelCredentialModel;
    defaults: ModelCredentialDefaults;
}
export interface ModelCredentialActiveStaticCatalogEntry extends ModelCredentialCatalogBase<ModelCredentialActiveStaticProviderId> {
    modes: readonly ['api_key'];
    activeSlotEligible: true;
    connectorOnlyUntilRouted?: never;
    storage: ModelCredentialStaticStorage;
    materialization: ModelCredentialActiveStaticMaterialization;
    openclaw: ModelCredentialStaticOpenClaw;
}
export interface ModelCredentialConnectorOnlyCatalogEntry extends ModelCredentialCatalogBase<ModelCredentialConnectorOnlyProviderId> {
    modes: readonly ['api_key'];
    activeSlotEligible: false;
    connectorOnlyUntilRouted: true;
    storage: ModelCredentialConnectorOnlyStorage;
    materialization: ModelCredentialConnectorOnlyMaterialization;
    openclaw: ModelCredentialConnectorOnlyOpenClaw;
}
export interface ModelCredentialOAuthCatalogEntry extends ModelCredentialCatalogBase<ModelCredentialOAuthProviderId> {
    modes: readonly ['oauth'];
    activeSlotEligible: true;
    connectorOnlyUntilRouted?: never;
    storage: ModelCredentialOAuthStorage;
    materialization: ModelCredentialOAuthMaterialization;
    openclaw: ModelCredentialOAuthOpenClaw;
    oauth: ModelCredentialOAuthRuntime;
}
export type ModelCredentialStaticCatalogEntry = ModelCredentialActiveStaticCatalogEntry | ModelCredentialConnectorOnlyCatalogEntry;
export type ModelCredentialCatalogEntry = ModelCredentialStaticCatalogEntry | ModelCredentialOAuthCatalogEntry;
export interface ModelCredentialStateBase {
    active: boolean;
    provider: ModelCredentialProviderId;
    mode: ModelCredentialMode;
    status: ModelCredentialStateStatus;
    reasonCode: ModelCredentialStateReasonCode;
    secretName: string;
    addedAt?: unknown;
    lastUsedAt: unknown | null;
    lastProbeAt?: unknown;
    lastSyncAt?: unknown;
}
export interface ModelCredentialApiKeyState extends ModelCredentialStateBase {
    provider: ModelCredentialActiveStaticProviderId;
    mode: 'api_key';
    fingerprint: string;
    keyHash: string;
    baseUrl?: string;
    model?: string;
}
export interface ModelCredentialOAuthState extends ModelCredentialStateBase {
    provider: ModelCredentialOAuthProviderId;
    mode: 'oauth';
}
export type ModelCredentialState = ModelCredentialApiKeyState | ModelCredentialOAuthState;
export declare const MODEL_CREDENTIAL_CATALOG: readonly [{
    readonly id: 'openai';
    readonly displayName: 'OpenAI API key';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'auth-profile';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'none';
    };
    readonly model: {
        readonly required: false;
    };
    readonly openclaw: {
        readonly authProvider: 'openai';
        readonly configProfileId: 'openai:default';
        readonly storeProfileId: 'openai:default';
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: 'openai/gpt-5';
    };
}, {
    readonly id: 'openai-codex';
    readonly displayName: 'ChatGPT subscription';
    readonly modes: readonly ["oauth"];
    readonly captureMethods: readonly ["device-oauth"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'oauth-secret-manager';
        readonly secretNamePrefix: 'byosub';
    };
    readonly materialization: {
        readonly kind: 'oauth-profile-store';
        readonly writesAuthJson: true;
    };
    readonly oauth: {
        readonly subscriptionProvider: 'openai';
        readonly secretProvider: 'openai';
        readonly gatewayFlow: 'device-auth';
    };
    readonly baseUrl: {
        readonly kind: 'none';
    };
    readonly model: {
        readonly required: false;
    };
    readonly openclaw: {
        readonly authProvider: 'openai-codex';
        readonly configProfileId: 'openai-codex';
        readonly storeProfileId: 'openai-codex:default';
        readonly secretRefAllowed: false;
    };
    readonly defaults: {
        readonly model: 'openai/gpt-5.5';
    };
}, {
    readonly id: 'anthropic';
    readonly displayName: 'Anthropic API key';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'auth-profile';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'none';
    };
    readonly model: {
        readonly required: false;
    };
    readonly openclaw: {
        readonly authProvider: 'anthropic';
        readonly configProfileId: 'anthropic:default';
        readonly storeProfileId: 'anthropic:default';
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: null;
    };
}, {
    readonly id: 'claude-cli';
    readonly displayName: 'Claude subscription';
    readonly modes: readonly ["oauth"];
    readonly captureMethods: readonly ["sso-oauth"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'oauth-secret-manager';
        readonly secretNamePrefix: 'byosub';
    };
    readonly materialization: {
        readonly kind: 'oauth-profile-store';
        readonly writesAuthJson: false;
    };
    readonly oauth: {
        readonly subscriptionProvider: 'anthropic';
        readonly secretProvider: 'anthropic';
        readonly gatewayFlow: 'claude-sso';
    };
    readonly baseUrl: {
        readonly kind: 'none';
    };
    readonly model: {
        readonly required: false;
    };
    readonly openclaw: {
        readonly authProvider: 'claude-cli';
        readonly configProfileId: 'anthropic:claude-cli';
        readonly storeProfileId: 'anthropic:claude-cli';
        readonly secretRefAllowed: false;
    };
    readonly defaults: {
        readonly model: 'claude-cli/claude-opus-4-8';
    };
}, {
    readonly id: 'openrouter';
    readonly displayName: 'OpenRouter';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'custom-openai-provider';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'canonical';
        readonly value: 'https://openrouter.ai/api/v1';
    };
    readonly model: {
        readonly required: true;
    };
    readonly openclaw: {
        readonly authProvider: 'openrouter';
        readonly configProfileId: null;
        readonly storeProfileId: null;
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: null;
    };
}, {
    readonly id: 'grok';
    readonly displayName: 'Grok';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'custom-openai-provider';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'canonical';
        readonly value: 'https://api.x.ai/v1';
    };
    readonly model: {
        readonly required: true;
    };
    readonly openclaw: {
        readonly authProvider: 'grok';
        readonly configProfileId: null;
        readonly storeProfileId: null;
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: null;
    };
}, {
    readonly id: 'minimax';
    readonly displayName: 'MiniMax';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'custom-openai-provider';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'canonical';
        readonly value: 'https://api.minimax.io/v1';
    };
    readonly model: {
        readonly required: true;
    };
    readonly openclaw: {
        readonly authProvider: 'minimax';
        readonly configProfileId: null;
        readonly storeProfileId: null;
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: null;
    };
}, {
    readonly id: 'openai-compatible';
    readonly displayName: 'Custom OpenAI-compatible';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: true;
    readonly storage: {
        readonly kind: 'secret-manager';
        readonly secretNamePrefix: 'byok';
    };
    readonly materialization: {
        readonly kind: 'custom-openai-provider';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'user';
        readonly requiresHttps: true;
    };
    readonly model: {
        readonly required: true;
    };
    readonly openclaw: {
        readonly authProvider: 'openai-compatible';
        readonly configProfileId: null;
        readonly storeProfileId: null;
        readonly secretRefAllowed: true;
    };
    readonly defaults: {
        readonly model: null;
    };
}, {
    readonly id: 'gemini';
    readonly displayName: 'Google Gemini';
    readonly modes: readonly ["api_key"];
    readonly captureMethods: readonly ["api-key"];
    readonly implemented: true;
    readonly activeSlotEligible: false;
    readonly connectorOnlyUntilRouted: true;
    readonly storage: {
        readonly kind: 'connector-secret';
        readonly pathTemplate: 'users/{uid}/secrets/{provider}';
    };
    readonly materialization: {
        readonly kind: 'connector-only';
        readonly writesAuthJson: false;
    };
    readonly baseUrl: {
        readonly kind: 'none';
    };
    readonly model: {
        readonly required: false;
    };
    readonly openclaw: {
        readonly authProvider: 'gemini';
        readonly configProfileId: null;
        readonly storeProfileId: null;
        readonly secretRefAllowed: false;
    };
    readonly defaults: {
        readonly model: null;
    };
}];
export declare const MODEL_CREDENTIAL_STATIC_PROVIDER_IDS: readonly ["openai", "anthropic", "openrouter", "grok", "minimax", "openai-compatible"];
export declare const MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS: readonly ["gemini"];
export declare const MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS: readonly ["openai-codex", "claude-cli"];
export declare const MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS: readonly ["openai", "anthropic"];
export interface UserByosubCredentialRef {
    provider: ModelCredentialSubscriptionProviderId;
    secretName: string;
}
export interface UserByosubCredentialRefs {
    refs: UserByosubCredentialRef[];
    skipped: string[];
}
export declare function byosubSecretNameForUser(uid: string, provider: ModelCredentialSubscriptionProviderId): string | null;
export declare function resolveUserByosubCredentialRefs(uid: string, integration: unknown): UserByosubCredentialRefs;
export declare function modelCredentialEntryById(id: ModelCredentialProviderId): ModelCredentialCatalogEntry;
export declare function modelCredentialOAuthEntryByProviderId(id: ModelCredentialOAuthProviderId): ModelCredentialOAuthCatalogEntry;
export declare function modelCredentialOAuthEntryBySubscriptionProvider(provider: string): ModelCredentialOAuthCatalogEntry | null;
export declare function modelCredentialApiKeyState(args: {
    provider: ModelCredentialActiveStaticProviderId;
    secretName: string;
    fingerprint: string;
    keyHash: string;
    baseUrl?: string;
    model?: string;
    addedAt?: unknown;
}): ModelCredentialApiKeyState;
export declare function modelCredentialOAuthState(args: {
    provider: ModelCredentialOAuthProviderId;
    secretName: string;
    addedAt?: unknown;
}): ModelCredentialOAuthState;
