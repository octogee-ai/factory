export declare const PUBLIC_APP_ORIGINS_ENV = "PUBLIC_APP_ORIGINS";
export declare function parsePublicAppOrigins(raw: string | undefined): string[];
export declare function publicAppOriginsFromEnv(env?: NodeJS.ProcessEnv): string[];
export declare function publicAppHostsFromEnv(env?: NodeJS.ProcessEnv): string[];
