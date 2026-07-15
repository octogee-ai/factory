export type ConnectorCaptureMethod = 'oauth-web' | 'device' | 'pat' | 'fields';
export type ConnectorConsumption = 'platform-read' | 'agent-runtime';
export type ConnectorClientSource = 'platform' | 'per-user';
export type ConnectorFamily = 'code-hosting' | 'deploy-hosting' | 'registry' | 'ai' | 'cloud' | 'productivity';
export type ConnectorId = 'github' | 'vercel' | 'netlify' | 'cloudflare' | 'npm' | 'docker' | 'openai' | 'anthropic' | 'openrouter' | 'grok' | 'minimax' | 'openai-compatible' | 'gemini' | 'aws' | 'gcp' | 'azure' | 'google' | 'microsoft' | 'yahoo';
export interface ConnectorCaptureField {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    multiline?: boolean;
}
export interface ConnectorMeta {
    id: ConnectorId;
    displayName: string;
    tagline: string;
    family: ConnectorFamily;
    captureMethods: ConnectorCaptureMethod[];
    consumption: ConnectorConsumption;
    clientSource: ConnectorClientSource;
    scopes: string[];
    platformScopes?: string[];
    agentRuntimeMaterializable?: boolean;
    captureFields?: ConnectorCaptureField[];
    implemented: boolean;
}
export declare const GOOGLE_SCOPES: string[];
export declare const GOOGLE_PLATFORM_SCOPES: string[];
export declare const MICROSOFT_SCOPES: string[];
export declare const CONNECTOR_CATALOG: readonly ConnectorMeta[];
export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';
export interface IntegrationStatusDoc {
    provider: string;
    status: IntegrationStatus;
    accountLabel?: string;
    scopes?: string[];
    captureMethod?: ConnectorCaptureMethod;
    clientConfigured?: boolean;
    error?: string;
    connectedAt?: unknown;
    updatedAt?: unknown;
    verifiedAt?: unknown;
}
