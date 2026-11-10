import type { SecretVersionWriteResult, SecretWrite, SubscriptionSecretVersionResult } from "./secret-store-types.js";
export declare function secretReplicationPolicy(targetProjectId: string): {
    userManaged: {
        replicas: {
            location: string;
        }[];
    };
};
export declare function writeSecret(params: SecretWrite): Promise<{
    versionName: string;
}>;
export declare function addSecretVersionIfExists(name: string, value: string): Promise<SecretVersionWriteResult>;
export declare function addSecretVersionKeepingLatest(name: string, value: string): Promise<SubscriptionSecretVersionResult>;
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
export declare function provisionGatewayAuthSecret(params: {
    gatewayId: string;
    gatewayServiceAccount: string;
}): Promise<{
    secretName: string;
    created: boolean;
}>;
