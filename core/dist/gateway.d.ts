import { type OpenClawConfig } from "./config.js";
export declare const agentToUid: Map<string, string>;
export declare function loadAgentToUidMapping(): Promise<void>;
export declare function registerAgentIds(uid: string, agentIds: string[]): void;
export declare function applyGatewayDefaults(config: OpenClawConfig): boolean;
export declare function ensureGatewayDefaults(): void;
