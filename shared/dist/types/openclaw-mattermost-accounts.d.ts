type JsonObject = Record<string, unknown>;
export type PlatformAgentMattermostAccountKind = "coach" | "project";
export declare function managedMattermostAccounts(config: JsonObject): Map<string, PlatformAgentMattermostAccountKind>;
export declare function mattermostAccountSecretRef(accountId: string): JsonObject;
export declare function platformAgentMattermostAccountsProjected(config: JsonObject, accounts: JsonObject, platformOwned: boolean): boolean;
export declare function projectPlatformAgentMattermostAccounts(config: JsonObject, accounts: JsonObject, platformOwned: boolean): void;
export {};
