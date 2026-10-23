export interface AgentStoreGatewayIdentity {
    gatewayId: string;
    gatewayClass: "shared" | "builder";
    token: string;
    builder?: {
        uid: string;
        slug: string;
    };
}
export declare function createAgentStoreCredentialProvisioner(adminDsn: string, clientDsn: string): (identity: AgentStoreGatewayIdentity) => Promise<string>;
export declare function createAgentStoreOwnershipTransferer(adminDsn: string): (builder: {
    uid: string;
    slug: string;
}, target: "shared" | "builder", assertCurrent?: () => Promise<void>) => Promise<void>;
export declare function assertNoBuilderAgentStores(adminDsn: string, builder: {
    uid: string;
    slug: string;
}): Promise<void>;
