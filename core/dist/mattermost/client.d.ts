export declare function assertMattermostConfigured(): void;
export declare function getMmAdminToken(): Promise<string | null>;
export declare function mmApiCall(method: string, endpoint: string, body?: unknown): Promise<any | null>;
export declare function mmApiCallStrict(method: string, endpoint: string, body?: unknown): Promise<unknown | null>;
export declare function isIdempotentMmError(body: string): boolean;
