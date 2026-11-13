import { type LogContext } from "@octogee/shared/server/service-logger";
export declare const OPENCLAW_DIR: string;
export declare const OPENCLAW_CONFIG: string;
export declare const AGENTS_DIR: string;
export declare const AGENT_PREFIX: string;
export declare const GATEWAY_ID: string;
export declare const GATEWAY_PROFILE: string;
export declare const GATEWAY_CLASS: string;
export declare function isIsolatedGateway(): boolean;
export declare function isSharedGateway(): boolean;
export declare function usesLlmBrokerToken(): boolean;
export declare const CUSTOMERS_DIR: string;
export declare const CUSTOMER_KEYS_DIR: string;
export declare const TEMPLATES_DIR: string;
export declare const GIT_API_URL: string;
export declare const GIT_ORG: string;
export declare const GIT_SSH_HOST = "gitea";
export declare const BLOB_SYNC_INTERVAL_MS: number;
export declare const GITHUB_TOKEN: string;
export declare const GITHUB_ORG: string;
export declare const BLOB_SYNC_MAX_CONCURRENT = 10;
export declare const BLOB_SYNC_MAX_SIZE: number;
export declare function log(msg: string, fields?: LogContext): void;
export declare function logLevel(): string;
export declare function dlog(msg: string, fields?: LogContext): void;
export declare function bootBanner(component: string): string;
export interface OpenClawAgentConfig {
    id: string;
    model?: string;
    heartbeat?: unknown;
    tools?: {
        fs?: {
            workspaceOnly?: boolean;
        };
        deny?: string[];
    };
}
export interface OpenClawConfig {
    channels?: Record<string, unknown>;
    agents?: {
        defaults?: {
            maxConcurrent?: number;
            verboseDefault?: string;
            subagents?: {
                maxConcurrent?: number;
                model?: string;
                runTimeoutSeconds?: number;
            };
        };
        list?: OpenClawAgentConfig[];
    };
    tools?: {
        subagents?: {
            tools?: {
                deny?: string[];
            };
        };
        elevated?: {
            enabled?: boolean;
        };
    };
    gateway?: {
        auth?: {
            rateLimit?: {
                maxAttempts: number;
                windowMs: number;
                lockoutMs: number;
            };
        };
    };
}
export declare function readOpenClawConfig(): OpenClawConfig;
export declare function writeOpenClawConfig(config: unknown, configPath?: string): void;
export declare function agentExists(config: unknown, agentId: string): boolean;
