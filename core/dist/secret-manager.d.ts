export declare const SINGLE_REGION_REPLICATION: {
    userManaged: {
        replicas: {
            location: string;
        }[];
    };
};
export declare function writeSecret(params: {
    name: string;
    value: string;
    labels?: Record<string, string>;
}): Promise<{
    versionName: string;
}>;
export declare function addSecretVersionIfExists(name: string, value: string): Promise<{
    ok: true;
    versionName: string;
} | {
    ok: false;
    reason: "not_found";
}>;
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
