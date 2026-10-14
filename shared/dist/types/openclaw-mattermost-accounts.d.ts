type JsonObject = Record<string, unknown>;
export type PlatformAgentMattermostAccountKind = "coach" | "project";
export declare const PLATFORM_MATTERMOST_BASE_URL = "${MM_URL}";
export declare function mattermostAccountEndpointsForTarget(current: unknown, accounts: JsonObject, platformOwned: boolean): JsonObject;
export declare function managedMattermostAccounts(config: JsonObject): Map<string, PlatformAgentMattermostAccountKind>;
export declare function mattermostAccountSecretRef(accountId: string): JsonObject;
export declare function platformAgentMattermostAccountsProjected(config: JsonObject, accounts: JsonObject, platformOwned: boolean): boolean;
export declare function projectPlatformAgentMattermostAccounts(config: JsonObject, accounts: JsonObject, platformOwned: boolean): void;
export {};
