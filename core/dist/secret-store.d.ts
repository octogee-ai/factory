import type { SecretStore, SecretWrite } from "./secret-store-types.js";
export { isSecretNotFound, SecretNotFoundError } from "./secret-store-types.js";
export type { SecretStore, SubscriptionSecretVersionResult } from "./secret-store-types.js";
type Environment = Readonly<Record<string, string | undefined>>;
export declare function rotateRuntimeSecretStoreKey(targetId: string, environment?: Environment): Promise<{
    rotated: number;
}>;
export declare function createRuntimeSecretStore(environment?: Environment): SecretStore;
export declare function writeSecret(input: SecretWrite): Promise<{
    versionName: string;
}>;
export declare function addSecretVersionIfExists(name: string, value: string): Promise<import("./secret-store-types.js").SecretVersionWriteResult>;
export declare function addSecretVersionKeepingLatest(name: string, value: string): Promise<import("./secret-store-types.js").SubscriptionSecretVersionResult>;
export declare function readSecret(name: string, version?: string): Promise<string>;
export declare function readSecretWithLabels(name: string, version?: string): Promise<{
    value: string;
    labels: Record<string, string>;
}>;
export declare function archiveSecret(name: string): Promise<{
    disabledCount: number;
}>;
export declare function deleteSecret(name: string): Promise<{
    deleted: boolean;
}>;
export declare function provisionGatewayAuthSecret(input: Parameters<SecretStore["provisionGatewayAuthSecret"]>[0]): Promise<{
    secretName: string;
    created: boolean;
}>;
