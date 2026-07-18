export interface ConnectorRevocationTarget {
    connectorId: string;
    revocationUrl: string;
}
interface SecretReader {
    collection(name: string): {
        doc(uid: string): {
            collection(name: string): {
                doc(connectorId: string): {
                    get(): Promise<{
                        data(): unknown;
                    }>;
                };
            };
        };
    };
}
export interface ConnectorRevocationDeps {
    db: SecretReader;
    decryptSecret: (ciphertext: string) => Promise<string>;
    logger: {
        warn: (message: string) => void;
    };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
export declare function revokeProviderGrant(uid: string, target: ConnectorRevocationTarget, deps: ConnectorRevocationDeps): Promise<void>;
export declare function revokeAllConnectorGrantsForUser(uid: string, targets: readonly ConnectorRevocationTarget[], deps: ConnectorRevocationDeps): Promise<void>;
export {};
