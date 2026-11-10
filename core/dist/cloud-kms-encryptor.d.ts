import type { Encryptor } from "./encryptor.js";
type KmsBytes = Buffer | string | Uint8Array;
export interface KmsClient {
    encrypt(req: {
        name: string;
        plaintext: Buffer;
    }): Promise<[{
        ciphertext?: KmsBytes | null;
    }, ...unknown[]]>;
    decrypt(req: {
        name: string;
        ciphertext: Buffer;
    }): Promise<[{
        plaintext?: KmsBytes | null;
    }, ...unknown[]]>;
}
export declare function createCloudKmsDecryptor(name: string, getClient: () => Pick<KmsClient, "decrypt">): Encryptor["decrypt"];
export declare function createCloudKmsEncryptor(name: string, getClient: () => KmsClient): Encryptor;
export {};
