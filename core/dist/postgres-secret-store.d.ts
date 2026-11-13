import pg from "pg";
import { type Encryptor } from "./encryptor.js";
import { type SecretStore } from "./secret-store-types.js";
export interface SecretStoreKeyRing {
    readonly targetKeyId: string;
    encryptor(keyId: string): Encryptor;
}
export declare function createSecretStoreKeyRing(encodedKey: string | undefined, previousKey?: string): SecretStoreKeyRing;
export declare function createPostgresSecretStore(pool: pg.Pool, keys: SecretStoreKeyRing, schema?: string): SecretStore & {
    rotate(): Promise<{
        rotated: number;
    }>;
};
