import { type ModelCredentialActiveStaticProviderId, type ModelCredentialOAuthProviderId } from "@octogee/shared/types/model-credentials";
export type ModelCredentialMaterializerProvider = ModelCredentialActiveStaticProviderId | ModelCredentialOAuthProviderId;
export type ModelCredentialMaterializerMode = "api_key" | "oauth";
export interface ModelCredentialConfigInput {
    slug: string;
    provider: ModelCredentialMaterializerProvider;
    baseUrl?: string;
    model?: string;
}
export interface ExecSecretRef {
    source: "exec";
    provider: string;
    id: string;
}
export type AuthProfileEntry = {
    type: "api_key";
    provider: string;
    keyRef: ExecSecretRef;
} | {
    type: "oauth";
    provider: string;
};
export interface AuthProfilesJson {
    profiles: Record<string, AuthProfileEntry>;
}
export interface CustomProviderEntry {
    api: "openai-completions";
    baseUrl: string;
    apiKey: ExecSecretRef;
    models: Array<{
        id: string;
        name: string;
    }>;
}
export interface ModelsJson {
    providers: Record<string, CustomProviderEntry>;
}
export interface ModelCredentialConfigOutput {
    authProfiles: AuthProfilesJson | null;
    models: ModelsJson | null;
    agentModelOverride: string | null;
}
export interface ModelCredentialMaterializerProviderSpec {
    mode: ModelCredentialMaterializerMode;
    shape: "profile" | "customProvider";
    profileKey?: string;
    authProvider: string;
    defaultModel: string | null;
    baseUrl?: string;
}
export declare const MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS: Record<ModelCredentialMaterializerProvider, ModelCredentialMaterializerProviderSpec>;
export declare function buildModelCredentialConfigForProvider(input: ModelCredentialConfigInput): ModelCredentialConfigOutput;
export declare function modelCredentialSecretNameFor(slug: string, provider: ModelCredentialMaterializerProvider): string;
export declare function isModelCredentialOauthProvider(provider: ModelCredentialMaterializerProvider): boolean;
export declare function codexRuntimeConfig(): {
    model: string;
    modelsDef: Record<string, {
        agentRuntime: {
            id: "codex";
        };
    }>;
};
export declare const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS: readonly ["claude-cli/claude-opus-5", "claude-cli/claude-sonnet-5", "claude-cli/claude-opus-4-8", "claude-cli/claude-opus-4-7", "claude-cli/claude-sonnet-4-6", "claude-cli/claude-opus-4-6"];
export declare function claudeCliRuntimeConfig(): {
    model: string;
    modelsDef: Record<string, Record<string, never>>;
};
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
export declare const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:octogee-chatgpt";
export declare const CLAUDE_CLI_DEFAULT_PROFILE_ID = "anthropic:claude-cli";
export declare function buildClaudeCliNativeCredentialsJson(raw: string): string | null;
export declare function buildClaudeCliAuthProfilesStore(token: string, nowMs: number): AuthProfilesStoreV1;
export declare function buildCodexAuthProfilesStore(codexAuthJsonText: string): AuthProfilesStoreV1;
export declare function buildCodexAuthJsonFromStore(authProfilesStoreText: string): string | null;
