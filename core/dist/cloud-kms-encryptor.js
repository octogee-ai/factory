function decodeKmsBytes(value) {
    return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}
export function createCloudKmsDecryptor(name, getClient) {
    return async (ciphertext) => {
        if (typeof ciphertext !== "string" || ciphertext.length === 0) {
            throw new Error("decryptSecret requires non-empty ciphertext string");
        }
        const [response] = await getClient().decrypt({
            name,
            ciphertext: Buffer.from(ciphertext, "base64"),
        });
        if (response.plaintext == null)
            throw new Error("KMS decrypt returned no plaintext");
        return decodeKmsBytes(response.plaintext).toString("utf8");
    };
}
export function createCloudKmsEncryptor(name, getClient) {
    return {
        async encrypt(plaintext) {
            if (typeof plaintext !== "string" || plaintext.length === 0) {
                throw new Error("encryptSecret requires non-empty plaintext string");
            }
            const [response] = await getClient().encrypt({
                name,
                plaintext: Buffer.from(plaintext, "utf8"),
            });
            if (response.ciphertext == null)
                throw new Error("KMS encrypt returned no ciphertext");
            return decodeKmsBytes(response.ciphertext).toString("base64");
        },
        decrypt: createCloudKmsDecryptor(name, getClient),
    };
}
