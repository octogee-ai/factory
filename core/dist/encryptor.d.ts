export interface Encryptor {
    encrypt(plaintext: string): Promise<string>;
    decrypt(ciphertext: string): Promise<string>;
}
export declare function createRootKeyEncryptor(encodedKey: string | undefined): Encryptor;
