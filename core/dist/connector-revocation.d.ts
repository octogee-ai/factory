import type { SecretsRepository } from "./platform-state/secrets.js";
export interface ConnectorRevocationTarget {
    connectorId: string;
    revocationUrl: string;
}
export interface ConnectorRevocationDeps {
    secrets: Pick<SecretsRepository, "get">;
    decryptSecret: (ciphertext: string) => Promise<string>;
    logger: {
        warn: (message: string) => void;
    };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}
export declare function revokeProviderGrant(uid: string, target: ConnectorRevocationTarget, deps: ConnectorRevocationDeps): Promise<void>;
export declare function revokeAllConnectorGrantsForUser(uid: string, targets: readonly ConnectorRevocationTarget[], deps: ConnectorRevocationDeps): Promise<void>;
